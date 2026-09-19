"use strict";

const crypto = require("crypto");
const { ApiError } = require("../../utils/errors");
const config = require("../../config");

/**
 * Admin authentication. Two real modes, chosen by AUTH_MODE:
 *
 *   cognito — verifies a JWT against the user pool. The documented end state
 *             (claude.md §22): the panel talks to Cognito directly and sends
 *             the token here. Requires COGNITO_USER_POOL_ID and
 *             COGNITO_CLIENT_ID.
 *
 *   token   — a shared secret in ADMIN_API_TOKEN, compared in constant time.
 *             Enough to build and test the admin panel against before a user
 *             pool exists. Single-actor, no identity, no revocation — so it is
 *             refused in production below.
 *
 * There is deliberately no "off" switch. An unauthenticated admin route is a
 * writable storefront, and the failure mode is silent.
 */

const mode = () => process.env.AUTH_MODE || "token";

/** Lazily built so the JWKS fetch happens once per container, not per request. */
let verifier;
function cognitoVerifier() {
  if (!verifier) {
    const { CognitoJwtVerifier } = require("aws-jwt-verify");
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    const clientId = process.env.COGNITO_CLIENT_ID;
    if (!userPoolId || !clientId) {
      throw new Error(
        "AUTH_MODE=cognito requires COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID",
      );
    }
    verifier = CognitoJwtVerifier.create({
      userPoolId,
      clientId,
      tokenUse: "access",
    });
  }
  return verifier;
}

/**
 * Resolves the shared secret.
 *
 * Preferred: ADMIN_TOKEN_SSM_PARAM names a SecureString parameter and the
 * value is fetched at cold start. Only the PATH is ever in the Lambda config,
 * so the secret stays out of the CloudFormation template, out of the function's
 * environment, and off the deploying machine's disk — all three places a
 * deploy-time `${ssm:...}` substitution would have written it in plaintext.
 *
 * ADMIN_API_TOKEN is still read as a direct fallback for local development,
 * where there is no SSM and no deploy artifact to leak into.
 */
let cachedSecret;
async function adminSecret() {
  if (cachedSecret !== undefined) {
    return cachedSecret;
  }

  const path = process.env.ADMIN_TOKEN_SSM_PARAM;
  if (path) {
    const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
    const client = new SSMClient({ region: config.region });
    const response = await client.send(
      new GetParameterCommand({ Name: path, WithDecryption: true }),
    );
    cachedSecret = response.Parameter?.Value || null;
    return cachedSecret;
  }

  cachedSecret = process.env.ADMIN_API_TOKEN || null;
  return cachedSecret;
}

/**
 * Resolves a user's email address from their Cognito subject id.
 *
 * A Cognito ACCESS token carries no `email` claim — that lives on the ID
 * token, which the API deliberately does not accept for authorisation. And
 * because this pool uses email as a username *alias*, `claims.username` is the
 * subject UUID, not an address. Reading either straight off the token is how
 * the portal ended up showing "01531d9a-b001-70…" where a name belongs, and
 * how the audit log ended up recording UUIDs.
 *
 * Cached per container: the same handful of people sign in repeatedly, so a
 * warm Lambda looks each up once rather than on every request. Falls back to
 * the subject id if the lookup fails — a wrong-looking name is better than a
 * failed request.
 */
const emailCache = new Map();

async function emailFor(sub) {
  if (emailCache.has(sub)) {
    return emailCache.get(sub);
  }

  let email = sub;
  try {
    const {
      CognitoIdentityProviderClient,
      AdminGetUserCommand,
    } = require("@aws-sdk/client-cognito-identity-provider");

    const client = new CognitoIdentityProviderClient({ region: config.region });
    const user = await client.send(
      new AdminGetUserCommand({
        UserPoolId: process.env.COGNITO_USER_POOL_ID,
        Username: sub,
      }),
    );
    email =
      (user.UserAttributes ?? []).find((a) => a.Name === "email")?.Value || sub;
  } catch (error) {
    console.warn("[auth] could not resolve email", { sub, name: error?.name });
  }

  emailCache.set(sub, email);
  return email;
}

