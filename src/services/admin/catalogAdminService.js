"use strict";

const {
  readDocument,
  writeDocument,
} = require("../../repositories/jsonRepository");
const { ApiError } = require("../../utils/errors");
const { normalizeStoredMedia } = require("../media/mediaService");
const {
  validateCategory,
  validateProduct,
  validateImages,
  validateOrder,
} = require("../../schemas/catalogSchemas");

/**
 * Admin writes against catalog.json.
 *
 * Everything here goes through mutate(), which is the only place the document
 * is written. Categories and products share one file, so every edit rewrites
 * the whole thing — which is exactly why the If-Match version is mandatory and
 * not a nicety. See API_CONTRACT.md §4.
 */

/** Admin reads are always fresh: an edit must never start from a cached copy. */
const loadCatalog = () => readDocument("catalog", { fresh: true });

/**
 * Read → apply → write, under the caller's version.
 *
 * @param {string} ifMatch  The version the admin loaded.
 * @param {(catalog: object) => unknown} apply  Mutates the catalog in place and
 *        returns whatever the caller should receive back.
 */
async function mutate(ifMatch, apply) {
  const { data: catalog } = await loadCatalog();
  const result = apply(catalog);

  // Last line of defence: whatever a client sent, what gets STORED is always a
  // relative key. A presigned URL saved into the catalogue expires within the
  // hour and the image silently disappears.
  catalog.categories = normalizeStoredMedia(catalog.categories ?? []);

  // Stamped on every successful write — this is what makes updatedAt mean
  // something rather than decorate something.
  catalog.updatedAt = new Date().toISOString();

  const { etag } = await writeDocument("catalog", catalog, ifMatch);
  return { data: result, version: etag };
}

const findCategory = (catalog, categoryId) => {
  const category = (catalog.categories ??= []).find((c) => c.id === categoryId);
  if (!category) {
    throw new ApiError("CATEGORY_NOT_FOUND", "Category not found.");
  }
  return category;
};

/** Products are globally unique, so this locates one without its category. */
function findProduct(catalog, productId) {
  for (const category of catalog.categories ?? []) {
    const index = (category.products ?? []).findIndex((p) => p.id === productId);
    if (index !== -1) {
      return { category, product: category.products[index], index };
    }
  }
  throw new ApiError("PRODUCT_NOT_FOUND", "Product not found.");
}

const nextOrder = (items) =>
  items.reduce((max, i) => Math.max(max, i.displayOrder ?? 0), 0) + 1;

// ---------------------------------------------------------------- categories

/** Includes inactive records — the admin needs to see what customers cannot. */
async function listCategories({ includeProducts = false } = {}) {
  const { data, etag } = await loadCatalog();
  const categories = (data.categories ?? []).map((category) => {
    const { products, ...rest } = category;
    return includeProducts
      ? { ...rest, products: products ?? [] }
      : { ...rest, productCount: (products ?? []).length };
  });
  return { data: categories, version: etag };
}

async function getCategory(categoryId) {
  const { data, etag } = await loadCatalog();
  const { products, ...category } = findCategory(data, categoryId);
  return {
    data: { ...category, productCount: (products ?? []).length },
    version: etag,
  };
}

async function createCategory(input, ifMatch) {
  validateCategory(input);
  return mutate(ifMatch, (catalog) => {
    catalog.categories ??= [];
    if (catalog.categories.some((c) => c.id === input.id)) {
      throw new ApiError("DUPLICATE_ID", `Category '${input.id}' already exists.`);
    }
    const category = {
      description: "",
      imageUrl: null,
      active: true,
      displayOrder: nextOrder(catalog.categories),
      ...input,
      products: [],
    };
    catalog.categories.push(category);
    const { products, ...rest } = category;
    return rest;
  });
}

/** `partial` is what separates PUT (replace) from PATCH (merge). */
async function updateCategory(categoryId, input, ifMatch, { partial }) {
  validateCategory({ ...input, id: categoryId }, { partial });
  return mutate(ifMatch, (catalog) => {
    const category = findCategory(catalog, categoryId);
    const { products } = category;
    const { id, products: _ignored, ...fields } = input;

    if (partial) {
      Object.assign(category, fields);
    } else {
      // Replace, but never let a full PUT drop the nested products.
      for (const key of Object.keys(category)) {
        if (key !== "id" && key !== "products") {
          delete category[key];
        }
      }
      Object.assign(category, fields, { products });
    }

    const { products: _p, ...rest } = category;
    return rest;
  });
}

