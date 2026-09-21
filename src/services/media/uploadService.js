"use strict";

const crypto = require("crypto");
const {
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { s3 } = require("../../repositories/s3/s3Client");
const config = require("../../config");
const { ApiError, validation } = require("../../utils/errors");
const { resolveMediaUrl } = require("./mediaService");

/**
 * Media upload, in two steps, for the reason set out in API_CONTRACT.md §3.
 *
 * A presigned PUT sends the bytes browser → S3, so the backend never sees
 * them and claude.md §18's validation has nowhere to run. `confirm` is where
 * it runs instead: nothing is written into a JSON document until the object
 * has been checked and a key handed back.
 */

/** The allowlist. Extension and magic bytes must both agree with the type. */
const ALLOWED = {
  "image/jpeg": { ext: "jpg", magic: [[0xff, 0xd8, 0xff]] },
  "image/png": {
    ext: "png",
    magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  },
  "image/webp": { ext: "webp", magic: [[0x52, 0x49, 0x46, 0x46]] }, // "RIFF"
};

const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 8 * 1024 * 1024);
const URL_TTL_SECONDS = 300;

const SCOPES = {
  product: (ownerId) => `media/products/${ownerId}`,
  category: (ownerId) => `media/categories/${ownerId}`,
  service: (ownerId) => `media/services/${ownerId}`,
  company: () => "media/company",
  storefront: () => "media/storefront",
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;

/**
 * Issues a short-lived, content-bound upload URL.
 *
 * The object key is generated here and the client's filename is never trusted
 * (claude.md §17) — an uploaded name is attacker-controlled input that would
 * otherwise become an S3 key.
 *
 * Note the path for a product: media/products/{productId}/ with no category
 * segment, so moving a product between categories never invalidates a URL.
 */
async function createUploadUrl({ scope, ownerId, contentType, fileSize }) {
  const problems = [];

  const buildPrefix = SCOPES[scope];
  if (!buildPrefix) {
    problems.push(`scope must be one of: ${Object.keys(SCOPES).join(", ")}`);
  }
  const needsOwner = scope === "product" || scope === "category" || scope === "service";
  if (needsOwner && !SLUG.test(ownerId ?? "")) {
    problems.push("ownerId must be the record's id, e.g. 'ring-001'");
  }
  const allowed = ALLOWED[contentType];
  if (!allowed) {
    problems.push(`contentType must be one of: ${Object.keys(ALLOWED).join(", ")}`);
  }
  if (!Number.isInteger(fileSize) || fileSize <= 0) {
    problems.push("fileSize must be a positive whole number of bytes");
  } else if (fileSize > MAX_BYTES) {
    problems.push(`fileSize exceeds the ${Math.round(MAX_BYTES / 1024 / 1024)}MB limit`);
  }

  if (problems.length > 0) {
    throw validation("Upload request is not valid.", { fields: problems });
  }

  const imageId = crypto.randomUUID();
  const key = `${buildPrefix(ownerId)}/${imageId}.${allowed.ext}`;

  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: config.mediaObjectKey(key),
    ContentType: contentType,
    ContentLength: fileSize,
  });

  const uploadUrl = await getSignedUrl(s3(), command, {
    expiresIn: URL_TTL_SECONDS,
  });

  return {
    uploadUrl,
    key,
    imageId,
    expiresIn: URL_TTL_SECONDS,
    /**
     * Headers the caller must send. Content-Type only.
     *
     * Content-Length is deliberately NOT listed even though it IS part of the
     * signature: it is a forbidden header in the Fetch API, so a browser
     * refuses to let JavaScript set it and supplies the real body length
     * itself. Advertising it would promise something no browser can do.
     *
     * It stays signed on purpose — that binds this URL to the size that was
     * declared, so a ticket issued for a 30KB photo cannot be used to upload
     * gigabytes.
     */
    requiredHeaders: {
      "Content-Type": contentType,
    },
  };
}

/** Reads the first bytes of an object without downloading the whole thing. */
async function readMagicBytes(key, length) {
  const response = await s3().send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: config.mediaObjectKey(key),
      Range: `bytes=0-${length - 1}`,
    }),
  );
  return Buffer.from(await response.Body.transformToByteArray());
}

const startsWith = (buffer, signature) =>
  signature.every((byte, i) => buffer[i] === byte);

