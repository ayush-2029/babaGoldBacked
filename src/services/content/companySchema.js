"use strict";

const { validation } = require("../../utils/errors");

/**
 * Validation for the parts of company.json the panel can edit freely.
 *
 * Only `assurances` is checked here — the trust row on the app's Profile
 * screen ("BIS hallmarked", "Certified diamonds", …), which used to be four
 * hardcoded items in the app and is now shop-editable.
 *
 * The rest of the document is prose and contact details; there is nothing to
 * be strict about, and refusing a write because a tagline looked odd would
 * only get in the shopkeeper's way.
 */

/**
 * The icons the APP can actually draw.
 *
 * This is the whole reason assurances are not free-form. React Native bundles
 * its icon components at build time, so an icon the app does not already
 * import cannot appear by editing JSON — the shop would save "diamond-ring",
 * see it accepted, and get a blank space in the app with nothing to explain
 * why. Keeping the list here means the panel can only offer real ones and the
 * API refuses anything else.
 *
 * Adding one means adding it in THREE places, in this order:
 *   1. here,
 *   2. the app's icon map (src/components/Assurances.tsx),
 *   3. the panel's picker (src/pages/CompanyPage.tsx).
 * Miss step 2 and the app renders a gap.
 */
const ASSURANCE_ICONS = [
  "award", // BIS hallmark, certification
  "gem", // diamonds, stones
  "refresh", // exchange, buy-back
  "wrench", // servicing, polishing
  "shield", // guarantee, insurance
  "truck", // delivery
  "badge", // authenticity
  "heart", // care, trust
  "sparkles", // craftsmanship
  "scale", // fair weighing, rates
];

const MAX_ASSURANCES = 8;

/**
 * @param {unknown} list
 * @returns {string[]} problems, empty when valid
 */
function collectAssuranceProblems(list) {
  const problems = [];

  if (list === undefined || list === null) {
    // Absent is fine: the app falls back to its bundled defaults.
    return problems;
  }

  if (!Array.isArray(list)) {
    problems.push("assurances must be a list");
    return problems;
  }

  if (list.length > MAX_ASSURANCES) {
    // The app lays these out in a single row; past eight they are unreadable
    // on a phone.
    problems.push(`assurances cannot have more than ${MAX_ASSURANCES} items`);
  }

  const seen = new Set();

  list.forEach((item, i) => {
    const at = `assurances[${i}]`;

    if (!item || typeof item !== "object" || Array.isArray(item)) {
      problems.push(`${at} must be an object`);
      return;
    }

    if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(item.id)) {
      problems.push(`${at}.id must be lowercase letters, numbers and hyphens`);
    } else if (seen.has(item.id)) {
      // Duplicates would collide as React keys and make reordering jump.
      problems.push(`${at}.id is used more than once`);
    } else {
      seen.add(item.id);
    }

    if (typeof item.label !== "string" || item.label.trim().length === 0) {
      problems.push(`${at}.label is required`);
    } else if (item.label.trim().length > 28) {
      // Two short words is what the tile fits; longer just truncates.
      problems.push(`${at}.label must be 28 characters or fewer`);
    }

    if (!ASSURANCE_ICONS.includes(item.icon)) {
      problems.push(
        `${at}.icon must be one of: ${ASSURANCE_ICONS.join(", ")}`,
      );
    }

    if (item.active !== undefined && typeof item.active !== "boolean") {
      problems.push(`${at}.active must be true or false`);
    }
  });

  return problems;
}

/** Write path: name the field so the admin can fix it. */
function validateCompanyInput(company) {
  if (!company || typeof company !== "object") {
    throw validation("Company details are not valid.");
  }
  const problems = collectAssuranceProblems(company.assurances);
  if (problems.length > 0) {
    throw validation("Company details are not valid.", { fields: problems });
  }
  return company;
}

module.exports = {
  validateCompanyInput,
  collectAssuranceProblems,
  ASSURANCE_ICONS,
  MAX_ASSURANCES,
};
