"use strict";

const catalogService = require("../services/catalog/catalogService");
const contentService = require("../services/content/contentService");
const noticeService = require("../services/content/noticeService");
const { ok, notModified } = require("../utils/envelope");
const { deliverMedia } = require("../services/media/mediaService");
const config = require("../config");

/**
 * Controllers do request/response shape only — parse params, call a service,
 * send the envelope. No S3, no business rules (claude.md §41).
 */

/**
 * Serves a service result: signs its media, then sets cache headers that can
 * never outlive the signatures.
 *
 * The staleness trap this avoids: the ETag is the S3 object's, and the JSON
 * rarely changes — so a client could revalidate to 304 forever, holding a body
 * whose image URLs quietly expired hours ago. Folding the signing window into
 * the ETag means the cached copy stops matching the moment fresh URLs are
 * minted, and max-age is clamped to the time left in the window on top of that.
 */
const serve = async (req, res, { data, etag }) => {
  const { data: body, window } = await deliverMedia(data);

  const versionedEtag = window && etag ? taggedWith(etag, window.start) : etag;

  if (notModified(req, res, versionedEtag, window ? window.endsIn : undefined)) {
    return undefined;
  }

  return ok(res, body, {
    etag: versionedEtag,
    cache: true,
    maxAge: window ? window.endsIn : undefined,
  });
};

/** Keeps the quoted-ETag shape S3 hands us. */
const taggedWith = (etag, windowStart) =>
  `"${etag.replace(/"/g, "")}-${windowStart}"`;

const health = (req, res) =>
  ok(res, {
    status: "ok",
    stage: config.stage,
    version: require("../../package.json").version,
  });

const company = async (req, res) => serve(req, res, await contentService.getCompany());
const services = async (req, res) => serve(req, res, await contentService.getServices());
const home = async (req, res) => serve(req, res, await contentService.getHome());
const storefront = async (req, res) => serve(req, res, await contentService.getStorefront());
const settings = async (req, res) => serve(req, res, await contentService.getSettings());
const bootstrap = async (req, res) => serve(req, res, await contentService.getBootstrap());

/**
 * GET /notice — the operator notice the app checks on launch.
 *
 * Served raw rather than through serve(): it carries no media to sign, and it
 * must not be cached. A notice exists to be acted on now, and a block that
 * takes minutes to lift is worse than no block at all.
 *
 * Deliberately absent from /bootstrap and from every admin route.
 */
const notice = async (req, res) => {
  const { data } = await noticeService.getNotice();
  res.set("Cache-Control", "no-store");
  return ok(res, data);
};

const categories = async (req, res) =>
  serve(req, res, await catalogService.getCategories());

const category = async (req, res) =>
  serve(req, res, await catalogService.getCategory(req.params.categoryId));

const categoryProducts = async (req, res) =>
  serve(req, res, await catalogService.getCategoryProducts(req.params.categoryId));

const product = async (req, res) =>
  serve(req, res, await catalogService.getProduct(req.params.productId));

/** `tag` is repeatable: ?tag=featured&tag=bridal narrows to products with both. */
const products = async (req, res) => {
  const { q, categoryId, sort, limit, cursor } = req.query;
  const tagParam = req.query.tag;
  const tags = tagParam === undefined ? [] : [].concat(tagParam);

  const result = await catalogService.listProducts({
    q,
    tags,
    categoryId,
    sort,
    limit,
    cursor,
  });
  return serve(req, res, result);
};

module.exports = {
  health,
  company,
  services,
  home,
  storefront,
  settings,
  bootstrap,
  notice,
  categories,
  category,
  categoryProducts,
  products,
  product,
};
