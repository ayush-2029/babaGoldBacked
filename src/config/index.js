"use strict";

/**
 * Every environment-dependent value in the service, resolved once.
 *
 * Nothing outside this module reads process.env. The bucket name in particular
 * must never appear in a handler, a controller, or any response body — it is a
 * storage detail, and the clients are forbidden from knowing it.
 */

const required = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const STAGE = process.env.STAGE || "dev";

const config = {
  stage: STAGE,
  isProduction: STAGE === "prod" || STAGE === "production",
  region: process.env.AWS_REGION || "ap-south-1",

  /**
   * The bucket and the prefix within it. Keeping the prefix configurable is
   * what lets dev and prod share one bucket safely if that is the chosen
   * split — see the environments question in API_CONTRACT.md §7.
   */
  bucket: required("DATA_BUCKET", "baba-gold-in"),
  dataPrefix: process.env.DATA_PREFIX || "data",

  /** Object keys, relative to dataPrefix. The app never learns these names. */
  keys: {
    catalog: "catalog.json",
    company: "company.json",
    services: "services.json",
    home: "home.json",
    storefront: "storefront.json",
    settings: "settings.json",
    /*
     * The operator notice. Hand-edited in the bucket, never written by the
     * API and never exposed through the admin router — see noticeService.
     */
    notice: "notice.json",
  },

  /**
   * Prepended to relative media keys before they reach a client. Empty until a
   * CloudFront distribution exists; relative keys then pass through unresolved
   * and the app falls back to its bundled placeholder, which is the same
   * behaviour it has today.
   */
  mediaBaseUrl: process.env.MEDIA_BASE_URL || "",

  media: {
    /**
     * 'signed'  — every image URL is a presigned S3 GET, so nothing under
     *             media/ is world-readable. The default.
     * 'public'  — plain S3/CDN URLs, requires media/* to be public-read.
     */
    mode:
      process.env.MEDIA_URL_MODE ||
      // The filesystem driver has no S3 to sign against, so local development
      // and the test suite fall back to plain URLs. Without this the suite
      // would quietly start needing AWS credentials.
      (process.env.STORAGE_DRIVER === "local" ? "public" : "signed"),

    /**
     * How long a signed URL stays valid, and how often a new one is minted.
     *
     * Signing is pinned to the START of the current window, so every request
     * inside a window produces a byte-identical URL. That is what keeps image
     * caching working at all — a URL that changed per request would make the
     * app re-download every photo on every screen.
     *
     * The gap between the two is the guarantee that matters: a URL handed out
     * at the very end of a window still has (ttl - window) left on it. Keep
     * ttl comfortably larger than window, or clients will meet expired URLs.
     */
    signedUrlTtlSeconds: Number(process.env.SIGNED_URL_TTL || 3600),
    signingWindowSeconds: Number(process.env.SIGNING_WINDOW || 2700),
  },

  /**
   * Substituted when a product carries no images at all, so the API never
   * returns an empty images array.
   *
   * The extension is .jpg because the artwork IS a JPEG. A mismatched
   * extension broke an Android release build once; keep the S3 object named to
   * match its real format.
   */
  fallbackProductImageKey:
    process.env.FALLBACK_PRODUCT_IMAGE_KEY ||
    "media/products/default/metal_details_2.jpg",

  cache: {
    /**
     * 0 means "always revalidate" — clients still get cheap 304s via the ETag.
     *
     * It was 60. Combined with the mobile app's on-disk HTTP cache that meant
     * an admin edit could stay invisible for over a minute, surviving an app
     * restart. Raise it only with a CDN in front.
     */
    maxAge: Number(process.env.CACHE_MAX_AGE || 0),
    staleWhileRevalidate: Number(process.env.CACHE_SWR || 0),
  },

  pagination: {
    defaultLimit: 50,
    maxLimit: 100,
  },
};

/** Full S3 key for one of the data documents. */
config.dataKey = (name) => `${config.dataPrefix}/${config.keys[name]}`;

module.exports = config;
