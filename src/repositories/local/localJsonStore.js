"use strict";

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { ApiError } = require("../../utils/errors");

/**
 * Filesystem driver with the same interface as the S3 one.
 *
 * It exists so the entire API can be run and tested against the hand-authored
 * JSON in D:\Jewl App\data\ before a single object is uploaded, and so the
 * test suite needs no AWS credentials. It is NOT a production path — the
 * service selects a driver by STORAGE_DRIVER and defaults to s3.
 *
 * The ETag is the md5 of the file contents, which is exactly what S3 computes
 * for a single-part upload, so conditional-write behaviour matches.
 */

const root = () =>
  process.env.LOCAL_DATA_DIR || path.resolve(__dirname, "../../../../../data");

const etagOf = (text) =>
  `"${crypto.createHash("md5").update(text).digest("hex")}"`;

/** Strips the configured data prefix — local files are flat in one folder. */
const fileFor = (key) => path.join(root(), path.basename(key));

async function read(key) {
  let text;
  try {
    text = await fs.readFile(fileFor(key), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ApiError("NOT_FOUND", "The requested data is not available.");
    }
    throw error;
  }

  try {
    return { data: JSON.parse(text), etag: etagOf(text) };
  } catch {
    throw new ApiError("INTERNAL_ERROR", "Stored data is unreadable.");
  }
}

async function write(key, data, ifMatch) {
  const file = fileFor(key);

  if (ifMatch) {
    const current = await read(key);
    if (current.etag !== ifMatch) {
      throw new ApiError(
        "CONFLICT_STALE_DATA",
        "This data was changed by someone else. Reload and reapply your edit.",
      );
    }
  }

  const text = JSON.stringify(data, null, 2);
  await fs.writeFile(file, text, "utf-8");
  return { etag: etagOf(text) };
}

module.exports = { read, write };
