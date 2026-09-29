"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

process.env.DATA_BUCKET = process.env.DATA_BUCKET || "baba-gold-in";
const { collectProblems } = require("../src/services/content/settingsSchema");

/**
 * The short promises beside the empty cart and at checkout.
 *
 * Editable from the panel, so the validator is what stands between a typo and
 * a broken cart screen — and it must not reject the documents already sitting
 * in the bucket, which have no `showAssurances` at all.
 */
const base = () => ({
  commerce: {
    currency: "INR",
    tax: { rate: 0.03, label: "GST (3%)" },
    shipping: { flatRate: 250, freeThreshold: 25000 },
    maxQuantityPerItem: 10,
  },
});

const withCheckout = (checkout) => ({ ...base(), checkout });
const problemsFor = (checkout) =>
  collectProblems(withCheckout(checkout)).filter((p) => p.includes("checkout"));

describe("checkout assurances", () => {
  test("absent checkout is fine", () => {
    assert.deepEqual(collectProblems(base()), []);
  });

  test("THE EXISTING DOCUMENT STILL VALIDATES — no showAssurances key", () => {
    // This is what is in the bucket today. A migration must not be needed.
    assert.deepEqual(
      problemsFor({
        mode: "whatsapp",
        assurances: ["✨ Premium Quality", "💎 Trendy Designs"],
      }),
      [],
    );
  });

  test("the switch is accepted either way", () => {
    assert.deepEqual(problemsFor({ showAssurances: true }), []);
    assert.deepEqual(problemsFor({ showAssurances: false }), []);
  });

  test("a non-boolean switch is refused", () => {
    // "false" as a string would read as truthy and silently show them.
    assert.match(problemsFor({ showAssurances: "false" })[0], /true or false/);
    assert.match(problemsFor({ showAssurances: 0 })[0], /true or false/);
  });

  test("an empty list is allowed — that is a valid choice", () => {
    assert.deepEqual(problemsFor({ assurances: [] }), []);
  });

  test("a non-array is refused", () => {
    assert.match(problemsFor({ assurances: "Premium" })[0], /must be an array/);
  });

  test("blank entries are refused rather than rendered as gaps", () => {
    assert.match(problemsFor({ assurances: ["ok", "   "] })[0], /non-empty/);
    assert.match(problemsFor({ assurances: ["ok", 5] })[0], /non-empty/);
  });

  test("more than the row can hold is refused", () => {
    const many = Array.from({ length: 7 }, (_, i) => `promise ${i}`);
    assert.match(problemsFor({ assurances: many })[0], /more than 6/);
  });

  test("an over-long promise is refused rather than truncated on the phone", () => {
    assert.match(
      problemsFor({ assurances: ["x".repeat(41)] })[0],
      /40 characters or fewer/,
    );
    assert.deepEqual(problemsFor({ assurances: ["x".repeat(40)] }), []);
  });
});

/**
 * The single line under the cart total.
 *
 * Empty is the off switch — there is deliberately no separate boolean, so the
 * text and its visibility cannot drift apart.
 */
describe("checkout.cartNote", () => {
  const problemsFor = (checkout) => collectProblems(withCheckout(checkout));

  test("absent is fine — documents already in the bucket have no cartNote", () => {
    assert.deepEqual(problemsFor({}), []);
  });

  test("empty or null means the line is simply not shown", () => {
    assert.deepEqual(problemsFor({ cartNote: "" }), []);
    assert.deepEqual(problemsFor({ cartNote: null }), []);
  });

  test("accepts the line the app used to hardcode", () => {
    assert.deepEqual(
      problemsFor({ cartNote: "BIS hallmarked · Final price confirmed before billing" }),
      [],
    );
  });

  test("rejects a line too long for one row under the total", () => {
    assert.match(
      problemsFor({ cartNote: "x".repeat(81) })[0],
      /80 characters or fewer/,
    );
    assert.deepEqual(problemsFor({ cartNote: "x".repeat(80) }), []);
  });

  test("rejects a non-string", () => {
    assert.match(problemsFor({ cartNote: 5 })[0], /must be text/);
  });
});

/**
 * The version line on Profile.
 *
 * Absent means shown, like every other switch, so a settings.json already in
 * the bucket keeps behaving as it does.
 */
describe("profile.showVersion", () => {
  const problemsFor = (profile) => collectProblems({ ...base(), profile });

  test("absent is fine — no document in the bucket has it", () => {
    assert.deepEqual(collectProblems(base()), []);
  });

  test("accepts either setting", () => {
    assert.deepEqual(problemsFor({ showVersion: true }), []);
    assert.deepEqual(problemsFor({ showVersion: false }), []);
  });

  test("rejects a string, which is how a checkbox gets saved wrong", () => {
    assert.match(problemsFor({ showVersion: "false" })[0], /must be true or false/);
  });

  test("rejects a profile that is not an object", () => {
    assert.match(collectProblems({ ...base(), profile: "yes" })[0], /must be an object/);
  });
});

/**
 * "What happens next" — the numbered steps on the checkout screen.
 *
 * These describe what the shop will DO once a quote is sent, so only the shop
 * can say whether they are still true.
 */
describe("checkout.steps and keptNote", () => {
  const problemsFor = (checkout) => collectProblems(withCheckout(checkout));

  test("absent is fine — the app keeps its own wording", () => {
    assert.deepEqual(problemsFor({}), []);
  });

  test("an empty list is allowed — it removes the section", () => {
    assert.deepEqual(problemsFor({ steps: [] }), []);
  });

  test("accepts the three the app used to hardcode", () => {
    assert.deepEqual(
      problemsFor({
        steps: [
          { title: "Press send in WhatsApp", body: "Nothing reaches the shop until you send it." },
          { title: "We confirm availability" },
          { title: "You receive the final quote", body: "Nothing is billed until you approve it." },
        ],
      }),
      [],
    );
  });

  test("a step needs a title", () => {
    assert.match(problemsFor({ steps: [{ body: "no title" }] })[0], /title is required/);
  });

  test("a body is optional", () => {
    assert.deepEqual(problemsFor({ steps: [{ title: "Just a title" }] }), []);
  });

  test("names the step that is wrong, so the admin can fix it", () => {
    const problems = problemsFor({
      steps: [{ title: "ok" }, { title: "x".repeat(51) }],
    });
    assert.ok(problems.some((p) => /checkout\.steps\[1\]\.title/.test(p)));
  });

  test("caps the count, since the app numbers them down one screen", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ title: `Step ${i}` }));
    assert.match(problemsFor({ steps: many })[0], /more than 5/);
  });

  test("rejects a step that is not an object", () => {
    assert.match(problemsFor({ steps: ["just a string"] })[0], /must be an object/);
  });

  test("keptNote is optional and length-checked", () => {
    assert.deepEqual(problemsFor({ keptNote: "" }), []);
    assert.deepEqual(problemsFor({ keptNote: "Your pieces stay in the cart." }), []);
    assert.match(problemsFor({ keptNote: "x".repeat(201) })[0], /200 characters or fewer/);
  });
});
