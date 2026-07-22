// stripe-refund — player self-withdraw + organizer manual-refund resolution.
//
// Modes (the UI carries NO money logic — all amounts come from the server):
//
//   mode: "self"  (default) — the PLAYER withdraws themselves.
//     { eventRegistrationId, dryRun }
//     Authorized as the registration OWNER. refund_compute() decides the
//     policy refund. When the policy can't auto-decide (manual_required), the
//     execute call FILES a withdrawal request (withdrawal_requested_at +
//     withdrawal_reason) for the organizer queue (#200) instead of refunding.
//
//   mode: "resolve" — an ORGANIZER resolves a queued withdrawal request (#200).
//     { eventRegistrationId, decision: "approve"|"deny", amountCents?, dryRun }
//     Authorized as an ADMIN of the registration's tournament org
//     (has_org_role(org,'admin')). Approve issues a refund of the organizer-
//     chosen amountCents (0..paid) → 'refunded' (or 'withdrawn' if $0); deny →
//     'withdrawn', no refund. Either stamps withdrawal_decided_at +
//     withdrawal_decision.
//
// Refund mechanics (Connect DIRECT charges): the charge lives on the
// organizer's connected account, so the refund is created scoped to that
// account ({ stripeAccount: connected_acct }) — refund_compute returns it.
// There is NO transfer to reverse (direct charges don't create one), so the
// destination-charge-only `reverse_transfer` is gone; the refund debits the
// organizer's balance directly. refund_application_fee:false keeps the
// platform's fee. Idempotent via an idempotencyKey keyed on the registration
// id, so a double-submit can never double-refund.
//
// Env (all already set): STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY (auto-injected).

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "npm:@supabase/supabase-js@2";
// @ts-expect-error remote import resolved at runtime by Deno
import Stripe from "npm:stripe@14.21.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

type Body = {
  eventRegistrationId?: string;
  dryRun?: boolean;
  mode?: "self" | "resolve";
  decision?: "approve" | "deny"; // resolve only
  amountCents?: number; // resolve + approve only
  reason?: string; // self + manual_required (player's stated reason)
};

