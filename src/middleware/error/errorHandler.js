"use strict";

const { ApiError, CODES } = require("../../utils/errors");
const { fail } = require("../../utils/envelope");
const config = require("../../config");

/**
 * The single exit for every failure. Two rules it exists to enforce
 * (claude.md §12, §31): the envelope is never broken, and a stack trace or a
 * raw AWS error never reaches a client.
 */

// eslint-disable-next-line no-unused-vars -- Express identifies this by arity
function errorHandler(error, req, res, next) {
  if (error instanceof ApiError) {
    if (error.status >= 500) {
      console.error("[error]", {
        code: error.code,
        message: error.message,
        path: req.originalUrl,
      });
    }
    return fail(res, error.status, error.code, error.message, error.details);
  }

  if (error?.type === "entity.parse.failed") {
    return fail(
      res,
      400,
      "VALIDATION_FAILED",
      "Request body is not valid JSON.",
    );
  }

  if (error?.type === "entity.too.large") {
    return fail(res, 413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
  }

  // Anything unrecognised: log everything, tell the client nothing.
  console.error("[error] unhandled", {
    name: error?.name,
    message: error?.message,
    stack: config.isProduction ? undefined : error?.stack,
    path: req.originalUrl,
  });

  return fail(
    res,
    CODES.INTERNAL_ERROR,
    "INTERNAL_ERROR",
    "Something went wrong. Please try again.",
  );
}

/** Wraps an async controller so a rejected promise reaches the handler above. */
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function notFoundHandler(req, res) {
  return fail(res, 404, "NOT_FOUND", "Endpoint not found.");
}

module.exports = { errorHandler, notFoundHandler, asyncRoute };
