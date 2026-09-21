"use strict";

const {
  readDocument,
  writeDocument,
} = require("../../repositories/jsonRepository");
const { ApiError, validation } = require("../../utils/errors");
const { validateSettingsInput } = require("../content/settingsSchema");
const { validateCompanyInput } = require("../content/companySchema");
const { normalizeStoredMedia } = require("../media/mediaService");

/**
 * Admin writes against the five content documents: settings, company,
 * services, home and storefront.
 *
 * Same concurrency rule as the catalogue — read fresh, write under the
 * caller's version, stamp updatedAt.
 */

async function load(name) {
  return readDocument(name, { fresh: true });
}

async function save(name, data, ifMatch) {
  // Same guarantee as the catalogue: never persist a signed, expiring URL.
  data = normalizeStoredMedia(data);
  data.updatedAt = new Date().toISOString();
  const { etag } = await writeDocument(name, data, ifMatch);
  return { data, version: etag };
}

const byDisplayOrder = (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0);

// -------------------------------------------------------------------- generic

/** Whole-document read, inactive records included. */
async function getDocument(name) {
  const { data, etag } = await load(name);
  return { data, version: etag };
}

/** Whole-document replace, with a per-document validator. */
async function putDocument(name, input, ifMatch, validate) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw validation("Body must be an object.");
  }
  if (validate) {
    validate(input);
  }
  const { data: current } = await load(name);
  // schemaVersion is ours, not the caller's — a client must not be able to
  // declare the document is a shape it is not.
  const next = { ...input, schemaVersion: current.schemaVersion };
  return save(name, next, ifMatch);
}

/**
 * The shop's own details.
 *
 * Validated because of `assurances` — the trust row on the app's Profile
 * screen. Its icons have to be ones the app actually bundles, so an unknown
 * name is refused here rather than silently rendering a gap on a phone.
 */
async function updateCompany(input, ifMatch) {
  return putDocument("company", input, ifMatch, validateCompanyInput);
}

// ------------------------------------------------------------------- settings

/**
 * The money document. Its validator runs on the way in as well as the way out,
 * and every write is logged with the actor and the values that changed —
 * these numbers decide what customers are told they will pay.
 */
async function updateSettings(input, ifMatch, actor) {
  validateSettingsInput(input);
  const { data: before } = await load("settings");
  const previous = snapshot(before.commerce);

  const result = await putDocument("settings", input, ifMatch, validateSettingsInput);

  // Only after the write lands. Logging before it would record a rejected
  // write — a stale If-Match, a failed validation — as though the price had
  // changed, which makes the audit trail worse than no audit trail.
  logCommerceChange(previous, input.commerce, actor);
  return result;
}

/** Convenience for the panel's pricing screen: replaces only `commerce`. */
async function updateCommerce(commerce, ifMatch, actor) {
  const { data: settings } = await load("settings");
  const previous = snapshot(settings.commerce);

  const next = { ...settings, commerce };
  validateSettingsInput(next);

  const result = await save("settings", next, ifMatch);
  logCommerceChange(previous, commerce, actor);
  return result;
}

/**
 * The document object is shared with the repository's cache and is mutated in
 * place on write, so the "before" values have to be copied out before saving
 * or the comparison ends up reading the new state twice.
 */
const snapshot = (value) =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function logCommerceChange(before = {}, after = {}, actor) {
  const changes = {};
  const compare = (path, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes[path] = { from: a, to: b };
    }
  };
  compare("tax", before.tax, after.tax);
  compare("shipping", before.shipping, after.shipping);
  compare("currency", before.currency, after.currency);
  compare("maxQuantityPerItem", before.maxQuantityPerItem, after.maxQuantityPerItem);

  if (Object.keys(changes).length > 0) {
    console.info("[audit] commerce settings changed", {
      actor: actor?.userId ?? "unknown",
      email: actor?.email ?? null,
      changes,
    });
  }
}

// ------------------------------------------------------------------- services

async function listServices() {
  const { data, etag } = await load("services");
  return { data: (data.services ?? []).sort(byDisplayOrder), version: etag };
}

async function createService(input, ifMatch) {
  const { data } = await load("services");
  data.services ??= [];
  if (!input?.id || !input?.name) {
    throw validation("Service requires an id and a name.");
  }
  if (data.services.some((s) => s.id === input.id)) {
    throw new ApiError("DUPLICATE_ID", `Service '${input.id}' already exists.`);
  }
  const service = {
    description: "",
    imageUrl: null,
    active: true,
    displayOrder:
      data.services.reduce((m, s) => Math.max(m, s.displayOrder ?? 0), 0) + 1,
    ...input,
  };
  data.services.push(service);
  const saved = await save("services", data, ifMatch);
  return { data: service, version: saved.version };
}

