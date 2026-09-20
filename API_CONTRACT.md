# BabaGold API Contract

Status: **approved and implemented 2026-09-16** — Ayush approved the endpoint
list, with one added requirement: *"price and everything needs to be manageable
from the JSON, nothing hardcoded on the app side."* That requirement added
`settings.json` and the `/settings` endpoint pair (§2, §3), and it is now a rule
the whole contract is held to — see §0.

**Built and DEPLOYED 2026-09-16.** All 12 public read endpoints and all 45 admin
write endpoints, 45 tests passing, live at
`https://yq798ysiji.execute-api.ap-south-1.amazonaws.com/api/v1` (stage `dev`,
stack `BabaGoldBackend-dev`), reading `s3://baba-gold-in` in ap-south-1.
`POST /quotes` and the export/import/versions/restore operations are the
remaining Phase-3 items. See `README.md`.

Derived from three sources, in this order of authority:

1. Ayush's explicit decisions (recorded in project memory).
2. `claude.md` in this repo (§11 API Design, §12 envelope, §16–21 media/concurrency).
3. The app's existing `BabaGold/src/services/api/*Repository.ts`, which already
   returns the exact shapes the screens consume. **Those repositories are the
   spec for the public API** — `__tests__/catalogRepository.test.ts` is a
   ready-made conformance suite. Reuse its assertions.

---

## 0. Nothing is hardcoded on the client

Ayush's rule, 2026-09-16. Every value a shopkeeper might reasonably want to
change must be reachable from JSON, edited through an admin endpoint, and
delivered by the API. The app renders data; it does not *contain* data.

The test for any constant in the app: **could Baba Gold want this different next
month without a Play Store release?** If yes, it belongs in JSON.

Six documents hold everything:

| File | Endpoint | Holds |
|---|---|---|
| `catalog.json` | `/categories`, `/products` | Categories with their products nested |
| `company.json` | `/company` | Identity, contact, address, hours, legal |
| `services.json` | `/services` | Service offerings |
| `home.json` | `/home` | Home section order and composition |
| `storefront.json` | `/storefront` | Banners, carousels, announcement, promo modal |
| **`settings.json`** | **`/settings`** | **Commerce rules, search config, checkout copy** |

`settings.json` is new and exists because of this rule. Audit of what was
hardcoded in the app when the rule was set:

| Was | Now |
|---|---|
| `src/config/commerce.ts` → `TAX_RATE`, `TAX_LABEL` | `settings.commerce.tax` |
| `src/config/commerce.ts` → `FREE_SHIPPING_THRESHOLD`, `SHIPPING_FLAT` | `settings.commerce.shipping` |
| `src/config/commerce.ts` → `MAX_QUANTITY_PER_ITEM` | `settings.commerce.maxQuantityPerItem` |
| `src/config/commerce.ts` → `DEFAULT_CURRENCY` | `settings.commerce.currency` |
| `SearchScreen.tsx` → `SUGGESTIONS` array | `settings.search.suggestions` |
| `utils/quote.ts` → `BG-` reference prefix | `settings.commerce.quoteReferencePrefix` |
| Cart/checkout assurance strings | `settings.checkout.assurances` |

**What legitimately stays in the app,** because it is presentation or platform
mechanics rather than business data: theme tokens (`src/theme/`), layout
constants, validation regexes for Indian phone/PIN formats, animation timings,
storage keys, and `src/config/dev.ts` (which is `__DEV__`-gated and compiles out
of release builds entirely).

**Two consequences for the backend.** Settings must never arrive missing or
malformed, so `GET /settings` validates against a schema and the app keeps a
bundled copy as a last-resort default — a cart that cannot compute tax is worse
than a slightly stale rate. And because `settings.commerce` changes what
customers are charged, its admin endpoint is the one most worth auditing: log
every write with the actor and the before/after values.

---

## 1. Conventions

**Base URL** — `https://{api-id}.execute-api.us-east-1.amazonaws.com/{stage}`,
later a custom domain. The app stores it in one place:
`BabaGold/src/services/api/config.ts` → `API_BASE_URL`.

**Versioning** — everything mounts under `/api/v1`. Adopting it now costs
nothing; retrofitting it later means a coordinated release across three repos.

