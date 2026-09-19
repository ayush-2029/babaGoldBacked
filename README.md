# BabaGold Backend

The API behind the BabaGold mobile app and admin panel. Express 5 on Lambda via
`serverless-http`, serving JSON documents stored in S3.

`API_CONTRACT.md` is the authority on what every endpoint does and why. This
file is how to run it.

---

## Run it locally — no AWS needed

```bash
npm install
npm run dev
```

Serves on `http://localhost:4000/api/v1`, reading the hand-authored JSON in
`D:\Jewl App\data\` directly. This is a real driver, not a mock: the same
services, the same transforms, the same conditional-write behaviour. It exists
so the whole API can be exercised before anything is uploaded to S3.

```bash
curl http://localhost:4000/api/v1/categories
curl http://localhost:4000/api/v1/products?q=22k+gold
```

For the admin routes, set a token first:

```bash
AUTH_MODE=token ADMIN_API_TOKEN=dev-token npm run dev

curl -H "Authorization: Bearer dev-token" http://localhost:4000/api/v1/admin/settings
```

## Tests

```bash
npm test
```

53 tests, no AWS credentials required. Each run copies `test/fixtures/` to a
temporary directory, so the suite can write freely without touching the real
data files.

`test/public.test.js` is the conformance suite: its assertions mirror the app's
`catalogRepository.test.ts`, so a break there means the app breaks too.

---

## Layout

```
handler.js            Lambda entry — builds the app once per container
local.js              Plain HTTP server for development
src/
  app.js              Express wiring: CORS, routers, error handler
  config/             Every env-dependent value, resolved once
  routes/public/      12 read endpoints, unauthenticated
  routes/admin/       45 write endpoints, all authenticated
  controllers/        Request/response shape only
  services/           Business rules — the transforms the app used to do
    catalog/          Categories, products, search
    content/          Company, services, home, storefront, settings
    admin/            Write paths for both of the above
    media/            URL resolution, presigned upload, validation
  repositories/       The storage seam
    jsonRepository.js Driver selection and per-container read cache
    s3/               The only place the AWS SDK is imported
    local/            Filesystem driver, same interface
  middleware/         auth, validation, error
  schemas/            Write-side validation
  utils/              Envelope, error codes
