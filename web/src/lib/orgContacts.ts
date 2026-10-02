import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../supabase";

// Org contact list = imported/manual contacts (organization_contacts)
// ∪ the org's registrants (distinct players in the org's event_registrations),
// deduped by player. Person data lives in the shared global `players` table.
//
// `organization_contacts` isn't in the generated `Database` types until the
// migration reaches the linked project and types are regenerated, so the client
// is cast to an untyped SupabaseClient for just those calls (mirrors the
// approach in lib/registrationCounts). The typed `supabase` is used for every
// already-generated table (tournaments / events / event_registrations / players).
const untyped = supabase as unknown as SupabaseClient;

// A registrant counts as "on the list" unless their registration is over
// (cancelled / refunded / withdrawn). Waitlisted players are included — they are
// exactly who an organizer needs to reach. Mirrors INACTIVE_STATUSES in
// lib/registrations and the roster export.
const ACTIVE_REG_STATUSES = [
  "paid",
  "pending_payment",
  "waitlisted",
  "waitlisted_pending_payment",
] as const;

// PostgREST caps every response at the project's max_rows (1000). A club with
// more contacts / registrations than that would silently lose the tail, so every
// list query here pages with .range() until a short page comes back.
const PAGE_SIZE = 1000;

import type { ContactSource } from "./contactSource";
export { matchesSource, type ContactSource, type SourceFilter } from "./contactSource";

export type OrgContact = {
  playerId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  /** How the person got onto the list — one label per contact for display.
   * An explicit import/manual link wins over "registrant". Filter with
   * `matchesSource`, not this field: a contact can be BOTH imported and a
   * registrant, and "Registrants" must mean everyone who registered. */
  source: ContactSource;
  /** True when the person holds an active registration in one of the org's
   * events — regardless of `source`. */
  isRegistrant: boolean;
  unsubscribed: boolean;
  /** When the contact was added to the list (organization_contacts.created_at).
   * Null for registrants, who are derived live and have no link row. */
  addedAt: string | null;
};

type LinkRow = {
  player_id: string;
  source: string;
  unsubscribed_at: string | null;
  created_at: string | null;
};

// Fetch the full contact list for an org. Registrants are derived live, so the
// list is never stale. Throws on a hard query failure (the page surfaces it).
export async function fetchOrgContacts(orgId: string): Promise<OrgContact[]> {
  // (a) imported/manual links
  const links: LinkRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: linkData, error: linkErr } = await untyped
      .from("organization_contacts")
      .select("player_id, source, unsubscribed_at, created_at")
      .eq("organization_id", orgId)
      .is("deleted_at", null)
      .order("player_id")
      .range(from, from + PAGE_SIZE - 1);
    if (linkErr) throw new Error(linkErr.message);
    const page = (linkData ?? []) as LinkRow[];
    links.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const linkByPlayer = new Map<string, LinkRow>();
  for (const l of links) linkByPlayer.set(l.player_id, l);

  // (b) registrants — distinct players in the org's event_registrations.
  const registrantIds = await fetchRegistrantPlayerIds(orgId);

  // Union of player ids from both sources.
  const allIds = new Set<string>([...linkByPlayer.keys(), ...registrantIds]);
  if (allIds.size === 0) return [];

  // Person data for the union (chunked to stay under URL length limits).
  const players = await fetchPlayers([...allIds]);

  const out: OrgContact[] = [];
  for (const p of players) {
    const link = linkByPlayer.get(p.id);
    // Source precedence: an explicit import/manual link labels the row;
    // otherwise the person is on the list purely because they registered.
    const source: ContactSource =
      link?.source === "manual"
        ? "manual"
        : link?.source === "import"
          ? "import"
          : "registrant";
    out.push({
      playerId: p.id,
      firstName: p.first_name ?? "",
      lastName: p.last_name ?? "",
      email: p.email,
      phone: p.phone,
      city: p.city,
      state: p.state,
      source,
      isRegistrant: registrantIds.has(p.id),
      unsubscribed: !!link?.unsubscribed_at,
      addedAt: link?.created_at ?? null,
    });
  }
  // Stable sort: last name, then first.
  out.sort(
    (a, b) =>
      a.lastName.localeCompare(b.lastName) ||
      a.firstName.localeCompare(b.firstName),
  );
  return out;
}

