"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

process.env.DATA_BUCKET = process.env.DATA_BUCKET || "baba-gold-in";

/**
 * One bucket, two roots: prod/ and dev/.
 *
 * The bug this exists to stop is concrete — a panel running on a laptop was
 * writing the same objects the shop's customers were reading. These tests pin
 * the two rules that keep them apart: every S3 key carries the environment,
 * and every STORED key does not.
 */

/** config caches process.env at load, so each case needs a fresh copy. */
function configFor(appEnv) {
  const before = process.env.APP_ENV;
  if (appEnv === undefined) {
    delete process.env.APP_ENV;
  } else {
    process.env.APP_ENV = appEnv;
  }
  delete require.cache[require.resolve("../src/config")];
  const config = require("../src/config");
  process.env.APP_ENV = before;
  return config;
}

describe("environment roots", () => {
  test("prod and dev read different documents", () => {
    assert.equal(configFor("prod").dataKey("catalog"), "prod/data/catalog.json");
    assert.equal(configFor("dev").dataKey("catalog"), "dev/data/catalog.json");
  });

  test("prod and dev read different media objects", () => {
    const key = "media/products/ring-001/front.webp";
    assert.equal(
      configFor("prod").mediaObjectKey(key),
      "prod/media/products/ring-001/front.webp",
    );
    assert.equal(
      configFor("dev").mediaObjectKey(key),
      "dev/media/products/ring-001/front.webp",
    );
  });

  test("NO overlap — every prod key differs from the dev one", () => {
    const prod = configFor("prod");
    const dev = configFor("dev");
    for (const name of ["catalog", "company", "services", "home", "storefront", "settings"]) {
      assert.notEqual(prod.dataKey(name), dev.dataKey(name), name);
    }
  });

  test("THE DEFAULT IS DEV — an unset APP_ENV must not reach production", () => {
    // Someone running this locally with no configuration should land where
    // mistakes are free. Production has to be asked for.
    assert.equal(configFor(undefined).appEnv, "dev");
    assert.equal(configFor(undefined).dataKey("catalog"), "dev/data/catalog.json");
  });

  test("anything that is not exactly prod is dev", () => {
    for (const value of ["", "production ", "PROD ", "staging", "live", "1"]) {
      const env = configFor(value).appEnv;
      assert.equal(env, value.trim().toLowerCase() === "prod" ? "prod" : "dev", value);
    }
  });

  test("PROD and prod both mean production", () => {
    assert.equal(configFor("PROD").appEnv, "prod");
    assert.equal(configFor("prod").appEnv, "prod");
  });
});

describe("stored keys stay environment-agnostic", () => {
  test("the relative key round-trips", () => {
    const config = configFor("prod");
    const stored = "media/company/logo.png";
    assert.equal(
      config.mediaRelativeKey(config.mediaObjectKey(stored)),
      stored,
      "a document must get back exactly what it put in",
    );
  });

  test("prefixing is idempotent — an already-prefixed key is not doubled", () => {
    const config = configFor("prod");
    const once = config.mediaObjectKey("media/x.png");
    assert.equal(config.mediaObjectKey(once), once);
    assert.ok(!once.includes("prod/prod/"));
  });

  test("THE SAME DOCUMENT WORKS IN BOTH — this is why prod can be copied to dev", () => {
    // If the environment were baked into stored keys, a copy of prod data
    // would follow its images back to production's objects.
    const stored = "media/products/ring-001/front.webp";
    assert.equal(
      configFor("prod").mediaObjectKey(stored),
      "prod/media/products/ring-001/front.webp",
    );
    assert.equal(
      configFor("dev").mediaObjectKey(stored),
      "dev/media/products/ring-001/front.webp",
    );
  });

  test("a stray environment prefix is stripped back out", () => {
    // Defence for the write path: if a prefixed key ever reaches a document,
    // it must not be persisted that way.
    const config = configFor("dev");
    assert.equal(config.mediaRelativeKey("dev/media/a.png"), "media/a.png");
  });

  test("a key from the OTHER environment is left alone, not silently adopted", () => {
    // dev must not quietly rewrite a prod key into its own namespace; leaving
    // it visible means it shows up as a broken image and gets noticed.
    const config = configFor("dev");
    assert.equal(config.mediaRelativeKey("prod/media/a.png"), "prod/media/a.png");
  });
});
