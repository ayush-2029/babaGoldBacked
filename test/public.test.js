"use strict";

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, request } = require("./helpers");

/**
 * Conformance suite for the public API.
 *
 * These assertions mirror BabaGold/src/services/api/__tests__/catalogRepository.test.ts.
 * The app has been running against bundled JSON with exactly this behaviour;
 * when it flips DATA_SOURCE to 'remote', nothing on screen may change. If one
 * of these breaks, the app breaks with it.
 */
describe("public API", () => {
  let server;
  let get;

  before(async () => {
    server = await startServer();
    get = (path) => request(server.base, "GET", path);
  });

  after(() => server.close());

  test("every content endpoint answers", async () => {
    for (const path of [
      "/health",
      "/company",
      "/services",
      "/home",
      "/storefront",
      "/settings",
      "/bootstrap",
    ]) {
      const { status, json } = await get(path);
      assert.equal(status, 200, `${path} returned ${status}`);
      assert.equal(json.success, true, `${path} broke the envelope`);
    }
  });

  test("bootstrap carries everything Home needs", async () => {
    const { json } = await get("/bootstrap");
    for (const key of [
      "company",
      "services",
      "home",
      "storefront",
      "settings",
      "categories",
    ]) {
      assert.ok(json.data[key] !== undefined, `bootstrap is missing ${key}`);
    }
  });

  test("categories strip nested products and report an active count", async () => {
    const { json } = await get("/categories");
    for (const category of json.data) {
      assert.equal(category.products, undefined, "nested products leaked");
      assert.equal(typeof category.productCount, "number");
    }
  });

  test("inactive records never reach a client", async () => {
    const { json } = await get("/categories");
    assert.ok(json.data.every((c) => c.active !== false));

    const products = (await get("/products")).json.data.items;
    assert.ok(products.every((p) => p.active !== false));
  });

  test("categories and products come back in displayOrder", async () => {
    const { json } = await get("/categories");
    const orders = json.data.map((c) => c.displayOrder ?? 0);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  });

  test("a product carries the categoryId its storage does not", async () => {
    const products = (await get("/products")).json.data.items;
    assert.ok(products.length > 0, "fixture has no products");
    for (const product of products) {
      assert.equal(typeof product.categoryId, "string");
      assert.ok(product.categoryId.length > 0);
    }
  });

  test("images are never empty and never unordered", async () => {
    const products = (await get("/products")).json.data.items;
    for (const product of products) {
      assert.ok(
        Array.isArray(product.images) && product.images.length > 0,
        `${product.id} has no images`,
      );
      const orders = product.images.map((i) => i.displayOrder ?? 0);
      assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
    }
  });

  test("search narrows as terms are added, never widens", async () => {
    const one = (await get("/products?q=gold")).json.data.page.total;
    const two = (await get("/products?q=gold+solitaire")).json.data.page.total;
    assert.ok(two <= one, `"gold" ${one} -> "gold solitaire" ${two}`);
  });

  test("an empty query returns nothing rather than everything", async () => {
    const { json } = await get("/products?q=%20%20");
    assert.equal(json.data.items.length, 0);
  });

  test("pagination reports a usable cursor", async () => {
    const { json } = await get("/products?limit=1");
    assert.equal(json.data.items.length, 1);
    if (json.data.page.total > 1) {
      assert.equal(typeof json.data.page.nextCursor, "string");
      const next = await get(`/products?limit=1&cursor=${json.data.page.nextCursor}`);
      assert.notEqual(next.json.data.items[0].id, json.data.items[0].id);
    }
  });

  test("a missing record is a typed 404, not a crash", async () => {
    assert.equal((await get("/categories/nope")).json.error.code, "CATEGORY_NOT_FOUND");
    assert.equal((await get("/products/nope")).json.error.code, "PRODUCT_NOT_FOUND");
    assert.equal((await get("/nope")).json.error.code, "NOT_FOUND");
  });

  test("an invalid id is rejected before it reaches storage", async () => {
    for (const id of ["UPPERCASE", "with%20space", "a_b", "x".repeat(70)]) {
      const { status, json } = await get(`/categories/${id}`);
      assert.equal(status, 400, `${id} was not rejected`);
      assert.equal(json.error.code, "VALIDATION_FAILED");
    }
  });

  test("a path traversal attempt never reaches storage", async () => {
    // Deployed, this returns 404 rather than 400: API Gateway decodes %2F to a
    // real slash before routing, so the path stops matching /categories/:id and
    // falls through to the not-found handler. Locally Express keeps it as one
    // segment and the id validator rejects it. Both refuse the request and
    // neither touches S3 — so assert the refusal, not the particular code.
    const { status, json } = await get("/categories/..%2F..%2Fetc");
    assert.ok(status === 400 || status === 404, `unexpected status ${status}`);
    assert.equal(json.success, false);
  });

  test("responses revalidate rather than going stale", async () => {
    const first = await get("/categories");
    const etag = first.headers.get("etag");
    assert.ok(etag, "no ETag issued");

    const cacheControl = first.headers.get("cache-control");

    // A client must never serve a stored copy blind. `max-age=60` here once
    // meant an admin's edit stayed invisible in the app for over a minute —
    // and because the mobile HTTP cache is on disk, restarting did not help.
    assert.match(
      cacheControl,
      /no-cache|max-age=0/,
      `cache-control must force revalidation, got "${cacheControl}"`,
    );
    assert.match(cacheControl, /must-revalidate/);
    assert.ok(
      !/stale-while-revalidate=[1-9]/.test(cacheControl),
      "stale-while-revalidate would let a client serve old data after expiry",
    );

    // Revalidation stays cheap: unchanged documents cost an empty 304.
    const again = await fetch(server.base + "/categories", {
      headers: { "If-None-Match": etag },
    });
    assert.equal(again.status, 304);
  });

  test("no response ever leaks a stack trace", async () => {
    for (const path of ["/company", "/products", "/nope", "/categories/nope"]) {
      const body = JSON.stringify((await get(path)).json ?? {});
      assert.ok(!/\bat \w+ \(/.test(body), `${path} leaked a stack trace`);
      assert.ok(!/AccessDenied|NoSuchKey|s3\.amazonaws/i.test(body),
        `${path} leaked a raw AWS error`);
    }
  });

  test("errors never name the bucket", async () => {
    // Image URLs legitimately carry the storage host — that is the delivery
    // mechanism, in both signed and public mode. Errors are different: an
    // error naming the bucket tells an attacker where the data lives and is
    // never useful to a client.
    for (const path of ["/nope", "/categories/nope", "/products/nope"]) {
      const body = JSON.stringify((await get(path)).json ?? {});
      assert.ok(!/baba-gold/.test(body), `${path} leaked the bucket name`);
    }
  });
});
