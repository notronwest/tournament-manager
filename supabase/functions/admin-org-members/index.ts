// supabase/functions/admin-org-members/index.ts
//
// Who can sign in and manage an organization — the server side of the
// "Users and Roles" page. Needs service_role for two reasons: emails live in
// auth.users (not readable from the client at all), and adding someone means
// looking their account up by email.
//
// Caller must be an owner/admin of the org, or a platform admin. Staff can't
// reach this at all — managing people is an admin-or-above job (matching the
// "members managed by admins" RLS policy).
//
// Body: { organizationId, action, ... }
//   action: "list"                           → { members: OrgMember[] }
//   action: "add",      email, role          → { member: OrgMember }
//   action: "set_role", userId, role         → { member: OrgMember }
//   action: "remove",   userId               → { ok: true }
//
// Guard rails, enforced here rather than in the UI so a hand-rolled request
// can't get round them:
//   · only an owner (or platform admin) may grant or revoke 'owner'
//   · the last owner can't be demoted or removed — an org always has one
//   · you can't change or remove your own row (no self-lockout, no self-promotion)
//
// Required secrets (auto-injected): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   SUPABASE_ANON_KEY.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type OrgRole = "owner" | "admin" | "staff";
const ROLES: OrgRole[] = ["owner", "admin", "staff"];

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthenticated" }, 401);

  // @ts-expect-error Deno env
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  // @ts-expect-error Deno env
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // @ts-expect-error Deno env
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

  let body: {
    organizationId?: string;
    action?: string;
    email?: string;
    userId?: string;
    role?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const orgId = (body.organizationId ?? "").trim();
  const action = body.action ?? "list";
  if (!orgId) return json({ error: "missing_organization" }, 400);

  // ── Authenticate ────────────────────────────────────────────────────
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user: callerUser }, error: userErr } = await caller.auth.getUser();
  if (userErr || !callerUser) return json({ error: "unauthenticated" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── Authorize: org owner/admin, or platform admin ───────────────────
  const { data: padmin } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", callerUser.id)
    .maybeSingle();
  const isPlatformAdmin = Boolean(padmin);

  const { data: ownRow } = await admin
    .from("organization_members")
    .select("role")
    .eq("organization_id", orgId)
    .eq("user_id", callerUser.id)
    .maybeSingle();
  const callerRole = (ownRow?.role ?? null) as OrgRole | null;

  const callerIsAdmin = callerRole === "admin" || callerRole === "owner";
  if (!isPlatformAdmin && !callerIsAdmin) return json({ error: "forbidden" }, 403);
  // A platform admin acts with owner authority even without a row of their own.
  const callerCanManageOwners = isPlatformAdmin || callerRole === "owner";

  try {
    if (action === "list") {
      return json({ members: await listMembers(admin, orgId) });
    }

    if (action === "add") {
      const email = (body.email ?? "").trim().toLowerCase();
      const role = body.role as OrgRole | undefined;
      if (!email) return json({ error: "missing_email" }, 400);
      if (!role || !ROLES.includes(role)) return json({ error: "bad_role" }, 400);
      if (role === "owner" && !callerCanManageOwners) {
        return json({ error: "only_owner_manages_owners" }, 403);
      }

      const authUser = await findAuthUserByEmail(admin, email);
      if (!authUser) return json({ error: "no_account" }, 404);

      // Adding is additive only — a silent role change behind an "Add" button
      // would be a surprise, so say so and let them use the row's Role picker.
      const { data: existing } = await admin
        .from("organization_members")
        .select("user_id")
        .eq("organization_id", orgId)
        .eq("user_id", authUser.id)
        .maybeSingle();
      if (existing) return json({ error: "already_member" }, 409);

      const { error: upErr } = await admin
        .from("organization_members")
        .insert({ organization_id: orgId, user_id: authUser.id, role });
      if (upErr) return json({ error: upErr.message }, 500);

      const members = await listMembers(admin, orgId);
      return json({ member: members.find((m) => m.userId === authUser.id) ?? null, members });
    }

    if (action === "set_role" || action === "remove") {
      const userId = (body.userId ?? "").trim();
      if (!userId) return json({ error: "missing_user" }, 400);
      if (userId === callerUser.id) return json({ error: "cannot_change_self" }, 400);

      const { data: targetRow } = await admin
        .from("organization_members")
        .select("role")
        .eq("organization_id", orgId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!targetRow) return json({ error: "not_a_member" }, 404);
      const targetRole = targetRow.role as OrgRole;

      const nextRole = action === "set_role" ? (body.role as OrgRole | undefined) : undefined;
      if (action === "set_role" && (!nextRole || !ROLES.includes(nextRole))) {
        return json({ error: "bad_role" }, 400);
      }

      // Touching an owner — in either direction — is owner-only.
      if ((targetRole === "owner" || nextRole === "owner") && !callerCanManageOwners) {
        return json({ error: "only_owner_manages_owners" }, 403);
      }

      // Never strand the org without an owner.
      if (targetRole === "owner" && nextRole !== "owner") {
        const { count } = await admin
          .from("organization_members")
          .select("user_id", { count: "exact", head: true })
          .eq("organization_id", orgId)
          .eq("role", "owner");
        if ((count ?? 0) <= 1) return json({ error: "last_owner" }, 400);
      }

      if (action === "remove") {
        const { error: delErr } = await admin
          .from("organization_members")
          .delete()
          .eq("organization_id", orgId)
          .eq("user_id", userId);
        if (delErr) return json({ error: delErr.message }, 500);
        return json({ ok: true, members: await listMembers(admin, orgId) });
      }

      const { error: updErr } = await admin
        .from("organization_members")
        .update({ role: nextRole })
        .eq("organization_id", orgId)
        .eq("user_id", userId);
      if (updErr) return json({ error: updErr.message }, 500);

      const members = await listMembers(admin, orgId);
      return json({ member: members.find((m) => m.userId === userId) ?? null, members });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: String((e as { message?: string })?.message ?? e) }, 500);
  }
});

