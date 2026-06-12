// supabase/functions/cancel-tournament/index.ts
//
// DRAFT — Card-A for #201 (#22 surface c; see docs/REFUNDS.md). Ron reviews
// the [DECIDE] items + deploys. Money + email path: do not ship without
// sign-off.
//
// Organizer "Cancel tournament": ORG-STAFF only. Flips the tournament to
// `cancelled` (the public page stays up with a banner — that's a UI concern,
// #201), bulk-refunds every PAID registration per the cancellation policy by
// calling the shared `stripe-refund` primitive in `auto` mode — NOT
// duplicating Stripe code — and emails every affected player ONE notice with
// the cancellation reason + their individual refund amount.
//
// Idempotent / resumable: only `status='paid'` regs are processed, and
// `stripe-refund` flips each to `refunded`/`withdrawn`, so re-running after a
// partial failure naturally skips the ones already done.
//
// Body:    { tournament_id: string, reason: string }
// Returns: 200 (all clean) or 207 (some refunds failed — retry by re-running)
//          { cancelled, players_refunded, registrations_refunded,
//            total_refunded_cents, emailed, failures: [...] }
//
// Required secrets:
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — auto-injected by the runtime.
//   RESEND_API_KEY / RESEND_FROM_ADDRESS     — already set (partner invites
//                                              use them) for the email blast.
//   (Stripe secrets live in `stripe-refund`, which runs as its own function.)

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Body = { tournament_id: string; reason: string };

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    // @ts-expect-error Deno env
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(
      SUPABASE_URL,
      // @ts-expect-error Deno env
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    // @ts-expect-error Deno env
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    // @ts-expect-error Deno env
    const fromAddress = Deno.env.get("RESEND_FROM_ADDRESS");

    // ── 1. Authenticate the caller ──────────────────────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
    const authUserId = userData.user.id;

    // ── 2. Input ────────────────────────────────────────────────────
    const { tournament_id, reason } = (await req.json()) as Body;
    if (!tournament_id || !reason || !reason.trim()) {
      return json({ error: "tournament_id and reason are required" }, 400);
    }

    // ── 3. Load tournament + org ────────────────────────────────────
    const { data: t, error: tErr } = await admin
      .from("tournaments")
      .select("id, name, organization_id, status")
      .eq("id", tournament_id)
      .is("deleted_at", null)
      .single();
    if (tErr || !t) return json({ error: "tournament_not_found" }, 404);

    // ── 4. Authorize: ORG STAFF only (same gate as stripe-refund) ───
    const { data: staffRow } = await admin
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", t.organization_id)
      .eq("user_id", authUserId)
      .maybeSingle();
    if (!staffRow) return json({ error: "forbidden_org_staff_only" }, 403);

    // ── 5. Flip status → cancelled (idempotent; safe to re-run) ─────
    // TODO(Ron) [DECIDE]: persist `reason`. `tournaments` has no
    // cancellation_reason column today, so the reason currently only reaches
    // players via the email below. Add a column + migration if you want it
    // shown on the public "cancelled" banner.
    const { error: updErr } = await admin
      .from("tournaments")
      .update({ status: "cancelled" })
      .eq("id", t.id);
    if (updErr) return json({ error: updErr.message }, 500);

    // ── 6. Every PAID registration (idempotent set — refunded/withdrawn
    //       regs are already excluded, so a re-run skips finished ones) ──
    const { data: regs, error: regErr } = await admin
      .from("event_registrations")
      .select(
        "id, player_id, events!inner(name, tournament_id), " +
          "player:players!player_id(email, first_name)",
      )
      .eq("events.tournament_id", t.id)
      .eq("status", "paid")
      .is("deleted_at", null);
    if (regErr) return json({ error: regErr.message }, 500);

    // ── 7. Refund each via the shared primitive (auto, per policy) ──
    // Forward the org-staff JWT so stripe-refund's own auth authorizes it;
    // no Stripe code is duplicated here.
    const refundUrl = `${SUPABASE_URL}/functions/v1/stripe-refund`;
    type Row = {
      reg: string; playerId: string; ok: boolean; refundCents: number;
      email: string | null; firstName: string | null; eventName: string;
      error?: string;
    };
    // The embedded-resource select confuses supabase-js's type-level parser
    // (same reason stripe-refund uses @ts-expect-error on its joins); cast the
    // rows to the shape we actually selected.
    type RegRow = {
      id: string;
      player_id: string;
      events: { name: string | null } | null;
      player: { email: string | null; first_name: string | null } | null;
    };
    const results: Row[] = [];
    for (const r of (regs ?? []) as unknown as RegRow[]) {
      const email: string | null = r.player?.email ?? null;
      const firstName: string | null = r.player?.first_name ?? null;
      const eventName: string = r.events?.name ?? "your event";
      try {
        const resp = await fetch(refundUrl, {
          method: "POST",
          headers: { Authorization: authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ event_registration_id: r.id, mode: "auto", reason }),
        });
        const out = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          results.push({ reg: r.id, playerId: r.player_id, ok: false, refundCents: 0, email, firstName, eventName, error: out?.error ?? `http_${resp.status}` });
        } else {
          results.push({ reg: r.id, playerId: r.player_id, ok: true, refundCents: out?.refunded_amount_cents ?? 0, email, firstName, eventName });
        }
      } catch (e) {
        results.push({ reg: r.id, playerId: r.player_id, ok: false, refundCents: 0, email, firstName, eventName, error: String((e as { message?: string })?.message ?? e) });
      }
    }

    // ── 8. Email blast — ONE email per affected player, aggregating their
    //       refunds across events. Best-effort: a send failure never fails
    //       the cancellation (the refund already happened). ──────────────
    let emailed = 0;
    if (resendApiKey && fromAddress) {
      const byPlayer = new Map<string, { email: string; firstName: string | null; totalCents: number; events: string[] }>();
      for (const r of results) {
        if (!r.ok || !r.email) continue;
        const cur = byPlayer.get(r.playerId) ?? { email: r.email, firstName: r.firstName, totalCents: 0, events: [] };
        cur.totalCents += r.refundCents;
        cur.events.push(r.eventName);
        byPlayer.set(r.playerId, cur);
      }
      for (const p of byPlayer.values()) {
        const dollars = (p.totalCents / 100).toFixed(2);
        const plural = p.events.length > 1 ? "s" : "";
        const html =
          `<p>Hi ${escapeHtml(p.firstName ?? "there")},</p>` +
          `<p><strong>${escapeHtml(t.name)}</strong> has been cancelled.</p>` +
          `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` +
          `<p>You have been refunded <strong>$${dollars}</strong> for your registration${plural} ` +
          `(${escapeHtml(p.events.join(", "))}). Refunds typically settle back to your original ` +
          `payment method within 5–10 business days.</p>` +
          `<p>We're sorry for the disruption.</p>`;
        try {
          const er = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: fromAddress, to: p.email, subject: `${t.name} has been cancelled`, html }),
          });
          if (er.ok) emailed++;
        } catch {
          /* best-effort — refund already succeeded */
        }
      }
    }

    // ── 9. Summary (207 if any refund failed → retry by re-running) ─
    const refunded = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);
    return json(
      {
        cancelled: true,
        players_refunded: new Set(refunded.map((r) => r.playerId)).size,
        registrations_refunded: refunded.length,
        total_refunded_cents: refunded.reduce((s, r) => s + r.refundCents, 0),
        emailed,
        failures: failures.map((f) => ({ event_registration_id: f.reg, error: f.error })),
      },
      failures.length ? 207 : 200,
    );
  } catch (e) {
    return json({ error: "internal_error", detail: String((e as { message?: string })?.message ?? e) }, 500);
  }
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
