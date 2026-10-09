// supabase/functions/create-payment-intent/index.ts
//
// SKELETON — drafted for #20 (see docs/STRIPE_CHARGING.md). Ron reviews +
// completes the [DECIDE]/TODO parts before deploy. Money path: do not
// ship without sign-off.
//
// Creates a Stripe Connect *direct charge* PaymentIntent for the caller's
// pending_payment registrations in one tournament, records a pending
// `payments` row + `payment_line_items`, and returns the client_secret (and
// the organizer's connected account id) for the browser's Stripe Payment
// Element to confirm.
//
// DIRECT charge (not destination): the PaymentIntent is created ON the
// organizer's connected account (`{ stripeAccount: org.stripe_account_id }`),
// so the funds settle straight into THEIR balance and never pass through the
// platform's — the organizer is merchant of record (their 1099-K, their
// statement descriptor) and pays Stripe's processing fee. The platform's only
// cut is `application_fee_amount`, pulled to the platform account. Because the
// intent lives on the connected account, its client_secret is
// connected-account-scoped: the browser must init Stripe.js with the returned
// connectedAccountId (see web/src/lib/stripe.ts).
//
// The amount is computed SERVER-SIDE (never trusted from the client) via
// the compute_checkout_total RPC, then optionally reduced by a validated
// coupon, then by any available account credit (#1102, D-0077 §2, coupon
// first). The platform fee drives the Connect split.
//
// Platform fee is read from the platform_settings table (no-code,
// editable by the site super-admin), not from an env var.
//
// Required secrets:
//   STRIPE_SECRET_KEY                  — already set for Connect.
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY
//                                      — auto-injected by the runtime.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "npm:@supabase/supabase-js@2";
// @ts-expect-error remote import resolved at runtime by Deno
import Stripe from "npm:stripe@14.21.0";
import { computeChargeCents, computePlatformFeeCents } from "../_shared/platformFee.ts";

// At-checkout donation add-on (#378). Same bounds as the standalone
// create-donation-intent flow, for the same reason: a sane floor against
// $0/negative and a sanity ceiling for a single card charge.
const MIN_DONATION_CENTS = 100;
const MAX_DONATION_CENTS = 100_000_00;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Registration statuses a player can pay for. 'waitlisted_pending_payment' is
// a promoted waitlister whose spot is reserved ("pay to claim") — the checkout
// total (compute_checkout_total) includes them, so the guard and the flip
// below must too, or pay-to-claim 409s / never flips to paid.
const PAYABLE_STATUSES = ["pending_payment", "waitlisted_pending_payment"];

