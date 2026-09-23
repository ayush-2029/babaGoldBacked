"use strict";

const { ApiError, validation } = require("../../utils/errors");

/**
 * settings.json decides what customers are charged. It gets stricter checking
 * than any other document.
 *
 * Two entry points, deliberately different:
 *   validateSettings  — on READ. A bad document is an operator fault: 500, and
 *                       nothing is served. Serving a wrong tax rate is worse
 *                       than serving an error.
 *   validateSettingsInput — on WRITE. A bad document is an admin's mistake:
 *                       400 with the offending field named, and nothing is
 *                       stored.
 */

const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

/** Collects every problem rather than stopping at the first. */
function collectProblems(settings) {
  const problems = [];
  const require_ = (condition, message) => {
    if (!condition) {
      problems.push(message);
    }
  };

  require_(settings && typeof settings === "object", "settings must be an object");
  if (problems.length > 0) {
    return problems;
  }

  const commerce = settings.commerce;
  require_(commerce && typeof commerce === "object", "commerce is required");
  if (!commerce || typeof commerce !== "object") {
    return problems;
  }

  require_(
    typeof commerce.currency === "string" && commerce.currency.length === 3,
    "commerce.currency must be a 3-letter code",
  );

  const tax = commerce.tax ?? {};
  require_(
    isNumber(tax.rate) && tax.rate >= 0 && tax.rate <= 1,
    "commerce.tax.rate must be a fraction between 0 and 1 (0.03 for 3%)",
  );
  require_(
    typeof tax.label === "string" && tax.label.length > 0,
    "commerce.tax.label is required — it is shown on the cart line",
  );

  const shipping = commerce.shipping ?? {};
  require_(
    isNumber(shipping.flatRate) && shipping.flatRate >= 0,
    "commerce.shipping.flatRate must be zero or more",
  );
  require_(
    isNumber(shipping.freeThreshold) && shipping.freeThreshold >= 0,
    "commerce.shipping.freeThreshold must be zero or more",
  );

  require_(
    Number.isInteger(commerce.maxQuantityPerItem) &&
      commerce.maxQuantityPerItem >= 1,
    "commerce.maxQuantityPerItem must be a whole number of at least 1",
  );

  if (settings.search !== undefined) {
    require_(
      Array.isArray(settings.search?.suggestions),
      "search.suggestions must be an array",
    );
  }

  /*
   * The short promises shown beside the empty cart and at checkout.
   *
   * `showAssurances` is the on/off switch, checked for TYPE only — absent
   * means shown, so every settings.json already in a bucket keeps working
   * without a migration.
   */
  if (settings.checkout !== undefined) {
    const list = settings.checkout?.assurances;
    if (list !== undefined) {
      require_(Array.isArray(list), "checkout.assurances must be an array");
      if (Array.isArray(list)) {
        require_(
          list.every((a) => typeof a === "string" && a.trim().length > 0),
          "checkout.assurances must all be non-empty text",
        );
        // The app lays these out in one row; past six they stop being short
        // promises and start being a paragraph.
        require_(
          list.length <= 6,
          "checkout.assurances cannot have more than 6 items",
        );
        require_(
          list.every((a) => typeof a !== "string" || a.length <= 40),
          "each checkout assurance must be 40 characters or fewer",
        );
      }
    }
    if (settings.checkout?.showAssurances !== undefined) {
      require_(
        typeof settings.checkout.showAssurances === "boolean",
        "checkout.showAssurances must be true or false",
      );
    }

    /*
     * The single line under the cart total.
     *
     * Was hardcoded in the app as "BIS hallmarked · Final price confirmed
     * before billing" — a claim about the shop's own goods, in the one place
     * the shop could not change it. Empty means the line is not shown, which
     * is the whole switch; there is no separate flag to get out of step with
     * the text.
     */
    const note = settings.checkout?.cartNote;
    if (note !== undefined && note !== null && note !== "") {
      require_(typeof note === "string", "checkout.cartNote must be text");
      require_(
        typeof note !== "string" || note.trim().length <= 80,
        "checkout.cartNote must be 80 characters or fewer",
      );
    }
  }

  /*
   * The version line on the app's Profile screen.
   *
   * ABSENT MEANS SHOWN, like every other switch here, so no settings.json
   * already in a bucket changes behaviour.
   *
   * Worth knowing what this does NOT hide, because the app deliberately
   * overrides it in two cases: a build talking to a non-production API always
   * shows the line (that marker is how a stakeholder APK is told apart from a
   * Play Store one), and an available update always shows, because that row is
   * the soft-update prompt and hiding it would quietly disable updates.
   */
  if (settings.profile !== undefined) {
    require_(
      settings.profile !== null && typeof settings.profile === "object" &&
        !Array.isArray(settings.profile),
      "profile must be an object",
    );
    if (settings.profile?.showVersion !== undefined) {
      require_(
        typeof settings.profile.showVersion === "boolean",
        "profile.showVersion must be true or false",
      );
    }
  }

  problems.push(...checkAppUpdate(settings.appUpdate));

  return problems;
}

