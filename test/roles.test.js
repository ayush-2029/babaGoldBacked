"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

process.env.DATA_BUCKET = process.env.DATA_BUCKET || "baba-gold-in";
const {
  requireWriteAccess,
  requireAdminRole,
  isAdmin,
  ROLES,
} = require("../src/middleware/auth/requireAdmin");

/**
 * Authorisation, tested directly.
 *
 * These guards decide whether a read-only account can change the shop's
 * prices. A regression here is silent — everything still works, it just works
 * for people it should not.
 */

/** Runs a middleware and reports what it did. */
function run(middleware, { method = "GET", roles = [] } = {}) {
  const req = { method, admin: { userId: "u", email: "a@b.c", roles } };
  let error = null;
  let passed = false;
  middleware(req, {}, (err) => {
    if (err) error = err;
    else passed = true;
  });
  return { passed, error };
}

describe("write access", () => {
  const admin = [ROLES.ADMIN];
  const viewer = [ROLES.VIEWER];

  test("an admin may use every mutating verb", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.ok(run(requireWriteAccess, { method, roles: admin }).passed, method);
    }
  });

  test("a viewer may read", () => {
    assert.ok(run(requireWriteAccess, { method: "GET", roles: viewer }).passed);
  });

  test("a viewer may not write, by any verb", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const { passed, error } = run(requireWriteAccess, { method, roles: viewer });
      assert.equal(passed, false, `${method} was allowed`);
      assert.equal(error.code, "FORBIDDEN");
      assert.match(error.message, /read-only/i, 'the refusal should say why');
    }
  });

  test("a signed-in user with NO group is treated as read-only", () => {
    // Forgetting to assign a group must cost write access, never grant it.
    const { passed, error } = run(requireWriteAccess, { method: "POST", roles: [] });
    assert.equal(passed, false);
    assert.equal(error.code, "FORBIDDEN");
  });

  test("an unrecognised group grants nothing", () => {
    const { passed } = run(requireWriteAccess, {
      method: "DELETE",
      roles: ["superuser", "root", "owner"],
    });
    assert.equal(passed, false, 'only the literal "admin" group grants writes');
  });
});

describe("user management access", () => {
  test("only an admin may reach it, reads included", () => {
    assert.ok(run(requireAdminRole, { roles: [ROLES.ADMIN] }).passed);

    for (const roles of [[ROLES.VIEWER], [], ["admins"], ["Admin"]]) {
      const { passed, error } = run(requireAdminRole, { method: "GET", roles });
      assert.equal(passed, false, `${JSON.stringify(roles)} got through`);
      assert.equal(error.code, "FORBIDDEN");
    }
  });

  test("the role check is case-sensitive and exact", () => {
    // Cognito group names are case-sensitive; a near-miss must not pass.
    assert.equal(isAdmin({ admin: { roles: ["Admin"] } }), false);
    assert.equal(isAdmin({ admin: { roles: ["administrator"] } }), false);
    assert.equal(isAdmin({ admin: { roles: ["admin"] } }), true);
  });

  test("a missing admin object does not throw", () => {
    assert.equal(isAdmin({}), false);
    assert.equal(isAdmin({ admin: {} }), false);
  });
});
