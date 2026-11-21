"use strict";

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, request, asAdmin } = require("./helpers");

/**
 * Permanent deletes. The JSON half runs over HTTP against the local driver;
 * the S3 half is checked at the decision boundary, because every path that
 * reaches S3 needs credentials.
 */
describe("hard delete", () => {
  let server;
  let admin;
  let anon;

  before(async () => {
    server = await startServer();
    admin = asAdmin(server.base);
    anon = (method, path, options) => request(server.base, method, path, options);
  });

  after(() => server.close());

  const versionOf = async (path) => (await admin("GET", path)).json.data.version;

  test("a hard-deleted product is gone from admin and public reads", async () => {
    const version = await versionOf("/admin/categories");
    const res = await admin("DELETE", "/admin/products/ring-001?hard=true", { version });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.deleted, true);
    // The local driver has no media store, and says so rather than pretending.
    assert.equal(res.json.data.media.skipped, "local storage");

    assert.equal((await admin("GET", "/admin/products/ring-001")).status, 404);
    assert.equal((await anon("GET", "/products/ring-001")).status, 404);
  });

  test("a soft delete still only hides, and touches no media", async () => {
    const list = await admin("GET", "/admin/products");
    const target = list.json.data.items.find((p) => p.active);
    const version = await versionOf("/admin/categories");
    const res = await admin("DELETE", `/admin/products/${target.id}`, { version });
    assert.equal(res.json.data.deleted, false);
    assert.equal(res.json.data.media, undefined);
    assert.equal((await admin("GET", `/admin/products/${target.id}`)).status, 200);
  });

  test("a hard delete with a stale version is refused and deletes nothing", async () => {
    const stale = await versionOf("/admin/categories");
    // Any write moves the version on.
    await admin("PUT", "/admin/categories/order", {
      body: { ids: (await admin("GET", "/admin/categories")).json.data.items.map((c) => c.id) },
      version: stale,
    });
    const list = await admin("GET", "/admin/products");
    const target = list.json.data.items[0];
    const res = await admin("DELETE", `/admin/products/${target.id}?hard=true`, {
      version: stale,
    });
    assert.equal(res.status, 409);
    assert.equal((await admin("GET", `/admin/products/${target.id}`)).status, 200);
  });

  test("an empty category can be hard-deleted", async () => {
    let version = await versionOf("/admin/categories");
    await admin("POST", "/admin/categories", {
      body: { id: "temp-empty", name: "Temp" },
      version,
    });
    version = await versionOf("/admin/categories");
    const res = await admin("DELETE", "/admin/categories/temp-empty?hard=true", { version });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.deleted, true);
    assert.equal((await admin("GET", "/admin/categories/temp-empty")).status, 404);
  });
});

describe("media cleanup decisions", () => {
  // Required lazily: loading it at definition time would fix the storage
  // driver before the HTTP suite above has switched it to local.
  const cleanup = new Proxy({}, {
    get: (_t, name) => require("../src/services/media/mediaCleanup")[name],
  });

  test("a file another document still references is kept", () => {
    const keys = ["media/products/p1/a.jpg", "media/products/p1/b.jpg"];
    const referenced = new Set(["media/products/p1/b.jpg"]);
    assert.deepEqual(cleanup.selectDeletable(keys, referenced), ["media/products/p1/a.jpg"]);
  });

  test("the folder holding the fallback image is protected", () => {
    assert.ok(cleanup.PROTECTED_PREFIXES().includes(cleanup.FOLDERS.product("default")));
  });

  test("an id that could escape its folder is refused before any S3 call", async () => {
    const saved = process.env.STORAGE_DRIVER;
    process.env.STORAGE_DRIVER = "s3";
    try {
      for (const id of ["../x", "", "a/b", undefined]) {
        const result = await cleanup.deleteOwnMedia("product", id);
        assert.equal(result.skipped, "invalid id");
      }
      const protectedResult = await cleanup.deleteOwnMedia("product", "default");
      assert.equal(protectedResult.skipped, "protected folder");
    } finally {
      process.env.STORAGE_DRIVER = saved;
    }
  });
});