type Body = {
  orgSlug: string;
  tournamentSlug: string;
  couponCode?: string;
  // The browser's origin (window.location.origin). Stashed into the
  // PaymentIntent metadata so the webhook — which has no browser
  // context — can build partner-invite accept links pointing back at
  // wherever the player checked out (localhost vs. prod). See #191.
  baseUrl?: string;
  // Optional at-checkout donation add-on (#378). Adds to the charged total
  // on top of the required fees; never reduces it, and never affects the
  // platform application_fee (computed on the registration subtotal only).
  donationCents?: number;
};

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // @ts-expect-error Deno env
    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
      apiVersion: "2024-06-20",
      httpClient: Stripe.createFetchHttpClient(),
    });

    // Service-role client (bypasses RLS for the payments write); auth
    // is verified explicitly from the caller's JWT below.
    const admin = createClient(
      // @ts-expect-error Deno env
      Deno.env.get("SUPABASE_URL")!,
      // @ts-expect-error Deno env
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── 1. Authenticate the caller and resolve their player id ──────
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return json({ error: "unauthorized" }, 401);
    }
    const authUserId = userData.user.id;

    const { orgSlug, tournamentSlug, couponCode, baseUrl, donationCents: rawDonationCents } =
      (await req.json()) as Body;

    // ── Validate the optional donation add-on (#378) ─────────────────
    // Absent/0 must be byte-identical to today, so only a present, nonzero
    // value is validated/charged at all.
    let donationCents = 0;
    if (rawDonationCents !== undefined && rawDonationCents !== null && rawDonationCents !== 0) {
      if (!Number.isInteger(rawDonationCents)) {
        return json({ error: "invalid_donation_amount" }, 400);
      }
      if (rawDonationCents < MIN_DONATION_CENTS || rawDonationCents > MAX_DONATION_CENTS) {
        return json({ error: "donation_amount_out_of_bounds" }, 400);
      }
      donationCents = rawDonationCents;
    }

    // Resolve org → tournament. (Pricing is tier-based; tournaments has
    // no entry_fee_cents — the total comes from compute_checkout_total.)
    const { data: tournament, error: tErr } = await admin
      .from("tournaments")
      .select("id, organization_id, status, accepts_donations, platform_fee_bps, platform_fee_fixed_cents, organizations!inner(slug, stripe_account_id, stripe_account_status)")
      .eq("slug", tournamentSlug)
      .single();
    if (tErr || !tournament) return json({ error: "tournament_not_found" }, 404);

    // Guard: published tournaments accept payment, and so do CLOSED ones —
    // "closed" means no new sign-ups, but a player who already holds a
    // pending registration (accepted a partner invite, was promoted off the
    // waitlist, or was added by the organizer) must still be able to pay
    // for it. Draft / completed / cancelled never take money.
    if (tournament.status !== "published" && tournament.status !== "closed") {
      return json({ error: "tournament_not_accepting_payment" }, 409);
    }

    // The organizer's accepts_donations opt-in is the trust boundary, not
    // the checkout UI (#946 only hides the field client-side). Mirrors
    // create-donation-intent's same check — a tournament with donations
    // turned off must reject a donation here even if a client posts one.
    if (donationCents > 0 && !tournament.accepts_donations) {
      return json({ error: "donations_not_enabled" }, 409);
    }

    // @ts-expect-error to-one join shape
    const org = tournament.organizations;
    // NB: the org-Stripe-active check moved DOWN to the paid path only — a
    // FREE ($0) registration needs no Stripe account, so an organizer who
    // hasn't connected Stripe can still accept free registrations.

    // Map auth user → player id.
    const { data: player } = await admin
      .from("players")
      .select("id, first_name, last_name, email")
      .eq("auth_user_id", authUserId)
      .single();
    if (!player) return json({ error: "player_not_found" }, 404);

    // ── 2. Authoritative total (server-side) ────────────────────────
    // TODO(Ron): compute_checkout_total RPC must exist (Card A).
    // Returns { total_cents, line_items: [{ event_registration_id,
    // description, amount_cents }] } for this player's pending_payment
    // regs in this tournament (entry fee + per-event tiers).
    const { data: totalRes, error: totalErr } = await admin.rpc(
      "compute_checkout_total",
      { p_player_id: player.id, p_tournament_id: tournament.id },
    );
    if (totalErr || !totalRes) return json({ error: "total_compute_failed" }, 500);

    let totalCents: number = totalRes.total_cents;
    const lineItems: Array<{ event_registration_id: string | null; description: string; amount_cents: number }> =
      totalRes.line_items ?? [];
    // NB: a $0 total is NOT an error here — a tournament with no fees (or a
    // coupon that brings the basket to $0) is a valid FREE registration,
    // handled after the coupon step below. We only reject when there's
    // genuinely nothing in the cart (no regs), checked there.

    // Guard: verify the regs we're about to charge are still unpaid
    // (pending_payment, or waitlisted_pending_payment — a promoted waitlister
    // paying to claim their reserved spot), not soft-deleted, and belong to
    // this tournament's events. Prevents
    // charging for a reg that was cancelled/withdrawn between page-load and
    // payment-form submit.
    const regIdsToCharge = lineItems
      .map((li) => li.event_registration_id)
      .filter((id): id is string => !!id);
    if (regIdsToCharge.length > 0) {
      const { data: validRegs, error: verifyErr } = await admin
        .from("event_registrations")
        .select("id, events!inner(tournament_id)")
        .in("id", regIdsToCharge)
        .in("status", PAYABLE_STATUSES)
        .is("deleted_at", null)
        .eq("events.tournament_id", tournament.id);
      if (verifyErr) return json({ error: "reg_verify_failed" }, 500);
      if (!validRegs || validRegs.length !== regIdsToCharge.length) {
        return json({ error: "regs_not_payable" }, 409);
      }
    }

    // ── 3. Optional coupon ──────────────────────────────────────────
    let couponId: string | null = null;
    if (couponCode) {
      const { data: cv } = await admin.rpc("validate_coupon", {
        p_tournament_id: tournament.id,
        p_code: couponCode,
        p_subtotal_cents: totalCents,
      });
      if (cv?.valid) {
        totalCents = Math.max(0, totalCents - (cv.discount_cents ?? 0));
        couponId = cv.coupon_id ?? null;
        lineItems.push({
          event_registration_id: null,
          description: `Coupon ${couponCode}`,
          amount_cents: -(cv.discount_cents ?? 0),
        });
      }
      // Invalid coupon: ignore silently here; the UI validates + shows
      // the error before the user reaches Pay.
    }

    // ── 3b. Account credit (issue #1102, D-0077 §2) ─────────────────
    // Applied to the remainder AFTER the coupon, floored at zero — never
    // more than the coupon left owing, and never more than the player
    // actually has. The balance is read authoritatively server-side
    // (account_credit_balance); the client names neither the org nor the
    // amount, so it can't forge or inflate this. Not redeemed yet — that's
    // the atomic step, done at payment success (stripe-webhook) or
    // immediately below for a free checkout — this only lowers what Stripe
    // (or the free-confirm path) charges.
    let creditAppliedCents = 0;
    if (totalCents > 0) {
      const { data: creditBalance } = await admin.rpc("account_credit_balance", {
        p_organization_id: tournament.organization_id,
        p_player_id: player.id,
      });
      creditAppliedCents = Math.min(totalCents, Number(creditBalance ?? 0));
      if (creditAppliedCents > 0) {
        totalCents -= creditAppliedCents;
        lineItems.push({
          event_registration_id: null,
          description: "Account credit",
          amount_cents: -creditAppliedCents,
        });
      }
    }

    // ── Amount actually charged (#378) ───────────────────────────────
    // The donation rides on top of the registration subtotal. Keep
    // totalCents (the fee base) and chargeCents (what Stripe collects)
    // separate from here on — the platform fee below is computed from
    // totalCents ONLY, so a donation never changes it.
    const chargeCents = computeChargeCents(totalCents, donationCents);

    // ── Free registration (no payment) ──────────────────────────────
    // $0 to pay — either the tournament has no fees or a coupon zeroed the
    // basket, AND there's no donation riding along (a donation alone still
    // requires a real Stripe charge, handled by the paid path below). There's
    // no Stripe charge and therefore no webhook to flip the regs, so we
    // confirm right here: mark the player's pending regs paid, redeem any
    // coupon, and fire the deferred partner invites — mirroring
    // stripe-webhook's handleSucceeded for the paid path. The total is
    // computed server-side (compute_checkout_total) above, so a client can't
    // forge a free checkout for a paid event.
    if (chargeCents <= 0) {
      if (regIdsToCharge.length === 0) {
        return json({ error: "nothing_to_charge" }, 400);
      }
      const { error: flipErr } = await admin
        .from("event_registrations")
        .update({ status: "paid" })
        .in("id", regIdsToCharge)
        .in("status", PAYABLE_STATUSES);
      if (flipErr) return json({ error: "free_confirm_failed" }, 500);
      if (couponId) await admin.rpc("redeem_coupon", { p_coupon_id: couponId });
      // Redeem the credit now — a free confirm has no webhook to do it
      // later. Idempotency here comes from the PAYABLE_STATUSES guard
      // above: a retried call finds nothing left in regIdsToCharge and
      // returns "nothing_to_charge" before ever reaching this line, same
      // as the coupon redemption right above it.
      if (creditAppliedCents > 0) {
        await admin.rpc("redeem_account_credit", {
          p_organization_id: tournament.organization_id,
          p_player_id: player.id,
          p_amount_cents: creditAppliedCents,
          p_registration_id: regIdsToCharge[0] ?? null,
          p_payment_intent_id: null,
        });
      }
      await sendFreeInvites(admin, player.id, regIdsToCharge, baseUrl);
      return json({ confirmed: true, free: true }, 200);
    }

    // ── Paid path requires the organizer's Stripe Connect to be active ──
    // (Checked here, not earlier, so the free path above is reachable for
    // organizers who haven't connected Stripe.)
    if (!org?.stripe_account_id || org.stripe_account_status !== "active") {
      return json({ error: "org_stripe_not_active" }, 409);
    }

    if (donationCents > 0) {
      lineItems.push({
        event_registration_id: null,
        description: "Donation",
        amount_cents: donationCents,
      });
    }

    // ── 4. Platform fee (Connect direct charge) ─────────────────────
    // Per-tournament override wins when set (both columns non-null);
    // otherwise fall back to the platform_settings global default. Both
    // are edited no-code by platform admins (per-tournament in the wizard,
    // global on /admin/platform), NOT env vars.
    let feeBps: number;
    let feeFixed: number;
    if (
      tournament.platform_fee_bps !== null &&
      tournament.platform_fee_fixed_cents !== null
    ) {
      feeBps = tournament.platform_fee_bps;
      feeFixed = tournament.platform_fee_fixed_cents;
    } else {
      const { data: settings } = await admin
        .from("platform_settings")
        .select("platform_fee_bps, platform_fee_fixed_cents")
        .eq("id", true)
        .single();
      feeBps = settings?.platform_fee_bps ?? 0;
      feeFixed = settings?.platform_fee_fixed_cents ?? 0;
    }
    // Computed on totalCents (registration subtotal) ONLY — never on
    // chargeCents, so an at-checkout donation (#378) is always fee-free.
    const platformFeeCents = computePlatformFeeCents(totalCents, feeBps, feeFixed);

    // ── 5. Create or reuse the PaymentIntent ────────────────────────
    // A player can return to checkout with the same pending regs after a
    // prior attempt: a declined card, an abandoned tab, or — in local dev
    // with no webhook — a payment that already SUCCEEDED before the regs
    // flipped to 'paid'. We reuse the existing intent only while Stripe can
    // still collect on it. A terminal intent (succeeded/canceled) or one
    // mid-processing must never be handed back to the browser's Elements,
    // which throws "This PaymentIntent is in a terminal state and cannot be
    // used to initialize Elements".
    //
    // This replaces an earlier *stable* idempotency key: Stripe replays the
    // original response for that key for 24h, so once the first intent went
    // terminal every retry got the same dead intent. Double-click creation
    // is instead guarded client-side (the Pay button disables on submit).
    const metadata = {
      player_id: player.id,
      tournament_id: tournament.id,
      coupon_id: couponId ?? "",
      // How much account credit (issue #1102) this intent's amount already
      // reflects — the webhook reads this to redeem the SAME amount
      // atomically at payment success. Not a trust boundary: the amount was
      // computed server-side above, never from the client.
      credit_cents: String(creditAppliedCents),
      // At-checkout donation amount riding this same intent (#378).
      // Informational only — the webhook identifies the linked `donations`
      // row by stripe_payment_intent_id, not by this field.
      donation_cents: String(donationCents),
      // Sanitised origin for the webhook's partner-invite links (#191).
      base_url: (baseUrl ?? "").replace(/\/+$/, "").slice(0, 200),
    };
    const REUSABLE_INTENT_STATUSES = new Set([
      "requires_payment_method",
      "requires_confirmation",
      "requires_action",
    ]);

    let intent: { id: string; client_secret: string | null } | null = null;

    // Newest still-pending payment row for this player+tournament points at
    // the intent from their last attempt (if any). In prod the webhook flips
    // it off 'pending' on success, so this only finds genuinely-resumable
    // attempts; in dev it may surface a succeeded intent we then discard.
    const { data: priorPayment } = await admin
      .from("payments")
      .select("stripe_payment_intent_id")
      .eq("player_id", player.id)
      .eq("organization_id", tournament.organization_id)
      .eq("status", "pending")
      .not("stripe_payment_intent_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Direct charges live on the connected account, so every Stripe call for
    // this intent (retrieve / update / create) must be scoped to it with the
    // `{ stripeAccount }` request options. A legacy destination-charge intent
    // (created on the platform account before this cutover) will 404 under the
    // connected-account scope → caught below → a fresh direct intent is made.
    const stripeAcct = { stripeAccount: org.stripe_account_id };

    if (priorPayment?.stripe_payment_intent_id) {
      try {
        const existing = await stripe.paymentIntents.retrieve(
          priorPayment.stripe_payment_intent_id,
          stripeAcct,
        );
        if (REUSABLE_INTENT_STATUSES.has(existing.status)) {
          // Resync amount/fee in case the basket or coupon changed since the
          // intent was first created, then reuse its client_secret.
          intent =
            existing.amount !== chargeCents ||
            existing.application_fee_amount !== platformFeeCents
              ? await stripe.paymentIntents.update(
                  existing.id,
                  {
                    amount: chargeCents,
                    application_fee_amount: platformFeeCents,
                    metadata,
                  },
                  stripeAcct,
                )
              : existing;
        }
      } catch (_err) {
        // Intent missing or unreadable — fall through and create a fresh one.
      }
    }

    if (!intent) {
      intent = await stripe.paymentIntents.create(
        {
          amount: chargeCents,
          currency: "usd",
          automatic_payment_methods: { enabled: true },
          application_fee_amount: platformFeeCents,
          metadata,
        },
        stripeAcct,
      );
    }

    // ── 6. Record the pending payment + line items ──────────────────
    // Upsert on the unique stripe_payment_intent_id so a retried call
    // doesn't duplicate the row.
    const { data: payment, error: payErr } = await admin
      .from("payments")
      .upsert(
        {
          organization_id: tournament.organization_id,
          player_id: player.id,
          stripe_payment_intent_id: intent.id,
          stripe_connected_account_id: org.stripe_account_id,
          amount_cents: chargeCents,
          platform_fee_cents: platformFeeCents,
          status: "pending",
        },
        { onConflict: "stripe_payment_intent_id" },
      )
      .select("id")
      .single();
    if (payErr || !payment) return json({ error: "payment_record_failed" }, 500);

    // Replace line items for this payment (idempotent on retry).
    await admin.from("payment_line_items").delete().eq("payment_id", payment.id);
    if (lineItems.length > 0) {
      await admin.from("payment_line_items").insert(
        lineItems.map((li) => ({
          payment_id: payment.id,
          event_registration_id: li.event_registration_id,
          description: li.description,
          amount_cents: li.amount_cents,
        })),
      );
    }

    // ── At-checkout donation (#378) ───────────────────────────────────
    // Mirrors the line-items wipe-and-reinsert above: drop whatever a prior
    // attempt at this payment wrote, then reinsert only if a donation is
    // still present — so lowering it to $0 on a retry removes the stale row
    // instead of leaving it dangling. The webhook flips this to 'succeeded'
    // (or 'failed') by stripe_payment_intent_id, same as a standalone
    // donation (#377) — riding the registration's own intent here instead
    // of a dedicated one.
    await admin.from("donations").delete().eq("payment_id", payment.id);
    if (donationCents > 0) {
      const { error: donationErr } = await admin.from("donations").upsert(
        {
          organization_id: tournament.organization_id,
          tournament_id: tournament.id,
          payment_id: payment.id,
          stripe_payment_intent_id: intent.id,
          stripe_connected_account_id: org.stripe_account_id,
          donor_name: `${player.first_name} ${player.last_name}`.trim(),
          donor_email: player.email ?? "",
          amount_cents: donationCents,
          status: "pending",
        },
        { onConflict: "stripe_payment_intent_id" },
      );
      if (donationErr) return json({ error: "donation_record_failed" }, 500);
    }

    // connectedAccountId lets the browser init Stripe.js scoped to the org's
    // connected account — required to confirm a direct-charge client_secret.
    return json(
      {
        clientSecret: intent.client_secret,
        paymentId: payment.id,
        connectedAccountId: org.stripe_account_id,
      },
      200,
    );
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Fire the player's pending OUTBOUND partner invites for the events they just
// registered for free. Mirrors stripe-webhook's sendDeferredInvites (which
// handles the paid path) — kept in sync by hand until extracted to a shared
// module. Best-effort: a failed email must not fail the confirmation.
// deno-lint-ignore no-explicit-any
async function sendFreeInvites(
  admin: any,
  inviterPlayerId: string,
  regIds: string[],
  baseUrl?: string,
) {
  if (regIds.length === 0) return;
  const { data: regs } = await admin
    .from("event_registrations")
    .select("event_id")
    .in("id", regIds);
  const eventIds = Array.from(
    new Set((regs ?? []).map((r: { event_id: string }) => r.event_id).filter(Boolean)),
  );
  if (eventIds.length === 0) return;

  const { data: invites } = await admin
    .from("partner_invites")
    .select("id, invitee_email")
    .eq("inviter_player_id", inviterPlayerId)
    .eq("status", "pending")
    .in("event_id", eventIds);

  const base =
    (baseUrl ?? "").replace(/\/+$/, "") || "https://tournament-manager.pages.dev";

  for (const inv of (invites ?? []) as { id: string; invitee_email: string | null }[]) {
    if (isObviouslyFakeEmail(inv.invitee_email)) continue;
    try {
      await admin.functions.invoke("send-partner-invite", {
        body: { inviteId: inv.id, baseUrl: base },
      });
    } catch (_e) {
      // best-effort — confirmation already succeeded
    }
  }
}

function isObviouslyFakeEmail(email: string | null): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return (
    e.endsWith(".test") ||
    e.endsWith("@example.com") ||
    e.endsWith("@example.net") ||
    e.endsWith("@example.org")
  );
}
