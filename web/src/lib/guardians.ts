// Guardians and dependents (#1169) — a parent registering a junior.
//
// A guardian holds a link to each player they act for, in player_guardians
// (migration 20261027120000). The link is the whole authorization: RLS lets a
// guardian insert, read and update an event_registrations row for a linked
// dependent and nobody else's, and compute_checkout_total bills the family as
// one basket so the parent pays with one card.
//
// Two properties of the database shape the code here:
//
//   * There is NO insert policy on player_guardians and no insert grant. A
//     link exists only where add_dependent() made one, and that function
//     creates the player row and the link together — so there is no way to
//     point a link at a player row that already exists, which is what would
//     otherwise turn a guardian link into a way to reach into someone else's
//     registrations. (An earlier draft did allow an insert, fenced by a policy
//     that the dependent hold no account and no registrations; the review
//     closed the path instead of fencing it.)
//   * is_guardian_of() requires the dependent to still be account-less, so a
//     guardian's authority over a row ends the moment the real person claims
//     it — the orphan-claim flow is how a child gets their own account at 18.
//   * Table-level UPDATE is revoked; the grant covers (deleted_at,
//     relationship) only, so a guardian can retire a link or label it but
//     cannot re-point either end of it.
//
// player_guardians is newer than the generated types, so it is read through an
// untyped view of the client — the same pattern as CheckoutPage's
// account_credits reads. Drop the cast once `supabase gen types` has been
// re-run against a database that has this migration.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../supabase";
import type { Database } from "../types/supabase";

type Player = Database["public"]["Tables"]["players"]["Row"];

const untyped = supabase as unknown as SupabaseClient;

// registered_by_player_id was added in 20261027120000; extend the generated
// types locally until they are regenerated (never hand-edit
// types/supabase.ts). Optional, so rows read with the stale generated Row
// still assign cleanly and every consumer treats absent as "self-registered".
export type EventRegistrationInsert =
  Database["public"]["Tables"]["event_registrations"]["Insert"] & {
    registered_by_player_id?: string | null;
  };

// The generated Insert type actively rejects keys it doesn't know about, so an
// insert carrying the new column has to be handed over as the generated shape.
// One place to do it, with the reason attached, rather than a bare cast at
// each call site.
export function asRegistrationInsert(
  values: EventRegistrationInsert,
): Database["public"]["Tables"]["event_registrations"]["Insert"] {
  return values as Database["public"]["Tables"]["event_registrations"]["Insert"];
}

export type Dependent = {
  // The player_guardians row, which is what a "remove" retires.
  linkId: string;
  player: Player;
};

// Everyone a checkout or a register card may act for: the signed-in player
// first, then their dependents. The order is the order they are offered in,
// and the player themselves is always the default.
export type Registrant = {
  player: Player;
  isSelf: boolean;
};

export function registrantsFor(me: Player | null, dependents: Dependent[]): Registrant[] {
  if (!me) return [];
  return [
    { player: me, isSelf: true },
    ...dependents.map((d) => ({ player: d.player, isSelf: false })),
  ];
}