**Envelope** — mandatory on every response, success and failure alike (`claude.md` §12):

```json
{ "success": true, "data": {} }
{ "success": false, "error": { "code": "PRODUCT_NOT_FOUND", "message": "Product not found" } }
```

Never leak stack traces or raw AWS errors. The app's `ApiResponse<T>` type in
`src/services/api/types.ts` already models this discriminated union.

**Public vs admin visibility**

| | Public API | Admin API |
|---|---|---|
| `active: false` records | never returned | always returned, flag intact |
| Image URLs | absolute (backend prepends CDN base) | absolute for display, relative keys on write |
| S3 keys / filenames | never exposed | never exposed (media keys are opaque handles) |
| Empty `images: []` | impossible — fallback injected | returned as-is, so the admin sees the gap |

**Caching** — every public GET returns `ETag` and
`Cache-Control: public, max-age=60, stale-while-revalidate=300`; honour
`If-None-Match` with `304`. Design for CloudFront in front, but do not add it yet
(`claude.md` §25: "do not add unnecessary infrastructure during the initial
implementation").

**Pagination** — `?limit=` (default 50, max 100) and `?cursor=` (opaque). Only
`/products` needs it at current volume; add it to the others when they grow.

**Error codes** — a closed set, so the app can branch on `code` rather than
parse `message`:

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Request body/params failed schema validation |
| `UNAUTHENTICATED` | 401 | Missing or invalid token |
| `FORBIDDEN` | 403 | Authenticated but not permitted |
| `CATEGORY_NOT_FOUND` | 404 | |
| `PRODUCT_NOT_FOUND` | 404 | |
| `SERVICE_NOT_FOUND` | 404 | |
| `MEDIA_NOT_FOUND` | 404 | |
| `DUPLICATE_ID` | 409 | Stable ID already in use |
| `CONFLICT_STALE_DATA` | 409 | `If-Match` version no longer current — see §4 |
| `CATEGORY_NOT_EMPTY` | 409 | Hard-delete refused; category still has products |
| `RESOURCE_IN_USE` | 409 | Delete refused; something still references it (a carousel on the home page) |
| `PAYLOAD_TOO_LARGE` | 413 | Upload exceeds the size allowlist |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | MIME/extension not on the allowlist |
| `RATE_LIMITED` | 429 | |
| `INTERNAL_ERROR` | 500 | Everything else, message sanitised |

The app's repositories today emit `CATEGORIES_UNAVAILABLE`,
`PRODUCTS_UNAVAILABLE`, `SEARCH_FAILED` and similar for local read failures.
Those are **client-side** codes meaning "the data layer broke" and stay as they
are; the backend never sends them.

---

## 2. Public API — mobile app

Twelve endpoints, plus `/quotes` in Phase 3. This is the whole Phase-1 build.

### Content

| Method | Path | Returns | App caller |
|---|---|---|---|
| GET | `/api/v1/health` | `{ status, version, stage }` | — (ops/uptime) |
| GET | `/api/v1/company` | `Company` | `contentRepository.getCompany()` |
| GET | `/api/v1/services` | `Service[]` | `contentRepository.getServices()` |
| GET | `/api/v1/home` | `HomeContent` | `contentRepository.getHome()` |
| GET | `/api/v1/storefront` | `Storefront` | `contentRepository.getStorefront()` |
| GET | `/api/v1/settings` | `Settings` | `contentRepository.getSettings()` — **to build** |
| GET | `/api/v1/bootstrap` | `{ company, services, home, storefront, settings, categories }` | *proposed* — see below |

Server-side work each one owes (the app does it locally today; the Lambda must
take it over so behaviour is identical after the switch):

- `/services` — filter `active`, sort by `displayOrder`.
- `/home` — filter `active` sections, sort by `displayOrder`. Unknown section
  `type` values must pass through untouched: `HomeSectionView` returns `null`
  for anything it does not recognise, so a newer JSON degrades quietly. Do not
  let the backend "clean up" sections it does not understand.
- `/company` — returned as stored; `businessHours` stays 24h, the app formats it.
- `/storefront` — returned as stored, media URLs resolved.
- `/settings` — **validated before it is served**. A missing or non-numeric
  `tax.rate`, a negative `shipping.flatRate`, a `maxQuantityPerItem` below 1:
  each is a `500 INTERNAL_ERROR` with the fault logged, not a silently served
  bad number. Money the customer sees is computed from this document.

**`/bootstrap` (proposed).** Home needs company, home, storefront and categories
before it can render — four cold-start round trips against a Lambda that reads
one or two S3 objects either way. One request cuts launch latency materially and
costs nothing extra server-side. The app keeps the four separate repository
methods regardless, so this is purely an optimisation the data layer can adopt
or ignore.

### Operator notice (not in the panel)

| Method | Path | Returns | App caller |
| --- | --- | --- | --- |
| GET | `/notice` | `{ enabled, mode, id, title, message, contact }` | on every launch |

**This is the one document with no admin route and no screen.** It is edited by
hand in `s3://baba-gold-in/data/notice.json` so it stays with whoever holds the
AWS account, independently of the panel — which is the point: it is the lever
that still works when the panel does not, or is in someone else’s hands.

`mode` is the whole difference. `"message"` shows a full-screen notice the
customer can close; `"block"` shows it and nothing else, with no way past. Any
value that is not exactly `"block"` degrades to `"message"`, and a notice with
no `message`, or without `enabled: true` exactly, is ignored entirely — a typo
in a hand-edited file must never take a shop down.

Served `no-store` and deliberately absent from `/bootstrap`: both are caches,
and a block that takes minutes to lift is worse than no block at all.

**Do not add this to the admin router, the panel, or any "all documents" list.**
### Catalog

| Method | Path | Returns | App caller |
|---|---|---|---|
| GET | `/api/v1/categories` | `Category[]` (with `productCount`, no nested products) | `catalogRepository.getCategories()` |
| GET | `/api/v1/categories/:categoryId` | `Category` | — (available; the app gets it from the route below) |
| GET | `/api/v1/categories/:categoryId/products` | `{ category, products }` | `catalogRepository.getCategoryProducts()` |
| GET | `/api/v1/products` | `Product[]` + page info | `searchProducts()` / `getProductsByTag()` |
| GET | `/api/v1/products/:productId` | `Product` (with `categoryId` injected) | `catalogRepository.getProduct()` |

`GET /api/v1/products` query parameters:

| Param | Notes |
|---|---|
| `q` | Free text. **All terms must match** — extra words narrow, never widen. Searches name, shortDescription, description, `metal.purity`, `metal.type`, category name, tags. Mirrors `searchProducts()` exactly. |
| `tag` | Repeatable. Drives the home rails (`featured`, `new-arrival`, …). Mirrors `getProductsByTag()`. |
| `categoryId` | Optional filter; the nested route stays because the app needs the category object alongside. |
| `limit`, `cursor` | Pagination. |
| `sort` | `displayOrder` (default), `priceAsc`, `priceDesc`, `newest`. |

Transforms every catalog response owes — all of these are already implemented
and unit-tested in `catalogRepository.ts`, so port them rather than rewrite:

1. Drop inactive categories and inactive products.
2. Sort categories and products by `displayOrder`.
3. `/categories` strips the nested `products` array and returns `productCount`,
   counting **active** products only.
4. `/products/:id` flat-scans all categories and **injects `categoryId`** — the
   stored product has no `categoryId` of its own, because nesting implies it.
5. Sort each product's `images` by `displayOrder`.
6. Substitute the fallback image when `images` is empty, as
   `{ id: 'fallback', isPrimary: true, displayOrder: 1 }`, so **the API never
   returns a product with an empty `images` array**.
7. Resolve every relative media key to an absolute URL using the CDN base from
   config. Absolute `http(s)` URLs pass through untouched — the JSON currently
   holds absolute Unsplash URLs for design review, and `resolveMediaUrl()` on
   the app side already behaves this way.

### Quotes (Phase 3)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/quotes` | Checkout form + cart lines → `{ reference, status }` |

Today `CheckoutScreen` builds a WhatsApp message and opens it; that message *is*
the order. When this endpoint exists it takes the same payload and the WhatsApp
hand-off becomes a fallback. Two hard requirements:

- The backend **re-validates every price server-side**. Cart lines are snapshots
  taken at add-to-cart time and are restored from AsyncStorage as-is, so a
  catalogue edit never reaches a cart already holding the item.
- The device-generated reference (`BG-YYMMDD-XXXX`) is sent in the payload; the
  backend either honours it or returns its own, but the customer must never see
  two different references.

Public write endpoints need rate limiting and a spam guard before they ship.

---

## 3. Admin API — admin panel

All under `/api/v1/admin/*`. **Every one requires a valid token; none ships
before auth does** (`claude.md` §11, §22, §23).

### Auth

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/admin/me` | `{ userId, email, roles }` — panel bootstrap and token probe |

Login, refresh and password reset are **Cognito's job**, not ours — the panel
talks to the user pool directly and sends the JWT as `Authorization: Bearer`.
The backend validates it in middleware. `claude.md` §22: "do not build insecure
custom password authentication without a strong reason." So there are deliberately
no `/login` or `/password` endpoints here.

### Categories

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/admin/categories` | Includes inactive. `?includeProducts=true` for the tree view |
| GET | `/api/v1/admin/categories/:id` | |
| POST | `/api/v1/admin/categories` | ID is client-supplied and stable (`"rings"`), validated `^[a-z0-9-]{2,40}$`, `409 DUPLICATE_ID` on collision |
| PUT | `/api/v1/admin/categories/:id` | Full replace |
| PATCH | `/api/v1/admin/categories/:id` | Partial — the `active` toggle lives here |
| DELETE | `/api/v1/admin/categories/:id` | **Soft** (`active: false`). `?hard=true` only when empty, else `409 CATEGORY_NOT_EMPTY` |
| PUT | `/api/v1/admin/categories/order` | Bulk reorder, body `{ ids: [...] }` — one write instead of N |

### Products

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/admin/products` | `?categoryId=&q=&active=&limit=&cursor=`; includes inactive |
| GET | `/api/v1/admin/products/:id` | |
| POST | `/api/v1/admin/products` | Body carries `categoryId`; the product is nested under it in storage |
| PUT | `/api/v1/admin/products/:id` | Full replace |
| PATCH | `/api/v1/admin/products/:id` | Partial — `active`, `available`, price edits |
| DELETE | `/api/v1/admin/products/:id` | Soft. `?hard=true` also deletes `media/products/{id}/` |
| PUT | `/api/v1/admin/categories/:categoryId/products/order` | Reorder within a category |
| PATCH | `/api/v1/admin/products/:id/category` | Move between categories. Separate endpoint because it relocates the node in `catalog.json` — and note **no image work is needed**, which is exactly why the media path has no `categoryId` segment |

### Product images

Images are objects (`{ id, url, alt, isPrimary, displayOrder }`), not bare
strings, precisely so the panel can reorder them and pick a primary.

| Method | Path | Notes |
|---|---|---|
| PUT | `/api/v1/admin/products/:id/images` | Replace the whole ordered array — the simplest correct primitive for a drag-and-drop grid |
| POST | `/api/v1/admin/products/:id/images` | Append one confirmed upload |
| DELETE | `/api/v1/admin/products/:id/images/:imageId` | Removes from JSON **and** deletes the S3 object |
| PUT | `/api/v1/admin/products/:id/images/:imageId/primary` | Sets `isPrimary`, clears it elsewhere — exactly one primary is an invariant the backend enforces |

### Media

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/admin/media/upload-url` | → `{ uploadUrl, key, imageId, expiresIn, requiredHeaders }` |
| POST | `/api/v1/admin/media/confirm` | Backend validates the uploaded object, returns `{ key, url, width, height, bytes }` |
| DELETE | `/api/v1/admin/media` | Body `{ key }`. Refuses a key still referenced by any JSON |
| GET | `/api/v1/admin/media` | `?prefix=` — browse, and find orphans |

`upload-url` takes `{ scope, ownerId, contentType, fileSize, fileName }` where
scope is `product | category | service | company | storefront`. It **generates
the object key itself** — `media/products/{productId}/{imageId}.{ext}` — and
never trusts `fileName` (`claude.md` §17). The presigned URL is content-type and
content-length bound, and short-lived.

**Why `confirm` exists.** With presigned PUT the bytes go browser → S3 and the
backend never sees them, so §18's validation has nowhere to happen. `confirm`
closes that hole: it `HEAD`s the object, re-checks size and content type,
verifies the **magic bytes actually match the extension**, reads dimensions, and
only then returns a key the caller may write into JSON. An unconfirmed key is
never persisted, and a failed confirm deletes the object.

That magic-byte check is not theoretical. A JPEG named `.png` passed Metro,
TypeScript and every Jest test in the app, then failed the Android release build
with *"failed to read PNG signature"* — days after the mistake was made. The app
now guards it with `scripts/check-assets.js` in its lint chain; the backend is
the equivalent gate for anything uploaded. Same reason the fallback key is
`…/metal_details_2.jpg`, not `.png`.

**Media path rule (Ayush, final):** `media/products/{productId}/<file>` — no
`categoryId` segment, so a product moves between categories without breaking or
re-uploading a single URL. This **overrides** `claude.md` §17's
`media/products/{categoryId}/{productId}/…` sketch. Product IDs are globally
unique, so the folder is unambiguous on its own.

### Content

| Method | Path | Notes |
|---|---|---|
| GET / PUT | `/api/v1/admin/settings` | Commerce rules, search config, checkout copy |
| PUT | `/api/v1/admin/settings/commerce` | Tax, shipping, currency, quantity cap — **the money screen** |
| GET / PUT | `/api/v1/admin/company` | Whole document |
| GET | `/api/v1/admin/services` | Includes inactive |
| POST / PUT / DELETE | `/api/v1/admin/services[/:id]` | Soft delete |
| PUT | `/api/v1/admin/services/order` | |
| GET / PUT | `/api/v1/admin/home` | Sections array — order, dividers, which rails appear |
| PUT | `/api/v1/admin/home/order` | |
| GET / PUT | `/api/v1/admin/storefront` | Whole document |
| PUT | `/api/v1/admin/storefront/announcement` | The thin gold strip |
| POST / PUT / DELETE | `/api/v1/admin/storefront/carousels[/:carouselId]` | Carousels are a **map keyed by id**, referenced from `home.json` by `carouselId` |
| PUT | `/api/v1/admin/storefront/carousels/:carouselId/slides` | Replace the ordered slide array |
| PUT | `/api/v1/admin/storefront/promo` | The promo modal |

Two validations worth writing down because both have already caused a visible bug:

- **`aspectRatio` is width ÷ height.** A value below 1 makes a banner *taller*
  than it is wide. The hero shipped at 0.66 once and rendered as a huge blank
  gap. Validate the range (roughly 0.8–3.0) and reject anything outside it.
- **Changing a `promoModal.id` re-shows the modal to everyone who dismissed the
  previous one** — dismissal is stored per-id under `@babagold/promo-seen/<id>`.
  That is the intended mechanism, but the panel should say so out loud rather
  than let someone rename an id by accident.

### Operations

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/admin/catalog/export` | Raw `catalog.json` — backup, and the hand-edit escape hatch |
| POST | `/api/v1/admin/catalog/import` | Full validate-then-write. Guarded |
| GET | `/api/v1/admin/versions` | `?file=catalog.json` — list S3 object versions |
| POST | `/api/v1/admin/restore` | Restore a version. Destructive: explicit confirmation |
| POST | `/api/v1/admin/cache/invalidate` | CloudFront invalidation after a publish (once a CDN exists) |

### Quotes (Phase 3, alongside `POST /api/v1/quotes`)

| Method | Path |
|---|---|
| GET | `/api/v1/admin/quotes` (`?status=&from=&to=`) |
| GET | `/api/v1/admin/quotes/:id` |
| PATCH | `/api/v1/admin/quotes/:id` (status, internal notes) |

---

## 4. Concurrency — the one thing that must not be hand-waved

`claude.md` §20 is explicit, and nesting the entire catalogue in one file makes
it sharper: **every product edit rewrites `catalog.json` in full**, so two admins
saving different products a second apart is a lost update, not an edge case.

The strategy:

1. Every admin `GET` returns a `version` field (the S3 `ETag`) alongside the data.
2. Every admin write **requires** `If-Match: <version>`. A missing header is
   `400 VALIDATION_FAILED` — never an implicit overwrite.
3. The repository performs `GetObject` → mutate → `PutObject` with the `IfMatch`
   condition. S3 rejects the write if the object changed underneath.
4. A rejected write returns `409 CONFLICT_STALE_DATA` with the current `version`
   and `updatedAt`, and the panel prompts to reload rather than silently retrying.
5. `updatedAt` is stamped on every successful write. This is what makes the
   field meaningful rather than decorative.

Verify S3 conditional-write (`If-Match` on `PutObject`) support in the SDK
version pinned here before building on it; if it is unavailable, the fallback is
a DynamoDB lock item, not blind overwrite. Do not ship the blind path "for now."

Public reads are unaffected — they are `GetObject` only.

---

## 5. Layering

`claude.md` §41, non-negotiable. No S3 call ever appears in a controller.

```
routes/public/*  routes/admin/*
        ↓
   controllers/          request/response shape only
        ↓
    services/            business rules, the transforms in §2
        ↓
  repositories/s3/       the only place aws-sdk is imported
        ↓
        S3
```

The bucket name `baba-gold` lives in `config/`, read from an env var — never in
handler code, never in the app, never in the admin panel. Storage must be
swappable for DynamoDB without touching a controller or a client.

Structure to create (none of it exists yet):

```
src/
  handlers/           routes/{public,admin}/   controllers/
  services/{products,categories,company,services,media,storage}/
  repositories/s3/    middleware/{auth,validation,error}/
  models/  schemas/  utils/  config/  types/
```

---

## 6. Build order

**Phase 1 — public read API (next).** The 12 read endpoints in §2.
No auth, no writes, no Cognito. JSON is hand-uploaded from `D:\Jewl App\data\`
to `s3://baba-gold/data/` — a deliberate stage, not tech debt. Done when the app
flips `DATA_SOURCE` to `'remote'` and behaves identically, verified against
`catalogRepository.test.ts`.

**Phase 1b — app reads settings from the API.** Replace `src/config/commerce.ts`
with values from `/settings`, per §0. This is an app-repo change and follows the
change protocol separately; the backend work above does not depend on it, but
the rule is not satisfied until it lands.

**Phase 2 — admin API.** Cognito, auth middleware, the concurrency layer,
catalog + content CRUD, media upload. Only starts once the app design is final.

**Phase 3 — quotes, CloudFront + invalidation, versions/restore.**

Per the project's change protocol, each phase gets an impact write-up
(*current implementation / required change / files affected / approach*) before
code, and any shared-model change is checked against all three consumers first.

---

## 7. Open questions for Ayush

1. **`/api/v1` prefix from day one?** Recommended. Free now, expensive later.
2. **`/bootstrap` endpoint?** Recommended — cuts app launch from four round
   trips to one, with no downside to the contract.
3. **Pricing model** — the *values* are now JSON-managed (§0), but the *model*
   is still open: per-product fixed `amount`, vs `priceOnRequest`, vs computed
   from a daily gold rate × weight + making charge. Only the third needs new
   API surface — `settings.commerce.goldRates` plus a rate-update endpoint, so
   one edit reprices the whole catalogue. Worth deciding before the admin panel
   is designed, because it changes what the product form looks like.
4. **Tax on making charges** — the current single 3% rate is a simplification.
   India taxes making charges at 5% when billed separately. If Baba Gold bills
   that way, `settings.commerce.tax` needs a second rate and products need a
   making-charge field.
5. **CloudFront domain** — needed to set `MEDIA_BASE_URL`. Until it exists the
   backend can return the S3 URL, but only if the bucket has a read-only public
   policy on `media/*`, which needs a deliberate decision.
6. **Environments** — separate buckets per stage, or prefixes inside
   `baba-gold`? §28 requires the split; prefixes are cheaper, separate buckets
   are safer.
7. **Quotes to the backend, or WhatsApp indefinitely?** Determines whether
   `POST /quotes` is real work or a placeholder.
8. **Admin users** — how many, and one role or several (owner vs staff)? Shapes
   the Cognito group design.
9. **Fallback images for categories, services and the company logo** — the
   current default is product-scoped only, and the logo deliberately has none.
