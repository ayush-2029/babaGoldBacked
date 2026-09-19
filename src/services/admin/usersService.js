"use strict";

const crypto = require("crypto");
const {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const config = require("../../config");
const { ApiError, validation } = require("../../utils/errors");
const { ROLES } = require("../../middleware/auth/requireAdmin");

/**
 * Managing who can sign in to the admin portal.
 *
 * Cognito is the store — there is no user table of our own, so there is
 * nothing to keep in sync and nothing to leak. Roles are Cognito groups.
 *
 * Every mutating function here takes the CALLER, because the guards that
 * matter are all about the caller acting on themselves: removing your own
 * access, or removing the last administrator, would lock everyone out of the
 * portal with no way back except the AWS console.
 */

let client;
const cognito = () => {
  if (!client) {
    client = new CognitoIdentityProviderClient({ region: config.region });
  }
  return client;
};

const poolId = () => {
  const id = process.env.COGNITO_USER_POOL_ID;
  if (!id) {
    throw new ApiError(
      "INTERNAL_ERROR",
      "User management is not configured for this environment.",
    );
  }
  return id;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const VALID_ROLES = [ROLES.ADMIN, ROLES.VIEWER];

const attr = (user, name) =>
  (user.Attributes ?? user.UserAttributes ?? []).find((a) => a.Name === name)?.Value;

/**
 * Shapes a Cognito user for the portal. Deliberately narrow: the portal needs
 * an identity, a role and a state, not the full Cognito record.
 */
const present = (user, roles = []) => ({
  username: user.Username,
  email: attr(user, "email") ?? user.Username,
  role: roles.includes(ROLES.ADMIN) ? ROLES.ADMIN : ROLES.VIEWER,
  enabled: user.Enabled !== false,
  // FORCE_CHANGE_PASSWORD means they have been invited but never signed in.
  status: user.UserStatus,
  pendingFirstSignIn: user.UserStatus === "FORCE_CHANGE_PASSWORD",
  createdAt: user.UserCreateDate,
});

async function rolesOf(username) {
  const result = await cognito().send(
    new AdminListGroupsForUserCommand({ UserPoolId: poolId(), Username: username }),
  );
  return (result.Groups ?? []).map((group) => group.GroupName);
}

async function listUsers() {
  const result = await cognito().send(
    new ListUsersCommand({ UserPoolId: poolId(), Limit: 60 }),
  );

  const users = await Promise.all(
    (result.Users ?? []).map(async (user) => present(user, await rolesOf(user.Username))),
  );

  users.sort((a, b) => a.email.localeCompare(b.email));
  return users;
}

/** How many administrators remain — the number the lockout guards protect. */
async function adminCount() {
  const result = await cognito().send(
    new ListUsersInGroupCommand({
      UserPoolId: poolId(),
      GroupName: ROLES.ADMIN,
      Limit: 60,
    }),
  );
  return (result.Users ?? []).filter((user) => user.Enabled !== false).length;
}

/**
 * A temporary password that satisfies the pool policy: 10+ characters with an
 * uppercase, a lowercase and a digit. Ambiguous characters are left out
 * because this gets read aloud or copied by hand.
 */
function temporaryPassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const pick = (set, n) =>
    Array.from({ length: n }, () => set[crypto.randomInt(set.length)]);

  const chars = [...pick(upper, 3), ...pick(lower, 6), ...pick(digits, 4)];
  // Shuffle so the character classes are not in a predictable order.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/**
 * Invites someone.
 *
 * The temporary password is returned ONCE, to the administrator who created
 * the account, so they can pass it on. Cognito's own invitation email is
 * suppressed: its default sender lands in spam often enough that a shop would
 * conclude the feature is broken. The account cannot be used until its owner
 * replaces the password at first sign-in, so this is a one-time handover
 * secret rather than a working credential.
 *
 * Move to SES and Cognito-sent invitations before this is used at any scale.
 */
async function createUser({ email, role }, actor) {
  const problems = [];
  if (!EMAIL.test(email ?? "")) problems.push("email must be a valid address");
  if (!VALID_ROLES.includes(role)) {
    problems.push(`role must be one of: ${VALID_ROLES.join(", ")}`);
  }
  if (problems.length > 0) {
    throw validation("This user could not be added.", { fields: problems });
  }

  const username = email.trim().toLowerCase();
  const password = temporaryPassword();

  try {
    await cognito().send(
      new AdminCreateUserCommand({
        UserPoolId: poolId(),
        Username: username,
        TemporaryPassword: password,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: username },
          { Name: "email_verified", Value: "true" },
        ],
      }),
    );
  } catch (error) {
    if (error.name === "UsernameExistsException") {
      throw new ApiError("DUPLICATE_ID", "Someone with that email already has access.");
    }
    throw error;
  }

  await cognito().send(
    new AdminAddUserToGroupCommand({
      UserPoolId: poolId(),
      Username: username,
      GroupName: role,
    }),
  );

  console.info("[audit] admin user invited", {
    actor: actor?.email ?? actor?.userId,
    user: username,
    role,
  });

  const created = await cognito().send(
    new AdminGetUserCommand({ UserPoolId: poolId(), Username: username }),
  );

  return {
    ...present({ ...created, Attributes: created.UserAttributes }, [role]),
    temporaryPassword: password,
  };
}

