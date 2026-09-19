"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

/**
 * Upload validation is tested at the service boundary rather than over HTTP:
 * every path that would reach S3 needs credentials, but the request checks
 * that reject a bad upload run before any AWS call and are the part worth
 * pinning down.
 */
process.env.DATA_BUCKET = process.env.DATA_BUCKET || "baba-gold";
const upload = require("../src/services/media/uploadService");

const valid = {
  scope: "product",
  ownerId: "ring-001",
  contentType: "image/jpeg",
  fileSize: 120000,
};

const rejects = async (input, matcher) => {
  await assert.rejects(() => upload.createUploadUrl(input), (error) => {
    assert.equal(error.code, "VALIDATION_FAILED");
    assert.ok(
      error.details.fields.some((f) => matcher.test(f)),
      `no field matched ${matcher}: ${JSON.stringify(error.details.fields)}`,
    );
    return true;
  });
};

describe("media upload requests", () => {
  test("an unknown scope is rejected", async () => {
    await rejects({ ...valid, scope: "wherever" }, /scope/);
  });

  test("a non-image content type is rejected", async () => {
    await rejects({ ...valid, contentType: "application/pdf" }, /contentType/);
  });

  test("an oversized file is rejected before it is uploaded", async () => {
    await rejects({ ...valid, fileSize: upload.MAX_BYTES + 1 }, /fileSize/);
  });

  test("a missing or malformed ownerId is rejected", async () => {
    await rejects({ ...valid, ownerId: "../../etc/passwd" }, /ownerId/);
    await rejects({ ...valid, ownerId: undefined }, /ownerId/);
  });

  test("every problem is reported at once", async () => {
    await assert.rejects(
      () => upload.createUploadUrl({ scope: "nope", contentType: "text/html", fileSize: 0 }),
      (error) => {
        assert.ok(error.details.fields.length >= 3);
        return true;
      },
    );
  });

  test("the allowlist maps each type to the extension its magic bytes imply", () => {
    // The pairing is what stops a JPEG being stored as .png — the mismatch
    // that passes every client check and then fails an Android release build.
    assert.equal(upload.ALLOWED["image/jpeg"].ext, "jpg");
    assert.equal(upload.ALLOWED["image/png"].ext, "png");
    assert.equal(upload.ALLOWED["image/webp"].ext, "webp");
    assert.equal(upload.ALLOWED["image/gif"], undefined);
  });

  test("confirm refuses a key outside the media prefix", async () => {
    await assert.rejects(
      () => upload.confirmUpload({ key: "data/catalog.json" }),
      (error) => {
        assert.equal(error.code, "VALIDATION_FAILED");
        return true;
      },
    );
  });

  test("delete refuses a key outside the media prefix", async () => {
    await assert.rejects(
      () => upload.deleteMedia("data/catalog.json"),
      (error) => {
        assert.equal(error.code, "VALIDATION_FAILED");
        return true;
      },
    );
  });
});

describe('storage key normalisation', () => {
  process.env.DATA_BUCKET = 'baba-gold-in';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/media/mediaService')];
  const { toStorageKey, normalizeStoredMedia } = require('../src/services/media/mediaService');

  const KEY = 'media/products/ring-001/a.jpg';

  test('a presigned URL is reduced to its key', () => {
    // The exact shape that got persisted into catalog.json.
    const signed =
      `https://baba-gold-in.s3.ap-south-1.amazonaws.com/${KEY}` +
      '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc123&X-Amz-Expires=3600';
    assert.equal(toStorageKey(signed), KEY);
  });

  test('an unsigned bucket URL is reduced too', () => {
    assert.equal(toStorageKey(`https://baba-gold-in.s3.ap-south-1.amazonaws.com/${KEY}`), KEY);
  });

  test('a path-style URL drops the bucket segment', () => {
    assert.equal(toStorageKey(`https://s3.ap-south-1.amazonaws.com/baba-gold-in/${KEY}`), KEY);
  });

  test('a relative key passes through unchanged', () => {
    assert.equal(toStorageKey(KEY), KEY);
  });

  test('external URLs are NOT rewritten', () => {
    // The Unsplash placeholders are not ours to touch.
    const unsplash = 'https://images.unsplash.com/photo-123?auto=format&w=800';
    assert.equal(toStorageKey(unsplash), unsplash);
  });

  test('it walks a whole product, images and all', () => {
    const product = {
      id: 'ring-001',
      images: [
        { id: 'a', url: `https://baba-gold-in.s3.ap-south-1.amazonaws.com/${KEY}?X-Amz-Signature=x` },
        { id: 'b', url: 'https://images.unsplash.com/photo-9' },
      ],
      nested: { imageUrl: `https://baba-gold-in.s3.ap-south-1.amazonaws.com/media/x.png?X-Amz-Signature=y` },
    };
    const clean = normalizeStoredMedia(product);
    assert.equal(clean.images[0].url, KEY);
    assert.equal(clean.images[1].url, 'https://images.unsplash.com/photo-9');
    assert.equal(clean.nested.imageUrl, 'media/x.png');
    assert.equal(clean.id, 'ring-001', 'non-media fields are untouched');
  });

  test('nothing signed can survive a round trip', () => {
    const signed = `https://baba-gold-in.s3.ap-south-1.amazonaws.com/${KEY}?X-Amz-Signature=abc`;
    assert.ok(!/X-Amz/.test(toStorageKey(signed)));
  });
});
