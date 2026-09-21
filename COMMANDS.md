# Commands — backend (API)

Everything you actually run here. Sibling files: `COMMANDS.md` in the app and
the admin panel repos.

## The one rule

**Deploys happen from GitHub Actions, not from a laptop.** The workflows run
the tests, check the deploy actually came up, and leave a record of who
released what and why. A local `serverless deploy` does none of that.

---

## Run it locally

```bash
npm run dev
```

Serves `http://localhost:4000/api/v1` from the hand-authored JSON in
`../../data/`, with **no AWS and no credentials**. Nothing it does can touch
dev or prod.

Against a copy of real data instead:

```bash
# Windows PowerShell
$env:STORAGE_DRIVER="local"; $env:LOCAL_DATA_DIR="C:\path\to\json"; npm run dev

# bash
STORAGE_DRIVER=local LOCAL_DATA_DIR=/path/to/json npm run dev
```

Point it at the **real dev bucket** (needs AWS credentials — it writes to
`dev/`, never `prod/`):

```bash
# PowerShell
$env:STORAGE_DRIVER="s3"; $env:APP_ENV="dev"; $env:DATA_BUCKET="baba-gold-in"; npm run dev
```

`APP_ENV` defaults to `dev`, so forgetting it is safe. Only an explicit
`APP_ENV=prod` reaches production data, and nothing here should ever set that.

## Tests

```bash
npm test          # 115 tests, no AWS needed
```

---

## Deploy

### Dev

GitHub → **Actions** → **Deploy to dev** → *Run workflow* → branch `main`.

Runs the tests, deploys `--stage dev`, then checks `/health` and that the
stage came up reading `dev/data`.

### Production

GitHub → **Actions** → **Deploy to PRODUCTION** → *Run workflow*, and type
`deploy prod` in the confirmation box.

Also checks afterwards that the stage is really reading `prod/data` — a
production deploy quietly serving dev data is the expensive failure, so it is
verified rather than assumed.

Neither ever runs by itself. There is no `push`, `schedule` or `release`
trigger; **merging to main deploys nothing.**

### If you must deploy from a laptop

```bash
npx serverless deploy --stage dev
npx serverless deploy --stage prod   # avoid — use the workflow
```

No tests, no post-deploy check, no record. Only for when Actions is down.

## Logs

```bash
npm run logs                                  # tails the default stage
npx serverless logs -f api -t --stage prod    # production
```

---

## Which data a stage reads

| Stage | `APP_ENV` | Reads |
| --- | --- | --- |
| dev | `dev` | `s3://baba-gold-in/dev/` |
| prod | `prod` | `s3://baba-gold-in/prod/` |

Each stage's IAM role is scoped to its own root, so a dev deployment **cannot**
write production data even if its config were wrong. Check it yourself:

```bash
aws iam simulate-principal-policy \
  --policy-source-arn "$(aws lambda get-function-configuration \
      --function-name BabaGoldBackend-dev-api --region ap-south-1 \
      --query Role --output text)" \
  --action-names s3:PutObject \
  --resource-arns arn:aws:s3:::baba-gold-in/prod/data/catalog.json \
  --query 'EvaluationResults[0].EvalDecision' --output text
# implicitDeny
```

## The operator notice

The one document with no admin screen — edited by hand so it stays with
whoever holds the AWS account:

```bash
aws s3 cp s3://baba-gold-in/dev/data/notice.json .   # or prod/
# edit, then
aws s3 cp notice.json s3://baba-gold-in/dev/data/notice.json --content-type application/json
```

`enabled: false`, or no file at all, means nothing is shown. `mode: "block"`
shuts every customer out of the app; anything that is not exactly `"block"`
degrades to a closable message.
