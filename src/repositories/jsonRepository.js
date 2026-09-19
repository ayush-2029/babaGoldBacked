"use strict";

const config = require("../config");

/**
 * The storage seam (claude.md §41). Services call this; they never import a
 * driver, an AWS SDK client, or a filesystem module.
 *
 * Swapping S3 for DynamoDB later means writing a third driver here and
 * changing nothing above this line.
 */
const driver =
  process.env.STORAGE_DRIVER === "local"
    ? require("./local/localJsonStore")
    : require("./s3/s3JsonStore");

/**
 * Per-container memoisation. A warm Lambda serving a burst of requests should
 * not re-read catalog.json for each one.
 *
 * Deliberately short: the manual-upload phase means data can change without
 * the service being redeployed, and a stale catalogue for a minute is the
 * price of not hammering S3. Admin writes clear the entry outright.
 */
const cache = new Map();
/*
 * Short on purpose. Its job is to stop a warm container re-reading S3 for
 * every request in a burst, NOT to serve stale data. At 30s a write made in
 * one container stayed invisible to the others for half a minute, which the
 * shopkeeper experienced as "the app has not updated yet".
 */
const TTL_MS = Number(process.env.READ_CACHE_TTL_MS || 3000);

/**
 * @param {string} name  A key of config.keys — 'catalog', 'company', …
 * @param {{ fresh?: boolean }} [options] fresh:true bypasses the cache; admin
 *        reads use it, because an edit must never be based on a stale copy.
 * @returns {Promise<{ data: object, etag: string }>}
 */
async function readDocument(name, options = {}) {
  const key = config.dataKey(name);

  if (!options.fresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      return { data: hit.data, etag: hit.etag };
    }
  }

  const result = await driver.read(key);
  cache.set(key, { ...result, at: Date.now() });
  return result;
}

/**
 * @param {string} name
 * @param {object} data
 * @param {string} ifMatch  The ETag the caller last read. Required for updates.
 */
async function writeDocument(name, data, ifMatch) {
  const key = config.dataKey(name);
  const result = await driver.write(key, data, ifMatch);
  // Never serve the pre-write copy after a successful write.
  cache.set(key, { data, etag: result.etag, at: Date.now() });
  return result;
}

/** Test seam, and a safety valve if a document is edited out of band. */
function clearCache() {
  cache.clear();
}

module.exports = { readDocument, writeDocument, clearCache };
