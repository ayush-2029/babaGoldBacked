"use strict";

const serverless = require("serverless-http");
const { createApp } = require("./src/app");

/**
 * The Lambda entry point. Everything of substance lives in src/ so the same
 * app can run locally and under supertest without the adapter in the way.
 *
 * The app is built at module scope so the work happens once per container,
 * not once per request.
 */
const app = createApp();

exports.handler = serverless(app);
