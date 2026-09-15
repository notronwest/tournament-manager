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

## Ship function changes separately from UX (same rule as migrations)

An edge function is a **deploy-on-merge server change** — exactly like a DB
migration: it goes live only on merge, and the preview calls the *prod*
function until then (see above). So it follows the **same split rule**:

- A function change ships in its **own PR**, separate from the UX that depends
  on it. Mark it **`[FN]`** + the **`edge-function`** label (the function
  sibling of `[DB]` / `db-migration`).
- **Deploy-on-merge server PRs go first.** Merge the `[FN]` (or `[DB]`) PR →
  it deploys → then the dependent **UX PR** is testable against the live
  function and merged. Expand/contract, same as schema.

Why: bundling a function change with its UI means the UI can't be exercised on
the preview before merge (the function isn't deployed yet) — the same
untestable-before-merge trap that motivated the DB split. Canonical rule:
[`../../wmpc-meta/conventions/migrations.md`](../../wmpc-meta/conventions/migrations.md).

## Inert until configured

If `SUPABASE_ACCESS_TOKEN` / `SUPABASE_PROJECT_REF` aren't set, the workflow
exits green doing nothing (fail-closed, same as `migrations.yml`). They are
currently set, so the pipeline is live. A failed deploy posts to
`DISCORD_WEBHOOK`.

## `send-tournament-summary` — end-of-tournament results email with a PDF

Emails every player who held a spot (`paid` / `pending_payment`
`event_registrations`) in one tournament the organizer's wrap-up message with
the results report attached as a PDF. Org-staff only; logged to
`contact_broadcasts` / `contact_broadcast_recipients` like the briefing, so it
appears on Email → History with delivery tracking. Service email — no
unsubscribe link (same rationale as `send-tournament-briefing`).

**Secrets:** none new. It reads `RESEND_API_KEY` and `RESEND_FROM_ADDRESS`,
which already exist for the other Resend functions.

**Why it sends per recipient, in windows.** This was the first email in the
codebase with an attachment, and Resend's `/emails/batch` endpoint does not
accept attachments. So the function sends one `POST /emails` per recipient,
paced (~550 ms apart, one 429 retry) to stay under Resend's default 2 req/s.
To keep each invocation short it processes a **window** of recipients per call
and the client loops on `nextCursor`. Recipients are sorted by lowercased email
so windows never overlap or skip. The validation + single-send + pacing helpers
live in `_shared/attachments.ts` and are reused by `send-contact-broadcast`.

**Request** (JSON; JWT in `Authorization` via `supabase.functions.invoke`):

```
{ tournamentId, mode: "preview" | "test" | "send",
  subject,                       // test/send, ≤ 200 chars
  message,                       // plain text, blank line = paragraph
  attachment: { filename, contentBase64 },   // test/send; .pdf, ≤ 5 MB decoded
  consent: true,                 // send
  cursor: 0, limit: 25,          // send; limit clamped 1..50
  broadcastId }                  // send; required when cursor > 0
```

**Responses (200):**

- `preview` → `{ mode, total, missingEmail, sample: [first 5 emails], fromAddress }`
- `test` → sends the real email (attachment included) to the caller → `{ mode, sentTo }`
- `send` → cursor 0 creates the `contact_broadcasts` row, then sends
  `recipients[cursor, cursor+limit)` → `{ mode, total, sent, failed, nextCursor, broadcastId }`
  (`nextCursor` is `null` on the last window; pass `broadcastId` back on every
  later call).

**Errors** (`{ error, detail? }`): 401 `unauthorized`, 403
`forbidden_org_staff_only`, 404 `tournament_not_found` / `broadcast_not_found`,
400 `invalid_mode` / `tournament_id_required` / `subject_required` /
`subject_too_long` / `attachment_required` / `attachment_invalid` /
`attachment_too_large` / `consent_required` / `broadcast_id_required` /
`no_recipients`, 500 `missing_resend_config`, 502 `send_failed` (test send).

## `send-contact-broadcast` — org-wide admin email, with optional PDF attachments

Emails the club's contact list (imported contacts + registrants, deduped,
unsubscribed dropped), optionally narrowed to `playerIds`. Org-staff only,
`consent: true` required. Every send is logged to `contact_broadcasts` /
`contact_broadcast_recipients` with a per-recipient signed unsubscribe link and
`List-Unsubscribe` headers.

**Secrets:** none new. It reads `RESEND_API_KEY` and `RESEND_FROM_ADDRESS`,
which already exist.

**Two delivery paths, chosen by whether `attachments` is present:**

- **No attachments (or an empty array)** — unchanged: the whole list goes out
  in one call via Resend `/emails/batch` in chunks of 100. `cursor` / `limit` /
  `broadcastId` are ignored. Response
  `{ broadcastId, recipientCount, sent, failed?, detail? }`; 502 (and the
  broadcast row removed) when Resend accepted nothing.
- **With attachments** — `/emails/batch` cannot carry files, so the send
  becomes one `POST /emails` per recipient, paced under Resend's 2 req/s, and
  the function processes a **window** per call; **the client loops on
  `nextCursor` until it is `null`**, passing back `broadcastId` on every call
  after the first. The recipient list is computed the same way on every call
  and sorted (lowercased email, then playerId) so windows never overlap or
  skip. Cursor 0 creates the `contact_broadcasts` row (`recipient_count` =
  the whole list). Each email is identical to the batch path (html, reply-to,
  unsubscribe link + headers) plus the files.

**Request** (JSON; JWT in `Authorization` via `supabase.functions.invoke`):

```
{ organizationId, subject, body, consent: true,
  playerIds?: string[],                  // restrict to this subset
  bodyIsHtml?: boolean, replyTo?: string,
  attachments?: [{ filename, contentBase64 }],  // PDF only; ≤ 3 files, ≤ 5 MB total decoded
  cursor: 0, limit: 25,                  // attachments only; limit clamped 1..50
  broadcastId }                          // attachments only; required when cursor > 0
```

**Response (200, attachments path):**
`{ broadcastId, recipientCount, sent, failed, nextCursor, detail? }` —
`sent` / `failed` count **this window**; `recipientCount` is the whole list;
`detail` is the first Resend error, if any. Per-recipient failures are counted
and logged, never thrown. On the **final** window, if no window at all produced
a recipient row, the broadcast row is deleted and the call returns 502 like the
batch path's "nothing accepted" case.

**Errors** (`{ error, detail? }`): 401 `unauthorized`, 403
`forbidden_org_staff_only`, 404 `organization_not_found` /
`broadcast_not_found` (a `broadcastId` from another org), 400
`consent_required` / `invalid_reply_to` / `no_recipients` /
`too_many_recipients` / `attachment_invalid` / `attachment_too_large` /
`too_many_attachments` / `broadcast_id_required`, 500 `server_misconfigured`,
502 when Resend accepted nothing.
