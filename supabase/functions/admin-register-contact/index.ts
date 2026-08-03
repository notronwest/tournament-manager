// supabase/functions/admin-register-contact/index.ts
//
// Register a player (contact) into one or more of an org's events WITHOUT
// going through Stripe checkout. Three treatments:
//   - 'comp'    — waive the fee ($0), mark paid.
//   - 'offline' — payment already collected (cash/check/venmo/other), mark paid.
//   - 'invoice' — leave a BALANCE: create a pending_payment row the player pays
//                 online themselves. No manual_payments row; marked
//                 admin_invoiced_at so the stale-pending sweep never deletes it.
//
// For comp/offline we create a `paid` event_registrations row and record a
// matching `manual_payments` row so the non-Stripe payment is auditable. For
// invoice we create a `pending_payment` row and nothing else. Doubles events
// register the player as 'seeking' a partner (singles → 'solo'). Events not in
// the org, and players already actively registered, are skipped (never
// duplicated) rather than failing the whole request.
//
// ORG-STAFF only. All DB work uses the service-role client (bypasses RLS);
// manual_payments has no client write policy by design.
//
// Body: {
//   organizationId: string,
//   playerId: string,
//   registrations: { eventId: string, amountCents: number }[], // amountCents used only for offline
//   kind: 'comp' | 'offline',
//   method?: 'cash' | 'check' | 'venmo' | 'other',             // required when kind==='offline'
//   note?: string
// }
// Returns: { registered: number, skipped: { eventId, reason }[], errors?: string[] }
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

type Kind = "comp" | "offline" | "invoice";
type Method = "cash" | "check" | "venmo" | "other";
const VALID_METHODS: Method[] = ["cash", "check", "venmo", "other"];

