"use strict";

const { validation } = require("../utils/errors");
const { ID_PATTERN } = require("../middleware/validation/validateId");

/**
 * Write-side validation (claude.md §21). Everything an admin sends is checked
 * here before it can reach a document — the panel's own validation is a
 * convenience, never a guarantee.
 *
 * Each validator collects every problem rather than stopping at the first, so
 * a form can show all its errors at once instead of one per save.
 */

const isString = (v) => typeof v === "string" && v.trim().length > 0;
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
const isBool = (v) => typeof v === "boolean";

function assertNoProblems(problems, message) {
  if (problems.length > 0) {
    throw validation(message, { fields: problems });
  }
}

/** Shared by create and update. `partial` skips required-field checks. */
function checkCategory(input, { partial = false } = {}) {
  const problems = [];
  const has = (key) => input[key] !== undefined;

  if (!partial || has("id")) {
    if (!ID_PATTERN.test(input.id ?? "")) {
      problems.push("id must be a lowercase slug, e.g. 'rings'");
    }
  }
  if (!partial || has("name")) {
    if (!isString(input.name)) {
      problems.push("name is required");
    }
  }
  if (has("displayOrder") && !isNumber(input.displayOrder)) {
    problems.push("displayOrder must be a number");
  }
  if (has("active") && !isBool(input.active)) {
    problems.push("active must be true or false");
  }
  if (has("imageUrl") && input.imageUrl !== null && !isString(input.imageUrl)) {
    problems.push("imageUrl must be a string");
  }

  return problems;
}

function validateCategory(input, options) {
  assertNoProblems(checkCategory(input, options), "Category is not valid.");
  return input;
}

function checkImages(images) {
  const problems = [];
  if (!Array.isArray(images)) {
    return ["images must be an array"];
  }
  images.forEach((image, i) => {
    if (!isString(image?.id)) {
      problems.push(`images[${i}].id is required`);
    }
    if (!isString(image?.url)) {
      problems.push(`images[${i}].url is required`);
    }
    if (image?.isPrimary !== undefined && !isBool(image.isPrimary)) {
      problems.push(`images[${i}].isPrimary must be true or false`);
    }
  });

  // Exactly one primary is an invariant the API enforces rather than hopes for.
  const primaries = images.filter((i) => i?.isPrimary).length;
  if (images.length > 0 && primaries > 1) {
    problems.push("only one image may be marked isPrimary");
  }
  return problems;
}

function checkProduct(input, { partial = false } = {}) {
  const problems = [];
  const has = (key) => input[key] !== undefined;

  if (!partial || has("id")) {
    if (!ID_PATTERN.test(input.id ?? "")) {
      problems.push("id must be a lowercase slug, e.g. 'ring-001'");
    }
  }
  if (!partial || has("name")) {
    if (!isString(input.name)) {
      problems.push("name is required");
    }
  }

  if (!partial || has("price")) {
    const price = input.price;
    if (!price || typeof price !== "object") {
      problems.push("price is required");
    } else {
      const onRequest = price.priceOnRequest === true;
      if (!onRequest) {
        if (!isNumber(price.amount) || price.amount < 0) {
          problems.push(
            "price.amount must be zero or more, or set price.priceOnRequest",
          );
        }
      }
      if (!isString(price.currency) || price.currency.length !== 3) {
        problems.push("price.currency must be a 3-letter code, e.g. INR");
      }
      if (
        price.mrp !== undefined &&
        price.mrp !== null &&
        (!isNumber(price.mrp) || price.mrp < 0)
      ) {
        problems.push("price.mrp must be zero or more");
      }
      if (
        isNumber(price.amount) &&
        isNumber(price.mrp) &&
        price.mrp > 0 &&
        price.mrp < price.amount
      ) {
        // A "discount" that raises the price reads as a bug to a customer.
        problems.push("price.mrp cannot be lower than price.amount");
      }
    }
  }

  if (has("images")) {
    problems.push(...checkImages(input.images));
  }
  if (has("displayOrder") && !isNumber(input.displayOrder)) {
    problems.push("displayOrder must be a number");
  }
  if (has("active") && !isBool(input.active)) {
    problems.push("active must be true or false");
  }
  if (has("available") && !isBool(input.available)) {
    problems.push("available must be true or false");
  }
  if (has("tags") && !Array.isArray(input.tags)) {
    problems.push("tags must be an array of strings");
  }
  if (has("sizes") && !Array.isArray(input.sizes)) {
    problems.push("sizes must be an array");
  }

  // Storage nests products inside their category, so a product carrying its
  // own categoryId would be a second source of truth that can disagree.
  if (has("categoryId")) {
    problems.push(
      "categoryId is not stored on a product — move it with PATCH /products/:id/category",
    );
  }

  return problems;
}

function validateProduct(input, options) {
  assertNoProblems(checkProduct(input, options), "Product is not valid.");
  return input;
}

function validateImages(images) {
  assertNoProblems(checkImages(images), "Images are not valid.");
  return images;
}

/** Bulk reorder payloads: { ids: [...] }. */
function validateOrder(input) {
  const problems = [];
  if (!Array.isArray(input?.ids)) {
    problems.push("ids must be an array of identifiers");
  } else {
    if (input.ids.some((id) => !ID_PATTERN.test(id ?? ""))) {
      problems.push("every id must be a lowercase slug");
    }
    if (new Set(input.ids).size !== input.ids.length) {
      problems.push("ids must not contain duplicates");
    }
  }
  assertNoProblems(problems, "Order is not valid.");
  return input.ids;
}

module.exports = {
  validateCategory,
  validateProduct,
  validateImages,
  validateOrder,
  checkCategory,
  checkProduct,
};