export function playerName(p: Player): string {
  return `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "Unnamed player";
}

// Two queries rather than an embedded join: player_guardians has two foreign
// keys to players, so `players(*)` would be ambiguous and needs naming the
// constraint — which is the kind of detail that breaks silently when a
// constraint is renamed.
export async function fetchDependents(
  guardianPlayerId: string,
): Promise<{ dependents: Dependent[]; error: string | null }> {
  const { data: links, error: linkErr } = await untyped
    .from("player_guardians")
    .select("id, dependent_player_id")
    .eq("guardian_player_id", guardianPlayerId)
    .is("deleted_at", null);
  if (linkErr) return { dependents: [], error: linkErr.message };

  const rows = (links ?? []) as { id: string; dependent_player_id: string }[];
  if (rows.length === 0) return { dependents: [], error: null };

  const { data: players, error: playerErr } = await supabase
    .from("players")
    .select("*")
    .in(
      "id",
      rows.map((r) => r.dependent_player_id),
    )
    .is("deleted_at", null);
  if (playerErr) return { dependents: [], error: playerErr.message };

  const byId = new Map((players ?? []).map((p) => [p.id, p]));
  const dependents = rows
    .map((r) => {
      const player = byId.get(r.dependent_player_id);
      return player ? { linkId: r.id, player } : null;
    })
    .filter((d): d is Dependent => d !== null)
    .sort((a, b) => playerName(a.player).localeCompare(playerName(b.player)));

  return { dependents, error: null };
}

// Creates the dependent's player row and the guardian link, in one
// SECURITY DEFINER call. The client cannot do this in two steps any more and
// should not want to: there is no insert policy on player_guardians, precisely
// so a link can never be pointed at a player row that already existed.
//
// A child needs no email address — a name and a date of birth are the whole
// requirement, and that is the point of the feature. But one is worth asking
// for (#1186): every message the platform sends a registrant is addressed from
// players.email, and a row without one is skipped rather than redirected —
// cancel-tournament and notify-registration-change both log "no email address"
// and move on, and neither reads player_guardians. So a child with no address
// is a child whose cancelled tournament nobody is told about. A guardian
// putting their own address on the row is the intended shape: players.email is
// deliberately soft-unique (indexed, no unique constraint) so a parent and
// child can share one.
//
// The address is a SECOND write, not an argument to add_dependent(): the RPC's
// signature is fixed and changing a SECURITY DEFINER function to carry one
// more optional column would be a migration, where the guardian migration
// already granted exactly this. Its "players update by self or related org"
// policy has an is_guardian_of() branch built for a guardian maintaining a
// dependent's profile, and its `with check` pins auth_user_id to null, so this
// path cannot do anything the policy didn't already intend. The cost is that
// the pair isn't atomic, which is what emailError reports.
export async function addDependent(args: {
  guardianPlayerId: string;
  firstName: string;
  lastName: string;
  dob: string;
  email?: string | null;
}): Promise<{
  dependent: Dependent | null;
  error: string | null;
  // Set only when the child WAS created and the optional address was not
  // stored. Distinct from error because the row exists: retrying the whole
  // call would add a second child, so the caller's job is to report this, not
  // to repeat itself.
  emailError: string | null;
}> {
  const { data: newId, error: rpcErr } = await untyped.rpc("add_dependent", {
    p_first_name: args.firstName,
    p_last_name: args.lastName,
    p_dob: args.dob,
  });
  if (rpcErr || !newId) {
    return {
      dependent: null,
      error: rpcErr?.message ?? "Couldn't add that child.",
      emailError: null,
    };
  }

  // Blank is sent as no address at all.
  const email = (args.email ?? "").trim();
  let emailError: string | null = null;
  if (email) {
    const { error: emailErr } = await setDependentEmail(newId as string, email);
    emailError = emailErr;
  }

  // Read the pair back rather than assembling it from the arguments, so the
  // list shows what the database actually stored (trimmed names, the address
  // as citext kept it, the link id the remove action needs).
  const { dependents, error: readErr } = await fetchDependents(args.guardianPlayerId);
  const dependent = dependents.find((d) => d.player.id === (newId as string)) ?? null;
  if (!dependent) {
    return {
      dependent: null,
      error: readErr ?? "Added, but couldn't read the family list back. Reload to see them.",
      emailError: null,
    };
  }
  return { dependent, error: null, emailError };
}

// The address write on its own, so a form that got half of the pair can retry
// THAT half rather than the whole call — repeating addDependent would add a
// second child, and a row that already exists only needs its address set.
// The policy branch is the same one described above; citext, so the stored
// value compares case-insensitively and there is nothing to lower-case here.
//
// A blank draft stores NULL, not "". Every reader of this column treats the
// absence of an address as "nobody to email" and nothing treats "" that way:
// an empty string would render as a dangling separator, defeat the "No email
// address" line the family row shows, and look like an address to code that
// only checks for null. So clearing the field is a supported move with one
// representation, rather than a second kind of empty.
export async function setDependentEmail(
  dependentPlayerId: string,
  email: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from("players")
    .update({ email: email.trim() || null })
    .eq("id", dependentPlayerId);
  return { error: error?.message ?? null };
}

// The one rule about a dependent's date of birth, and the one wording for it.
//
// Not a database rule — the row saves without one. But a child added for a
// juniors bracket with no date of birth is a registration refused later for a
// reason nobody can see, so the field is required wherever a guardian can
// write it. Both places are now writable (the add form and the row editor on
// My family), and a row editor that accepted a blank would quietly undo what
// the add form insisted on — which is why this is a function and not a rule
// typed out twice.
export function dependentDobError(dob: string): string | null {
  return dob.trim()
    ? null
    : "A date of birth is needed so age-restricted brackets can check it.";
}

// The rest of what a bracket checks, written as one update (#1183).
//
// A child added through add_dependent() has a name and a date of birth and
// nothing else, and nothing anywhere could give them more: the rating pickers
// on the profile page write the signed-in player's own columns, and the add
// form collects no gender. So a skill-bounded division refused the child "no
// doubles self-rating on file" and a girls' bracket refused them "women's
// event", with no control the parent could reach — the youth path finished
// only on open-skill, mixed and open events.
//
// Same policy branch as setDependentEmail: the guardian migration's "players
// update by self or related org" has an is_guardian_of() arm for a guardian
// maintaining a dependent's profile, row-level over every column bar
// auth_user_id, which its `with check` pins to null. No migration, and
// nothing here the policy did not already intend.
//
// One update rather than a call per field, so a parent who sets a rating and
// a gender together cannot end up with half of it stored. Every value is
// sent, nulls included: clearing a rating is a real move (tapping the
// selected chip clears it), so an undefined-means-leave-it shape would make
// "no rating" unreachable once one had been set.
export async function setDependentProfile(
  dependentPlayerId: string,
  values: {
    dob: string | null;
    gender: Database["public"]["Enums"]["player_gender"] | null;
    doubles: number | null;
    mixed: number | null;
    singles: number | null;
  },
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from("players")
    .update({
      dob: values.dob,
      gender: values.gender,
      self_rating_doubles: values.doubles,
      self_rating_mixed: values.mixed,
      self_rating_singles: values.singles,
    })
    .eq("id", dependentPlayerId);
  return { error: error?.message ?? null };
}

// Retires the link, not the player. The child's own row and any history stay
// where they are — this is the soft delete the table was built for, and it is
// what lets the same child later claim their own account. (Re-adding the same
// child now means adding them again, since add_dependent() always makes a new
// player row; the retired link and its player stay as they are.)
export async function removeDependent(linkId: string): Promise<{ error: string | null }> {
  const { error } = await untyped
    .from("player_guardians")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", linkId);
  return { error: error?.message ?? null };
}