// Soft-delete an imported/manual contact link. Registrants have no link row —
// removing them is a no-op here (they're managed via their registration).
export async function removeOrgContact(
  orgId: string,
  playerId: string,
): Promise<void> {
  const { error } = await untyped
    .from("organization_contacts")
    .update({ deleted_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("player_id", playerId);
  if (error) throw new Error(error.message);
}

// Person fields an admin can create/edit for a contact. These live on the shared
// global `players` row, so editing one updates the person everywhere they appear.
export type ContactInput = {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
};

// Normalize a blank string to null (email/phone/city/state are optional).
function orNull(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : null;
}

// Add a single contact. Mirrors the bulk importer's matching rule: if an email
// is given and an existing (non-deleted) player already has it, reuse that
// player (do NOT overwrite their fields); otherwise create a new player. Then
// upsert a `manual` link, restoring it if it was previously soft-deleted.
// Returns the player id the contact resolved to.
export async function createOrgContact(
  orgId: string,
  input: ContactInput,
): Promise<string> {
  const email = orNull(input.email);
  let playerId: string | null = null;

  if (email) {
    // citext column → case-insensitive match; take the earliest existing row.
    const { data: existing, error: lookupErr } = await supabase
      .from("players")
      .select("id")
      .eq("email", email)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .limit(1);
    if (lookupErr) throw new Error(lookupErr.message);
    playerId = existing?.[0]?.id ?? null;
  }

  if (!playerId) {
    const { data: inserted, error: insErr } = await supabase
      .from("players")
      .insert({
        first_name: input.firstName.trim(),
        last_name: input.lastName.trim(),
        email,
        phone: orNull(input.phone),
        city: orNull(input.city),
        state: orNull(input.state),
      })
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);
    playerId = inserted.id;
  }

  const { error: linkErr } = await untyped
    .from("organization_contacts")
    .upsert(
      {
        organization_id: orgId,
        player_id: playerId,
        source: "manual",
        deleted_at: null,
      },
      { onConflict: "organization_id,player_id" },
    );
  if (linkErr) throw new Error(linkErr.message);
  return playerId;
}

// Edit a contact's person fields. NOTE: `players` is a shared global record, so
// this updates the person across every org/tournament they appear in. We never
// touch auth_user_id here — editing contact info can't hijack an account.
export async function updateContactPerson(
  playerId: string,
  input: ContactInput,
): Promise<void> {
  const { error } = await supabase
    .from("players")
    .update({
      first_name: input.firstName.trim(),
      last_name: input.lastName.trim(),
      email: orNull(input.email),
      phone: orNull(input.phone),
      city: orNull(input.city),
      state: orNull(input.state),
    })
    .eq("id", playerId);
  if (error) throw new Error(error.message);
}

// Distinct players holding a live registration in any of the org's tournaments.
// One org-scoped query through the events → tournaments join (the same shape the
// Attendees page uses), rather than collecting every event id into the request
// URL (a long event list can push that request past the URL limit) and capped
// at one page. Previously any failure here was swallowed, so the registrant side
// of the list silently vanished and only imported/manual contacts were left.
// Errors now throw so the page can say so.
async function fetchRegistrantPlayerIds(orgId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const { data: tourneys, error: tErr } = await supabase
    .from("tournaments")
    .select("id")
    .eq("organization_id", orgId)
    .is("deleted_at", null);
  if (tErr) throw new Error(tErr.message);
  const tournamentIds = (tourneys ?? []).map((t) => t.id);
  if (tournamentIds.length === 0) return ids;

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: regs, error: rErr } = await supabase
      .from("event_registrations")
      .select("id, player_id, events!inner(tournament_id, deleted_at)")
      .in("events.tournament_id", tournamentIds)
      .is("events.deleted_at", null)
      .in("status", [...ACTIVE_REG_STATUSES])
      .is("deleted_at", null)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (rErr) throw new Error(rErr.message);
    const page = regs ?? [];
    for (const r of page) if (r.player_id) ids.add(r.player_id);
    if (page.length < PAGE_SIZE) break;
  }
  return ids;
}

type PlayerRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
};

async function fetchPlayers(ids: string[]): Promise<PlayerRow[]> {
  const out: PlayerRow[] = [];
  const CHUNK = 300;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("players")
      .select("id, first_name, last_name, email, phone, city, state")
      .in("id", slice)
      .is("deleted_at", null);
    if (error) throw new Error(error.message);
    for (const p of data ?? []) out.push(p as PlayerRow);
  }
  return out;
}