/** A version like 1.0 or 1.2.3, optionally with a -beta / +build suffix. */
const VERSION = /^\d+(\.\d+)*([-+].*)?$/;

/**
 * The update gate can lock every customer out of the app, so its config is
 * validated harder than anything else here.
 *
 * The specific failure to prevent: a hard update pointing at a version nobody
 * can reach. Publishing `updateType: 'hard'` with a `latestVersion` that is
 * not actually in the store, or with no store link, bricks the app for every
 * customer — and the fix has to come from the same admin panel they can no
 * longer be told about.
 */
function checkAppUpdate(update) {
  if (update === undefined || update === null) {
    return [];
  }

  const problems = [];

  if (typeof update !== "object") {
    return ["appUpdate must be an object"];
  }

  for (const field of ["latestVersion", "minimumVersion"]) {
    const value = update[field];
    if (value !== undefined && value !== "" && !VERSION.test(String(value))) {
      problems.push(`appUpdate.${field} must look like 1.2.3`);
    }
  }

  if (
    update.updateType !== undefined &&
    !["soft", "hard"].includes(update.updateType)
  ) {
    problems.push("appUpdate.updateType must be 'soft' or 'hard'");
  }

  // A minimum ahead of the latest release would force an update to a version
  // that does not exist — everyone blocked, nobody able to comply.
  if (
    VERSION.test(String(update.minimumVersion ?? "")) &&
    VERSION.test(String(update.latestVersion ?? "")) &&
    compareVersions(update.minimumVersion, update.latestVersion) > 0
  ) {
    problems.push(
      "appUpdate.minimumVersion cannot be newer than latestVersion — customers would be blocked with no version to update to",
    );
  }

  if (update.enabled === true) {
    if (!VERSION.test(String(update.latestVersion ?? ""))) {
      problems.push("appUpdate.latestVersion is required when updates are enabled");
    }

    const android = update.storeUrl?.android;
    const ios = update.storeUrl?.ios;
    if (!android && !ios) {
      problems.push(
        "appUpdate needs at least one store link, or customers are told to update with no way to do it",
      );
    }
  }

  return problems;
}

/** Numeric, segment by segment — '1.10.0' is newer than '1.9.0'. */
function compareVersions(a, b) {
  const parse = (v) =>
    String(v)
      .split(/[-+]/)[0]
      .split(".")
      .map((n) => Number(n.replace(/[^\d]/g, "")) || 0);

  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

/** Read path: refuse to serve a broken document. */
function validateSettings(settings) {
  const problems = collectProblems(settings);
  if (problems.length > 0) {
    // Logged with detail; the client is told nothing about the internals.
    console.error("[settings] stored document is invalid", { problems });
    throw new ApiError(
      "INTERNAL_ERROR",
      "Store settings are unavailable. Please try again shortly.",
    );
  }
  return settings;
}

/** Write path: name the field so the admin can fix it. */
function validateSettingsInput(settings) {
  const problems = collectProblems(settings);
  if (problems.length > 0) {
    throw validation("Settings are not valid.", { fields: problems });
  }
  return settings;
}

module.exports = { validateSettings, validateSettingsInput, collectProblems };
