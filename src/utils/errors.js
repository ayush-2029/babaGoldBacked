"use strict";

/**
 * The closed set of error codes from API_CONTRACT.md §1.
 *
 * Clients branch on `code`, never on `message` — so a message may be reworded
 * freely, but a code is part of the contract and changing one is a breaking
 * change across three repos.
 */
const CODES = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CATEGORY_NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  SERVICE_NOT_FOUND: 404,
  MEDIA_NOT_FOUND: 404,
  NOT_FOUND: 404,
  DUPLICATE_ID: 409,
  CONFLICT_STALE_DATA: 409,
  CATEGORY_NOT_EMPTY: 409,
  RESOURCE_IN_USE: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

class ApiError extends Error {
  /**
   * @param {keyof CODES} code
   * @param {string} message  Safe to show a client. Never interpolate an AWS
   *                          error or a stack trace into this.
   * @param {object} [details] Extra fields merged into the error object —
   *                          used by CONFLICT_STALE_DATA to return the
   *                          current version.
   */
  constructor(code, message, details) {
    super(message);
    this.name = "ApiError";
    this.code = CODES[code] ? code : "INTERNAL_ERROR";
    this.status = CODES[this.code];
    this.details = details;
  }
}

const notFound = (code, message) => new ApiError(code, message);
const validation = (message, details) =>
  new ApiError("VALIDATION_FAILED", message, details);
const conflict = (code, message, details) =>
  new ApiError(code, message, details);

module.exports = { ApiError, CODES, notFound, validation, conflict };
