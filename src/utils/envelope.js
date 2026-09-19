"use strict";

const config = require("../config");

/**
 * The response envelope, mandatory in both directions (claude.md §12).
 *
 * Controllers call these rather than res.json directly, so no route can
 * accidentally return a bare object and break the contract the app's
 * ApiResponse<T> type depends on.
 */

/**
 * @param {import('express').Response} res
 * @param {unknown} data
 * @param {{ status?: number, etag?: string, cache?: boolean }} [options]
 */
function ok(res, data, options = {}) {
  const { status = 200, etag, cache = false, maxAge } = options;

  if (etag) {
    res.set("ETag", etag);
  }

  if (cache) {
    res.set("Cache-Control", cacheControl(maxAge));
  } else {
    res.set("Cache-Control", "no-store");
  }

  return res.status(status).json({ success: true, data });
}

/**
 * ALWAYS REVALIDATE, by default.
 *
 * This used to send `max-age=60, stale-while-revalidate=300`, written for a
 * CDN that does not exist yet. The mobile app's HTTP cache honoured it — and
 * that cache PERSISTS TO DISK, so a shopkeeper's edit could stay invisible for
 * a minute or more and restarting the app did not help, because the stored
 * response outlived the process. That was the reported "I have to close and
 * reopen it several times before I see the change".
 *
 * `no-cache` does not mean "do not store"; it means "revalidate before using".
 * Paired with the ETag an unchanged document costs a 304 with an empty body,
 * so freshness is nearly free. Reinstate a real max-age only once something
 * shared sits in front and the staleness is worth the saving.
 *
 * `maxAge` may still be passed to shorten the window further — responses
 * carrying presigned media pass the time left in the signing window, so a
 * cached copy can never outlive the image URLs inside it.
 */
function cacheControl(maxAge) {
  const age =
    typeof maxAge === "number"
      ? Math.max(0, Math.min(maxAge, config.cache.maxAge))
      : config.cache.maxAge;

  return age > 0
    ? `public, max-age=${age}, must-revalidate`
    : "public, no-cache, must-revalidate";
}

/**
 * Sends 304 and ends the response when the client's If-None-Match matches.
 * Returns true if it did, so the caller can stop.
 */
function notModified(req, res, etag, maxAge) {
  if (!etag) {
    return false;
  }
  const ifNoneMatch = req.get("If-None-Match");
  if (ifNoneMatch && ifNoneMatch === etag) {
    res.set("ETag", etag);
    res.set("Cache-Control", cacheControl(maxAge));
    res.status(304).end();
    return true;
  }
  return false;
}

/**
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {object} [details]
 */
function fail(res, status, code, message, details) {
  const error = { code, message };
  if (details && Object.keys(details).length > 0) {
    Object.assign(error, details);
  }
  return res.status(status).json({ success: false, error });
}

module.exports = { ok, fail, notModified };
