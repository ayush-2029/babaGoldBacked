"use strict";

const { readDocument } = require("../../repositories/jsonRepository");

/**
 * The operator notice. Read by the app on launch; NOT editable from the panel.
 *
 * This is deliberately the one piece of configuration with no admin route, no
 * write endpoint and no screen. It is changed by editing
 * `data/notice.json` in the bucket directly, which means it stays available
 * to whoever holds the AWS account even if the panel is unreachable, broken,
 * or in someone else's hands.
 *
 * Do NOT add it to the admin router, the bootstrap payload, or the panel. If
 * a future change needs a list of "all documents", this one is excluded on
 * purpose — see the exclusion in adminController and contentService.
 *
 * Shape of notice.json:
 *
 *   {
 *     "enabled": true,
 *     "mode": "message" | "block",
 *     "id": "2026-09-payment",
 *     "title": "Service notice",
 *     "message": "…",
 *     "contact": "+91 …"          // optional, shown under the message
 *   }
 *
 * `mode` is the whole difference:
 *   "message" — a full-screen notice the customer can close and carry on.
 *   "block"   — the app shows this and nothing else. No close button.
 */

/** What the app is told when there is nothing to say. */
const SILENT = Object.freeze({ enabled: false });

/**
 * Normalises whatever is in the bucket into something the app can trust.
 *
 * Anything unexpected becomes SILENT rather than an error. A typo in a
 * hand-edited file must not take the shop down — this feature exists to block
 * the app deliberately, so it must never do it by accident.
 */
function normalise(raw) {
  if (!raw || typeof raw !== "object" || raw.enabled !== true) {
    return SILENT;
  }

  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (!message) {
    // A block with no words is a dead-end screen. Refuse it.
    return SILENT;
  }

  // Anything that is not exactly "block" is treated as a dismissible message.
  // Blocking every customer is the more destructive of the two, so it has to
  // be asked for precisely.
  const mode = raw.mode === "block" ? "block" : "message";

  return {
    enabled: true,
    mode,
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "notice",
    title: typeof raw.title === "string" && raw.title.trim()
      ? raw.title.trim()
      : "Service notice",
    message,
    contact:
      typeof raw.contact === "string" && raw.contact.trim()
        ? raw.contact.trim()
        : null,
  };
}

/**
 * GET /api/v1/notice
 *
 * Never throws. A missing object, a malformed one, or S3 being unreachable
 * all resolve to "nothing to say" — the app then behaves exactly as it does
 * with no notice configured.
 */
async function getNotice() {
  try {
    const { data, etag } = await readDocument("notice");
    return { data: normalise(data), etag };
  } catch (error) {
    // NoSuchKey is the normal case: the file only exists when it is needed.
    if (error && error.code !== "NOT_FOUND" && error.name !== "NoSuchKey") {
      console.error("[notice] could not be read", {
        name: error.name,
        code: error.code,
      });
    }
    return { data: SILENT, etag: undefined };
  }
}

module.exports = { getNotice, normalise, SILENT };
