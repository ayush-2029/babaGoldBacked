"use strict";

const {
  GetObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const { s3 } = require("./s3Client");
const config = require("../../config");
const { ApiError } = require("../../utils/errors");

/**
 * Reads and writes the JSON documents in S3. This is the ONLY module in the
 * service that knows the bucket exists.
 *
 * Every read returns the object's ETag alongside the data, and every write
 * requires one back. That pair is the whole concurrency strategy — see
 * API_CONTRACT.md §4.
 */

/** @returns {Promise<{ data: object, etag: string }>} */
async function read(key) {
  try {
    const response = await s3().send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    );
    const body = await response.Body.transformToString("utf-8");
    return { data: JSON.parse(body), etag: response.ETag };
  } catch (error) {
    if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) {
      throw new ApiError("NOT_FOUND", "The requested data is not available.");
    }
    if (error instanceof SyntaxError) {
      // Malformed JSON in the bucket is an operator problem, not a client one.
      throw new ApiError("INTERNAL_ERROR", "Stored data is unreadable.");
    }
    throw error;
  }
}

/**
 * Conditional write. `ifMatch` is the ETag the caller last read; S3 rejects the
 * PUT if the object changed underneath, which is what turns a lost update into
 * a 409 the admin panel can recover from.
 *
 * Passing no ifMatch is permitted only for creating a document that does not
 * exist yet. Never call it that way to "get past" a conflict.
 *
 * @returns {Promise<{ etag: string }>}
 */
async function write(key, data, ifMatch) {
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: JSON.stringify(data, null, 2),
    ContentType: "application/json",
    CacheControl: "no-cache",
  });

  if (ifMatch) {
    command.input.IfMatch = ifMatch;
  } else {
    // Create-only: fails if anything is already at this key.
    command.input.IfNoneMatch = "*";
  }

  try {
    const response = await s3().send(command);
    return { etag: response.ETag };
  } catch (error) {
    const status = error.$metadata?.httpStatusCode;
    if (error.name === "PreconditionFailed" || status === 412) {
      throw new ApiError(
        "CONFLICT_STALE_DATA",
        "This data was changed by someone else. Reload and reapply your edit.",
      );
    }
    if (status === 409) {
      // IfNoneMatch rejected: the object exists, so this was not a create.
      throw new ApiError(
        "CONFLICT_STALE_DATA",
        "This data already exists. Reload before editing.",
      );
    }
    throw error;
  }
}

module.exports = { read, write };