async function updateService(serviceId, input, ifMatch, { partial }) {
  const { data } = await load("services");
  const service = (data.services ?? []).find((s) => s.id === serviceId);
  if (!service) {
    throw new ApiError("SERVICE_NOT_FOUND", "Service not found.");
  }
  const index = data.services.indexOf(service);
  const next = partial
    ? { ...service, ...input, id: serviceId }
    : { ...input, id: serviceId };
  data.services[index] = next;
  const saved = await save("services", data, ifMatch);
  return { data: next, version: saved.version };
}

async function deleteService(serviceId, ifMatch, { hard = false } = {}) {
  const { data } = await load("services");
  const service = (data.services ?? []).find((s) => s.id === serviceId);
  if (!service) {
    throw new ApiError("SERVICE_NOT_FOUND", "Service not found.");
  }
  if (hard) {
    data.services = data.services.filter((s) => s.id !== serviceId);
  } else {
    service.active = false;
  }
  const saved = await save("services", data, ifMatch);
  return { data: { id: serviceId, deleted: hard }, version: saved.version };
}

async function reorderServices(ids, ifMatch) {
  const { data } = await load("services");
  const byId = new Map((data.services ?? []).map((s) => [s.id, s]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new ApiError(
      "SERVICE_NOT_FOUND",
      `Unknown services: ${unknown.join(", ")}`,
    );
  }
  ids.forEach((id, index) => {
    byId.get(id).displayOrder = index + 1;
  });
  const saved = await save("services", data, ifMatch);
  return { data: { ids }, version: saved.version };
}

// ----------------------------------------------------------------- storefront

/**
 * aspectRatio is width ÷ height, so a value below 1 makes a banner TALLER than
 * it is wide. A hero shipped at 0.66 once and rendered one and a half screens
 * tall, reading as a huge blank gap. The range check is cheap; the bug was not.
 */
function validateStorefront(input) {
  const problems = [];
  for (const [id, carousel] of Object.entries(input.carousels ?? {})) {
    const ratio = carousel?.aspectRatio;
    if (ratio !== undefined) {
      if (typeof ratio !== "number" || !Number.isFinite(ratio)) {
        problems.push(`carousels.${id}.aspectRatio must be a number`);
      } else if (ratio < 0.8 || ratio > 3.0) {
        problems.push(
          `carousels.${id}.aspectRatio ${ratio} is outside 0.8–3.0 (width ÷ height; below 1 is taller than wide)`,
        );
      }
    }
    if (carousel?.slides !== undefined && !Array.isArray(carousel.slides)) {
      problems.push(`carousels.${id}.slides must be an array`);
    }
  }
  if (problems.length > 0) {
    throw validation("Storefront content is not valid.", { fields: problems });
  }
  return input;
}

async function updateCarousel(carouselId, carousel, ifMatch) {
  const { data } = await load("storefront");
  data.carousels ??= {};
  data.carousels[carouselId] = { ...carousel, id: carouselId };
  validateStorefront(data);
  const saved = await save("storefront", data, ifMatch);
  return { data: data.carousels[carouselId], version: saved.version };
}

async function deleteCarousel(carouselId, ifMatch) {
  const { data } = await load("storefront");
  if (!data.carousels?.[carouselId]) {
    throw new ApiError("NOT_FOUND", "Carousel not found.");
  }

  // home.json references carousels by id. Removing one that is still on the
  // home page would leave a section that renders nothing.
  const { data: home } = await load("home");
  const referencedBy = (home.sections ?? []).filter(
    (s) => s.carouselId === carouselId,
  );
  if (referencedBy.length > 0) {
    throw new ApiError(
      "RESOURCE_IN_USE",
      `This carousel is still used by home sections: ${referencedBy
        .map((s) => s.id)
        .join(", ")}`,
    );
  }

  delete data.carousels[carouselId];
  const saved = await save("storefront", data, ifMatch);
  return { data: { id: carouselId, deleted: true }, version: saved.version };
}

/** Partial updates for the three independent blocks of storefront.json. */
async function updateStorefrontBlock(block, value, ifMatch) {
  const { data } = await load("storefront");
  data[block] = value;
  validateStorefront(data);
  const saved = await save("storefront", data, ifMatch);
  return { data: data[block], version: saved.version };
}

// ----------------------------------------------------------------------- home

function validateHome(input) {
  if (!Array.isArray(input.sections)) {
    throw validation("home.sections must be an array.");
  }
  return input;
}

async function reorderHomeSections(ids, ifMatch) {
  const { data } = await load("home");
  const byId = new Map((data.sections ?? []).map((s) => [s.id, s]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new ApiError("NOT_FOUND", `Unknown sections: ${unknown.join(", ")}`);
  }
  ids.forEach((id, index) => {
    byId.get(id).displayOrder = index + 1;
  });
  const saved = await save("home", data, ifMatch);
  return { data: { ids }, version: saved.version };
}

module.exports = {
  getDocument,
  putDocument,
  updateCompany,
  updateSettings,
  updateCommerce,
  listServices,
  createService,
  updateService,
  deleteService,
  reorderServices,
  updateCarousel,
  deleteCarousel,
  updateStorefrontBlock,
  reorderHomeSections,
  validateStorefront,
  validateHome,
};
