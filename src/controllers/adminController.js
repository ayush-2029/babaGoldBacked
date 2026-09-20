"use strict";

const catalog = require("../services/admin/catalogAdminService");
const content = require("../services/admin/contentAdminService");
const media = require("../services/media/uploadService");
const { deliverMedia } = require("../services/media/mediaService");
const users = require("../services/admin/usersService");
const { ok } = require("../utils/envelope");
const { validateOrder } = require("../schemas/catalogSchemas");

/**
 * Admin responses always carry the version alongside the payload, because the
 * next write must send it back as If-Match. It is in the body as well as the
 * ETag header so the panel never has to read a CORS-exposed header to save.
 */
const send = async (res, { data, version }, status = 200) => {
  // Admin responses are never cached (no-store), so they need no window
  // bookkeeping — but they still show images, so the keys still need signing.
  const { data: body } = await deliverMedia(data);
  return ok(res, { version, ...wrap(body) }, { status, etag: version });
};

/** Arrays cannot carry a version field, so they get a named property. */
const wrap = (data) => (Array.isArray(data) ? { items: data } : data);

const me = (req, res) => ok(res, req.admin);

// ---------------------------------------------------------------- categories

const listCategories = async (req, res) =>
  send(
    res,
    await catalog.listCategories({
      includeProducts: req.query.includeProducts === "true",
    }),
  );

const getCategory = async (req, res) =>
  send(res, await catalog.getCategory(req.params.categoryId));

const createCategory = async (req, res) =>
  send(res, await catalog.createCategory(req.body, req.ifMatch), 201);

const putCategory = async (req, res) =>
  send(
    res,
    await catalog.updateCategory(req.params.categoryId, req.body, req.ifMatch, {
      partial: false,
    }),
  );

const patchCategory = async (req, res) =>
  send(
    res,
    await catalog.updateCategory(req.params.categoryId, req.body, req.ifMatch, {
      partial: true,
    }),
  );

const deleteCategory = async (req, res) =>
  send(
    res,
    await catalog.deleteCategory(req.params.categoryId, req.ifMatch, {
      hard: req.query.hard === "true",
    }),
  );

const reorderCategories = async (req, res) =>
  send(res, await catalog.reorderCategories(req.body, req.ifMatch));

// ------------------------------------------------------------------ products

const listProducts = async (req, res) => {
  const { categoryId, q, active } = req.query;
  return send(
    res,
    await catalog.listProducts({
      categoryId,
      q,
      active: active === undefined ? undefined : active === "true",
    }),
  );
};

const getProduct = async (req, res) =>
  send(res, await catalog.getProduct(req.params.productId));

const createProduct = async (req, res) =>
  send(res, await catalog.createProduct(req.body, req.ifMatch), 201);

const putProduct = async (req, res) =>
  send(
    res,
    await catalog.updateProduct(req.params.productId, req.body, req.ifMatch, {
      partial: false,
    }),
  );

const patchProduct = async (req, res) =>
  send(
    res,
    await catalog.updateProduct(req.params.productId, req.body, req.ifMatch, {
      partial: true,
    }),
  );

const deleteProduct = async (req, res) =>
  send(
    res,
    await catalog.deleteProduct(req.params.productId, req.ifMatch, {
      hard: req.query.hard === "true",
    }),
  );

const reorderProducts = async (req, res) =>
  send(
    res,
    await catalog.reorderProducts(req.params.categoryId, req.body, req.ifMatch),
  );

const moveProduct = async (req, res) =>
  send(
    res,
    await catalog.moveProduct(
      req.params.productId,
      req.body?.categoryId,
      req.ifMatch,
    ),
  );

// -------------------------------------------------------------------- images

const putImages = async (req, res) =>
  send(
    res,
    await catalog.replaceImages(req.params.productId, req.body?.images, req.ifMatch),
  );

const addImage = async (req, res) =>
  send(res, await catalog.addImage(req.params.productId, req.body, req.ifMatch), 201);

const deleteImage = async (req, res) =>
  send(
    res,
    await catalog.deleteImage(req.params.productId, req.params.imageId, req.ifMatch),
  );

const setPrimaryImage = async (req, res) =>
  send(
    res,
    await catalog.setPrimaryImage(
      req.params.productId,
      req.params.imageId,
      req.ifMatch,
    ),
  );

// --------------------------------------------------------------------- users

/**
 * Access management. No document version is involved — these act on Cognito,
 * not on a JSON file — and the router restricts the whole group to admins.
 */
const listUsers = async (req, res) => ok(res, { items: await users.listUsers() });

const createUser = async (req, res) =>
  ok(res, await users.createUser(req.body ?? {}, req.admin), { status: 201 });

const setUserRole = async (req, res) =>
  ok(res, await users.setRole(req.params.username, req.body?.role, req.admin));

const setUserEnabled = async (req, res) =>
  ok(res, await users.setEnabled(req.params.username, req.body?.enabled === true, req.admin));

