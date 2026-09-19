"use strict";

const express = require("express");
const c = require("../../controllers/adminController");
const { asyncRoute } = require("../../middleware/error/errorHandler");
const {
  requireAdmin,
  requireIfMatch,
  requireWriteAccess,
  requireAdminRole,
} = require("../../middleware/auth/requireAdmin");
const { validateId } = require("../../middleware/validation/validateId");

/**
 * The admin write API.
 *
 * Two middleware apply to everything here and are applied at the router level
 * rather than per route, so a new endpoint cannot be added unprotected by
 * forgetting a line:
 *   requireAdmin   — authentication, on every method including GET
 *   requireIfMatch — the version being edited, on every mutating method
 */
const router = express.Router();

router.use(asyncRoute(requireAdmin));

// Authorisation, applied to everything below: a read-only account may GET
// anything here and change nothing. Router-level rather than per route, so
// adding an endpoint cannot accidentally leave it writable by a viewer.
router.use(requireWriteAccess);

/**
 * Mutating verbs must declare the version they are editing.
 *
 * /media is exempt: those routes act on S3 objects rather than a JSON
 * document, so there is no version to conflict with. The key they return only
 * reaches a document later, through an ordinary versioned catalogue write.
 */
const MUTATING = ["POST", "PUT", "PATCH", "DELETE"];
const NO_VERSION = ["/media", "/users"];
router.use((req, res, next) =>
  MUTATING.includes(req.method) &&
  !NO_VERSION.some((prefix) => req.path.startsWith(prefix))
    ? requireIfMatch(req, res, next)
    : next(),
);

router.get("/me", c.me);

/**
 * Access management — admin-only on reads too, because the user list is a
 * roster of who can reach the shop's data and a read-only account has no
 * business enumerating it. No If-Match: these act on Cognito, not on a
 * versioned JSON document.
 */
router.use("/users", requireAdminRole);
router.get("/users", asyncRoute(c.listUsers));
router.post("/users", asyncRoute(c.createUser));
router.patch("/users/:username/role", asyncRoute(c.setUserRole));
router.patch("/users/:username/enabled", asyncRoute(c.setUserEnabled));
router.post("/users/:username/reset-password", asyncRoute(c.resetUserPassword));
router.delete("/users/:username", asyncRoute(c.deleteUser));

// Categories
router.get("/categories", asyncRoute(c.listCategories));
router.put("/categories/order", asyncRoute(c.reorderCategories));
router.post("/categories", asyncRoute(c.createCategory));
router.get("/categories/:categoryId", validateId("categoryId"), asyncRoute(c.getCategory));
router.put("/categories/:categoryId", validateId("categoryId"), asyncRoute(c.putCategory));
router.patch("/categories/:categoryId", validateId("categoryId"), asyncRoute(c.patchCategory));
router.delete("/categories/:categoryId", validateId("categoryId"), asyncRoute(c.deleteCategory));

// Products within a category
router.put(
  "/categories/:categoryId/products/order",
  validateId("categoryId"),
  asyncRoute(c.reorderProducts),
);

// Products
router.get("/products", asyncRoute(c.listProducts));
router.post("/products", asyncRoute(c.createProduct));
router.get("/products/:productId", validateId("productId"), asyncRoute(c.getProduct));
router.put("/products/:productId", validateId("productId"), asyncRoute(c.putProduct));
router.patch("/products/:productId", validateId("productId"), asyncRoute(c.patchProduct));
router.delete("/products/:productId", validateId("productId"), asyncRoute(c.deleteProduct));
router.patch(
  "/products/:productId/category",
  validateId("productId"),
  asyncRoute(c.moveProduct),
);

// Product images
router.put("/products/:productId/images", validateId("productId"), asyncRoute(c.putImages));
router.post("/products/:productId/images", validateId("productId"), asyncRoute(c.addImage));
router.delete(
  "/products/:productId/images/:imageId",
  validateId("productId"),
  asyncRoute(c.deleteImage),
);
router.put(
  "/products/:productId/images/:imageId/primary",
  validateId("productId"),
  asyncRoute(c.setPrimaryImage),
);

// Media — presigned upload, then confirm before the key may be used
router.post("/media/upload-url", asyncRoute(c.createUploadUrl));
router.post("/media/confirm", asyncRoute(c.confirmUpload));
router.get("/media", asyncRoute(c.listMedia));
router.delete("/media", asyncRoute(c.deleteMedia));

// Settings — the money document
router.get("/settings", asyncRoute(c.getSettings));
router.put("/settings", asyncRoute(c.putSettings));
router.put("/settings/commerce", asyncRoute(c.putCommerce));

// Company
router.get("/company", asyncRoute(c.getCompany));
router.put("/company", asyncRoute(c.putCompany));

// Services
router.get("/services", asyncRoute(c.listServices));
router.put("/services/order", asyncRoute(c.reorderServices));
router.post("/services", asyncRoute(c.createService));
router.put("/services/:serviceId", validateId("serviceId"), asyncRoute(c.putService));
router.patch("/services/:serviceId", validateId("serviceId"), asyncRoute(c.patchService));
router.delete("/services/:serviceId", validateId("serviceId"), asyncRoute(c.deleteService));

// Home
router.get("/home", asyncRoute(c.getHome));
router.put("/home", asyncRoute(c.putHome));
router.put("/home/order", asyncRoute(c.reorderHome));

// Storefront
router.get("/storefront", asyncRoute(c.getStorefront));
router.put("/storefront", asyncRoute(c.putStorefront));
router.put("/storefront/announcement", asyncRoute(c.putAnnouncement));
router.put("/storefront/promo", asyncRoute(c.putPromo));
router.put("/storefront/carousels/:carouselId", asyncRoute(c.putCarousel));
router.delete("/storefront/carousels/:carouselId", asyncRoute(c.deleteCarousel));
router.put(
  "/storefront/carousels/:carouselId/slides",
  asyncRoute(c.putCarouselSlides),
);

module.exports = router;
