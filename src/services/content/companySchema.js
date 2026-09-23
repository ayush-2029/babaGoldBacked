"use strict";

const { validation } = require("../../utils/errors");

/**
 * Validation for the parts of company.json the panel can edit freely.
 *
 * Three things are checked here, and they are the ones where a bad value
 * silently does nothing in the app rather than looking wrong:
 *
 *   assurances  — the trust row on the app's Profile screen ("BIS hallmarked",
 *                 "Certified diamonds", …), once four hardcoded items.
 *   socialLinks — the Follow us row. A link with no scheme opens nothing.
 *   footerNote  — the single line under the Profile footer, also once
 *                 hardcoded, and a claim only the shop can stand behind.
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
 * Social links.
 *
 * Stored as a map of platform to link, because that is the shape already in
 * every company.json in the bucket:
 *
 *   "socialLinks": { "instagram": "https://…", "youtube": null }
 *
 * A link may ALSO be written as `{ url, active }`. That exists so the panel
 * can switch a link off without throwing the address away — the alternative
 * is asking the shop to delete their Instagram URL to hide the button and
 * paste it back to show it again, which is how URLs get lost.
 *
 * The platform key is not checked against a list. The app renders whatever
 * keys it is given, titled from the key itself, so a shop that opens a
 * Pinterest account should not have to wait for an app release.
 */
const MAX_SOCIAL_LINKS = 8;
const SOCIAL_KEY = /^[a-z][a-z0-9]{1,19}$/;
const MAX_SOCIAL_URL = 300;

/**
 * @param {unknown} links
 * @returns {string[]} problems, empty when valid
 */
function collectSocialProblems(links) {
  const problems = [];

  if (links === undefined || links === null) {
    return problems;
  }

  if (typeof links !== "object" || Array.isArray(links)) {
    problems.push("socialLinks must be an object");
    return problems;
  }

  const keys = Object.keys(links);
  if (keys.length > MAX_SOCIAL_LINKS) {
    problems.push(`socialLinks cannot have more than ${MAX_SOCIAL_LINKS} entries`);
  }

  keys.forEach((key) => {
    const at = `socialLinks.${key}`;

    if (!SOCIAL_KEY.test(key)) {
      problems.push(`${at} must be lowercase letters and numbers`);
    }

    const value = links[key];

    // An empty slot is how a link is left unset. Keeping the key is useful —
    // it is what lets the panel show a blank Instagram row to fill in.
    if (value === null || value === undefined || value === "") {
      return;
    }

    let url = value;

    if (typeof value === "object" && !Array.isArray(value)) {
      url = value.url;
      if (value.active !== undefined && typeof value.active !== "boolean") {
        problems.push(`${at}.active must be true or false`);
      }
      if (url === null || url === undefined || url === "") {
        // Switched off and never filled in. Nothing to check.
        return;
      }
    } else if (typeof value !== "string") {
      problems.push(`${at} must be a web address`);
      return;
    }

    if (typeof url !== "string") {
      problems.push(`${at} must be a web address`);
      return;
    }

    const trimmed = url.trim();
    if (trimmed.length > MAX_SOCIAL_URL) {
      problems.push(`${at} must be ${MAX_SOCIAL_URL} characters or fewer`);
    }
    // Without a scheme the app hands the phone something it cannot open, and
    // the button silently does nothing.
    if (!/^https?:\/\/\S+$/i.test(trimmed)) {
      problems.push(`${at} must start with http:// or https:// and contain no spaces`);
    }
  });

  return problems;
}

/**
 * The single line under the Profile screen's footer.
 *
 * Was hardcoded in the app as "Every piece BIS hallmarked with a HUID" — a
 * claim only the shop can know is true, in the one place the shop could not
 * edit. Empty means the line is not shown.
 */
const MAX_FOOTER_NOTE = 80;

/**
 * @param {unknown} note
 * @returns {string[]} problems, empty when valid
 */
function collectFooterNoteProblems(note) {
  const problems = [];

  if (note === undefined || note === null || note === "") {
    return problems;
  }

  if (typeof note !== "string") {
    problems.push("footerNote must be text");
    return problems;
  }

  if (note.trim().length > MAX_FOOTER_NOTE) {
    problems.push(`footerNote must be ${MAX_FOOTER_NOTE} characters or fewer`);
  }

  return problems;
}

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
  const problems = [
    ...collectAssuranceProblems(company.assurances),
    ...collectSocialProblems(company.socialLinks),
    ...collectFooterNoteProblems(company.footerNote),
  ];
  if (problems.length > 0) {
    throw validation("Company details are not valid.", { fields: problems });
  }
  return company;
}

module.exports = {
  validateCompanyInput,
  collectAssuranceProblems,
  collectSocialProblems,
  collectFooterNoteProblems,
  ASSURANCE_ICONS,
  MAX_ASSURANCES,
  MAX_SOCIAL_LINKS,
  MAX_FOOTER_NOTE,
};
