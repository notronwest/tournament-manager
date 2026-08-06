// supabase/functions/_shared/playerOrgAccess.ts
//
// Resolve what a caller may do on a single (global) player record for the
// unified person admin page. Shared by admin-get-player and admin-update-player
// so the authorization can never drift between read and write.
//
// Two access levels:
//   'platform' — the caller has a platform_admins row → full cross-org view/edit.
//   'org'      — the caller is a member of the named org AND the player belongs
//                to that org → scoped to that org (profile + that org's regs).
//                Org admins never get login/password/avatar-moderation or the
//                cross-org merge/impersonate actions (enforced by the callers).
// Returns null when neither holds — deny.

// deno-lint-ignore no-explicit-any
type Db = any;

export type PlayerAccess =
  | { scope: "platform" }
  | { scope: "org"; orgId: string; orgSlug: string };

export async function resolvePlayerAccess(
  admin: Db,
  callerUserId: string,
  playerId: string,
  orgSlug: string | null,
): Promise<PlayerAccess | null> {
  // Platform admin → full access, ignore any org scope.
  const { data: padmin } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", callerUserId)
    .maybeSingle();
  if (padmin) return { scope: "platform" };

  // Otherwise the caller must name an org they belong to, and the player must
  // belong to that org — otherwise an org admin could pull up any global player.
  if (!orgSlug) return null;

  const { data: org } = await admin
    .from("organizations")
    .select("id, slug")
    .eq("slug", orgSlug)
    .is("deleted_at", null)
    .maybeSingle();
  if (!org) return null;

  const { data: member } = await admin
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", org.id)
    .eq("user_id", callerUserId)
    .maybeSingle();
  if (!member) return null;

  if (!(await playerBelongsToOrg(admin, playerId, org.id))) return null;

  return { scope: "org", orgId: org.id, orgSlug: org.slug };
}

// A player belongs to an org if they have an explicit contact link there, or a
// non-deleted registration in one of the org's tournaments. The registration
// path is walked EXPLICITLY (org → tournaments → events → regs) rather than via
// an embedded-resource filter, so a malformed nested filter can never silently
// grant access to a player who only belongs to some OTHER org. Fails closed.
async function playerBelongsToOrg(
  admin: Db,
  playerId: string,
  orgId: string,
): Promise<boolean> {
  const { data: contact } = await admin
    .from("organization_contacts")
    .select("player_id")
    .eq("organization_id", orgId)
    .eq("player_id", playerId)
    .is("deleted_at", null)
    .maybeSingle();
  if (contact) return true;

  // org → its tournaments
  const { data: tourneys } = await admin
    .from("tournaments")
    .select("id")
    .eq("organization_id", orgId)
    .is("deleted_at", null);
  const tournamentIds = (tourneys ?? []).map((t: { id: string }) => t.id);
  if (tournamentIds.length === 0) return false;

  // tournaments → their events
  const { data: events } = await admin
    .from("events")
    .select("id")
    .in("tournament_id", tournamentIds)
    .is("deleted_at", null);
  const eventIds = (events ?? []).map((e: { id: string }) => e.id);
  if (eventIds.length === 0) return false;

  // a non-deleted reg by this player in one of those events
  const { data: regs } = await admin
    .from("event_registrations")
    .select("id")
    .eq("player_id", playerId)
    .in("event_id", eventIds)
    .is("deleted_at", null)
    .limit(1);
  return !!(regs && regs.length > 0);
}
