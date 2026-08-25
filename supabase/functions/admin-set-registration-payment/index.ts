// supabase/functions/admin-set-registration-payment/index.ts
//
// Settle an EXISTING unpaid registration without Stripe — the post-hoc twin of
// admin-register-contact's comp/offline treatments. An organizer who already
// registered someone (or who took the money at the desk after the player
// self-registered) uses this to close the balance:
//   - 'comp'    — waive the fee ($0), mark paid.
//   - 'offline' — payment collected outside the app (cash/check/venmo/other)
//                 for `amountCents`, mark paid.
//
// Deliberately NOT supported:
//   - Re-pricing an already-PAID registration. Money has moved; lowering the
//     price is a refund, so paid regs are read-only here and the UI points at
//     the stripe-refund `admin_refund` flow instead.
//   - 'invoice' (leave a balance at a custom amount). The authoritative
//     checkout total (compute_checkout_total) prices from events.event_fee_cents
//     + the tournament's pricing tier and never reads
//     event_registrations.event_fee_cents, so writing a custom balance here
//     would NOT change what the player is actually charged. Honouring a
//     per-registration override needs a schema + function change.
//
// Both supported kinds end at status='paid', which is why neither touches the
// checkout path: there is nothing left to compute a total for.
//
// ORG-STAFF only. All DB work uses the service-role client (bypasses RLS);
// manual_payments has no client write policy by design.
//
// Body: {
//   regId: string,
//   kind: 'comp' | 'offline',
//   amountCents?: number,                            // required when kind==='offline'
//   method?: 'cash' | 'check' | 'venmo' | 'other',   // required when kind==='offline'
//   note?: string
// }
// Returns: { ok: true, regId, status: 'paid', kind, amountCents }
//
// Required secrets (auto-injected): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Kind = "comp" | "offline";
type Method = "cash" | "check" | "venmo" | "other";
const VALID_METHODS: Method[] = ["cash", "check", "venmo", "other"];

// Statuses we are willing to settle. Anything else (paid, refunded, cancelled,
// withdrawn) is either already settled or intentionally out of this flow.
const SETTLEABLE = ["pending_payment", "waitlisted_pending_payment"];

type Body = {
  regId?: string;
  kind?: Kind;
  amountCents?: number;
  method?: Method;
  note?: string;
};

// The remote-imported supabase client is untyped in the Deno runtime.
// deno-lint-ignore no-explicit-any
type Db = any;

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    // @ts-expect-error Deno env
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    // @ts-expect-error Deno env
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // ── 1. Authenticate ──────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
    const authUserId = userData.user.id;

    // ── 2. Input ─────────────────────────────────────────────────────
    const { regId, kind, amountCents, method, note } = (await req.json()) as Body;
    if (!regId) return json({ error: "regId is required" }, 400);
    if (kind !== "comp" && kind !== "offline") {
      return json({ error: "kind must be 'comp' or 'offline'" }, 400);
    }
    if (kind === "offline") {
      if (!method || !VALID_METHODS.includes(method)) {
        return json({ error: "method is required for offline payments" }, 400);
      }
      if (
        typeof amountCents !== "number" ||
        !Number.isInteger(amountCents) ||
        amountCents < 0
      ) {
        return json(
          { error: "amountCents must be an integer >= 0 for offline payments" },
          400,
        );
      }
    }
    // Comp is always $0 with no method; offline carries the collected amount.
    const effectiveAmount = kind === "comp" ? 0 : amountCents!;
    const effectiveMethod: Method | null = kind === "offline" ? method! : null;

    // ── 3. Load the registration + its owning org ────────────────────
    const { data: reg, error: regErr } = await admin
      .from("event_registrations")
      .select(
        "id, player_id, status, event_fee_cents, deleted_at, " +
          "events!inner(id, deleted_at, tournaments!inner(id, organization_id, deleted_at))",
      )
      .eq("id", regId)
      .maybeSingle();
    if (regErr) return json({ error: regErr.message }, 500);
    if (!reg || reg.deleted_at) return json({ error: "registration_not_found" }, 404);

    // @supabase to-one joins come back as objects.
    const event = reg.events as
      | { id: string; deleted_at: string | null; tournaments: { id: string; organization_id: string; deleted_at: string | null } }
      | null;
    const tournament = event?.tournaments ?? null;
    if (!event || event.deleted_at || !tournament || tournament.deleted_at) {
      return json({ error: "registration_not_found" }, 404);
    }
    const organizationId = tournament.organization_id;

    // ── 4. Authorize against the reg's OWN org (never a client-supplied one) ──
    if (!(await isOrgStaff(admin, organizationId, authUserId))) {
      return json({ error: "forbidden_org_staff_only" }, 403);
    }

    // ── 5. Guard: only an open balance can be settled here ───────────
    if (reg.status === "paid") {
      return json({ error: "already_paid_use_refund" }, 409);
    }
    if (!SETTLEABLE.includes(reg.status)) {
      return json({ error: `cannot_settle_status_${reg.status}` }, 409);
    }

    // ── 6. Settle: stamp the fee actually charged + mark paid ────────
    // admin_invoiced_at is cleared — this is no longer an outstanding invoice,
    // so the stale-pending sweep exemption no longer applies (and the row is
    // 'paid' anyway, which the sweep never touches).
    const { error: updErr } = await admin
      .from("event_registrations")
      .update({
        event_fee_cents: effectiveAmount,
        status: "paid",
        admin_invoiced_at: null,
      })
      .eq("id", regId)
      // Optimistic guard: if another admin settled this row between our read
      // and this write, affect nothing rather than double-recording a payment.
      .eq("status", reg.status)
      .select("id")
      .maybeSingle();
    if (updErr) return json({ error: updErr.message }, 500);

    // ── 7. Record the non-Stripe payment so it is auditable ──────────
    const { error: payErr } = await admin.from("manual_payments").insert({
      organization_id: organizationId,
      event_registration_id: regId,
      player_id: reg.player_id,
      kind,
      amount_cents: effectiveAmount,
      method: effectiveMethod,
      note: note ?? null,
      recorded_by: authUserId,
    });
    if (payErr) {
      // The reg is settled but we could not log the payment — surface it rather
      // than reporting a payment we never recorded.
      return json(
        { error: "manual_payment_insert_failed", detail: payErr.message },
        500,
      );
    }

    return json({
      ok: true,
      regId,
      status: "paid",
      kind,
      amountCents: effectiveAmount,
    });
  } catch (e) {
    return json(
      { error: "internal_error", detail: String((e as { message?: string })?.message ?? e) },
      500,
    );
  }
});

async function isOrgStaff(admin: Db, organizationId: string, authUserId: string): Promise<boolean> {
  const { data: staffRow } = await admin
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("user_id", authUserId)
    .maybeSingle();
  if (staffRow) return true;
  const { data: padmin } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", authUserId)
    .maybeSingle();
  return !!padmin;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
