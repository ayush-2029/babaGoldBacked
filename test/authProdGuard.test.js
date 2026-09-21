"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

process.env.DATA_BUCKET = process.env.DATA_BUCKET || "baba-gold-in";

/**
 * The shared-secret admin bypass must not be usable against production data.
 *
 * AUTH_MODE=token exists so the panel could be built before a user pool did.
 * It has no identity and no revocation, so requireAdmin refuses it whenever
 * `config.isProduction` — which makes the definition of isProduction a
 * security boundary rather than a label.
 *
 * The gap these tests close: isProduction used to read STAGE alone, so a
 * deployment named "dev" pointed at APP_ENV=prod would serve production data
 * while still accepting a shared secret.
 */
function configWith({ stage, appEnv }) {
  const before = { STAGE: process.env.STAGE, APP_ENV: process.env.APP_ENV };

  if (stage === undefined) delete process.env.STAGE;
  else process.env.STAGE = stage;
  if (appEnv === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = appEnv;

  delete require.cache[require.resolve("../src/config")];
  const config = require("../src/config");

  process.env.STAGE = before.STAGE;
  process.env.APP_ENV = before.APP_ENV;
  if (before.STAGE === undefined) delete process.env.STAGE;
  if (before.APP_ENV === undefined) delete process.env.APP_ENV;

  return config;
}

describe("production guard", () => {
  test("a prod stage is production", () => {
    assert.equal(configWith({ stage: "prod", appEnv: "prod" }).isProduction, true);
    assert.equal(configWith({ stage: "production", appEnv: "prod" }).isProduction, true);
  });

  test("THE GAP: a dev-named stage reading PROD data is still production", () => {
    // Reading production data IS being production, whatever the stage is
    // called. Without this the shared-secret bypass would be accepted.
    assert.equal(configWith({ stage: "dev", appEnv: "prod" }).isProduction, true);
    assert.equal(configWith({ stage: "staging", appEnv: "prod" }).isProduction, true);
  });

  test("a genuinely dev deployment is not production", () => {
    // Otherwise the token mode this exists for could never be used at all.
    assert.equal(configWith({ stage: "dev", appEnv: "dev" }).isProduction, false);
  });

  test("defaults are the safe combination", () => {
    // Nothing set: APP_ENV defaults to dev, STAGE defaults to dev. Not
    // production, so local work still functions — and it reads dev data, so
    // there is nothing of value behind the bypass.
    const c = configWith({});
    assert.equal(c.isProduction, false);
    assert.equal(c.appEnv, "dev");
  });

  test("the guard cannot be turned off by a typo in APP_ENV", () => {
    // Anything that is not exactly "prod" resolves to dev, which is the safe
    // direction for the DATA — and the stage still decides on its own.
    assert.equal(configWith({ stage: "prod", appEnv: "prodd" }).isProduction, true);
    assert.equal(configWith({ stage: "dev", appEnv: "prodd" }).isProduction, false);
  });
});
