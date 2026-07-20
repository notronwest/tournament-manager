// supabase/functions/import-contacts/index.ts
//
// Import a club's contacts from a parsed CSV/XLSX upload into the org's
// contact list. The browser parses the file (SheetJS) and posts rows here;
// this function never sees the raw file.
//
// Person data lives in the shared global `players` table (one row per human,
// deduped by email). This function:
//   1. matches each row to an existing player by email (citext, case-insensitive),
//   2. creates a player only when no email match exists,
//   3. links the player to the org via `organization_contacts` (source 'import').
//
// It deliberately does NOT overwrite fields on a matched existing player — those
// rows are shared across orgs, so one org's import must not clobber another's data.
//
// ORG-STAFF only (member of the org, or a platform admin). DB-only — no Resend.
//
// Body:    { organizationId: string, rows: ContactRow[] }   (rows capped at 5000)
// Returns: { added, matchedExisting, linked, skipped, total }
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

const MAX_ROWS = 5000;

type ContactRow = {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  state?: string | null;
};

type Body = { organizationId?: string; rows?: ContactRow[] };

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
    const admin = createClient(
      SUPABASE_URL,
      // @ts-expect-error Deno env
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── 1. Authenticate ──────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
    const authUserId = userData.user.id;

    // ── 2. Input ─────────────────────────────────────────────────────
    const { organizationId, rows } = (await req.json()) as Body;
    if (!organizationId) return json({ error: "organizationId is required" }, 400);
    if (!Array.isArray(rows)) return json({ error: "rows must be an array" }, 400);
    if (rows.length === 0) return json({ error: "no rows to import" }, 400);
    if (rows.length > MAX_ROWS) {
      return json({ error: `too many rows (max ${MAX_ROWS})` }, 400);
    }

    // ── 3. Authorize: org member or platform admin ───────────────────
    if (!(await isOrgStaff(admin, organizationId, authUserId))) {
      return json({ error: "forbidden_org_staff_only" }, 403);
    }

    // ── 4. Normalize + validate rows ─────────────────────────────────
    // Keep a row if it has a first name (players.first_name is NOT NULL).
    // Dedup within the file by lowercased email (rows without email can't
    // be deduped, so each becomes its own player).
    let skipped = 0;
    const seenEmails = new Set<string>();
    type Clean = { first: string; last: string; email: string | null; phone: string | null; city: string | null; state: string | null };
    const clean: Clean[] = [];
    for (const r of rows) {
      const first = str(r.first_name);
      const last = str(r.last_name);
      const email = normEmail(r.email);
      if (!first && !last) { skipped++; continue; } // no name → can't create a player
      if (email) {
        if (seenEmails.has(email)) { skipped++; continue; } // dup within file
        seenEmails.add(email);
      }
      clean.push({
        first: first || last, // guarantee a non-empty first_name
        last: first ? last : "",
        email,
        phone: str(r.phone) || null,
        city: str(r.city) || null,
        state: str(r.state) || null,
      });
    }
    if (clean.length === 0) return json({ added: 0, matchedExisting: 0, linked: 0, skipped, total: rows.length });

    // ── 5. Match existing players by email (batch) ───────────────────
    const emails = [...seenEmails];
    const emailToPlayerId = new Map<string, string>();
    if (emails.length > 0) {
      const { data: existing, error: exErr } = await admin
        .from("players")
        .select("id, email")
        .in("email", emails)
        .is("deleted_at", null);
      if (exErr) return json({ error: exErr.message }, 500);
      for (const p of (existing ?? []) as { id: string; email: string | null }[]) {
        const key = (p.email ?? "").toLowerCase();
        // first match wins (players email is soft-unique, dupes possible)
        if (key && !emailToPlayerId.has(key)) emailToPlayerId.set(key, p.id);
      }
    }

    // ── 6. Create players that had no email match ────────────────────
    const toCreate = clean.filter((c) => !(c.email && emailToPlayerId.has(c.email)));
    let created = 0;
    // Map each new row to its created player id by position.
    const createdIds: (string | null)[] = [];
    if (toCreate.length > 0) {
      const { data: ins, error: insErr } = await admin
        .from("players")
        .insert(
          toCreate.map((c) => ({
            first_name: c.first,
            last_name: c.last,
            email: c.email, // null ok
            phone: c.phone,
            city: c.city,
            state: c.state,
          })),
        )
        .select("id");
      if (insErr) return json({ error: insErr.message }, 500);
      const insRows = (ins ?? []) as { id: string }[];
      created = insRows.length;
      for (let i = 0; i < toCreate.length; i++) {
        const id = insRows[i]?.id ?? null;
        createdIds.push(id);
        // Record email→id so later same-email rows (shouldn't exist — deduped) resolve.
        if (id && toCreate[i].email) emailToPlayerId.set(toCreate[i].email!, id);
      }
    }

    // ── 7. Resolve every clean row to a player id ────────────────────
    const playerIds = new Set<string>();
    let createCursor = 0;
    let matchedExisting = 0;
    for (const c of clean) {
      let pid: string | null = null;
      if (c.email && emailToPlayerId.has(c.email)) {
        pid = emailToPlayerId.get(c.email)!;
        matchedExisting++;
      } else {
        pid = createdIds[createCursor++] ?? null;
      }
      if (pid) playerIds.add(pid);
    }

    // ── 8. Link players to the org (upsert; restores soft-deleted links) ─
    const links = [...playerIds].map((player_id) => ({
      organization_id: organizationId,
      player_id,
      source: "import",
      deleted_at: null,
    }));
    let linked = 0;
    if (links.length > 0) {
      const { error: linkErr } = await admin
        .from("organization_contacts")
        .upsert(links, { onConflict: "organization_id,player_id" });
      if (linkErr) return json({ error: linkErr.message }, 500);
      linked = links.length;
    }

    return json({
      added: created,
      matchedExisting,
      linked,
      skipped,
      total: rows.length,
    });
  } catch (e) {
    return json({ error: "internal_error", detail: String((e as { message?: string })?.message ?? e) }, 500);
  }
});

async function isOrgStaff(
  admin: Db,
  organizationId: string,
  authUserId: string,
): Promise<boolean> {
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

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}
function normEmail(v: unknown): string | null {
  const s = str(v).toLowerCase();
  return s && s.includes("@") ? s : null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
