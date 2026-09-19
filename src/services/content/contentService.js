"use strict";

const { readDocument } = require("../../repositories/jsonRepository");
const { resolveMediaDeep } = require("../media/mediaService");
const { validateSettings } = require("./settingsSchema");

/**
 * Port of BabaGold/src/services/api/contentRepository.ts. Same filtering, same
 * ordering, same shapes — so the app sees no difference after the switch.
 */

const byDisplayOrder = (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0);

/** GET /api/v1/company */
async function getCompany() {
  const { data, etag } = await readDocument("company");
  // businessHours stays in 24h form; the app formats it for display and its
  // open/closed logic parses these exact strings.
  return { data: resolveMediaDeep(data), etag };
}

/** GET /api/v1/services */
async function getServices() {
  const { data, etag } = await readDocument("services");
  const services = (data.services ?? [])
    .filter((s) => s.active)
    .sort(byDisplayOrder)
    .map((s) => resolveMediaDeep(s));
  return { data: services, etag };
}

/**
 * GET /api/v1/home
 *
 * Unrecognised section types pass through untouched. The app's HomeSectionView
 * returns null for anything it does not know, so a section added to a newer
 * JSON degrades quietly on an older build — filtering them here would break
 * that and make every content addition a forced app update.
 */
async function getHome() {
  const { data, etag } = await readDocument("home");
  const sections = (data.sections ?? [])
    .filter((s) => s.active)
    .sort(byDisplayOrder);
  return { data: { ...data, sections: resolveMediaDeep(sections) }, etag };
}

/** GET /api/v1/storefront */
async function getStorefront() {
  const { data, etag } = await readDocument("storefront");
  return { data: resolveMediaDeep(data), etag };
}

/**
 * GET /api/v1/settings
 *
 * Validated before it is served. These numbers decide what a customer is told
 * they will pay, so a malformed document is an operator fault to be logged and
 * fixed — never a bad number quietly handed to a cart.
 */
async function getSettings() {
  const { data, etag } = await readDocument("settings");
  validateSettings(data);
  return { data, etag };
}

/**
 * GET /api/v1/bootstrap
 *
 * Everything Home needs to render, in one request. Four cold-start round trips
 * against a Lambda that reads the same two or three objects either way is a
 * real cost at launch; this removes it without changing any other endpoint.
 */
async function getBootstrap() {
  const [company, services, home, storefront, settings] = await Promise.all([
    getCompany(),
    getServices(),
    getHome(),
    getStorefront(),
    getSettings(),
  ]);

  const { getCategories } = require("../catalog/catalogService");
  const categories = await getCategories();

  return {
    data: {
      company: company.data,
      services: services.data,
      home: home.data,
      storefront: storefront.data,
      settings: settings.data,
      categories: categories.data,
    },
  };
}

module.exports = {
  getCompany,
  getServices,
  getHome,
  getStorefront,
  getSettings,
  getBootstrap,
};