function bearer(req) {
  const header = req.get("Authorization") || "";
  const [scheme, value] = header.split(" ");
  if (!/^Bearer$/i.test(scheme || "") || !value) {
    return null;
  }
  return value.trim();
}

/** Length-safe constant-time compare — timingSafeEqual throws on a mismatch. */
function secretMatches(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so a wrong length is not measurably faster.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

async function requireAdmin(req, res, next) {
  try {
    const token = bearer(req);
    if (!token) {
      throw new ApiError("UNAUTHENTICATED", "Authentication required.");
    }

    if (mode() === "cognito") {
      const claims = await cognitoVerifier().verify(token);
      req.admin = {
        userId: claims.sub,
        email: await emailFor(claims.sub),
        roles: claims["cognito:groups"] || [],
      };
      return next();
    }

    if (config.isProduction) {
      // Shared-secret auth has no identity and no revocation. Refusing here
      // means a misconfigured production deploy fails closed rather than
      // exposing writes.
      console.error("[auth] AUTH_MODE=token refused in production");
      throw new ApiError("FORBIDDEN", "Admin access is not configured.");
    }

    const expected = await adminSecret();
    if (!expected) {
      throw new ApiError("FORBIDDEN", "Admin access is not configured.");
    }
    if (!secretMatches(token, expected)) {
      throw new ApiError("UNAUTHENTICATED", "Authentication required.");
    }

    req.admin = { userId: "shared-token", email: null, roles: ["admin"] };
    return next();
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // A JWT that fails verification, an expired token, a bad signature.
    console.warn("[auth] rejected", { reason: error?.name });
    return next(new ApiError("UNAUTHENTICATED", "Authentication required."));
  }
}

/**
 * Roles, as Cognito groups.
 *
 *   admin  — may change anything, including who else has access
 *   viewer — may read everything, may change nothing
 *
 * A signed-in user with NO group is treated as a viewer, not as an admin:
 * forgetting to assign a group should cost someone write access, never grant
 * it by accident.
 */
const ROLES = { ADMIN: 'admin', VIEWER: 'viewer' };

const isAdmin = (req) => (req.admin?.roles ?? []).includes(ROLES.ADMIN);

const MUTATING = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * Authorisation, separate from authentication (claude.md §23).
 *
 * Applied to the whole admin router rather than route by route, so a new
 * endpoint cannot be added unprotected by forgetting a line. Read-only users
 * get a 403 that says what they can do, not a bare refusal.
 */
function requireWriteAccess(req, res, next) {
  if (!MUTATING.includes(req.method)) {
    return next();
  }
  if (isAdmin(req)) {
    return next();
  }
  return next(
    new ApiError(
      "FORBIDDEN",
      "Your account has read-only access. Ask an administrator to make this change.",
    ),
  );
}

/** Managing other people's access is admin-only, on reads as well as writes. */
function requireAdminRole(req, res, next) {
  if (isAdmin(req)) {
    return next();
  }
  return next(
    new ApiError("FORBIDDEN", "Only an administrator can manage user access."),
  );
}

/**
 * Every admin write must carry the version it is editing (API_CONTRACT.md §4).
 * A missing header is rejected rather than treated as "overwrite whatever is
 * there" — that default is exactly the lost update the rule exists to prevent.
 */
function requireIfMatch(req, res, next) {
  const version = req.get("If-Match");
  if (!version) {
    return next(
      new ApiError(
        "VALIDATION_FAILED",
        "An If-Match header carrying the version you loaded is required.",
      ),
    );
  }
  req.ifMatch = version;
  return next();
}

module.exports = {
  requireAdmin,
  requireIfMatch,
  requireWriteAccess,
  requireAdminRole,
  ROLES,
  isAdmin,
};