type RefundComputeRow = {
  decision: "full" | "partial" | "none" | "unpaid" | "manual_required";
  paid_cents: number;
  refund_cents: number;
  reg_status: string;
  preset: string | null;
  payment_id: string | null;
  payment_intent: string | null;
  charge_id: string | null;
  connected_acct: string | null;
  partner_reg_id: string | null;
};

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const stripe = new Stripe(
      // @ts-expect-error Deno env
      Deno.env.get("STRIPE_SECRET_KEY")!,
      { apiVersion: "2024-06-20", httpClient: Stripe.createFetchHttpClient() },
    );

    // @ts-expect-error Deno env
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    // Service-role client (bypasses RLS); caller auth is verified explicitly.
    const admin = createClient(
      supabaseUrl,
      // @ts-expect-error Deno env
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Authenticate the caller ─────────────────────────────────────────
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);

    const {
      eventRegistrationId,
      dryRun = true,
      mode = "self",
      decision,
      amountCents,
      reason,
    } = (await req.json()) as Body;
    if (!eventRegistrationId) return json({ error: "missing_event_registration_id" }, 400);

    // ── Load the registration (shared) ──────────────────────────────────
    const { data: reg } = await admin
      .from("event_registrations")
      .select(
        "id, player_id, event_id, status, partner_registration_id, withdrawal_requested_at, withdrawal_decided_at",
      )
      .eq("id", eventRegistrationId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!reg) return json({ error: "registration_not_found" }, 404);

    // ── Authoritative money context (server-side, read-only) ────────────
    const { data: rows, error: rpcErr } = await admin.rpc("refund_compute", {
      p_event_registration_id: eventRegistrationId,
    });
    if (rpcErr) return json({ error: "compute_failed" }, 500);
    const r = (Array.isArray(rows) ? rows[0] : rows) as RefundComputeRow | undefined;
    if (!r) return json({ error: "registration_not_found" }, 404);

    // Partner context for the preview warning / unpair.
    let partner: { name: string; willUnpair: boolean } | null = null;
    if (r.partner_reg_id) {
      const { data: pr } = await admin
        .from("event_registrations")
        .select("players!inner(first_name, last_name)")
        .eq("id", r.partner_reg_id)
        .maybeSingle();
      // @ts-expect-error to-one join shape
      const pp = pr?.players;
      if (pp) {
        partner = {
          name: [pp.first_name, pp.last_name].filter(Boolean).join(" "),
          willUnpair: true,
        };
      }
    }

    // Clear both sides of a doubles pair; the remaining partner re-seeks.
    const unpairPartner = async () => {
      if (!r.partner_reg_id) return;
      await admin
        .from("event_registrations")
        .update({ partner_registration_id: null, partner_status: "seeking" })
        .eq("id", r.partner_reg_id);
      await admin
        .from("event_registrations")
        .update({ partner_registration_id: null })
        .eq("id", eventRegistrationId);
    };

    // ════════════════════════════════════════════════════════════════════
    // RESOLVE — organizer approves/denies a queued withdrawal request (#200)
    // ════════════════════════════════════════════════════════════════════
    if (mode === "resolve") {
      // Authorize: caller must be an ADMIN of the reg's tournament org.
      const { data: ev } = await admin
        .from("events")
        .select("tournament_id")
        .eq("id", reg.event_id)
        .maybeSingle();
      const { data: trn } = ev
        ? await admin
            .from("tournaments")
            .select("organization_id")
            .eq("id", ev.tournament_id)
            .maybeSingle()
        : { data: null as { organization_id: string } | null };
      const orgId = trn?.organization_id;
      if (!orgId) return json({ error: "org_not_found" }, 404);

      // has_org_role resolves auth.uid() from the caller's JWT, so call it via
      // a caller-scoped client (not the service-role one). Returns true for
      // platform admins too.
      const caller = createClient(
        supabaseUrl,
        // @ts-expect-error Deno env
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: `Bearer ${jwt}` } } },
      );
      const { data: authorized, error: roleErr } = await caller.rpc("has_org_role", {
        org: orgId,
        min_role: "admin",
      });
      if (roleErr) return json({ error: "auth_check_failed" }, 500);
      if (!authorized) return json({ error: "forbidden_not_organizer" }, 403);

      // Must be a queued (filed, not-yet-decided) request on a paid or withdrawn reg.
      // Old flow (mode:"self", manual_required): reg stays paid when request is filed.
      // New flow (#289, file_refund_request RPC): reg is already withdrawn.
      if (!reg.withdrawal_requested_at || reg.withdrawal_decided_at) {
        return json({ error: "no_pending_request" }, 409);
      }
      if (reg.status !== "paid" && reg.status !== "withdrawn") {
        return json({ error: "not_resolvable" }, 409);
      }

      if (decision !== "approve" && decision !== "deny") {
        return json({ error: "missing_decision" }, 400);
      }

      // Refund cap = the NET actually charged for this reg, not the gross
      // per-event line-item sum. A coupon is a payment-level negative line
      // (event_registration_id = null) and the charge is clamped at $0
      // (over-couponing → $0, never negative), so `refund_compute.paid_cents`
      // (per-event gross) can overstate what the player netted. Bound at the
      // covering payment's net charge; Stripe is the hard backstop (it can't
      // refund more than was captured on the payment_intent).
      let paymentNet = r.paid_cents;
      if (r.payment_id) {
        const { data: pay } = await admin
          .from("payments")
          .select("amount_cents")
          .eq("id", r.payment_id)
          .maybeSingle();
        if (pay && typeof pay.amount_cents === "number") paymentNet = pay.amount_cents;
      }
      const maxRefundable = Math.max(0, Math.min(r.paid_cents, paymentNet));

      // Approve amount: integer, 0 ≤ amount ≤ maxRefundable. Deny → 0.
      let amount = 0;
      if (decision === "approve") {
        amount = typeof amountCents === "number" ? Math.trunc(amountCents) : NaN;
        if (!Number.isInteger(amount) || amount < 0) {
          return json({ error: "invalid_amount" }, 400);
        }
        if (amount > maxRefundable) {
          return json({ error: "amount_exceeds_paid", maxRefundableCents: maxRefundable }, 422);
        }
      }

      const resolvePreview = {
        mode: "resolve",
        decision,
        paidCents: maxRefundable, // net charged ("what they paid"), the slider max
        maxRefundableCents: maxRefundable,
        amountCents: amount,
        currency: "usd",
        partner,
      };
      if (dryRun) return json(resolvePreview);

      // Approve + money → Stripe refund first (idempotency-keyed).
      if (decision === "approve" && amount > 0) {
        if (!r.payment_intent) return json({ error: "no_payment_intent" }, 409);
        // Direct charge: the refund must be created on the connected account.
        if (!r.connected_acct) return json({ error: "no_connected_account" }, 409);
        try {
          await stripe.refunds.create(
            {
              payment_intent: r.payment_intent,
              amount,
              // No reverse_transfer — direct charges have no transfer; the
              // refund debits the organizer's balance directly.
              refund_application_fee: false, // platform keeps its fee
              metadata: {
                event_registration_id: eventRegistrationId,
                reason: "organizer_manual",
              },
            },
            {
              stripeAccount: r.connected_acct,
              idempotencyKey: `manual_refund_${eventRegistrationId}`,
            },
          );
        } catch (e: any) {
          return json({ error: "refund_failed", detail: String(e?.message ?? e) }, 502);
        }
      }

      const newStatus = decision === "approve" && amount > 0 ? "refunded" : "withdrawn";
      // Flip status + stamp the decision, guarded so a double-resolve no-ops
      // (and the Stripe call above is idempotency-keyed regardless).
      const { data: upd } = await admin
        .from("event_registrations")
        .update({
          status: newStatus,
          withdrawal_decided_at: new Date().toISOString(),
          withdrawal_decision: decision === "approve" ? "approved" : "denied",
        })
        .eq("id", eventRegistrationId)
        .in("status", ["paid", "withdrawn"])
        .is("withdrawal_decided_at", null)
        .select("id");
      if (upd && upd.length > 0) await unpairPartner();
      return json({ ...resolvePreview, applied: true, newStatus });
    }

    // ════════════════════════════════════════════════════════════════════
    // SELF — the player withdraws themselves (owner-authorized)
    // ════════════════════════════════════════════════════════════════════
    const { data: player } = await admin
      .from("players")
      .select("id")
      .eq("auth_user_id", userData.user.id)
      .single();
    if (!player) return json({ error: "player_not_found" }, 404);
    if (reg.player_id !== player.id) return json({ error: "forbidden" }, 403);

    const preview = {
      decision: r.decision,
      paidCents: r.paid_cents,
      refundCents: r.refund_cents,
      currency: "usd",
      partner,
    };

    // Dry run → preview only.
    if (dryRun) return json(preview);

    // manual_required: the policy can't auto-decide → FILE a withdrawal
    // request for the organizer queue (#200) instead of refunding.
    if (r.decision === "manual_required") {
      await admin
        .from("event_registrations")
        .update({
          withdrawal_requested_at: new Date().toISOString(),
          withdrawal_reason: typeof reason === "string" ? reason.slice(0, 2000) : null,
        })
        .eq("id", eventRegistrationId)
        .eq("status", "paid")
        .is("withdrawal_decided_at", null);
      return json({ ...preview, applied: false, requested: true, newStatus: null });
    }

    // Guard against acting on an already-resolved reg (idempotency at the
    // row level; the Stripe call is additionally idempotency-keyed below).
    if (reg.status !== "paid" && reg.status !== "pending_payment") {
      return json({ error: "not_withdrawable" }, 409);
    }

    // Unpaid → just cancel, no Stripe.
    if (r.decision === "unpaid") {
      const { data: upd } = await admin
        .from("event_registrations")
        .update({ status: "cancelled" })
        .eq("id", eventRegistrationId)
        .eq("status", "pending_payment")
        .select("id");
      if (!upd || upd.length === 0) return json({ error: "not_withdrawable" }, 409);
      await unpairPartner();
      return json({ ...preview, applied: true, newStatus: "cancelled" });
    }

    // Paid, no money back → withdraw without a Stripe call.
    if (r.refund_cents <= 0) {
      const { data: upd } = await admin
        .from("event_registrations")
        .update({ status: "withdrawn" })
        .eq("id", eventRegistrationId)
        .eq("status", "paid")
        .select("id");
      if (!upd || upd.length === 0) return json({ error: "not_withdrawable" }, 409);
      await unpairPartner();
      return json({ ...preview, applied: true, newStatus: "withdrawn" });
    }

    // Paid + money back → issue the Stripe refund, then flip to refunded.
    if (!r.payment_intent) return json({ error: "manual_required" }, 409);
    // Direct charge: the refund must be created on the connected account.
    if (!r.connected_acct) return json({ error: "no_connected_account" }, 409);
    try {
      await stripe.refunds.create(
        {
          payment_intent: r.payment_intent,
          amount: r.refund_cents,
          // No reverse_transfer — direct charges have no transfer; the refund
          // debits the organizer's balance directly.
          refund_application_fee: false, // platform keeps its fee
          metadata: {
            event_registration_id: eventRegistrationId,
            reason: "player_withdraw",
          },
        },
        {
          stripeAccount: r.connected_acct,
          idempotencyKey: `refund_${eventRegistrationId}`,
        },
      );
    } catch (e: any) {
      return json({ error: "refund_failed", detail: String(e?.message ?? e) }, 502);
    }

    const { data: upd } = await admin
      .from("event_registrations")
      .update({ status: "refunded" })
      .eq("id", eventRegistrationId)
      .eq("status", "paid")
      .select("id");
    // Even if the guard found the row already flipped, the refund was
    // idempotency-keyed so no double charge occurred.
    if (!upd || upd.length === 0) {
      return json({ ...preview, applied: true, newStatus: "refunded" });
    }
    await unpairPartner();
    return json({ ...preview, applied: true, newStatus: "refunded" });
  } catch (e: any) {
    return json({ error: "unhandled", detail: String(e?.message ?? e) }, 500);
  }
});
