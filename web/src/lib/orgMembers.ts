import { supabase } from "../supabase";

// Who can sign in and manage an organization. Served by the admin-org-members
// edge function rather than read straight from the table: emails live in
// auth.users, which the browser client can't read at all, and adding someone
// means looking their account up by email.

export type OrgRole = "owner" | "admin" | "staff";

export type OrgMember = {
  userId: string;
  email: string | null;
  role: OrgRole;
  createdAt: string | null;
  firstName: string | null;
  lastName: string | null;
  playerId: string | null;
  lastSignInAt: string | null;
};

export const ORG_ROLES: OrgRole[] = ["owner", "admin", "staff"];

export const ROLE_LABELS: Record<OrgRole, string> = {
  owner: "Owner",
  admin: "Admin",
  staff: "Staff",
};

// Plain-language, in the order the list sorts. Shown behind a "What can each
// role do?" toggle so the page isn't a wall of explanation on first load.
export const ROLE_BLURBS: Record<OrgRole, string> = {
  owner:
    "Full access, and the only role that can add or remove other owners. Every organization keeps at least one.",
  admin:
    "Full access to tournaments, players, venues, email and payment settings. Can add or remove admins and staff.",
  staff:
    "Can run tournaments day to day — brackets, scores, check-in. Can't change payment settings or manage who has access.",
};

export function memberName(m: OrgMember): string {
  const n = `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim();
  return n || m.email || "Unnamed account";
}

export async function fetchOrgMembers(organizationId: string): Promise<OrgMember[]> {
  const res = await invoke({ organizationId, action: "list" });
  return res.members ?? [];
}

// Grants access to an existing account. Membership points at a login row, so
// there's nothing to grant until the person has signed in once — that case
// comes back as the "no_account" message rather than a silent no-op.
export async function addOrgMember(
  organizationId: string,
  email: string,
  role: OrgRole,
): Promise<OrgMember[]> {
  const res = await invoke({ organizationId, action: "add", email, role });
  return res.members ?? [];
}

export async function setOrgMemberRole(
  organizationId: string,
  userId: string,
  role: OrgRole,
): Promise<OrgMember[]> {
  const res = await invoke({ organizationId, action: "set_role", userId, role });
  return res.members ?? [];
}

export async function removeOrgMember(
  organizationId: string,
  userId: string,
): Promise<OrgMember[]> {
  const res = await invoke({ organizationId, action: "remove", userId });
  return res.members ?? [];
}

type FnResponse = { members?: OrgMember[]; member?: OrgMember | null; ok?: boolean };

async function invoke(body: Record<string, unknown>): Promise<FnResponse> {
  const { data, error } = await supabase.functions.invoke("admin-org-members", { body });
  if (error) throw new Error(friendly(await readFnError(error)));
  return (data ?? {}) as FnResponse;
}

// The function's error codes, said the way the page should say them.
function friendly(code: string): string {
  switch (code) {
    case "no_account":
      return "No account with that email yet. Ask them to sign in to the site once, then add them here.";
    case "already_member":
      return "That person already has access to this organization.";
    case "only_owner_manages_owners":
      return "Only an owner can add or remove another owner.";
    case "last_owner":
      return "This is the only owner. Make someone else an owner first.";
    case "cannot_change_self":
      return "You can't change your own role. Ask another owner or admin to do it.";
    case "not_a_member":
      return "That person no longer has access — the list has moved on. Reload the page.";
    case "forbidden":
      return "You need to be an owner or admin of this organization to manage access.";
    case "unauthenticated":
      return "Your session expired. Sign in again.";
    default:
      return code;
  }
}

// Unwrap a supabase FunctionsError — the edge function's JSON body is on
// err.context as a Response (same idiom used across the admin pages).
async function readFnError(err: unknown): Promise<string> {
  const ctx = (err as { context?: Response })?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const b = (await ctx.json()) as { error?: string };
      if (b?.error) return b.error;
    } catch {
      /* fall through */
    }
  }
  return (err as { message?: string })?.message ?? "Something went wrong.";
}