type Body = {
  organizationId?: string;
  playerId?: string;
  registrations?: { eventId?: string; amountCents?: number }[];
  kind?: Kind;
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
    const { organizationId, playerId, registrations, kind, method, note } =
      (await req.json()) as Body;
    if (!organizationId) return json({ error: "organizationId is required" }, 400);
    if (!playerId) return json({ error: "playerId is required" }, 400);
    if (!Array.isArray(registrations) || registrations.length === 0) {
      return json({ error: "registrations must be a non-empty array" }, 400);
    }
    if (kind !== "comp" && kind !== "offline" && kind !== "invoice") {
      return json({ error: "kind must be 'comp', 'offline', or 'invoice'" }, 400);
    }
    if (kind === "offline") {
      if (!method || !VALID_METHODS.includes(method)) {
        return json({ error: "method is required for offline payments" }, 400);
      }
      for (const r of registrations) {
        if (
          typeof r?.amountCents !== "number" ||
          !Number.isInteger(r.amountCents) ||
          r.amountCents < 0
        ) {
          return json(
            { error: "each amountCents must be an integer >= 0 for offline payments" },
            400,
          );
        }
      }
    }
    // Only offline records a payment method; comp/invoice have none.
    const effectiveMethod: Method | null = kind === "offline" ? method! : null;

    // ── 3. Authorize ─────────────────────────────────────────────────
    if (!(await isOrgStaff(admin, organizationId, authUserId))) {
      return json({ error: "forbidden_org_staff_only" }, 403);
    }

    // ── 4. Verify the player exists ──────────────────────────────────
    const { data: player, error: playerErr } = await admin
      .from("players")
      .select("id")
      .eq("id", playerId)
      .is("deleted_at", null)
      .maybeSingle();
    if (playerErr) return json({ error: playerErr.message }, 500);
    if (!player) return json({ error: "player_not_found" }, 404);

    // ── 5. Register into each event ──────────────────────────────────
    const skipped: { eventId: string; reason: string }[] = [];
    const errors: string[] = [];
    let registered = 0;

    for (const reg of registrations) {
      const eventId = reg?.eventId;
      if (!eventId) {
        skipped.push({ eventId: String(eventId), reason: "missing_event_id" });
        continue;
      }

      // (a) Event must belong to this org's tournaments, and neither the event
      //     nor its tournament may be soft-deleted.
      const { data: event, error: eventErr } = await admin
        .from("events")
        .select("id, event_fee_cents, format, deleted_at, tournaments!inner(id, organization_id, deleted_at)")
        .eq("id", eventId)
        .maybeSingle();
      if (eventErr) {
        errors.push(`event ${eventId}: ${eventErr.message}`);
        skipped.push({ eventId, reason: "event_lookup_failed" });
        continue;
      }
      // @supabase to-one join comes back as an object.
      const tournament = event?.tournaments as
        | { id: string; organization_id: string; deleted_at: string | null }
        | null;
      if (
        !event ||
        event.deleted_at ||
        !tournament ||
        tournament.deleted_at ||
        tournament.organization_id !== organizationId
      ) {
        skipped.push({ eventId, reason: "event_not_in_org" });
        continue;
      }

      // (b) Don't duplicate an existing active registration.
      const { data: existing, error: existingErr } = await admin
        .from("event_registrations")
        .select("id")
        .eq("event_id", eventId)
        .eq("player_id", playerId)
        .is("deleted_at", null)
        .maybeSingle();
      if (existingErr) {
        errors.push(`event ${eventId}: ${existingErr.message}`);
        skipped.push({ eventId, reason: "registration_lookup_failed" });
        continue;
      }
      if (existing) {
        skipped.push({ eventId, reason: "already_registered" });
        continue;
      }

      // (c) Create the registration. Invoice = pending_payment (player pays
      //     online, fee snapshotted from the event) + admin_invoiced_at so the
      //     sweep never deletes it. Comp/offline = paid (fee $0 / collected).
      //     A race on the active-unique index surfaces here as an insert error
      //     → skip rather than fail the batch.
      const isInvoice = kind === "invoice";
      const now = new Date().toISOString();
      const { data: newReg, error: insertErr } = await admin
        .from("event_registrations")
        .insert({
          event_id: eventId,
          player_id: playerId,
          // Amount owed: $0 comp, collected amount offline, the event's fee for
          // an invoice (checkout recomputes the payable total from tiers).
          event_fee_cents:
            kind === "comp"
              ? 0
              : isInvoice
                ? (event.event_fee_cents ?? 0)
                : (reg.amountCents ?? 0),
          status: isInvoice ? "pending_payment" : "paid",
          // Doubles → the player still needs a partner, so mark them 'seeking'
          // (shows in the "Looking for a partner" / pairing workflow); singles
          // has no partner, so 'solo'.
          partner_status: event.format === "doubles" ? "seeking" : "solo",
          registered_at: now,
          admin_invoiced_at: isInvoice ? now : null,
        })
        .select("id")
        .single();
      if (insertErr || !newReg) {
        errors.push(`event ${eventId}: ${insertErr?.message ?? "insert_failed"}`);
        skipped.push({ eventId, reason: "insert_failed" });
        continue;
      }

      // (d) Comp/offline record a manual_payments row; an invoice has no
      //     payment yet (the player pays online later), so nothing to record.
      if (!isInvoice) {
        const { error: payErr } = await admin.from("manual_payments").insert({
          organization_id: organizationId,
          event_registration_id: newReg.id,
          player_id: playerId,
          kind,
          amount_cents: kind === "comp" ? 0 : (reg.amountCents ?? 0),
          method: effectiveMethod,
          note: note ?? null,
          recorded_by: authUserId,
        });
        if (payErr) {
          // The registration exists but we couldn't log the payment — surface it
          // rather than silently counting a payment we never recorded.
          errors.push(`event ${eventId}: manual_payment insert failed: ${payErr.message}`);
          skipped.push({ eventId, reason: "manual_payment_failed" });
          continue;
        }
      }

      registered += 1;
    }

    // ── 6. Summary ───────────────────────────────────────────────────
    return json({
      registered,
      skipped,
      ...(errors.length > 0 ? { errors } : {}),
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