/**
 * Ends every active session for a user.
 *
 * Necessary because a Cognito access token carries the group membership it had
 * WHEN IT WAS ISSUED. Demote someone and their existing token still says
 * "admin" until it expires — the API verifies a signature, it does not call
 * Cognito on every request. Without this, a revoked administrator keeps
 * administrator access for up to the token's remaining life.
 *
 * This revokes their refresh tokens, so they cannot extend the session and
 * must sign in again — at which point the new role applies. The window shrinks
 * to whatever is left on the access token they already hold (an hour at most).
 *
 * Closing that window entirely would mean checking a revocation list on every
 * request, which trades the whole benefit of stateless verification for an
 * hour. Not worth it at this scale, but say so rather than leave it implied.
 *
 * Best effort: a failure here must not roll back the role change itself.
 */
async function endSessions(username, reason) {
  try {
    await cognito().send(
      new AdminUserGlobalSignOutCommand({ UserPoolId: poolId(), Username: username }),
    );
  } catch (error) {
    console.warn("[auth] could not end sessions", { user: username, reason, name: error.name });
  }
}

/** Guard: nothing may leave the portal without a way back in. */
async function assertNotLastAdmin(username, actor, action) {
  const roles = await rolesOf(username);
  if (!roles.includes(ROLES.ADMIN)) {
    return;
  }
  if ((await adminCount()) <= 1) {
    throw new ApiError(
      "FORBIDDEN",
      `This is the only administrator left. ${action} would lock everyone out of the portal.`,
    );
  }
  if (username === actor?.email || username === actor?.userId) {
    // Allowed when another admin exists, but worth saying out loud.
    console.warn("[audit] administrator acting on their own access", {
      actor: actor?.email,
      action,
    });
  }
}

async function setRole(username, role, actor) {
  if (!VALID_ROLES.includes(role)) {
    throw validation(`role must be one of: ${VALID_ROLES.join(", ")}`);
  }

  if (role !== ROLES.ADMIN) {
    await assertNotLastAdmin(username, actor, "Removing their admin access");
  }

  const current = await rolesOf(username);

  await Promise.all(
    current
      .filter((group) => VALID_ROLES.includes(group) && group !== role)
      .map((group) =>
        cognito().send(
          new AdminRemoveUserFromGroupCommand({
            UserPoolId: poolId(),
            Username: username,
            GroupName: group,
          }),
        ),
      ),
  );

  if (!current.includes(role)) {
    await cognito().send(
      new AdminAddUserToGroupCommand({
        UserPoolId: poolId(),
        Username: username,
        GroupName: role,
      }),
    );
  }

  // The new role only takes effect on their next sign-in, so force one.
  await endSessions(username, "role changed");

  console.info("[audit] admin role changed", {
    actor: actor?.email ?? actor?.userId,
    user: username,
    from: current.join(","),
    to: role,
  });

  return { username, role };
}

async function setEnabled(username, enabled, actor) {
  if (!enabled) {
    await assertNotLastAdmin(username, actor, "Suspending them");
  }

  await cognito().send(
    enabled
      ? new AdminEnableUserCommand({ UserPoolId: poolId(), Username: username })
      : new AdminDisableUserCommand({ UserPoolId: poolId(), Username: username }),
  );

  if (!enabled) {
    await endSessions(username, "suspended");
  }

  console.info("[audit] admin user " + (enabled ? "restored" : "suspended"), {
    actor: actor?.email ?? actor?.userId,
    user: username,
  });

  return { username, enabled };
}

async function deleteUser(username, actor) {
  await assertNotLastAdmin(username, actor, "Removing them");

  await cognito().send(
    new AdminDeleteUserCommand({ UserPoolId: poolId(), Username: username }),
  );

  console.info("[audit] admin user removed", {
    actor: actor?.email ?? actor?.userId,
    user: username,
  });

  return { username, deleted: true };
}

/**
 * Issues a fresh temporary password.
 *
 * Set as temporary, not permanent, so the account returns to
 * FORCE_CHANGE_PASSWORD and the owner must choose their own again — a reset
 * that leaves a password the administrator knows is not a reset.
 */
async function resetPassword(username, actor) {
  const password = temporaryPassword();

  await cognito().send(
    new AdminSetUserPasswordCommand({
      UserPoolId: poolId(),
      Username: username,
      Password: password,
      Permanent: false,
    }),
  );

  await endSessions(username, "password reset");

  console.info("[audit] admin password reset", {
    actor: actor?.email ?? actor?.userId,
    user: username,
  });

  return { username, temporaryPassword: password };
}

module.exports = {
  listUsers,
  createUser,
  setRole,
  setEnabled,
  deleteUser,
  resetPassword,
  VALID_ROLES,
};
