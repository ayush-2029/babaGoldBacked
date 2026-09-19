"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

/**
 * The signing window, tested directly rather than over HTTP: presigning needs
 * AWS credentials, but the window arithmetic is what actually guarantees no
 * client is ever handed a dead image URL, and it is pure.
 */
process.env.DATA_BUCKET = process.env.DATA_BUCKET || "baba-gold-in";
process.env.MEDIA_URL_MODE = "signed";
process.env.SIGNED_URL_TTL = "3600";
process.env.SIGNING_WINDOW = "2700";

delete require.cache[require.resolve("../src/config")];
const config = require("../src/config");
const { currentWindow } = require("../src/services/media/mediaService");

describe("signed URL windows", () => {
  const TTL = config.media.signedUrlTtlSeconds;
  const WINDOW = config.media.signingWindowSeconds;

  test("the TTL outlives the window, or URLs would expire in a client's hands", () => {
    assert.ok(
      TTL > WINDOW,
      `ttl ${TTL}s must exceed window ${WINDOW}s — the gap is the safety margin`,
    );
  });

  test("a URL minted at the last instant of a window still has life left", () => {
    // Worst case: signed at window start, handed out one second before the
    // window rolls. Whatever is left is the least a client can ever receive.
    const worstCase = TTL - WINDOW;
    assert.ok(worstCase >= 600, `only ${worstCase}s of margin; want >= 600s`);
  });

  test("every request inside one window signs from the same instant", () => {
    // Must start from an aligned boundary: an arbitrary timestamp sits partway
    // through a window, so +WINDOW-1 from it would cross into the next one.
    const start = Math.floor(1_700_000_000 / WINDOW) * WINDOW;
    const a = currentWindow(start * 1000);
    const b = currentWindow((start + WINDOW - 1) * 1000);
    assert.equal(
      a.signingDate.getTime(),
      b.signingDate.getTime(),
      "identical signing dates are what keep image caching alive",
    );
    assert.equal(a.start, b.start);
  });

  test("crossing a boundary mints a new window", () => {
    const start = Math.floor(1_700_000_000 / WINDOW) * WINDOW;
    const before = currentWindow((start + WINDOW - 1) * 1000);
    const after = currentWindow((start + WINDOW) * 1000);
    assert.notEqual(before.start, after.start);
  });

  test("endsIn never exceeds expiresIn", () => {
    // Cache headers are clamped to endsIn; if it could exceed the URL's own
    // life, a cached response would outlive the links inside it.
    for (let offset = 0; offset < WINDOW; offset += 137) {
      const w = currentWindow((1_700_000_000 + offset) * 1000);
      assert.ok(
        w.endsIn <= w.expiresIn,
        `at +${offset}s: endsIn ${w.endsIn} > expiresIn ${w.expiresIn}`,
      );
      assert.ok(w.expiresIn > 0);
    }
  });

  test("the cache window is always shorter than the signature it protects", () => {
    const w = currentWindow();
    assert.ok(w.endsIn <= WINDOW);
    assert.ok(w.expiresIn <= TTL);
  });
});
