"use strict";

const express = require("express");
const controller = require("../../controllers/publicController");
const { asyncRoute } = require("../../middleware/error/errorHandler");
const { validateId } = require("../../middleware/validation/validateId");

/**
 * The public read API. No authentication — these serve the storefront.
 * Everything here is a GET; the app never writes through this router.
 */
const router = express.Router();

router.get("/health", controller.health);

// Content
router.get("/company", asyncRoute(controller.company));
router.get("/services", asyncRoute(controller.services));
router.get("/home", asyncRoute(controller.home));
router.get("/storefront", asyncRoute(controller.storefront));
router.get("/settings", asyncRoute(controller.settings));
router.get("/bootstrap", asyncRoute(controller.bootstrap));

// Catalog
router.get("/categories", asyncRoute(controller.categories));
router.get(
  "/categories/:categoryId",
  validateId("categoryId"),
  asyncRoute(controller.category),
);
router.get(
  "/categories/:categoryId/products",
  validateId("categoryId"),
  asyncRoute(controller.categoryProducts),
);
router.get("/products", asyncRoute(controller.products));
router.get(
  "/products/:productId",
  validateId("productId"),
  asyncRoute(controller.product),
);

module.exports = router;