/**
 * Validates what was actually uploaded, and only then hands back a key that
 * may be written into a document.
 *
 * The magic-byte check is the important one. A JPEG named .png passes every
 * client-side check, every type system and every test — and then fails an
 * Android release build with "failed to read PNG signature", long after anyone
 * remembers uploading it. Catching it here is the difference between a clear
 * error at upload time and a broken build weeks later.
 *
 * A failed confirm deletes the object, so a rejected upload cannot linger as
 * an orphan or be referenced by a hand-edited document later.
 */
async function confirmUpload({ key }) {
  if (typeof key !== "string" || !key.startsWith("media/")) {
    throw validation("key must be a media key returned by /media/upload-url.");
  }

  let head;
  try {
    head = await s3().send(
      new HeadObjectCommand({ Bucket: config.bucket, Key: config.mediaObjectKey(key) }),
    );
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 404 || error.name === "NotFound") {
      throw new ApiError("MEDIA_NOT_FOUND", "No file was uploaded to that key.");
    }
    throw error;
  }

  const reject = async (error) => {
    await s3()
      .send(new DeleteObjectCommand({ Bucket: config.bucket, Key: config.mediaObjectKey(key) }))
      .catch(() => {
        // Best effort. The object is unreferenced either way; a failed cleanup
        // is a housekeeping problem, not a correctness one.
        console.warn("[media] could not remove a rejected upload", { key });
      });
    throw error;
  };

  const contentType = head.ContentType;
  const allowed = ALLOWED[contentType];
  if (!allowed) {
    return reject(
      new ApiError(
        "UNSUPPORTED_MEDIA_TYPE",
        `${contentType || "That file type"} is not an accepted image type.`,
      ),
    );
  }

  if (head.ContentLength > MAX_BYTES) {
    return reject(
      new ApiError(
        "PAYLOAD_TOO_LARGE",
        `Image exceeds the ${Math.round(MAX_BYTES / 1024 / 1024)}MB limit.`,
      ),
    );
  }

  const longest = Math.max(...allowed.magic.map((m) => m.length));
  const head_ = await readMagicBytes(key, Math.max(longest, 12));
  const matches = allowed.magic.some((signature) => startsWith(head_, signature));

  // WebP is RIFF....WEBP — the four bytes at offset 8 are what distinguish it
  // from any other RIFF container.
  const webpOk =
    contentType !== "image/webp" || head_.slice(8, 12).toString("ascii") === "WEBP";

  if (!matches || !webpOk) {
    return reject(
      new ApiError(
        "UNSUPPORTED_MEDIA_TYPE",
        `This file is not really a ${allowed.ext.toUpperCase()}. Re-export it and upload again.`,
      ),
    );
  }

  return {
    key,
    url: resolveMediaUrl(key),
    contentType,
    bytes: head.ContentLength,
  };
}

/** Permanent. Only ever called for a key nothing references any more. */
async function deleteMedia(key) {
  if (typeof key !== "string" || !key.startsWith("media/")) {
    throw validation("key must be a media key.");
  }
  await s3().send(
    new DeleteObjectCommand({ Bucket: config.bucket, Key: config.mediaObjectKey(key) }),
  );
  return { key, deleted: true };
}

/** Browse a prefix — used by the admin media library and to find orphans. */
async function listMedia({ prefix = "media/", cursor } = {}) {
  if (!String(prefix).startsWith("media/")) {
    throw validation("prefix must start with 'media/'.");
  }
  const response = await s3().send(
    new ListObjectsV2Command({
      Bucket: config.bucket,
      // Listing is the one place the environment is visible to S3 but must
      // not leak back out — the keys are stripped again below.
      Prefix: config.mediaObjectKey(prefix),
      MaxKeys: 100,
      ContinuationToken: cursor || undefined,
    }),
  );
  return {
    items: (response.Contents ?? []).map((object) => ({
      key: config.mediaRelativeKey(object.Key),
      url: resolveMediaUrl(config.mediaRelativeKey(object.Key)),
      bytes: object.Size,
      updatedAt: object.LastModified,
    })),
    nextCursor: response.NextContinuationToken ?? null,
  };
}

module.exports = {
  createUploadUrl,
  confirmUpload,
  deleteMedia,
  listMedia,
  ALLOWED,
  MAX_BYTES,
};
