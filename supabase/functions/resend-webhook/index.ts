// supabase/functions/resend-webhook/index.ts
//
// Ingest Resend delivery events for contact-list emails and advance each
// recipient's status. Resend signs webhooks with the Svix scheme; we verify the
// signature with RESEND_WEBHOOK_SECRET before trusting the payload.
//
// Events we care about (each carries data.email_id, which correlates to a
// contact_broadcast_recipients row by resend_email_id):
//   email.delivered / email.opened / email.clicked / email.bounced /
//   email.complained / email.delivery_delayed
// We set the matching per-event timestamp (once) and advance `status` to the
// furthest state reached. Unrelated events / unknown email ids are 200-ignored.
//
// Public (verify_jwt=false) — the signature IS the authentication.
//
// Required secrets (auto-injected): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Required secret (set in the Resend + Supabase dashboards): RESEND_WEBHOOK_SECRET
//   (the "whsec_..." signing secret from the Resend webhook endpoint).

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// deno-lint-ignore no-explicit-any
type Db = any;

const STATUS_RANK: Record<string, number> = {
  sent: 0,
  delivery_delayed: 1,
  delivered: 2,
  opened: 3,
  clicked: 4,
  bounced: 5,
  complained: 6,
};

// event type → { timestamp column (null = none), status it implies }
const EVENT_MAP: Record<string, { col: string | null; status: string }> = {
  "email.delivered": { col: "delivered_at", status: "delivered" },
  "email.opened": { col: "opened_at", status: "opened" },
  "email.clicked": { col: "clicked_at", status: "clicked" },
  "email.bounced": { col: "bounced_at", status: "bounced" },
  "email.complained": { col: "complained_at", status: "complained" },
  "email.delivery_delayed": { col: null, status: "delivery_delayed" },
};

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  try {
    // @ts-expect-error Deno env
    const secret = Deno.env.get("RESEND_WEBHOOK_SECRET");
    if (!secret) return new Response("server_misconfigured", { status: 500 });

    const rawBody = await req.text();
    const svixId = req.headers.get("svix-id") ?? "";
    const svixTs = req.headers.get("svix-timestamp") ?? "";
    const svixSig = req.headers.get("svix-signature") ?? "";
    if (!(await verifySvix(secret, svixId, svixTs, svixSig, rawBody))) {
      return new Response("invalid_signature", { status: 401 });
    }

    let evt: { type?: string; data?: { email_id?: string } };
    try {
      evt = JSON.parse(rawBody);
    } catch {
      return new Response("bad_json", { status: 400 });
    }
    const type = evt?.type ?? "";
    const emailId = evt?.data?.email_id;
    const map = EVENT_MAP[type];
    // Not an event we track, or no email id → acknowledge so Resend stops retrying.
    if (!map || !emailId) return new Response("ok", { status: 200 });

    // @ts-expect-error Deno env
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const admin: Db = createClient(
      SUPABASE_URL,
      // @ts-expect-error Deno env
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: rec } = await admin
      .from("contact_broadcast_recipients")
      .select("id, status, delivered_at, opened_at, clicked_at, bounced_at, complained_at")
      .eq("resend_email_id", emailId)
      .maybeSingle();
    // Not one of our contact-broadcast emails (e.g. a transactional email).
    if (!rec) return new Response("ok", { status: 200 });

    const nowIso = new Date().toISOString();
    const patch: Record<string, unknown> = { last_event_at: nowIso };
    // Set the per-event timestamp once (preserve first-occurrence time).
    if (map.col && !rec[map.col]) patch[map.col] = nowIso;
    // Advance status only forward.
    if ((STATUS_RANK[rec.status] ?? 0) < (STATUS_RANK[map.status] ?? 0)) {
      patch.status = map.status;
    }
    await admin.from("contact_broadcast_recipients").update(patch).eq("id", rec.id);

    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("resend-webhook error", String((e as { message?: string })?.message ?? e));
    return new Response("error", { status: 500 });
  }
});

// ── Svix signature verification ─────────────────────────────────────
// signed content = `${id}.${timestamp}.${body}`; secret is "whsec_<base64>";
// the header is a space-separated list of "v1,<base64 HMAC-SHA256>".
async function verifySvix(
  secret: string,
  id: string,
  timestamp: string,
  sigHeader: string,
  body: string,
): Promise<boolean> {
  if (!id || !timestamp || !sigHeader) return false;
  let keyBytes: Uint8Array;
  try {
    keyBytes = b64decode(secret.replace(/^whsec_/, ""));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = `${id}.${timestamp}.${body}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)),
  );
  const expected = b64encode(sig);
  for (const part of sigHeader.split(" ")) {
    const comma = part.indexOf(",");
    if (comma < 0) continue;
    const version = part.slice(0, comma);
    const value = part.slice(comma + 1);
    if (version === "v1" && timingSafeEqual(value, expected)) return true;
  }
  return false;
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
