// stripe-refund — player self-withdraw with a policy-aware refund.
//
// The UI carries NO money logic. It calls this twice:
//   1. { eventRegistrationId, dryRun: true }  → preview (no side effects)
//   2. { eventRegistrationId, dryRun: false } → execute
//
// All math lives in the public.refund_compute() SQL function (see
// docs/REFUNDS.md + migration 20260611120000_refund_compute.sql). This
// function authenticates the caller, asks refund_compute for the decision +
// amount, and on execute issues the Stripe refund, flips the registration
// status, and unpairs the partner.
//
// Refund mechanics (Connect destination charges): refund by payment_intent
// with reverse_transfer:true (debit the organizer) and
// refund_application_fee:false (platform keeps its fee). Idempotent via an
// idempotencyKey keyed on the registration id, so a double-submit can never
// double-refund.
//
// Env (all already set): STRIPE_SECRET_KEY, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY (auto-injected).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// @ts-expect-error esm.sh Deno target
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

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

    // Service-role client (bypasses RLS); caller auth is verified explicitly.
    const admin = createClient(
      // @ts-expect-error Deno env
      Deno.env.get("SUPABASE_URL")!,
      // @ts-expect-error Deno env
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── 1. Authenticate the caller → player id ──────────────────────────
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);

    const { data: player } = await admin
      .from("players")
      .select("id")
      .eq("auth_user_id", userData.user.id)
      .single();
    if (!player) return json({ error: "player_not_found" }, 404);

    const { eventRegistrationId, dryRun = true } = (await req.json()) as Body;
    if (!eventRegistrationId) return json({ error: "missing_event_registration_id" }, 400);

    // ── 2. Ownership: the reg must belong to the caller ─────────────────
    const { data: reg } = await admin
      .from("event_registrations")
      .select("id, player_id, status, partner_registration_id")
      .eq("id", eventRegistrationId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!reg) return json({ error: "registration_not_found" }, 404);
    if (reg.player_id !== player.id) return json({ error: "forbidden" }, 403);

    // ── 3. Authoritative decision + amount (server-side) ────────────────
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

    const preview = {
      decision: r.decision,
      paidCents: r.paid_cents,
      refundCents: r.refund_cents,
      currency: "usd",
      partner,
    };

    // ── 4. Dry run → preview only ───────────────────────────────────────
    if (dryRun) return json(preview);

    // ── 5. Execute ──────────────────────────────────────────────────────
    // manual_required: don't touch anything; the UI hands off to the
    // organizer review queue (#200).
    if (r.decision === "manual_required") {
      return json({ ...preview, applied: false, newStatus: null });
    }

    // Guard against acting on an already-resolved reg (idempotency at the
    // row level; the Stripe call is additionally idempotency-keyed below).
    if (reg.status !== "paid" && reg.status !== "pending_payment") {
      return json({ error: "not_withdrawable" }, 409);
    }

    const unpairPartner = async () => {
      if (!r.partner_reg_id) return;
      // Clear both sides; the remaining partner goes back to seeking.
      await admin
        .from("event_registrations")
        .update({ partner_registration_id: null, partner_status: "seeking" })
        .eq("id", r.partner_reg_id);
      await admin
        .from("event_registrations")
        .update({ partner_registration_id: null })
        .eq("id", eventRegistrationId);
    };

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
    try {
      await stripe.refunds.create(
        {
          payment_intent: r.payment_intent,
          amount: r.refund_cents,
          reverse_transfer: true,        // destination charge: debit the organizer
          refund_application_fee: false, // platform keeps its fee
          metadata: {
            event_registration_id: eventRegistrationId,
            reason: "player_withdraw",
          },
        },
        { idempotencyKey: `refund_${eventRegistrationId}` },
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
