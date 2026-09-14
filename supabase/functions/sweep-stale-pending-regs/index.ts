// supabase/functions/sweep-stale-pending-regs/index.ts
//
// Silent backstage cleanup for the register-then-checkout flow.
// Soft-cancels event_registrations rows that have been sitting in
// status='pending_payment' for longer than the hold window, flips
// their partner_invites rows to 'cancelled', unpairs their partner
// (→ seeking) and promotes the next waitlisted player per freed spot.
//
// Scheduled since 2026-09-11 by the pg_cron job 'sweep-stale-pending-regs'
// (every 5 min, migration 20260914200000), which runs the SQL function
// public.sweep_stale_pending_regs directly. This edge function is the
// MANUAL entry point — it calls the same RPC, so both paths are identical.
// Idempotent — safe to call as often as you want; only acts on rows that
// have aged past the threshold. (Before 2026-09-11 nothing invoked it.)
//
// The hold window is 30 minutes by default; override via the
// PENDING_HOLD_MINUTES env var if a tournament's organizer wants
// a longer / shorter buffer. Keep it long enough that a slow
// browser doesn't lose their slot mid-decision, short enough that
// abandoned baskets free up capacity in a useful timeframe.
//
// Surface to users: NONE. No email, no notification. If a user
// returns to checkout after their hold expired, the checkout page
// shows an empty state and they can re-register from the
// tournament page. Hold expiry is part of the design — see
// mockups/register-then-checkout-flow.html for the policy.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // @ts-expect-error Deno global
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  // @ts-expect-error Deno global
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // @ts-expect-error Deno global
  const holdMinutesEnv = Deno.env.get("PENDING_HOLD_MINUTES");
  if (!supabaseUrl || !serviceRole) {
    return jsonResp({ error: "Server missing Supabase config" }, 500);
  }
  const holdMinutes = Number.parseInt(holdMinutesEnv ?? "", 10);
  const minutes =
    Number.isFinite(holdMinutes) && holdMinutes > 0 ? holdMinutes : 30;

  const admin = createClient(supabaseUrl, serviceRole);

  // ONE implementation: the SQL function public.sweep_stale_pending_regs
  // (migration 20260914200000) is what the pg_cron job runs every 5 minutes.
  // Calling it here means a manual invocation does exactly what the job does:
  // soft-delete idle pending_payment regs (never admin-invoiced ones), cancel
  // their outbound partner invites, UNPAIR their partner (→ seeking) and
  // promote the next waitlisted player into each freed spot.
  const { data, error } = await admin.rpc("sweep_stale_pending_regs", {
    p_hold_minutes: minutes,
  });
  if (error) return jsonResp({ error: error.message }, 500);
  const row = Array.isArray(data) ? data[0] : data;

  return jsonResp({
    ok: true,
    cancelledRegs: row?.cancelled_regs ?? 0,
    cancelledInvites: row?.cancelled_invites ?? 0,
    unpairedPartners: row?.unpaired_partners ?? 0,
    promoted: row?.promoted ?? 0,
    promotedRegIds: row?.promoted_reg_ids ?? [],
    holdMinutes: minutes,
  });
});

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