const deleteUser = async (req, res) =>
  ok(res, await users.deleteUser(req.params.username, req.admin));

const resetUserPassword = async (req, res) =>
  ok(res, await users.resetPassword(req.params.username, req.admin));

// --------------------------------------------------------------------- media

/**
 * Media endpoints carry no document version: they touch S3 objects, not the
 * JSON, so there is nothing to conflict with. The key only reaches a document
 * later, through a normal versioned catalogue write.
 */
const createUploadUrl = async (req, res) =>
  ok(res, await media.createUploadUrl(req.body ?? {}), { status: 201 });

/** Signed so the panel can display the file it just uploaded. */
const confirmUpload = async (req, res) => {
  const { data } = await deliverMedia(await media.confirmUpload(req.body ?? {}));
  return ok(res, data);
};

const deleteMedia = async (req, res) =>
  ok(res, await media.deleteMedia(req.body?.key));

const listMedia = async (req, res) => {
  const { data } = await deliverMedia(
    await media.listMedia({ prefix: req.query.prefix, cursor: req.query.cursor }),
  );
  return ok(res, data);
};

// ------------------------------------------------------------------- content

const getSettings = async (req, res) => send(res, await content.getDocument("settings"));

const putSettings = async (req, res) =>
  send(res, await content.updateSettings(req.body, req.ifMatch, req.admin));

const putCommerce = async (req, res) =>
  send(res, await content.updateCommerce(req.body, req.ifMatch, req.admin));

const getCompany = async (req, res) => send(res, await content.getDocument("company"));

const putCompany = async (req, res) =>
  send(res, await content.updateCompany(req.body, req.ifMatch));

const listServices = async (req, res) => send(res, await content.listServices());

const createService = async (req, res) =>
  send(res, await content.createService(req.body, req.ifMatch), 201);

const putService = async (req, res) =>
  send(
    res,
    await content.updateService(req.params.serviceId, req.body, req.ifMatch, {
      partial: false,
    }),
  );

const patchService = async (req, res) =>
  send(
    res,
    await content.updateService(req.params.serviceId, req.body, req.ifMatch, {
      partial: true,
    }),
  );

const deleteService = async (req, res) =>
  send(
    res,
    await content.deleteService(req.params.serviceId, req.ifMatch, {
      hard: req.query.hard === "true",
    }),
  );

const reorderServices = async (req, res) =>
  send(res, await content.reorderServices(validateOrder(req.body), req.ifMatch));

const getHome = async (req, res) => send(res, await content.getDocument("home"));

const putHome = async (req, res) =>
  send(
    res,
    await content.putDocument("home", req.body, req.ifMatch, content.validateHome),
  );

const reorderHome = async (req, res) =>
  send(res, await content.reorderHomeSections(validateOrder(req.body), req.ifMatch));

const getStorefront = async (req, res) =>
  send(res, await content.getDocument("storefront"));

const putStorefront = async (req, res) =>
  send(
    res,
    await content.putDocument(
      "storefront",
      req.body,
      req.ifMatch,
      content.validateStorefront,
    ),
  );

const putAnnouncement = async (req, res) =>
  send(res, await content.updateStorefrontBlock("announcement", req.body, req.ifMatch));

const putPromo = async (req, res) =>
  send(res, await content.updateStorefrontBlock("promoModal", req.body, req.ifMatch));

const putCarousel = async (req, res) =>
  send(
    res,
    await content.updateCarousel(req.params.carouselId, req.body, req.ifMatch),
  );

const deleteCarousel = async (req, res) =>
  send(res, await content.deleteCarousel(req.params.carouselId, req.ifMatch));

const putCarouselSlides = async (req, res) => {
  const { data: storefront } = await content.getDocument("storefront");
  const existing = storefront.carousels?.[req.params.carouselId] ?? {};
  return send(
    res,
    await content.updateCarousel(
      req.params.carouselId,
      { ...existing, slides: req.body?.slides },
      req.ifMatch,
    ),
  );
};

module.exports = {
  me,
  listUsers,
  createUser,
  setUserRole,
  setUserEnabled,
  deleteUser,
  resetUserPassword,
  listCategories,
  getCategory,
  createCategory,
  putCategory,
  patchCategory,
  deleteCategory,
  reorderCategories,
  listProducts,
  getProduct,
  createProduct,
  putProduct,
  patchProduct,
  deleteProduct,
  reorderProducts,
  moveProduct,
  putImages,
  addImage,
  deleteImage,
  setPrimaryImage,
  createUploadUrl,
  confirmUpload,
  deleteMedia,
  listMedia,
  getSettings,
  putSettings,
  putCommerce,
  getCompany,
  putCompany,
  listServices,
  createService,
  putService,
  patchService,
  deleteService,
  reorderServices,
  getHome,
  putHome,
  reorderHome,
  getStorefront,
  putStorefront,
  putAnnouncement,
  putPromo,
  putCarousel,
  deleteCarousel,
  putCarouselSlides,
};
