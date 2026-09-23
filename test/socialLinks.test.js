"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

process.env.DATA_BUCKET = process.env.DATA_BUCKET || "baba-gold-in";
const {
  collectSocialProblems,
  collectFooterNoteProblems,
  validateCompanyInput,
  MAX_SOCIAL_LINKS,
  MAX_FOOTER_NOTE,
} = require("../src/services/content/companySchema");

describe("social links validation", () => {
  test("absent is fine — a shop need not be on social media", () => {
    assert.deepEqual(collectSocialProblems(undefined), []);
    assert.deepEqual(collectSocialProblems(null), []);
    assert.deepEqual(collectSocialProblems({}), []);
  });

  test("accepts the plain map already stored in every bucket", () => {
    assert.deepEqual(
      collectSocialProblems({
        instagram: "https://instagram.com/babagold",
        facebook: "https://facebook.com/babagold",
        youtube: null,
      }),
      [],
    );
  });

  test("accepts a link carrying its own on/off switch", () => {
    assert.deepEqual(
      collectSocialProblems({
        instagram: { url: "https://instagram.com/babagold", active: true },
        facebook: { url: "https://facebook.com/babagold", active: false },
      }),
      [],
    );
  });

  test("a switched-off link keeps its URL rather than being blanked", () => {
    // The point of the object form: hiding the button must not cost the shop
    // the address, or it gets pasted back in wrong.
    assert.deepEqual(
      collectSocialProblems({
        instagram: { url: "https://instagram.com/babagold", active: false },
      }),
      [],
    );
  });

  test("an empty slot is how a link is left unset", () => {
    assert.deepEqual(collectSocialProblems({ youtube: "" }), []);
    assert.deepEqual(collectSocialProblems({ youtube: null }), []);
    assert.deepEqual(collectSocialProblems({ youtube: { url: "" } }), []);
  });

  test("rejects a link with no scheme — the app would open nothing", () => {
    const problems = collectSocialProblems({ instagram: "instagram.com/babagold" });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /must start with http/);
  });

  test("rejects a link with spaces in it", () => {
    const problems = collectSocialProblems({
      instagram: "https://instagram.com/baba gold",
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /no spaces/);
  });

  test("names the platform in the problem, so the admin can fix it", () => {
    const problems = collectSocialProblems({ facebook: "nope" });
    assert.match(problems[0], /socialLinks\.facebook/);
  });

  test("active must be a boolean, not a string", () => {
    const problems = collectSocialProblems({
      instagram: { url: "https://instagram.com/x", active: "yes" },
    });
    assert.ok(problems.some((p) => /active must be true or false/.test(p)));
  });

  test("rejects a platform key the app could not title", () => {
    const problems = collectSocialProblems({ "My Space!": "https://x.test/y" });
    assert.ok(problems.some((p) => /lowercase letters and numbers/.test(p)));
  });

  test("does not restrict WHICH platforms — a new one needs no app release", () => {
    assert.deepEqual(
      collectSocialProblems({ pinterest: "https://pinterest.com/babagold" }),
      [],
    );
  });

  test("caps how many, since the app draws them in one column", () => {
    const many = {};
    for (let i = 0; i < MAX_SOCIAL_LINKS + 1; i += 1) {
      many[`site${i}`] = "https://example.test/x";
    }
    const problems = collectSocialProblems(many);
    assert.ok(problems.some((p) => /cannot have more than/.test(p)));
  });

  test("rejects a shape that is neither a link nor a link with a switch", () => {
    assert.ok(collectSocialProblems({ instagram: 42 }).length > 0);
    assert.ok(collectSocialProblems({ instagram: ["https://x.test"] }).length > 0);
  });

  test("a list instead of a map is rejected outright", () => {
    assert.deepEqual(collectSocialProblems([]), ["socialLinks must be an object"]);
  });
});

describe("footer note validation", () => {
  test("absent or empty is fine — the line is simply not shown", () => {
    assert.deepEqual(collectFooterNoteProblems(undefined), []);
    assert.deepEqual(collectFooterNoteProblems(null), []);
    assert.deepEqual(collectFooterNoteProblems(""), []);
  });

  test("accepts a short line", () => {
    assert.deepEqual(
      collectFooterNoteProblems("Every piece BIS hallmarked with a HUID"),
      [],
    );
  });

  test("rejects one too long to fit the footer", () => {
    const problems = collectFooterNoteProblems("x".repeat(MAX_FOOTER_NOTE + 1));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /80 characters or fewer/);
  });

  test("rejects a non-string", () => {
    assert.deepEqual(collectFooterNoteProblems(12), ["footerNote must be text"]);
  });
});

describe("validateCompanyInput", () => {
  test("reports every problem at once, across all three fields", () => {
    try {
      validateCompanyInput({
        assurances: [{ id: "bis", label: "BIS", icon: "not-an-icon" }],
        socialLinks: { instagram: "no-scheme" },
        footerNote: 5,
      });
      assert.fail("should have thrown");
    } catch (error) {
      const fields = error.details?.fields ?? [];
      assert.ok(fields.some((f) => /assurances\[0\]\.icon/.test(f)));
      assert.ok(fields.some((f) => /socialLinks\.instagram/.test(f)));
      assert.ok(fields.some((f) => /footerNote/.test(f)));
    }
  });

  test("a document with none of these fields still passes", () => {
    const company = { companyName: "Baba Gold", tagline: "…" };
    assert.equal(validateCompanyInput(company), company);
  });
});
