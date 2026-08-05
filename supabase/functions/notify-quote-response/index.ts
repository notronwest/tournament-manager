// supabase/functions/notify-quote-response/index.ts
//
// Emails the WMPC rep when a customer submits a response to their quote.
// Called fire-and-forget by the on_quote_customer_revision DB trigger (pg_net)
// with { quoteId, revisionId }. Loads the quote + customer + submitted revision
// and sends a summary + a link to open the quote in the admin editor.
//
// verify_jwt = false (see config.toml) — pg_net doesn't send a JWT. It only ever
// emails a fixed internal address and does nothing without a real quote id, so
// the exposure is limited. Always returns 200 so pg_net won't retry/surface errors.
//
// Required secrets (auto-injected): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Required secrets (already set): RESEND_API_KEY, RESEND_FROM_ADDRESS.
// Optional: SITE_URL (frontend base for the editor link; defaults to prod).

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { renderEmailHtml, escapeHtml } from "../_shared/email-layout.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const NOTIFY_TO = "ron@whitemountainpickleball.com";

// deno-lint-ignore no-explicit-any
type Db = any;

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Always 200 so pg_net never treats this as a failure to retry.
  const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    // @ts-expect-error Deno env
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    // @ts-expect-error Deno env
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    // @ts-expect-error Deno env
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    // @ts-expect-error Deno env
    const fromAddress = Deno.env.get("RESEND_FROM_ADDRESS");
    // @ts-expect-error Deno env
    const siteUrl = (Deno.env.get("SITE_URL") ?? "https://bertanderne.com").replace(/\/$/, "");
    if (!resendApiKey || !fromAddress) return ok();

    const { quoteId, revisionId } = (await req.json()) as { quoteId?: string; revisionId?: string };
    if (!quoteId) return ok();

    const admin: Db = createClient(SUPABASE_URL, SERVICE_KEY);

    // Quote + customer.
    const { data: quote } = await admin
      .from("quotes")
      .select("id, event_name, event_dates, status, customer_id")
      .eq("id", quoteId)
      .maybeSingle();
    if (!quote) return ok();

    let customer: { name?: string; email?: string; org_name?: string } | null = null;
    if (quote.customer_id) {
      const { data: c } = await admin
        .from("quote_customers")
        .select("name, email, org_name")
        .eq("id", quote.customer_id)
        .maybeSingle();
      customer = c ?? null;
    }

    // The submitted revision (fall back to the current one).
    let rev: { revision_number?: number; subtotal_cents?: number; notes?: string | null } | null = null;
    if (revisionId) {
      const { data: r } = await admin
        .from("quote_revisions")
        .select("revision_number, subtotal_cents, notes")
        .eq("id", revisionId)
        .maybeSingle();
      rev = r ?? null;
    }
    if (!rev) {
      const { data: r } = await admin
        .from("quote_revisions")
        .select("revision_number, subtotal_cents, notes")
        .eq("quote_id", quoteId)
        .eq("is_current", true)
        .maybeSingle();
      rev = r ?? null;
    }

    const who = customer?.name || customer?.org_name || "A customer";
    const event = quote.event_name || "their event";
    const usd = (cents?: number) => `$${(((cents ?? 0)) / 100).toFixed(2)}`;
    const editorUrl = `${siteUrl}/admin/quotes/${quoteId}`;

    const rows: string[] = [
      `<tr><td style="color:#6b7280;padding-right:12px;white-space:nowrap;">Customer</td><td><strong>${escapeHtml(who)}</strong>${customer?.email ? ` &lt;<a href="mailto:${escapeHtml(customer.email)}" style="color:#1e6cd6;">${escapeHtml(customer.email)}</a>&gt;` : ""}</td></tr>`,
      customer?.org_name ? `<tr><td style="color:#6b7280;padding-right:12px;">Organization</td><td>${escapeHtml(customer.org_name)}</td></tr>` : "",
      `<tr><td style="color:#6b7280;padding-right:12px;">Event</td><td>${escapeHtml(event)}${quote.event_dates ? ` &middot; ${escapeHtml(quote.event_dates)}` : ""}</td></tr>`,
      `<tr><td style="color:#6b7280;padding-right:12px;">Submitted total</td><td><strong>${usd(rev?.subtotal_cents)}</strong>${rev?.revision_number ? ` &middot; revision #${rev.revision_number}` : ""}</td></tr>`,
    ].filter(Boolean);

    const html = renderEmailHtml({
      headingLabel: "Quote response",
      heading: `${who} responded to their quote`,
      bodyHtml:
        `<p style="margin:0 0 16px;font-size:14px;color:#4a5159;line-height:1.6;">A customer just submitted their selections on the quote page.</p>
        <table style="font-size:14px;line-height:1.7;margin-bottom:8px;">${rows.join("")}</table>` +
        (rev?.notes ? `<div style="font-size:14px;line-height:1.6;color:#14181f;white-space:pre-wrap;border-left:3px solid #e3dec8;padding-left:14px;margin-top:12px;">${escapeHtml(rev.notes)}</div>` : ""),
      ctaLabel: "Open the quote",
      ctaUrl: editorUrl,
      footer: `Sent by bert &amp; erne when a customer responds to a quote.`,
    });

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromAddress,
        to: [NOTIFY_TO],
        subject: `Quote response: ${who}${quote.event_name ? ` — ${quote.event_name}` : ""}`,
        html,
      }),
    });

    return ok();
  } catch (_e) {
    // Never surface an error to pg_net.
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
