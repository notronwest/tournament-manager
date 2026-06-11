# Refunds & withdrawals — design

Source of truth for the **player self-withdraw + policy-aware refund** flow
(epic #22, surface (a) = #199). The UI carries **no money logic**: it calls the
`stripe-refund` edge function with `dry_run: true` for a preview, then again to
execute. All math + the Stripe call live server-side.

Two server pieces implement this:

1. **`public.refund_compute(p_event_registration_id uuid)`** — a pure,
   read-only SQL function (migration `20260611120000_refund_compute.sql`) that
   returns the refund *decision* and *amount* for one event registration. No
   writes, no Stripe.
2. **`stripe-refund` edge function** — authenticates the caller, calls
   `refund_compute`, and (on execute) issues the Stripe refund + flips the
   registration status + unpairs the partner. Idempotent.

---

## What is refundable (locked decisions — Ron, 2026-06-11)

- **Event fee only.** A single-event withdrawal refunds *that event's* fee — the
  `payment_line_items` row tied to the `event_registration_id`. The
  tournament-level **entry fee is never refunded** on a single-event withdraw
  (it's a separate line item with no `event_registration_id`).
- **Platform fee non-refundable.** The platform's `application_fee_amount` is
  **kept**. Stripe refunds use `refund_application_fee: false`; the connected
  (organizer) account absorbs the refunded event fee via `reverse_transfer:
  true` (these are Connect **destination** charges).
- **Half rounds to the nearest cent.** A "half refund" window returns
  `round(paid_cents / 2)` — `round(paid::numeric / 2.0)::int`, i.e. round half
  up. `dry_run` and execute use the same function, so the previewed number and
  the charged number always agree.

---

## Policy → decision

`tournaments.cancellation_policy_preset` drives the math. Windows are measured
against `tournaments.starts_at` ("before start") and the registration's
`registered_at` ("after registering"). `now()` is server time.

| preset | rule |
|---|---|
| **generous** | `> 7 days before start` → **full**; within 7 days of start → **none** |
| **standard** | `≤ 7 days after registering` → **full**; else `≥ 7 days before start` → **half**; else (within 7 days of start) → **none** |
| **strict** | always **none** (no refund after registration) |
| **custom** | **manual_required** — organizer-defined windows aren't modelled yet |
| `NULL` (unchosen) | **manual_required** |

### Decision values returned by `refund_compute`

| `decision` | meaning | `refund_cents` |
|---|---|---|
| `full` | full event fee back | = `paid_cents` |
| `partial` | half (rounded) | = `round(paid_cents/2)` |
| `none` | policy allows withdraw but $0 back | `0` |
| `unpaid` | reg is `pending_payment` — no charge to refund | `0` |
| `manual_required` | can't auto-decide → organizer review (#200) | `0` |

### Flagged / tunable (Ron can change in one place)

- **standard, the 7–30 day-before window.** The published preset summary says
  "half > 30d before, none < 7d before," leaving 7–30 days undefined. We resolve
  it **in the player's favor as half** (half applies whenever `≥ 7 days before
  start`, after the registration cooling-off). The literal "30d" is therefore
  informational. To make 7–30 days *none* instead, change the single threshold
  in `refund_compute`. This is the only place the math diverges from a strict
  reading of the preset text.
- **Coupons → manual_required (safety).** If the covering payment carried a
  coupon (any `payment_line_items` row on that payment with `amount_cents < 0`),
  the per-event line item overstates what the player *net* paid, so a naive
  refund could exceed it. `refund_compute` returns **manual_required** in that
  case rather than risk over-refunding. (A proportional-refund follow-up can
  remove this restriction.)
- **No succeeded payment for a `paid` reg** (data inconsistency) →
  **manual_required** (a human verifies before money moves).

---

## `stripe-refund` edge function contract

`POST /functions/v1/stripe-refund` — `Authorization: Bearer <user JWT>`.

**Request**

```jsonc
// mode "self" (default) — the PLAYER withdraws (owner-authorized)
{ "eventRegistrationId": "uuid", "dryRun": true }   // preview
{ "eventRegistrationId": "uuid", "dryRun": false, "reason": "..." }  // execute
//   On execute, if the policy can't auto-decide (manual_required), this FILES
//   a withdrawal request (withdrawal_requested_at + withdrawal_reason) for the
//   organizer queue (#200) and returns { applied:false, requested:true }.

// mode "resolve" — an ORGANIZER resolves a queued request (#200).
//   Authorized as has_org_role(<reg's tournament org>, 'admin').
{ "eventRegistrationId": "uuid", "mode": "resolve",
  "decision": "approve", "amountCents": 1500, "dryRun": false }  // refund $15
{ "eventRegistrationId": "uuid", "mode": "resolve", "decision": "deny" }
//   approve + amount>0 → refund that amount → 'refunded'; approve+$0 or deny →
//   'withdrawn'. Either stamps withdrawal_decided_at + withdrawal_decision.
//   amountCents is server-clamped to [0, paid_cents].
```

**Response (200)**

```jsonc
{
  "decision": "full | partial | none | unpaid | manual_required",
  "paidCents": 4000,
  "refundCents": 2000,
  "currency": "usd",
  "partner": { "name": "Tom Edwards", "willUnpair": true } | null,
  // execute only:
  "applied": true,
  "newStatus": "refunded | withdrawn | cancelled | null"  // null when manual_required
}
```

Error bodies are `{ "error": "<code>" }` with a 4xx/5xx status, decoded by the
client via the `fnErr.context` pattern (see `CheckoutPage`). Codes:
`unauthorized` (401), `player_not_found` / `registration_not_found` (404),
`forbidden` (403, not the caller's registration), `not_withdrawable` (409,
already withdrawn/refunded/cancelled), `refund_failed` (502, Stripe error).

### Execute semantics

| situation | Stripe call | new `event_registrations.status` |
|---|---|---|
| `manual_required` | none | unchanged (hand off to organizer review #200) |
| `unpaid` (pending) | none | `cancelled` |
| paid, `refund_cents == 0` | none | `withdrawn` |
| paid, `refund_cents > 0` | `refunds.create` | `refunded` |

- **Idempotent.** The Stripe refund is created with `idempotencyKey =
  refund_<eventRegistrationId>`, and the status flip is guarded
  (`... where id = $1 and status = 'paid'`), so a double-submit never
  double-refunds.
- **Partner unpair.** If the withdrawing reg has a `partner_registration_id`,
  both sides are cleared and the *remaining* partner is set back to
  `partner_status = 'seeking'` (they're looking again). The preview reports the
  partner's name + `willUnpair: true` so the ConfirmModal can warn first.
- The refund is by `payment_intent` with `reverse_transfer: true,
  refund_application_fee: false` (keep the platform fee; debit the organizer).

## Late-withdrawal queue columns (#200)

When surface (a) can't auto-decide (`manual_required`), the player files a
withdrawal **request** instead of an instant refund, and the organizer resolves
it from a queue (#200). Migration `20260611130000_withdrawal_request_columns`
adds, on `event_registrations`:

| column | type | meaning |
|---|---|---|
| `withdrawal_requested_at` | `timestamptz` | player filed the request (reg stays `paid`, no status change) |
| `withdrawal_reason` | `text` | optional reason from the player |
| `withdrawal_decided_at` | `timestamptz` | organizer resolved it |
| `withdrawal_decision` | `withdrawal_decision` enum (`approved`/`denied`) | the organizer's call |

The **pending queue** = `withdrawal_requested_at is not null and
withdrawal_decided_at is null` (a partial index backs this). The chosen refund
**amount** is not stored here — it's passed to `stripe-refund` (manual mode,
not yet built) at approve time and recorded in `payments`. Approve → manual
refund → status `refunded` (or `withdrawn` if $0); deny → `withdrawn`, no refund.

---

## Deploy — happens on merge (do NOT hand-run)

Per the WMPC convention, schema and edge functions deploy via **CI on merge to
`main`** — never a hand-run `supabase db push` / `functions deploy` (that's what
caused drift). So **merging this PR is the deploy:**

1. **Migration** → applied to prod by `.github/workflows/migrations.yml`
   (`db push --include-all`) on merge.
2. **`stripe-refund` function** → deployed by
   `.github/workflows/edge-functions.yml` on merge. **No new secrets** —
   `STRIPE_SECRET_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` are already
   set and auto-injected.
3. **Types** → `refund_compute` is `service_role`-only and called by the edge
   function (not the browser), so the frontend `supabase.ts` does **not** need
   regenerating for it.

**The one human step (Ron):** verify a **test-mode** payment → withdraw before
relying on it in prod. There's no safe pre-prod Stripe path yet — that's what
the `.test` environment + Stripe-test-mode enabler (#255) and the staging
release process (#227) are for; until then this can only be exercised carefully
against prod.