```

Nothing above `repositories/` knows S3 exists, and nothing outside `config/`
reads `process.env`. Swapping S3 for DynamoDB means writing a third driver and
changing nothing else.

---

## Environment

| Variable | Default | Notes |
|---|---|---|
| `STORAGE_DRIVER` | `s3` | `local` reads the filesystem instead |
| `LOCAL_DATA_DIR` | `../../../data` | Only used by the local driver |
| `DATA_BUCKET` | `baba-gold-in` | ap-south-1 (Mumbai). Never named in an error or in the data |
| `DATA_PREFIX` | `data` | Object prefix within the bucket |
| `MEDIA_URL_MODE` | `signed` | `signed` presigns every image URL; `public` uses `MEDIA_BASE_URL`. Defaults to `public` under the local driver |
| `MEDIA_BASE_URL` | *(empty)* | Only used in `public` mode — a CDN or public bucket |
| `SIGNED_URL_TTL` | `3600` | Seconds a signed URL stays valid |
| `SIGNING_WINDOW` | `2700` | Seconds between new signatures. Must stay below the TTL |
| `AUTH_MODE` | `token` | `token` or `cognito` |
| `ADMIN_API_TOKEN` | — | Shared secret for `token` mode. Refused in production |
| `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` | — | Required for `cognito` mode |
| `ALLOWED_ORIGINS` | `*` | Comma-separated. Set it once the panel is deployed |
| `READ_CACHE_TTL_MS` | `3000` | Per-container read cache. Short on purpose — see caching note |
| `CACHE_MAX_AGE` | `0` | 0 = always revalidate. Raise only behind a CDN |
| `MAX_UPLOAD_BYTES` | `8388608` | 8MB |

---

## Two things to understand before changing anything

**Every admin write needs an `If-Match`.** Admin reads return a `version`; the
matching write must send it back. S3 rejects the PUT if the document moved
underneath, and the API returns `409 CONFLICT_STALE_DATA`. Without this, two
admins saving a minute apart silently lose one of the edits — and because the
whole catalogue is one file, that is every pair of concurrent edits, not just
edits to the same product.

**Image URLs are presigned, and the cache headers are bound to them.** Nothing
under `media/` is world-readable — the bucket has no public policy. Each
response signs its image keys for `SIGNED_URL_TTL` (1h).

Signing is pinned to the start of a `SIGNING_WINDOW` (45m), which buys two
things. Every request inside a window produces a *byte-identical* URL, so the
app's image cache still works; and the gap between window and TTL means a URL
handed out at the last instant of a window still has 15 minutes left.

The trap this avoids: the ETag is the S3 object's, and the JSON rarely changes,
so a client could revalidate to `304` indefinitely while holding a body whose
image URLs quietly expired. The signing window is folded into the ETag and
clamps `max-age`, so a cached response can never outlive the links inside it.

Two consequences worth knowing:

- **Presigned URLs are bound to the HTTP method.** These are signed for `GET`.
  A `HEAD` against one fails signature validation — fine for `<img>`, surprising
  when testing with curl.
- **They cannot outlive the Lambda's role credentials.** A 1h TTL is safely
  inside that. Do not raise `SIGNED_URL_TTL` towards S3's 7-day maximum without
  testing — it will fail at the credential boundary, not the stated expiry.

Set `MEDIA_URL_MODE=public` (plus `MEDIA_BASE_URL`) to go back to plain URLs
once a CDN exists.

**Uploads are two calls, not one.** `POST /media/upload-url` returns a
presigned PUT; the browser uploads straight to S3, which means the backend
never sees the bytes. `POST /media/confirm` is where validation actually
happens — size, content type, and whether the file's magic bytes match its
extension. Only a confirmed key may be written into a document. A JPEG named
`.png` passes every client-side check and every test, then fails an Android
release build days later; `confirm` is what catches it at upload time instead.

---

## Deployed

**Stage `dev` is live in `ap-south-1`:**

```
https://yq798ysiji.execute-api.ap-south-1.amazonaws.com/api/v1
```

Stack `BabaGoldBackend-dev`, function `BabaGoldBackend-dev-api`, reading
`s3://baba-gold-in` (versioning on, nothing public — image URLs are presigned).

```bash
curl https://yq798ysiji.execute-api.ap-south-1.amazonaws.com/api/v1/categories
npm run deploy          # redeploy
npm run logs            # tail CloudWatch
npx serverless remove --stage dev   # tear the stack down
```

**The admin token lives in SSM, never in this repo:**

```bash
aws ssm get-parameter --name /babagold/dev/admin-api-token \
  --with-decryption --region ap-south-1 --query Parameter.Value --output text
```

The function reads it from SSM **at cold start**; only the parameter path is in
the Lambda config, so the secret never reaches the CloudFormation template, the
function's environment, or the deploying machine's disk. Rotate with
`put-parameter --overwrite` — no redeploy needed, the next cold start picks it
up. There is no prod parameter by design: production refuses token auth, so a
prod deploy must set `AUTH_MODE=cognito`.

The Lambda's IAM role is scoped to this bucket and these prefixes, plus its own
log group. Do not widen it; the function never needs more than the objects it
serves.

Still outstanding before this is production-ready:

- **A CDN.** Presigned URLs mean no shared caching: every image comes from S3
  directly, and each device re-fetches once per signing window. That is the
  price of keeping the bucket private. CloudFront with signed URLs or signed
  cookies gets both; until then the trade is deliberate.
- **Cognito**, to replace the shared token with real identities and revocation.
- **`ALLOWED_ORIGINS`**, currently `*`. Set it to the admin panel's origin once
  that exists — the admin routes are credentialed.
- whether dev and prod share `baba-gold-in` with different prefixes or get
  separate buckets (`serverless.yml` is written for the prefix split).