/**
 * Soft delete by default (`active: false`) — the project prefers it, because a
 * deactivated category can be restored and a deleted one takes its products
 * with it. A hard delete is refused while it still holds products.
 */
async function deleteCategory(categoryId, ifMatch, { hard = false } = {}) {
  return mutate(ifMatch, (catalog) => {
    const category = findCategory(catalog, categoryId);
    if (!hard) {
      category.active = false;
      return { id: categoryId, active: false, deleted: false };
    }
    if ((category.products ?? []).length > 0) {
      throw new ApiError(
        "CATEGORY_NOT_EMPTY",
        "Move or delete this category's products before deleting it.",
      );
    }
    catalog.categories = catalog.categories.filter((c) => c.id !== categoryId);
    return { id: categoryId, deleted: true };
  });
}

/** One write for a whole drag-and-drop reorder, instead of one per row. */
async function reorderCategories(input, ifMatch) {
  const ids = validateOrder(input);
  return mutate(ifMatch, (catalog) => {
    const known = new Set((catalog.categories ?? []).map((c) => c.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new ApiError(
        "CATEGORY_NOT_FOUND",
        `Unknown categories: ${unknown.join(", ")}`,
      );
    }
    ids.forEach((id, index) => {
      findCategory(catalog, id).displayOrder = index + 1;
    });
    return { ids };
  });
}

// ------------------------------------------------------------------ products

async function listProducts({ categoryId, q, active } = {}) {
  const { data, etag } = await loadCatalog();
  let products = [];
  for (const category of data.categories ?? []) {
    if (categoryId && category.id !== categoryId) {
      continue;
    }
    for (const product of category.products ?? []) {
      products.push({ ...product, categoryId: category.id });
    }
  }

  if (active !== undefined) {
    products = products.filter((p) => p.active === active);
  }
  if (q) {
    const needle = String(q).toLowerCase();
    products = products.filter((p) =>
      [p.name, p.sku, p.id].filter(Boolean).join(" ").toLowerCase().includes(needle),
    );
  }

  return { data: products, version: etag };
}

async function getProduct(productId) {
  const { data, etag } = await loadCatalog();
  const { category, product } = findProduct(data, productId);
  return { data: { ...product, categoryId: category.id }, version: etag };
}

async function createProduct(input, ifMatch) {
  const { categoryId, ...product } = input;
  if (!categoryId) {
    throw new ApiError("VALIDATION_FAILED", "categoryId is required.");
  }
  validateProduct(product);

  return mutate(ifMatch, (catalog) => {
    const category = findCategory(catalog, categoryId);
    for (const other of catalog.categories ?? []) {
      if ((other.products ?? []).some((p) => p.id === product.id)) {
        throw new ApiError(
          "DUPLICATE_ID",
          `Product '${product.id}' already exists in '${other.id}'.`,
        );
      }
    }

    category.products ??= [];
    const created = {
      active: true,
      available: true,
      images: [],
      tags: [],
      displayOrder: nextOrder(category.products),
      ...product,
    };
    category.products.push(created);
    return { ...created, categoryId };
  });
}

async function updateProduct(productId, input, ifMatch, { partial }) {
  validateProduct(input, { partial });
  return mutate(ifMatch, (catalog) => {
    const { category, product, index } = findProduct(catalog, productId);

    if (partial) {
      Object.assign(product, input);
      return { ...product, categoryId: category.id };
    }

    const replaced = { ...input, id: productId };
    category.products[index] = replaced;
    return { ...replaced, categoryId: category.id };
  });
}

async function deleteProduct(productId, ifMatch, { hard = false } = {}) {
  return mutate(ifMatch, (catalog) => {
    const { category, product, index } = findProduct(catalog, productId);
    if (!hard) {
      product.active = false;
      return { id: productId, active: false, deleted: false };
    }
    category.products.splice(index, 1);
    // The caller is responsible for media/products/{id}/ — see mediaService.
    return { id: productId, deleted: true };
  });
}

async function reorderProducts(categoryId, input, ifMatch) {
  const ids = validateOrder(input);
  return mutate(ifMatch, (catalog) => {
    const category = findCategory(catalog, categoryId);
    const known = new Set((category.products ?? []).map((p) => p.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new ApiError(
        "PRODUCT_NOT_FOUND",
        `Not in '${categoryId}': ${unknown.join(", ")}`,
      );
    }
    const byId = new Map(category.products.map((p) => [p.id, p]));
    ids.forEach((id, index) => {
      byId.get(id).displayOrder = index + 1;
    });
    return { categoryId, ids };
  });
}

/**
 * Moves a product to another category.
 *
 * Note what is NOT here: any image work. Media lives at
 * media/products/{productId}/ with no category segment precisely so this
 * operation is a pure JSON move and every image URL stays valid.
 */
async function moveProduct(productId, targetCategoryId, ifMatch) {
  return mutate(ifMatch, (catalog) => {
    const target = findCategory(catalog, targetCategoryId);
    const { category, product, index } = findProduct(catalog, productId);

    if (category.id === targetCategoryId) {
      return { id: productId, categoryId: targetCategoryId, moved: false };
    }

    category.products.splice(index, 1);
    target.products ??= [];
    product.displayOrder = nextOrder(target.products);
    target.products.push(product);

    return { id: productId, categoryId: targetCategoryId, moved: true };
  });
}

// -------------------------------------------------------------------- images

async function replaceImages(productId, images, ifMatch) {
  validateImages(images);
  return mutate(ifMatch, (catalog) => {
    const { product } = findProduct(catalog, productId);
    product.images = images.map((image, i) => ({
      ...image,
      displayOrder: image.displayOrder ?? i + 1,
    }));
    ensureOnePrimary(product);
    return { id: productId, images: product.images };
  });
}

async function addImage(productId, image, ifMatch) {
  validateImages([image]);
  return mutate(ifMatch, (catalog) => {
    const { product } = findProduct(catalog, productId);
    product.images ??= [];
    if (product.images.some((i) => i.id === image.id)) {
      throw new ApiError("DUPLICATE_ID", `Image '${image.id}' already exists.`);
    }
    product.images.push({
      ...image,
      displayOrder: image.displayOrder ?? nextOrder(product.images),
    });
    ensureOnePrimary(product);
    return { id: productId, images: product.images };
  });
}

async function deleteImage(productId, imageId, ifMatch) {
  return mutate(ifMatch, (catalog) => {
    const { product } = findProduct(catalog, productId);
    const before = (product.images ?? []).length;
    product.images = (product.images ?? []).filter((i) => i.id !== imageId);
    if (product.images.length === before) {
      throw new ApiError("MEDIA_NOT_FOUND", "Image not found on this product.");
    }
    ensureOnePrimary(product);
    return { id: productId, images: product.images };
  });
}

async function setPrimaryImage(productId, imageId, ifMatch) {
  return mutate(ifMatch, (catalog) => {
    const { product } = findProduct(catalog, productId);
    const target = (product.images ?? []).find((i) => i.id === imageId);
    if (!target) {
      throw new ApiError("MEDIA_NOT_FOUND", "Image not found on this product.");
    }
    product.images.forEach((image) => {
      image.isPrimary = image.id === imageId;
    });
    return { id: productId, images: product.images };
  });
}

/**
 * A product with images must have exactly one primary. Left to drift, the app
 * picks whichever image happens to sort first, and the card art changes for no
 * visible reason.
 */
function ensureOnePrimary(product) {
  const images = product.images ?? [];
  if (images.length === 0) {
    return;
  }
  const primaries = images.filter((i) => i.isPrimary);
  if (primaries.length === 1) {
    return;
  }
  images.forEach((image) => {
    image.isPrimary = false;
  });
  const first = [...images].sort(
    (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0),
  )[0];
  first.isPrimary = true;
}

module.exports = {
  listCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  reorderProducts,
  moveProduct,
  replaceImages,
  addImage,
  deleteImage,
  setPrimaryImage,
};
