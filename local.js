"use strict";

/**
 * Runs the API as a plain HTTP server, against the hand-authored JSON in
 * D:\Jewl App\data\ — no AWS, no credentials, no deploy.
 *
 *   npm run dev
 *
 * This is how the whole public API gets verified before a single object is
 * uploaded to S3.
 */
process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER || "local";

const { createApp } = require("./src/app");

const port = Number(process.env.PORT || 4000);

createApp().listen(port, () => {
  console.log(`BabaGold API on http://localhost:${port}/api/v1`);
  console.log(`storage driver: ${process.env.STORAGE_DRIVER}`);
});
