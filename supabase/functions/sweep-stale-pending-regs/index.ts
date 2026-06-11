// supabase/functions/sweep-stale-pending-regs/index.ts
//
// Silent backstage cleanup for the register-then-checkout flow.
// Soft-cancels event_registrations rows that have been sitting in
// status='pending_payment' for longer than the hold window, and
// flips their partner_invites rows to 'cancelled' too.
//
// Designed to be invoked on a schedule (Supabase Cron / pg_cron /
// any external cron hitting the function URL). Idempotent — safe
// to call as often as you want; only acts on rows that have aged
// past the threshold.
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

  // Cutoff: anything updated_at older than this is fair game for
  // cancellation. We use updated_at (not created_at) so a row that
  // got touched recently — e.g. someone briefly opened the
  // checkout page and edited something — gets a fresh window.
  const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();

  // Step 1: collect the regs we're about to cancel. Need them to
  // mirror-cancel any outbound partner_invites tied to the same
  // (event, player). Use a separate select instead of a single
  // UPDATE...RETURNING because we need to look up invites for
  // each (event_id, player_id) tuple.
  const { data: regs, error: selErr } = await admin
    .from("event_registrations")
    .select("id, event_id, player_id")
    .eq("status", "pending_payment")
    .is("deleted_at", null)
    .lt("updated_at", cutoff);
  if (selErr) return jsonResp({ error: selErr.message }, 500);
  const targetRegs = regs ?? [];
  if (targetRegs.length === 0) {
    return jsonResp({
      ok: true,
      cancelledRegs: 0,
      cancelledInvites: 0,
      holdMinutes: minutes,
    });
  }

  // Step 2: soft-delete the regs.
  const now = new Date().toISOString();
  const regIds = targetRegs.map((r) => r.id);
  const { error: regUpdErr } = await admin
    .from("event_registrations")
    .update({ deleted_at: now })
    .in("id", regIds);
  if (regUpdErr) return jsonResp({ error: regUpdErr.message }, 500);

  // Step 3: cancel any pending partner_invites tied to the same
  // (event_id, inviter_player_id) tuples — orphan invites are
  // confusing to the invitee otherwise.
  let cancelledInvites = 0;
  for (const r of targetRegs) {
    const { data, error: invErr } = await admin
      .from("partner_invites")
      .update({ status: "cancelled" })
      .eq("event_id", r.event_id)
      .eq("inviter_player_id", r.player_id)
      .eq("status", "pending")
      .select("id");
    if (invErr) continue;
    cancelledInvites += data?.length ?? 0;
  }

  return jsonResp({
    ok: true,
    cancelledRegs: targetRegs.length,
    cancelledInvites,
    holdMinutes: minutes,
  });
});

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
