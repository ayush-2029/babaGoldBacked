"use strict";

const { readDocument } = require("../../repositories/jsonRepository");
const { resolveMediaUrl } = require("../media/mediaService");
const config = require("../../config");
const { ApiError } = require("../../utils/errors");

/**
 * Every transform here is a port of BabaGold/src/services/api/catalogRepository.ts,
 * which the app has been running against bundled JSON. Behaviour must stay
 * identical: when the app flips DATA_SOURCE to 'remote' nothing on screen may
 * change. The app's __tests__/catalogRepository.test.ts is the conformance
 * suite for this file.
 */

const byDisplayOrder = (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0);

/** Guarantees a product never reaches a client with an empty images array. */
function withFallbackImage(product) {
  if (product.images && product.images.length > 0) {
    return product;
  }
  return {
    ...product,
    images: [
      {
        id: "fallback",
        url: config.fallbackProductImageKey,
        alt: product.name,
        isPrimary: true,
        displayOrder: 1,
      },
    ],
  };
}

/**
 * Products are stored nested inside their category and carry no categoryId of
 * their own — the nesting implies it. It is re-injected here, because a client
 * holding a product out of context still needs to know where it lives.
 */
function normalizeProduct(product, categoryId) {
  const images = [...(product.images ?? [])]
    .sort(byDisplayOrder)
    .map((image) => ({ ...image, url: resolveMediaUrl(image.url) }));

  return withFallbackImage({ ...product, categoryId, images });
}

function normalizeCategory(category) {
  return { ...category, imageUrl: resolveMediaUrl(category.imageUrl) };
}

async function loadActiveCategories(options) {
  const { data, etag } = await readDocument("catalog", options);
  const categories = (data.categories ?? [])
    .filter((c) => c.active)
    .sort(byDisplayOrder);
  return { categories, etag, schemaVersion: data.schemaVersion };
}

/** GET /api/v1/categories — nested products stripped, active count retained. */
async function getCategories() {
  const { categories, etag } = await loadActiveCategories();
  const data = categories.map(({ products, ...category }) => ({
    ...normalizeCategory(category),
    productCount: (products ?? []).filter((p) => p.active).length,
  }));
  return { data, etag };
}

/** GET /api/v1/categories/:categoryId */
async function getCategory(categoryId) {
  const { categories, etag } = await loadActiveCategories();
  const match = categories.find((c) => c.id === categoryId);
  if (!match) {
    throw new ApiError("CATEGORY_NOT_FOUND", "Category not found.");
  }
  const { products, ...category } = match;
  return {
    data: {
      ...normalizeCategory(category),
      productCount: (products ?? []).filter((p) => p.active).length,
    },
    etag,
  };
}

/** GET /api/v1/categories/:categoryId/products */
async function getCategoryProducts(categoryId) {
  const { categories, etag } = await loadActiveCategories();
  const match = categories.find((c) => c.id === categoryId);
  if (!match) {
    throw new ApiError("CATEGORY_NOT_FOUND", "Category not found.");
  }

  const { products, ...category } = match;
  const active = (products ?? [])
    .filter((p) => p.active)
    .sort(byDisplayOrder)
    .map((p) => normalizeProduct(p, match.id));

  return {
    data: {
      category: { ...normalizeCategory(category), productCount: active.length },
      products: active,
    },
    etag,
  };
}

/** GET /api/v1/products/:productId — flat scan across every category. */
async function getProduct(productId) {
  const { categories, etag } = await loadActiveCategories();
  for (const category of categories) {
    const found = (category.products ?? []).find(
      (p) => p.id === productId && p.active,
    );
    if (found) {
      return { data: normalizeProduct(found, category.id), etag };
    }
  }
  throw new ApiError("PRODUCT_NOT_FOUND", "Product not found.");
}

/** Flattens every active product once, for filtering. */
async function allActiveProducts() {
  const { categories, etag } = await loadActiveCategories();
  const products = [];
  for (const category of categories) {
    for (const product of category.products ?? []) {
      if (product.active) {
        products.push({
          product: normalizeProduct(product, category.id),
          categoryName: category.name,
        });
      }
    }
  }
  return { products, etag };
}

/**
 * Text match across name, descriptions, metal, category name and tags.
 *
 * EVERY term must match, so extra words narrow the result rather than widening
 * it. That is deliberate and mirrors the app's behaviour exactly — a customer
 * typing "22k gold band" expects fewer results than "gold", not more.
 */
function matchesQuery({ product, categoryName }, terms) {
  const haystack = [
    product.name,
    product.shortDescription,
    product.description,
    product.metal?.purity,
    product.metal?.type,
    categoryName,
    ...(product.tags ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return terms.every((term) => haystack.includes(term));
}

const SORTS = {
  displayOrder: (a, b) => byDisplayOrder(a, b),
  priceAsc: (a, b) => (a.price?.amount ?? 0) - (b.price?.amount ?? 0),
  priceDesc: (a, b) => (b.price?.amount ?? 0) - (a.price?.amount ?? 0),
  newest: (a, b) => String(b.id).localeCompare(String(a.id)),
};

/**
 * GET /api/v1/products — the collection endpoint behind both search and the
 * tag-driven home rails.
 *
 * @param {{ q?: string, tags?: string[], categoryId?: string,
 *           sort?: string, limit?: number, cursor?: string }} query
 */
async function listProducts(query = {}) {
  const { products, etag } = await allActiveProducts();

  let entries = products;

  if (query.categoryId) {
    entries = entries.filter((e) => e.product.categoryId === query.categoryId);
  }

  if (query.tags && query.tags.length > 0) {
    entries = entries.filter((e) =>
      query.tags.every((tag) => (e.product.tags ?? []).includes(tag)),
    );
  }

  if (query.q) {
    const terms = query.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    entries = terms.length > 0 ? entries.filter((e) => matchesQuery(e, terms)) : [];
  }

  const items = entries.map((e) => e.product);
  items.sort(SORTS[query.sort] ?? SORTS.displayOrder);

  const total = items.length;
  const limit = Math.min(
    Math.max(Number(query.limit) || config.pagination.defaultLimit, 1),
    config.pagination.maxLimit,
  );
  const offset = Math.max(Number(query.cursor) || 0, 0);
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;

  return {
    data: {
      items: page,
      page: {
        total,
        limit,
        cursor: offset > 0 ? String(offset) : null,
        nextCursor: nextOffset < total ? String(nextOffset) : null,
      },
    },
    etag,
  };
}

module.exports = {
  getCategories,
  getCategory,
  getCategoryProducts,
  getProduct,
  listProducts,
  // exported for the admin service and for tests
  withFallbackImage,
  normalizeProduct,
  byDisplayOrder,
};
