"use strict";

const { S3Client } = require("@aws-sdk/client-s3");
const config = require("../../config");

/**
 * The only S3 client in the service, created once per Lambda container so the
 * connection pool survives between invocations.
 *
 * No credentials are configured here on purpose: Lambda supplies them through
 * its execution role. Never add AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
 */
let client;

function s3() {
  if (!client) {
    client = new S3Client({
      region: config.region,

      /**
       * Do not add a checksum unless the operation actually requires one.
       *
       * The SDK's default ("WHEN_SUPPORTED") computes a CRC32 and signs it
       * into the request. For a PRESIGNED PUT that is computed at signing
       * time, when there is no body — so the URL carries the checksum of an
       * empty payload. The browser then uploads real bytes, S3 computes a
       * different CRC32, and rejects the upload. The failure looks like a CORS
       * error in the browser, because the rejection has no CORS headers on it.
       *
       * WHEN_REQUIRED keeps checksums for the operations that mandate them and
       * leaves presigned PUTs alone.
       */
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return client;
}

module.exports = { s3 };
