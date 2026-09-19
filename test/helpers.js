"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

/**
 * Starts the API against a throwaway copy of test/fixtures.
 *
 * Admin tests mutate documents, so every run gets its own directory — a suite
 * that edited the fixtures in place would pass once and then fail, or worse,
 * pass for the wrong reason.
 */
function startServer({ auth = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "babagold-test-"));
  for (const file of fs.readdirSync(path.join(__dirname, "fixtures"))) {
    fs.copyFileSync(path.join(__dirname, "fixtures", file), path.join(dir, file));
  }

  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_DATA_DIR = dir;
  process.env.READ_CACHE_TTL_MS = "0";
  process.env.AUTH_MODE = "token";
  process.env.ADMIN_API_TOKEN = auth ? "test-token" : "";

  // Required after the env is set: config reads it at module load.
  delete require.cache[require.resolve("../src/config")];
  const { createApp } = require("../src/app");

  const server = http.createServer(createApp());
  return new Promise((resolve) => {
    server.listen(0, () => {
      const base = `http://localhost:${server.address().port}/api/v1`;
      resolve({
        base,
        dir,
        close: () =>
          new Promise((done) => {
            server.close(done);
            fs.rmSync(dir, { recursive: true, force: true });
          }),
      });
    });
  });
}

/** Thin fetch wrapper that returns status and parsed body together. */
async function request(base, method, path, { body, version, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(version ? { "If-Match": version } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = res.status === 304 ? null : await res.json().catch(() => null);
  return { status: res.status, json, headers: res.headers };
}

const asAdmin = (base) => (method, path, options = {}) =>
  request(base, method, path, { ...options, token: "test-token" });

module.exports = { startServer, request, asAdmin };
