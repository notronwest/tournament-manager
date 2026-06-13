# Refunds & withdrawals — design

Source of truth for the player withdraw + refund-request flow (epic #22,
surfaces #289 player side / #200 organizer side). The UI carries **no money
logic**: amounts come from server-side RPCs and edge functions.

---

## Model — revised 2026-06-13 (supersedes the auto-refund model from #199)

Every refund now routes through an organizer decision. There is no more instant
auto-refund. Two separate player actions replace the old single "withdraw +
optional instant refund" step:

```
paid ─[1. withdraw]→ withdrawn ─[2. request refund]→ ($Y frozen, pending queue)
                                                            └─[3. organizer decides → #200]→ refunded | stays withdrawn
```

1. **Withdraw** (player, #289). Confirm modal + partner-unpair →
   reg `withdrawn`. `pending_payment` regs → `cancelled`. **No Stripe call, no
   money movement.** The entitled refund `$Y` is computed from `refund_compute`
   and **snapshotted at withdraw time** into `entitled_refund_cents` so an
   organizer delay cannot shrink it.
2. **Request refund** (player, #289). After withdrawing, a withdrawn+paid reg
   shows a "Request refund" affordance. The player sees **paid `$X`** (event fee)
   and **entitled `$Y`** (from `entitled_refund_cents` — already frozen). On
   submit, `file_refund_request()` stamps `withdrawal_requested_at` and
   (optional) `withdrawal_reason`. Idempotent — can't re-file.
3. **Organizer decides** (#200). Queue shows `entitled_refund_cents` as the
   pre-filled approve amount (adjustable $0–paid); organizer approves or denies
   via `stripe-refund` **manual** mode.

**Locked decisions (Ron, 2026-06-13):**
- (a) Every refund routes through an organizer decision — no auto-refund.
- (b) Entitlement is **snapshotted at withdraw time** (not request-filing time),
  frozen to the moment of withdrawal.
- (c) Withdraw and request-refund are two separate steps.

---

## Server pieces

### 1. `public.refund_compute(p_event_registration_id uuid)`

Pure, read-only SQL function (migration `20260611120000_refund_compute.sql`).
Returns `decision` + `paid_cents` + `refund_cents` for one event registration.
No writes, no Stripe. `SECURITY DEFINER`, granted to `service_role` only.

Called by:
- `withdraw_self()` (below) — at withdraw time, while the reg is still `paid`,
  to compute the entitled amount before snapshotting it.
- `stripe-refund` edge function — for the organizer manual-resolve path (#200).

### 2. `public.withdraw_self(p_reg_id uuid)` (added in #289)

`SECURITY DEFINER` RPC granted to `authenticated`. Explicit `auth.uid()` →
`player_id` ownership check.

- `paid` → `withdrawn`. Calls `refund_compute()` first (while still `paid`) and
  snapshots `entitled_refund_cents` atomically with the status flip.
  - `decision = full/partial` → snapshot the computed amount.
  - `decision = none` → snapshot 0 (player sees $0.00 and may still submit a
    review request).
  - `decision = manual_required` → snapshot `null` (organizer determines amount).
- `pending_payment` → `cancelled`. No refund step offered.
- Clears both sides of a doubles pair; the remaining partner returns to
  `partner_status = 'seeking'`.
- Returns `(new_status, entitled_cents)`.

### 3. `public.file_refund_request(p_reg_id uuid, p_reason text)` (added in #289)

`SECURITY DEFINER` RPC granted to `authenticated`.

- Must be called on a `withdrawn` reg owned by the caller.
- Stamps `withdrawal_requested_at = now()` and `withdrawal_reason`.
- Idempotent: re-filing returns `false` (no-op).
- Enqueues the reg into the organizer pending-withdrawals queue (#200).

### 4. `stripe-refund` edge function

`POST /functions/v1/stripe-refund` — `Authorization: Bearer <user JWT>`.

**`mode: "resolve"` (organizer, #200).** Resolves a queued withdrawal request.

```jsonc
// Organizer approve
{ "eventRegistrationId": "uuid", "mode": "resolve",
  "decision": "approve", "amountCents": 1500, "dryRun": false }

// Organizer deny
{ "eventRegistrationId": "uuid", "mode": "resolve",
  "decision": "deny", "dryRun": false }
```

Approve + `amountCents > 0` → Stripe refund → `refunded`; approve + $0 or deny
→ `withdrawn`. Both stamp `withdrawal_decided_at` + `withdrawal_decision`.
`amountCents` is server-capped at the net amount charged on the covering payment
(`min(paid_cents, payments.amount_cents)`) to prevent over-refund when a coupon
reduced the payment below the per-event gross. Stripe is the hard backstop.

Response codes: `unauthorized` (401), `registration_not_found` (404),
`forbidden` (403), `not_withdrawable` / `no_pending_request` (409),
`refund_failed` (502).

The legacy `mode: "self"` / `dryRun: false` execute path is no longer called by
the player UI (replaced by `withdraw_self` + `file_refund_request`), but remains
available.

---

## What is refundable (locked decisions — Ron, 2026-06-11)

- **Event fee only.** A single-event withdrawal refunds the `payment_line_items`
  row tied to the `event_registration_id`. The tournament-level **entry fee is
  never refunded** on a single-event withdraw (it's a separate line item with no
  `event_registration_id`).
- **Platform fee non-refundable.** `refund_application_fee: false`;
  `reverse_transfer: true` (Connect destination charges — organizer absorbs).
- **Half rounds to the nearest cent.** `round(paid_cents::numeric / 2.0)::int`.

---

## Policy → decision

`tournaments.cancellation_policy_preset` drives the math.

| preset | rule |
|---|---|
| **generous** | `> 7 days before start` → **full**; otherwise → **none** |
| **standard** | `≤ 7 days after registering` → **full** (cooling-off); else `≥ 7 days before start` → **half**; else → **none** |
| **strict** | always **none** (no refund after registration) |
| **custom** | **manual_required** — organizer-defined windows not modelled yet |
| `NULL` (unchosen) | **manual_required** |

| `decision` | `refund_cents` snapshotted in `entitled_refund_cents` |
|---|---|
| `full` | `= paid_cents` |
| `partial` | `= round(paid_cents / 2)` |
| `none` | `0` |
| `manual_required` | `null` (organizer decides) |
| `unpaid` | `null` (no payment; reg → `cancelled`) |

### Edge cases

- **Coupons → `manual_required`.** If the covering payment has a negative line
  item (coupon), `refund_compute` returns `manual_required` to avoid risk of
  over-refund. `entitled_refund_cents` is snapshotted as `null`.
- **No succeeded payment for a `paid` reg** → `manual_required`.
- **standard, 7–30 day window.** We resolve in the player's favor: half applies
  whenever `≥ 7 days before start` after the cooling-off period.

---

## Database columns on `event_registrations`

| column | type | meaning |
|---|---|---|
| `entitled_refund_cents` | `integer` (nullable) | Policy `$Y` frozen at withdraw time. Pre-fills the organizer's Approve amount. `null` = manual_required; `0` = policy denies but player can still request review. |
| `withdrawal_requested_at` | `timestamptz` (nullable) | Player filed the refund request. `null` = not yet requested. |
| `withdrawal_reason` | `text` (nullable) | Optional player-provided reason. |
| `withdrawal_decided_at` | `timestamptz` (nullable) | Organizer resolved the request. |
| `withdrawal_decision` | `withdrawal_decision` enum (nullable) | `approved` or `denied`. |

Pending queue = `withdrawal_requested_at IS NOT NULL AND withdrawal_decided_at IS
NULL` (backed by a partial index for the organizer queue view in #200).

---

## Deploy — happens on merge

Per WMPC convention, schema and edge functions deploy via CI on merge to `main`.
Never hand-run `supabase db push` or `functions deploy`.

**New secrets needed:** none. Existing `STRIPE_SECRET_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` already set.
