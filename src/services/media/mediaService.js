"use strict";

const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const config = require("../../config");

/**
 * Turns a stored media reference into something a client can load.
 *
 * The JSON holds RELATIVE S3 keys ("media/products/ring-001/front.webp") so the
 * delivery mechanism stays a config choice. Two modes:
 *
 *   signed (default) — a presigned S3 GET per image. Nothing under media/ is
 *                      world-readable; a URL only works until it expires.
 *   public           — a plain base-URL prefix, for a CDN or a public bucket.
 *
 * Absolute http(s) URLs pass through untouched in both modes. That matters
 * today: the catalogue still carries absolute Unsplash URLs for design review,
 * and the app's own resolveMediaUrl behaves the same way, so the two can
 * coexist file by file.
 */

const isAbsolute = (value) =>
  /^https?:\/\//i.test(value) || value.startsWith("data:");

/**
 * The current signing window.
 *
 * Every request inside one window signs from the same instant, so the URLs are
 * identical and both the client's image cache and the API's own ETag stay
 * usable. `expiresAt` is what the cache layer keys off to guarantee no client
 * can hold a URL past its life — see signedMediaWindow() callers.
 */
function currentWindow(now = Date.now()) {
  const { signingWindowSeconds, signedUrlTtlSeconds } = config.media;
  const seconds = Math.floor(now / 1000);
  const start = Math.floor(seconds / signingWindowSeconds) * signingWindowSeconds;
  return {
    start,
    endsIn: start + signingWindowSeconds - seconds,
    expiresIn: start + signedUrlTtlSeconds - seconds,
    signingDate: new Date(start * 1000),
  };
}

/**
 * Presigned URLs are memoised per key per window, so a response carrying the
 * same photo several times signs it once, and a warm container reuses the work
 * across requests. Cleared whenever the window rolls over, which also bounds
 * the map's size.
 */
let signatureCache = new Map();
let signatureCacheWindow = null;

function cacheFor(windowStart) {
  if (signatureCacheWindow !== windowStart) {
    signatureCache = new Map();
    signatureCacheWindow = windowStart;
  }
  return signatureCache;
}

/** Lazy so the local filesystem driver never constructs an S3 client. */
function s3() {
  return require("../../repositories/s3/s3Client").s3();
}

async function signMediaKey(key, window) {
  const cache = cacheFor(window.start);
  const hit = cache.get(key);
  if (hit) {
    return hit;
  }

  const pending = getSignedUrl(
    s3(),
    // The stored key is environment-agnostic; the object is not.
    new GetObjectCommand({ Bucket: config.bucket, Key: config.mediaObjectKey(key) }),
    { expiresIn: config.media.signedUrlTtlSeconds, signingDate: window.signingDate },
  );

  cache.set(key, pending);
  return pending;
}

/**
 * Public mode only: prefix a relative key with the delivery host.
 *
 * In signed mode this deliberately returns the key untouched — signing happens
 * once at the controller boundary, where the whole payload can be walked and
 * every key signed in parallel rather than one await at a time.
 */
function resolveMediaUrl(value) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) {
    return value;
  }
  if (config.media.mode === "signed") {
    return value;
  }
  if (!config.mediaBaseUrl) {
    return value;
  }
  return `${config.mediaBaseUrl.replace(/\/+$/, "")}/${value.replace(/^\/+/, "")}`;
}

/** Property names that hold a media reference. */
const MEDIA_KEYS = /^(imageUrl|logoUrl|url|thumbnailUrl|iconUrl)$/;

function resolveMediaDeep(value) {
  if (Array.isArray(value)) {
    return value.map(resolveMediaDeep);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        MEDIA_KEYS.test(key) && typeof item === "string"
          ? resolveMediaUrl(item)
          : resolveMediaDeep(item);
    }
    return out;
  }
  return value;
}

/** Collects every relative media key in a payload. */
function collectKeys(value, found) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, found));
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (MEDIA_KEYS.test(key) && typeof item === "string") {
        if (item.length > 0 && !isAbsolute(item)) {
          found.add(item);
        }
      } else {
        collectKeys(item, found);
      }
    }
  }
  return found;
}

function substitute(value, urls) {
  if (Array.isArray(value)) {
    return value.map((item) => substitute(item, urls));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        MEDIA_KEYS.test(key) && typeof item === "string"
          ? urls.get(item) ?? item
          : substitute(item, urls);
    }
    return out;
  }
  return value;
}

/**
 * Replaces every relative media key in a payload with a presigned URL.
 *
 * Called once per response at the controller boundary. All keys are signed in
 * parallel, so a bootstrap carrying thirty images costs one batch rather than
 * thirty sequential awaits.
 *
 * @returns {Promise<{ data: unknown, window: object|null }>} the window is
 *          returned so the caller can bound its cache headers by it.
 */
async function deliverMedia(data) {
  if (config.media.mode !== "signed") {
    return { data, window: null };
  }

  const keys = collectKeys(data, new Set());
  if (keys.size === 0) {
    return { data, window: currentWindow() };
  }

  const window = currentWindow();
  const signed = await Promise.all(
    [...keys].map(async (key) => [key, await signMediaKey(key, window)]),
  );

  return { data: substitute(data, new Map(signed)), window };
}

/**
 * The inverse of delivery: turn whatever a client sent back into what should
 * actually be STORED.
 *
 * This exists because the round trip is asymmetric and easy to get wrong. The
 * API hands out absolute, SIGNED URLs so a browser can display an image; if a
 * client saves that value straight back, a URL carrying a one-hour signature
 * lands in catalog.json and is dead within the hour. The admin panel did
 * exactly that.
 *
 * So the server normalises rather than trusting the client: anything pointing
 * at our own bucket is reduced to its relative key and the query string is
 * discarded. Genuinely external URLs (the Unsplash placeholders) pass through
 * untouched — those are not ours to rewrite.
 */
function toStorageKey(value) {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }
  if (!/^https?:\/\//i.test(value)) {
    return value.replace(/^\/+/, "");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return value;
  }

  const ours =
    url.hostname.startsWith(`${config.bucket}.s3.`) ||
    url.hostname === `s3.${config.region}.amazonaws.com` ||
    (config.mediaBaseUrl && value.startsWith(config.mediaBaseUrl));

  if (!ours) {
    return value;
  }

  // Path-style URLs carry the bucket as the first segment; virtual-hosted
  // style does not.
  const path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const withoutBucket = path.startsWith(`${config.bucket}/`)
    ? path.slice(config.bucket.length + 1)
    : path;

  /*
   * And drop the environment folder.
   *
   * A signed URL points at "prod/media/…", but documents must store
   * "media/…" — an environment baked into the data would follow a copy of
   * prod into dev and quietly send it back to production's images.
   */
  return config.mediaRelativeKey(withoutBucket);
}

/** Walks a payload applying toStorageKey to every media reference. */
function normalizeStoredMedia(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeStoredMedia);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        MEDIA_KEYS.test(key) && typeof item === "string"
          ? toStorageKey(item)
          : normalizeStoredMedia(item);
    }
    return out;
  }
  return value;
}

module.exports = {
  toStorageKey,
  normalizeStoredMedia,
  resolveMediaUrl,
  resolveMediaDeep,
  deliverMedia,
  currentWindow,
};
