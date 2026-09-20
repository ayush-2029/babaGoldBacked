# Deploying

Two workflows, both under **Actions** in GitHub:

| Workflow | Stage | Reads |
| --- | --- | --- |
| Deploy to dev | `dev` | `s3://baba-gold-in/dev/` |
| Deploy to PRODUCTION | `prod` | `s3://baba-gold-in/prod/` |

## Nothing deploys by itself

`workflow_dispatch` is the only trigger on both. There is no `push`, no
`schedule`, no `pull_request`, no `workflow_run`, no `release`. **Merging to
main does not deploy anything** — it only makes the code available to deploy.
A deploy happens when a person opens the workflow and runs it, and not before.

Production asks you to type `deploy prod` as well, which guards the one real
one-click mistake: choosing the production workflow when you meant dev.

Both refuse to run from any branch except `main`.

## Required approval (recommended)

Go to **Settings → Environments → production** and add yourself as a required
reviewer. GitHub then holds every production run until it is approved, on top
of the typed confirmation. Do the same for `dev` if you want it there too.

This is also how you stop anyone else deploying: environment reviewers are
checked by GitHub, not by anything in these files.

## Secrets to set

**Settings → Secrets and variables → Actions**

| Secret | Needed | What it is |
| --- | --- | --- |
| `SERVERLESS_ACCESS_KEY` | always | Serverless Framework v4 requires it because `serverless.yml` declares `org:`/`app:`. Without it the CLI tries to log in and the job hangs. Create one at app.serverless.com → Access Keys. |
| `AWS_DEPLOY_ROLE_ARN` | preferred | An IAM role GitHub assumes via OIDC. No standing credentials. |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | fallback | Used only when `AWS_DEPLOY_ROLE_ARN` is empty. |

The workflows pick whichever is configured. **Prefer OIDC**: access keys are
long-lived credentials with deploy rights sitting in GitHub, and they have to
be rotated by hand. With OIDC there is nothing to steal and nothing to rotate.

### Setting up OIDC

One-off, in AWS:

1. IAM → Identity providers → add an OpenID Connect provider for
   `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
2. Create a role that trusts it, with the condition
   `token.actions.githubusercontent.com:sub` = `repo:ayush-2029/babaGoldBacked:ref:refs/heads/main`
   so only this repo's `main` can assume it.
3. Attach the permissions a Serverless deploy needs (CloudFormation, Lambda,
   API Gateway, IAM role creation for the function, S3 for the deployment
   bucket, and the log groups).
4. Put the role ARN in `AWS_DEPLOY_ROLE_ARN`.

The `sub` condition is the part that matters — without it any repository could
assume the role.

## What each run checks

Before deploying: it is on `main`, and `npm test` passes.

After deploying: it asks the deployed service for `/api/v1/health`, then reads
the Lambda's own configuration back and fails if the stage came up pointing at
the wrong data. A production stage quietly serving dev data is the expensive
failure here, so it is verified rather than assumed — and because `APP_ENV`
defaults to `dev`, a params mistake fails loudly at this step instead of
silently.

Deploys of the same stage queue rather than run together (`concurrency`), and
are never cancelled mid-flight: a half-applied CloudFormation stack is worse
than waiting.
