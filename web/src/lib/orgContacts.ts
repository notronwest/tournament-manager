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

const ACTIVE_REG_STATUSES = ["paid", "pending_payment"] as const;

export type ContactSource = "registrant" | "import" | "manual";

export type OrgContact = {
  playerId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  source: ContactSource;
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
  const { data: linkData, error: linkErr } = await untyped
    .from("organization_contacts")
    .select("player_id, source, unsubscribed_at, created_at")
    .eq("organization_id", orgId)
    .is("deleted_at", null);
  if (linkErr) throw new Error(linkErr.message);
  const links = (linkData ?? []) as LinkRow[];

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

async function fetchRegistrantPlayerIds(orgId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const { data: tourneys } = await supabase
    .from("tournaments")
    .select("id")
    .eq("organization_id", orgId)
    .is("deleted_at", null);
  const tournamentIds = (tourneys ?? []).map((t) => t.id);
  if (tournamentIds.length === 0) return ids;

  const { data: events } = await supabase
    .from("events")
    .select("id")
    .in("tournament_id", tournamentIds)
    .is("deleted_at", null);
  const eventIds = (events ?? []).map((e) => e.id);
  if (eventIds.length === 0) return ids;

  const { data: regs } = await supabase
    .from("event_registrations")
    .select("player_id")
    .in("event_id", eventIds)
    .in("status", ACTIVE_REG_STATUSES)
    .is("deleted_at", null);
  for (const r of regs ?? []) if (r.player_id) ids.add(r.player_id);
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
