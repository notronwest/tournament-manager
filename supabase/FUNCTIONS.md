# Edge functions — how they ship

Edge functions deploy **automatically on merge to `main`**, via
`.github/workflows/edge-functions.yml`. You never run
`supabase functions deploy` by hand. Merge a PR that touches
`supabase/functions/**` → the function is live in prod within a minute.

This mirrors how the rest of the stack ships: migrations auto-apply
(`migrations.yml`), the frontend auto-deploys (Cloudflare). Edge functions
used to be the one piece with **no** automation — a merged function sat
undeployed until someone remembered, which is why "it needs an edge function"
kept looking broken.

## What the pipeline does and doesn't cover

- ✅ **Deploys the function code** — all functions, every merge (idempotent).
- ✅ **Honors per-function settings** from `config.toml` (e.g.
  `[functions.stripe-webhook] verify_jwt = false`).
- ❌ **Does NOT set secrets.** Secrets (`SITE_ADMIN_EMAIL`, `STRIPE_SECRET_KEY`,
  …) are, by definition, not in the repo. A function that reads a secret that
  isn't set will 500. **If your PR adds a function that needs a new secret,
  flag it** and set it in the Supabase dashboard
  (Project Settings → Edge Functions → Secrets) **before merging.**

## The one thing this does NOT solve: PR previews

The Cloudflare **preview** for a PR points at the *one shared* Supabase
project, where a not-yet-merged function does not exist. So a preview can't
exercise a brand-new function end-to-end — only the UI states that don't call
it. The full flow works once merged (this pipeline guarantees that). Making
previews fully testable would mean pointing them at the test Supabase project
and deploying PR functions there — tracked separately as an infra story.

## Inert until configured

If `SUPABASE_ACCESS_TOKEN` / `SUPABASE_PROJECT_REF` aren't set, the workflow
exits green doing nothing (fail-closed, same as `migrations.yml`). They are
currently set, so the pipeline is live. A failed deploy posts to
`DISCORD_WEBHOOK`.
