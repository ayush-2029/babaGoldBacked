"use strict";

const express = require("express");
const publicRoutes = require("./routes/public");
const adminRoutes = require("./routes/admin");
const {
  errorHandler,
  notFoundHandler,
} = require("./middleware/error/errorHandler");

/**
 * The Express app, built separately from the Lambda adapter so it can be run
 * directly (npm run dev) and mounted in tests with supertest.
 */
function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("etag", false); // We set ETags ourselves, from the S3 object.

  app.use(express.json({ limit: "1mb" }));

  /**
   * CORS. The admin panel is a browser app on another origin, so this is
   * required; the mobile app does not care either way.
   *
   * ALLOWED_ORIGINS is a comma-separated allowlist. It falls back to "*" only
   * while no admin origin exists — once the panel is deployed, set it, because
   * the admin routes are credentialed.
   */
  const allowed = (process.env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  app.use((req, res, next) => {
    const origin = req.get("Origin");
    if (allowed.includes("*")) {
      res.set("Access-Control-Allow-Origin", "*");
    } else if (origin && allowed.includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
    }
    res.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.set(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization,If-Match,If-None-Match",
    );
    res.set("Access-Control-Expose-Headers", "ETag");
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }
    return next();
  });

  // Admin mounts first: it is the more specific prefix, and mounting it ahead
  // of the public router keeps a future public route from shadowing it.
  app.use("/api/v1/admin", adminRoutes);
  app.use("/api/v1", publicRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
