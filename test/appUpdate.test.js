"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

process.env.DATA_BUCKET = process.env.DATA_BUCKET || "baba-gold-in";
const { collectProblems } = require("../src/services/content/settingsSchema");

/**
 * The update gate's config decides whether an app opens at all, so the
 * validator is tested for the ways it could brick every installed copy.
 */
const base = () => ({
  commerce: {
    currency: "INR",
    tax: { rate: 0.03, label: "GST (3%)" },
    shipping: { flatRate: 250, freeThreshold: 25000 },
    maxQuantityPerItem: 10,
  },
});

const withUpdate = (appUpdate) => ({ ...base(), appUpdate });
const problemsFor = (appUpdate) =>
  collectProblems(withUpdate(appUpdate)).filter((p) => p.includes("appUpdate"));

describe("app update config", () => {
  test("absent config is fine — the feature is optional", () => {
    assert.deepEqual(collectProblems(base()), []);
  });

  test("a well-formed config passes", () => {
    assert.deepEqual(
      problemsFor({
        enabled: true,
        latestVersion: "1.2.0",
        minimumVersion: "1.0.0",
        updateType: "soft",
        storeUrl: { android: "https://play.google.com/store/apps/details?id=com.babagold" },
      }),
      [],
    );
  });

  test("version strings must look like versions", () => {
    assert.ok(problemsFor({ latestVersion: "newest" }).length > 0);
    assert.ok(problemsFor({ minimumVersion: "latest" }).length > 0);
    // Short forms are legitimate — Android's versionName is often "1.0".
    assert.deepEqual(problemsFor({ latestVersion: "1.0" }), []);
  });

  test("updateType is limited to soft or hard", () => {
    assert.ok(problemsFor({ updateType: "force" }).length > 0);
    assert.deepEqual(problemsFor({ updateType: "hard" }), []);
  });

  test("REFUSES a minimum newer than the latest release", () => {
    // Everyone blocked, with no version in the store that would satisfy it.
    const problems = problemsFor({
      enabled: true,
      latestVersion: "1.2.0",
      minimumVersion: "1.5.0",
      storeUrl: { android: "https://play.google.com/store" },
    });
    assert.ok(problems.some((p) => /cannot be newer/.test(p)), problems.join("; "));
  });

  test("REFUSES an enabled config with no store link", () => {
    // Telling customers to update without giving them a way to do it.
    const problems = problemsFor({
      enabled: true,
      latestVersion: "1.2.0",
      updateType: "hard",
    });
    assert.ok(problems.some((p) => /store link/.test(p)), problems.join("; "));
  });

  test("REFUSES an enabled config with no latest version", () => {
    const problems = problemsFor({
      enabled: true,
      storeUrl: { android: "https://play.google.com/store" },
    });
    assert.ok(problems.some((p) => /latestVersion is required/.test(p)));
  });

  test("a DISABLED config is not held to those rules", () => {
    // Half-filled drafts must be savable; nothing is enforced until it is on.
    assert.deepEqual(problemsFor({ enabled: false, updateType: "hard" }), []);
  });

  test("one store link is enough", () => {
    assert.deepEqual(
      problemsFor({
        enabled: true,
        latestVersion: "1.2.0",
        storeUrl: { ios: "https://apps.apple.com/app/id1" },
      }),
      [],
    );
  });
});
