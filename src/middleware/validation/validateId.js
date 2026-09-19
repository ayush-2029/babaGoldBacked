"use strict";

const { validation } = require("../../utils/errors");

/**
 * IDs are stable, lowercase, hyphenated slugs ("rings", "ring-001") — never
 * display names. Validating the shape at the edge keeps anything that could be
 * read as a path traversal or an S3 key fragment out of the service layer.
 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;

const validateId = (param) => (req, res, next) => {
  const value = req.params[param];
  if (!ID_PATTERN.test(value ?? "")) {
    return next(
      validation(
        `${param} must be a lowercase slug of up to 60 characters.`,
        { field: param },
      ),
    );
  }
  return next();
};

module.exports = { validateId, ID_PATTERN };
