"use strict";

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

process.env.DATA_BUCKET = process.env.DATA_BUCKET || "baba-gold-in";
/*
 * These MUST be set before the requires below.
 *
 * jsonRepository picks its driver at module load, and reads READ_CACHE_TTL_MS
 * into a const at the same moment. Requiring noticeService first bound the
 * suite to the S3 driver, so every read failed — and because this service
 * fails open, the "no notice configured" test passed for entirely the wrong
 * reason while the one that wrote a file failed.
 */
process.env.STORAGE_DRIVER = "local";
process.env.READ_CACHE_TTL_MS = "0";

const { normalise, SILENT } = require("../src/services/content/noticeService");
const { startServer } = require("./helpers");

/**
 * The operator notice can stop every customer using the app, and it is
 * hand-edited JSON rather than something a validated form produces. So the
 * tests are mostly about what must NOT happen: a typo must never block a
 * shop, and the panel must never be able to touch it.
 */
describe("notice normalisation", () => {
  test("no document at all is silence", () => {
    assert.deepEqual(normalise(undefined), SILENT);
    assert.deepEqual(normalise(null), SILENT);
  });

  test("enabled must be exactly true", () => {
    // A hand-edited "true" or 1 is a typo, not consent to block a shop.
    assert.equal(normalise({ enabled: "true", message: "hi" }).enabled, false);
    assert.equal(normalise({ enabled: 1, message: "hi" }).enabled, false);
    assert.equal(normalise({ message: "hi" }).enabled, false);
  });

  test("an enabled notice with no message is ignored", () => {
    // A blocking screen with no words is a dead end.
    assert.equal(normalise({ enabled: true, mode: "block" }).enabled, false);
    assert.equal(normalise({ enabled: true, message: "   " }).enabled, false);
  });

  test("a valid message notice passes through", () => {
    const n = normalise({
      enabled: true,
      mode: "message",
      id: "sep-2026",
      title: "Service notice",
      message: "Back shortly.",
    });
    assert.equal(n.enabled, true);
    assert.equal(n.mode, "message");
    assert.equal(n.id, "sep-2026");
    assert.equal(n.message, "Back shortly.");
  });

  test("block mode is honoured when asked for exactly", () => {
    assert.equal(normalise({ enabled: true, mode: "block", message: "x" }).mode, "block");
  });

  test("ANY other mode degrades to a dismissible message", () => {
    // Blocking is the destructive option, so it is never the fallback.
    for (const mode of ["Block", "BLOCK", "blocked", "hard", "", undefined, 7]) {
      assert.equal(
        normalise({ enabled: true, mode, message: "x" }).mode,
        "message",
        `mode ${JSON.stringify(mode)} must not block`,
      );
    }
  });

  test("missing title and id get usable defaults", () => {
    const n = normalise({ enabled: true, message: "x" });
    assert.equal(n.title, "Service notice");
    assert.equal(n.id, "notice");
    assert.equal(n.contact, null);
  });
});

describe("GET /notice", () => {
  let server;
  after(async () => server && server.close());

  test("is silent when no notice.json exists", async () => {
    server = await startServer();
    const res = await fetch(`${server.base}/notice`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.enabled, false);
  });

  test("serves a notice once the file is put in the bucket by hand", async () => {
    fs.writeFileSync(
      path.join(server.dir, "notice.json"),
      JSON.stringify({
        enabled: true,
        mode: "block",
        id: "overdue",
        title: "Service paused",
        message: "Please contact the developer.",
        contact: "+91 00000 00000",
      }),
    );

    const res = await fetch(`${server.base}/notice`);
    const body = await res.json();
    assert.equal(body.data.enabled, true);
    assert.equal(body.data.mode, "block");
    assert.equal(body.data.contact, "+91 00000 00000");
  });

  test("is never cached — a block must lift the moment it is removed", async () => {
    const res = await fetch(`${server.base}/notice`);
    assert.match(res.headers.get("cache-control") || "", /no-store/);
  });

  test("malformed JSON does not take the shop down", async () => {
    fs.writeFileSync(path.join(server.dir, "notice.json"), "{ not json at all");
    const res = await fetch(`${server.base}/notice`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.enabled, false);
  });

  test("needs no authentication — the app is anonymous", async () => {
    fs.rmSync(path.join(server.dir, "notice.json"), { force: true });
    const res = await fetch(`${server.base}/notice`);
    assert.equal(res.status, 200);
  });

  test("it is NOT in the bootstrap payload", async () => {
    // Bootstrap is cached by the app; a notice must be read fresh each launch.
    const body = await (await fetch(`${server.base}/bootstrap`)).json();
    assert.equal(body.data.notice, undefined);
  });

  test("there is NO admin route for it, with or without a token", async () => {
    // The whole point: the panel cannot reach this, so the shop cannot
    // change it and cannot accidentally clear it either.
    for (const path_ of ["/admin/notice", "/admin/notices"]) {
      const res = await fetch(`${server.base}${path_}`, {
        headers: { Authorization: "Bearer test-token" },
      });
      assert.equal(res.status, 404, `${path_} must not exist`);
    }
  });

  test("and it cannot be written through the admin document route", async () => {
    const res = await fetch(`${server.base}/admin/notice`, {
      method: "PUT",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
        "If-Match": "x",
      },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 404);
  });
});
