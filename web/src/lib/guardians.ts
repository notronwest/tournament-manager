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
//   * A dependent's player row must be created BEFORE the link, in a separate
//     statement. The policy that decides whether a player may be adopted is
//     STABLE, so it reads the snapshot as of the start of the current
//     statement — doing both in one statement (a CTE) cannot see the new row
//     and is refused.
//   * A player may only be adopted while they hold no auth account and no
//     registrations, which in practice means "a row you just created". That
//     is what keeps a guardian link from being a way to reach into an
//     existing player's registrations.
//
// player_guardians is newer than the generated types, so it is read through an
// untyped view of the client — the same pattern as CheckoutPage's
// account_credits reads. Drop the cast once `supabase gen types` has been
// re-run against a database that has this migration.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../supabase";
import type { Database } from "../types/supabase";
import { persistPlayerSelection } from "../components/PlayerPicker";

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

// Creates the dependent's player row and links it to the guardian. The player
// row goes through persistPlayerSelection — the same helper the partner
// "+ Add new player" path uses — rather than a second creation path; it takes
// the date of birth as an optional field added for exactly this caller.
//
// A child needs no email address: that is the point of the feature, and
// nothing in this path asks for one.
export async function addDependent(args: {
  guardianPlayerId: string;
  firstName: string;
  lastName: string;
  dob: string;
}): Promise<{ dependent: Dependent | null; error: string | null }> {
  const { player, error } = await persistPlayerSelection({
    mode: "new",
    firstName: args.firstName,
    lastName: args.lastName,
    email: "",
    phone: "",
    dob: args.dob,
  });
  if (error || !player) {
    return { dependent: null, error: error ?? "Couldn't save that child." };
  }

  const { data, error: linkErr } = await untyped
    .from("player_guardians")
    .insert({
      guardian_player_id: args.guardianPlayerId,
      dependent_player_id: player.id,
    })
    .select("id")
    .single();
  if (linkErr || !data) {
    // The player row exists but is unreachable without the link, so say so
    // plainly rather than reporting a success that isn't one. It holds no
    // registrations, so re-adding the same child is safe.
    return {
      dependent: null,
      error: linkErr?.message ?? "Couldn't link that child to your account.",
    };
  }

  return { dependent: { linkId: (data as { id: string }).id, player }, error: null };
}

// Retires the link, not the player. The child's own row and any history stay
// where they are — this is the soft delete the table was built for, and it is
// what lets the same child be re-added or later claim their own account.
export async function removeDependent(linkId: string): Promise<{ error: string | null }> {
  const { error } = await untyped
    .from("player_guardians")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", linkId);
  return { error: error?.message ?? null };
}
