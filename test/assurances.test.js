"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

process.env.DATA_BUCKET = process.env.DATA_BUCKET || "baba-gold-in";
const {
  collectAssuranceProblems,
  ASSURANCE_ICONS,
  MAX_ASSURANCES,
} = require("../src/services/content/companySchema");

const item = (over = {}) => ({
  id: "bis",
  icon: "award",
  label: "BIS hallmarked",
  active: true,
  ...over,
});

describe("assurances validation", () => {
  test("absent is fine — the app falls back to its own defaults", () => {
    assert.deepEqual(collectAssuranceProblems(undefined), []);
    assert.deepEqual(collectAssuranceProblems(null), []);
  });

  test("an empty list is allowed — the shop may want no trust row", () => {
    assert.deepEqual(collectAssuranceProblems([]), []);
  });

  test("a well-formed list passes", () => {
    assert.deepEqual(
      collectAssuranceProblems([item(), item({ id: "gems", icon: "gem", label: "Certified" })]),
      [],
    );
  });

  test("an icon the app does not bundle is refused", () => {
    // This is the whole reason for the allowlist: an unknown icon would be
    // accepted, saved, and render as a blank space on the phone.
    const problems = collectAssuranceProblems([item({ icon: "diamond-ring" })]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /icon must be one of/);
  });

  test("every advertised icon is actually accepted", () => {
    for (const icon of ASSURANCE_ICONS) {
      assert.deepEqual(
        collectAssuranceProblems([item({ icon })]),
        [],
        `${icon} should be valid`,
      );
    }
  });

  test("a missing or blank label is refused", () => {
    assert.match(collectAssuranceProblems([item({ label: "" })])[0], /label is required/);
    assert.match(collectAssuranceProblems([item({ label: "   " })])[0], /label is required/);
    assert.match(collectAssuranceProblems([item({ label: 5 })])[0], /label is required/);
  });

  test("an over-long label is refused rather than silently truncated", () => {
    const problems = collectAssuranceProblems([item({ label: "x".repeat(29) })]);
    assert.match(problems[0], /28 characters or fewer/);
  });

  test("ids must be slugs, and unique", () => {
    assert.match(collectAssuranceProblems([item({ id: "Has Spaces" })])[0], /lowercase/);
    const dupes = collectAssuranceProblems([item(), item()]);
    assert.match(dupes[0], /used more than once/);
  });

  test("more than the row can hold is refused", () => {
    const many = Array.from({ length: MAX_ASSURANCES + 1 }, (_, i) =>
      item({ id: `a${i}` }),
    );
    assert.match(collectAssuranceProblems(many)[0], /more than/);
  });

  test("a non-list is refused without throwing", () => {
    assert.match(collectAssuranceProblems("award")[0], /must be a list/);
    assert.match(collectAssuranceProblems({})[0], /must be a list/);
  });

  test("active must be a boolean when present", () => {
    assert.match(collectAssuranceProblems([item({ active: "yes" })])[0], /true or false/);
    assert.deepEqual(collectAssuranceProblems([item({ active: undefined })]), []);
  });
});
