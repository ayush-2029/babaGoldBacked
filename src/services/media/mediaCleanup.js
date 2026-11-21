"use strict";

const { DeleteObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const config = require("../../config");
const { readDocument } = require("../../repositories/jsonRepository");

/**
 * Removes a deleted record's own media folder from S3.
 *
 * Runs AFTER the catalogue write has succeeded, never before. The other order
 * would leave a record pointing at images that no longer exist whenever the
 * write was refused (a stale If-Match, a validation failure). This way the
 * worst case is an orphaned file — a housekeeping problem, not a broken app.
 *
 * Two safety rules, both because a delete here cannot be undone:
 *   1. Only the record's own folder (media/products/{id}/ and similar) is ever
 *      touched. Never anything a document merely references.
 *   2. Any file in that folder that some document STILL references is kept —
 *      a banner or another product that reuses a photo must not go blank.
 */

/** Folders that must never be emptied, whatever id is passed. */
const PROTECTED_PREFIXES = () => {
  const fallback = config.fallbackProductImageKey;
  const folder = fallback.slice(0, fallback.lastIndexOf("/") + 1);
  return [folder];
};

const FOLDERS = {
  product: (id) => `media/products/${id}/`,
  category: (id) => `media/categories/${id}/`,
};

const ID = /^[a-z0-9][a-z0-9-]{0,59}$/;

/** Lazy, so the local filesystem driver never constructs an S3 client. */
function s3() {
  return require("../../repositories/s3/s3Client").s3();
}

/**
 * Every media key in `keys` that appears anywhere in any data document.
 * Plain substring search: references are stored as relative keys inside
 * arbitrary nested fields, so walking a schema would miss new fields later.
 */
async function stillReferenced(keys) {
  if (keys.length === 0) return new Set();
  const texts = [];
  for (const name of Object.keys(config.keys)) {
    try {
      const { data } = await readDocument(name, { fresh: true });
      texts.push(JSON.stringify(data));
    } catch {
      // A missing document (notice.json is optional) references nothing.
    }
  }
  const haystack = texts.join("\n");
  return new Set(keys.filter((key) => haystack.includes(key)));
}

/** Pure decision, separated so it can be tested without S3. */
function selectDeletable(keys, referenced) {
  return keys.filter((key) => !referenced.has(key));
}

async function listFolder(relativePrefix) {
  const keys = [];
  let cursor;
  do {
    const response = await s3().send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: config.mediaObjectKey(relativePrefix),
        ContinuationToken: cursor,
      }),
    );
    for (const object of response.Contents ?? []) {
      keys.push(config.mediaRelativeKey(object.Key));
    }
    cursor = response.NextContinuationToken;
  } while (cursor);
  return keys;
}

/**
 * @param {'product'|'category'} kind
 * @param {string} id
 * @returns {Promise<{ deleted: number, kept: number, skipped?: string }>}
 *          Never throws: the record is already gone, so a cleanup failure is
 *          logged and reported rather than turned into a failed request.
 */
async function deleteOwnMedia(kind, id) {
  // The local driver has no media store at all.
  if (process.env.STORAGE_DRIVER === "local") {
    return { deleted: 0, kept: 0, skipped: "local storage" };
  }

  const build = FOLDERS[kind];
  if (!build || !ID.test(id ?? "")) {
    return { deleted: 0, kept: 0, skipped: "invalid id" };
  }
  const folder = build(id);
  if (PROTECTED_PREFIXES().includes(folder)) {
    return { deleted: 0, kept: 0, skipped: "protected folder" };
  }

  try {
    const keys = await listFolder(folder);
    const referenced = await stillReferenced(keys);
    const deletable = selectDeletable(keys, referenced);

    let deleted = 0;
    for (const key of deletable) {
      try {
        await s3().send(
          new DeleteObjectCommand({ Bucket: config.bucket, Key: config.mediaObjectKey(key) }),
        );
        deleted += 1;
      } catch (error) {
        console.warn("[media] could not delete", { key, error: error.name });
      }
    }
    return { deleted, kept: keys.length - deleted };
  } catch (error) {
    console.warn("[media] cleanup failed", { kind, id, error: error.name });
    return { deleted: 0, kept: 0, skipped: "cleanup failed" };
  }
}

module.exports = { deleteOwnMedia, selectDeletable, FOLDERS, PROTECTED_PREFIXES };