type OrgMember = {
  userId: string;
  email: string | null;
  role: OrgRole;
  createdAt: string | null;
  firstName: string | null;
  lastName: string | null;
  playerId: string | null;
  lastSignInAt: string | null;
};

// Membership rows + the bits that only service_role can see (auth email,
// last sign-in) + the player record's name when the account is linked to one.
async function listMembers(
  // deno-lint-ignore no-explicit-any
  admin: any,
  orgId: string,
): Promise<OrgMember[]> {
  const { data: rows, error } = await admin
    .from("organization_members")
    .select("user_id, role, created_at")
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
  const members = rows ?? [];
  if (members.length === 0) return [];

  const userIds = members.map((m: { user_id: string }) => m.user_id);

  const { data: players } = await admin
    .from("players")
    .select("id, first_name, last_name, email, auth_user_id")
    .in("auth_user_id", userIds)
    .is("deleted_at", null);
  const byAuthId = new Map<string, { id: string; first_name: string | null; last_name: string | null; email: string | null }>();
  for (const p of players ?? []) {
    if (p.auth_user_id) byAuthId.set(p.auth_user_id, p);
  }

  const authUsers = await listAllAuthUsers(admin);

  return members
    .map((m: { user_id: string; role: OrgRole; created_at: string | null }) => {
      const p = byAuthId.get(m.user_id);
      const au = authUsers.get(m.user_id);
      return {
        userId: m.user_id,
        email: au?.email ?? p?.email ?? null,
        role: m.role,
        createdAt: m.created_at,
        firstName: p?.first_name ?? null,
        lastName: p?.last_name ?? null,
        playerId: p?.id ?? null,
        lastSignInAt: au?.lastSignInAt ?? null,
      };
    })
    .sort((a: OrgMember, b: OrgMember) => {
      const rank = (r: OrgRole) => ROLES.indexOf(r);
      if (rank(a.role) !== rank(b.role)) return rank(a.role) - rank(b.role);
      return nameOf(a).localeCompare(nameOf(b));
    });
}

function nameOf(m: OrgMember): string {
  const n = `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim();
  return (n || m.email || m.userId).toLowerCase();
}

// supabase-js has no get-user-by-email, so the auth admin list is paginated
// and indexed by id. Same idiom as the unregistered-users function.
async function listAllAuthUsers(
  // deno-lint-ignore no-explicit-any
  admin: any,
): Promise<Map<string, { email: string | null; lastSignInAt: string | null }>> {
  const out = new Map<string, { email: string | null; lastSignInAt: string | null }>();
  const PER_PAGE = 1000;
  for (let page = 1; page <= 50; page++) {
    const { data: list, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw new Error(error.message);
    const batch = list?.users ?? [];
    for (const u of batch) {
      out.set(u.id, { email: u.email ?? null, lastSignInAt: u.last_sign_in_at ?? null });
    }
    if (batch.length < PER_PAGE) break;
  }
  return out;
}

async function findAuthUserByEmail(
  // deno-lint-ignore no-explicit-any
  admin: any,
  email: string,
): Promise<{ id: string; email: string | null } | null> {
  const PER_PAGE = 1000;
  for (let page = 1; page <= 50; page++) {
    const { data: list, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw new Error(error.message);
    const batch = list?.users ?? [];
    const hit = batch.find((u: { email?: string | null }) => (u.email ?? "").toLowerCase() === email);
    if (hit) return { id: hit.id, email: hit.email ?? null };
    if (batch.length < PER_PAGE) break;
  }
  return null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
