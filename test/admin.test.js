"use strict";

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, request, asAdmin } = require("./helpers");

/**
 * The admin write API.
 *
 * The concurrency and validation cases matter more than the CRUD ones: a lost
 * update or a bad tax rate is invisible until a customer is affected by it.
 */
describe("admin API", () => {
  let server;
  let admin;
  let anon;

  before(async () => {
    server = await startServer();
    admin = asAdmin(server.base);
    anon = (method, path, options) => request(server.base, method, path, options);
  });

  after(() => server.close());

  /** Reads the current version so a write can be pinned to it. */
  const versionOf = async (path) => (await admin("GET", path)).json.data.version;

  describe("authentication", () => {
    test("an unauthenticated request never reaches the data", async () => {
      assert.equal((await anon("GET", "/admin/categories")).status, 401);
      assert.equal((await anon("GET", "/admin/settings")).status, 401);
    });

    test("a wrong token is rejected", async () => {
      const res = await request(server.base, "GET", "/admin/categories", {
        token: "not-the-token",
      });
      assert.equal(res.status, 401);
    });

    test("a valid token identifies the actor", async () => {
      const { status, json } = await admin("GET", "/admin/me");
      assert.equal(status, 200);
      assert.ok(json.data.roles.includes("admin"));
    });
  });

  describe("concurrency", () => {
    test("a write without If-Match is refused outright", async () => {
      const { status, json } = await admin("POST", "/admin/categories", {
        body: { id: "pendants", name: "Pendants" },
      });
      assert.equal(status, 400);
      assert.equal(json.error.code, "VALIDATION_FAILED");
    });

    test("a stale version conflicts instead of overwriting", async () => {
      const version = await versionOf("/admin/categories");
      const first = await admin("PATCH", "/admin/categories/rings", {
        body: { description: "First writer wins" },
        version,
      });
      assert.equal(first.status, 200);

      // Second admin still holds the version they loaded before the first save.
      const second = await admin("PATCH", "/admin/categories/rings", {
        body: { description: "Second writer must not clobber" },
        version,
      });
      assert.equal(second.status, 409);
      assert.equal(second.json.error.code, "CONFLICT_STALE_DATA");

      const now = await admin("GET", "/admin/categories/rings");
      assert.equal(now.json.data.description, "First writer wins");
    });

    test("a successful write stamps updatedAt", async () => {
      const before = await admin("GET", "/admin/company");
      const result = await admin("PUT", "/admin/company", {
        body: { ...before.json.data, tagline: "Updated" },
        version: before.json.data.version,
      });
      assert.equal(result.status, 200);
      assert.notEqual(result.json.data.updatedAt, before.json.data.updatedAt);
    });
  });

  describe("categories", () => {
    test("create, reject a duplicate, then patch", async () => {
      let version = await versionOf("/admin/categories");

      const created = await admin("POST", "/admin/categories", {
        body: { id: "pendants", name: "Pendants" },
        version,
      });
      assert.equal(created.status, 201);
      assert.equal(created.json.data.active, true, "new categories default to active");
      version = created.json.data.version;

      const duplicate = await admin("POST", "/admin/categories", {
        body: { id: "pendants", name: "Pendants" },
        version,
      });
      assert.equal(duplicate.json.error.code, "DUPLICATE_ID");

      const patched = await admin("PATCH", "/admin/categories/pendants", {
        body: { active: false },
        version,
      });
      assert.equal(patched.json.data.active, false);
    });

    test("a full PUT does not drop the category's products", async () => {
      const version = await versionOf("/admin/categories");
      await admin("PUT", "/admin/categories/rings", {
        body: { name: "Rings", description: "Replaced wholesale", active: true },
        version,
      });
      const products = await admin("GET", "/admin/products?categoryId=rings");
      assert.ok(products.json.data.items.length > 0, "PUT destroyed nested products");
    });

    test("hard delete is refused while products remain", async () => {
      const version = await versionOf("/admin/categories");
      const { status, json } = await admin("DELETE", "/admin/categories/rings?hard=true", {
        version,
      });
      assert.equal(status, 409);
      assert.equal(json.error.code, "CATEGORY_NOT_EMPTY");
    });

    test("soft delete deactivates and the public API stops serving it", async () => {
      const version = await versionOf("/admin/categories");
      await admin("DELETE", "/admin/categories/necklaces", { version });

      const publicList = await anon("GET", "/categories");
      assert.ok(!publicList.json.data.some((c) => c.id === "necklaces"));

      const adminList = await admin("GET", "/admin/categories");
      assert.ok(
        adminList.json.data.items.some((c) => c.id === "necklaces"),
        "admin must still see what it deactivated",
      );
    });
  });

  describe("products", () => {
    test("validation names every bad field at once", async () => {
      const version = await versionOf("/admin/categories");
      const { status, json } = await admin("POST", "/admin/products", {
        body: {
          categoryId: "rings",
          id: "Not A Slug",
          name: "",
          price: { amount: -1, currency: "RUPEES" },
        },
        version,
      });
      assert.equal(status, 400);
      assert.ok(json.error.fields.length >= 3, "should report more than one problem");
    });

    test("an mrp below the price is rejected", async () => {
      const version = await versionOf("/admin/categories");
      const { status, json } = await admin("POST", "/admin/products", {
        body: {
          categoryId: "rings",
          id: "ring-999",
          name: "Test",
          price: { amount: 50000, currency: "INR", mrp: 10000 },
        },
        version,
      });
      assert.equal(status, 400);
      assert.ok(json.error.fields.some((f) => /mrp/.test(f)));
    });

    test("priceOnRequest is a valid price", async () => {
      const version = await versionOf("/admin/categories");
      const { status } = await admin("POST", "/admin/products", {
        body: {
          categoryId: "rings",
          id: "ring-onreq",
          name: "Bespoke Band",
          price: { currency: "INR", priceOnRequest: true },
        },
        version,
      });
      assert.equal(status, 201);
    });

    test("moving between categories leaves image URLs untouched", async () => {
      let version = await versionOf("/admin/categories");
      const created = await admin("POST", "/admin/products", {
        body: {
          categoryId: "rings",
          id: "pendant-001",
          name: "Lotus Pendant",
          price: { amount: 24000, currency: "INR" },
          images: [
            { id: "a", url: "media/products/pendant-001/a.jpg", isPrimary: true },
          ],
        },
        version,
      });
      version = created.json.data.version;
      const urlBefore = created.json.data.images[0].url;

      const moved = await admin("PATCH", "/admin/products/pendant-001/category", {
        body: { categoryId: "earrings" },
        version,
      });
      assert.equal(moved.json.data.categoryId, "earrings");

      const after = await admin("GET", "/admin/products/pendant-001");
      assert.equal(
        after.json.data.images[0].url,
        urlBefore,
        "a category move must never invalidate an image URL",
      );
    });

    test("a product body may not carry its own categoryId", async () => {
      const version = await versionOf("/admin/categories");
      const { status } = await admin("PATCH", "/admin/products/ring-001", {
        body: { categoryId: "earrings" },
        version,
      });
      assert.equal(status, 400);
    });
  });

  describe("product images", () => {
    test("exactly one primary survives every edit", async () => {
      let version = await versionOf("/admin/categories");

      const set = await admin("PUT", "/admin/products/ring-001/images", {
        body: {
          images: [
            { id: "x", url: "a.jpg", displayOrder: 2 },
            { id: "y", url: "b.jpg", displayOrder: 1 },
          ],
        },
        version,
      });
      const primaries = set.json.data.images.filter((i) => i.isPrimary);
      assert.equal(primaries.length, 1);
      assert.equal(primaries[0].id, "y", "lowest displayOrder becomes primary");
      version = set.json.data.version;

      const promoted = await admin("PUT", "/admin/products/ring-001/images/x/primary", {
        version,
      });
      assert.equal(promoted.json.data.images.filter((i) => i.isPrimary).length, 1);
      version = promoted.json.data.version;

      const removed = await admin("DELETE", "/admin/products/ring-001/images/x", {
        version,
      });
      assert.equal(
        removed.json.data.images.filter((i) => i.isPrimary).length,
        1,
        "deleting the primary must promote another",
      );
    });

    test("two primaries are rejected", async () => {
      const version = await versionOf("/admin/categories");
      const { status } = await admin("PUT", "/admin/products/ring-001/images", {
        body: {
          images: [
            { id: "x", url: "a.jpg", isPrimary: true },
            { id: "y", url: "b.jpg", isPrimary: true },
          ],
        },
        version,
      });
      assert.equal(status, 400);
    });
  });

  describe("settings", () => {
    test("a tax rate given as a percentage is rejected", async () => {
      const current = await admin("GET", "/admin/settings");
      const { status, json } = await admin("PUT", "/admin/settings/commerce", {
        body: { ...current.json.data.commerce, tax: { rate: 3, label: "3%" } },
        version: current.json.data.version,
      });
      assert.equal(status, 400);
      assert.ok(json.error.fields.some((f) => /tax\.rate/.test(f)));
    });

    test("a valid change reaches the public API", async () => {
      const current = await admin("GET", "/admin/settings");
      const updated = await admin("PUT", "/admin/settings/commerce", {
        body: {
          ...current.json.data.commerce,
          tax: { enabled: true, rate: 0.05, label: "GST (5%)" },
        },
        version: current.json.data.version,
      });
      assert.equal(updated.status, 200);

      const served = await anon("GET", "/settings");
      assert.equal(served.json.data.commerce.tax.rate, 0.05);
      assert.equal(served.json.data.commerce.tax.label, "GST (5%)");
    });


    test("a rejected write leaves no audit trail behind it", async () => {
      const logged = [];
      const original = console.info;
      console.info = (...args) => logged.push(args.join(' '));
      try {
        const current = await admin('GET', '/admin/settings');
        // Consume the version so the next write is stale.
        await admin('PUT', '/admin/settings/commerce', {
          body: current.json.data.commerce,
          version: current.json.data.version,
        });
        const stale = await admin('PUT', '/admin/settings/commerce', {
          body: { ...current.json.data.commerce, tax: { enabled: true, rate: 0.99, label: 'Wrong' } },
          version: current.json.data.version,
        });
        assert.equal(stale.status, 409);
      } finally {
        console.info = original;
      }
      assert.ok(
        !logged.some((line) => /0.99/.test(line)),
        'a rejected price change must not be logged as though it happened',
      );
    });

    test("a negative shipping rate is rejected", async () => {
      const current = await admin("GET", "/admin/settings");
      const { status } = await admin("PUT", "/admin/settings/commerce", {
        body: {
          ...current.json.data.commerce,
          shipping: { flatRate: -100, freeThreshold: 25000 },
        },
        version: current.json.data.version,
      });
      assert.equal(status, 400);
    });
  });

  describe("storefront", () => {
    test("an aspectRatio that would render taller than wide is rejected", async () => {
      const current = await admin("GET", "/admin/storefront");
      const { status, json } = await admin(
        "PUT",
        "/admin/storefront/carousels/home-hero",
        {
          body: { ...current.json.data.carousels["home-hero"], aspectRatio: 0.66 },
          version: current.json.data.version,
        },
      );
      assert.equal(status, 400);
      assert.ok(json.error.fields.some((f) => /aspectRatio/.test(f)));
    });

    test("a carousel still referenced by the home page cannot be deleted", async () => {
      const current = await admin("GET", "/admin/storefront");
      const { status, json } = await admin(
        "DELETE",
        "/admin/storefront/carousels/home-hero",
        { version: current.json.data.version },
      );
      assert.equal(status, 409);
      assert.equal(json.error.code, "RESOURCE_IN_USE");
    });
  });
});
