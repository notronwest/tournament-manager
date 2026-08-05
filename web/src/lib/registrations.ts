import { supabase } from "../supabase";
import type { Database } from "../types/supabase";

type RegistrationStatus = Database["public"]["Enums"]["registration_status"];
type PartnerStatus = Database["public"]["Enums"]["partner_status"];
type EventFormat = Database["public"]["Enums"]["event_format"];

// One registration a player holds, flattened with its event + tournament
// context and the resolved partner name. Used by the Contacts "Registrations"
// list and passed (in shape) into the RegistrationEditorModal.
export type PlayerReg = {
  regId: string;
  eventId: string;
  eventName: string;
  format: EventFormat;
  tournamentId: string;
  tournamentName: string;
  tournamentSlug: string;
  status: RegistrationStatus;
  partnerStatus: PartnerStatus;
  partnerRegId: string | null;
  partnerName: string | null;
  eventFeeCents: number;
};

// Active statuses for "does this player already have a reg in this event" and
// for the pairing candidate list. Mirrors PairingBoardPage's
// `.not("status","in","(cancelled,refunded)")`, extended to also drop
// withdrawn regs (they've been pulled from the event).
const INACTIVE_STATUSES = "(cancelled,refunded,withdrawn)";

// Every non-deleted event_registration a player holds across an org's
// non-deleted tournaments/events. Walk org → tournaments → events (same shape
// as orgContacts.fetchRegistrantPlayerIds) then read the player's regs joined
// to their event, and resolve each partner's name in a second pass.
export async function fetchPlayerRegistrations(
  orgId: string,
  playerId: string,
): Promise<PlayerReg[]> {
  // org → tournaments (keep name + slug for the flattened rows)
  const { data: tourneys, error: tErr } = await supabase
    .from("tournaments")
    .select("id, name, slug")
    .eq("organization_id", orgId)
    .is("deleted_at", null);
  if (tErr) throw new Error(tErr.message);
  const tournaments = tourneys ?? [];
  if (tournaments.length === 0) return [];
  const tournamentById = new Map(tournaments.map((t) => [t.id, t]));

  // tournaments → events
  const { data: events, error: eErr } = await supabase
    .from("events")
    .select("id, tournament_id")
    .in(
      "tournament_id",
      tournaments.map((t) => t.id),
    )
    .is("deleted_at", null);
  if (eErr) throw new Error(eErr.message);
  const eventIds = (events ?? []).map((e) => e.id);
  if (eventIds.length === 0) return [];

  // this player's non-deleted regs in those events, joined to the event row
  const { data: regs, error: rErr } = await supabase
    .from("event_registrations")
    .select(
      "id, event_id, status, partner_status, partner_registration_id, event_fee_cents, events!inner(id, name, format, tournament_id)",
    )
    .eq("player_id", playerId)
    .in("event_id", eventIds)
    .is("deleted_at", null);
  if (rErr) throw new Error(rErr.message);

  type RawReg = {
    id: string;
    event_id: string;
    status: RegistrationStatus;
    partner_status: PartnerStatus;
    partner_registration_id: string | null;
    event_fee_cents: number;
    // to-one embed → object, not array (see CLAUDE.md gotcha)
    events: {
      id: string;
      name: string;
      format: EventFormat;
      tournament_id: string;
    } | null;
  };
  const rawRegs = (regs ?? []) as unknown as RawReg[];

  // Resolve partner names in one round-trip: partner_registration_id → that
  // reg's player → first/last name.
  const partnerRegIds = Array.from(
    new Set(
      rawRegs
        .map((r) => r.partner_registration_id)
        .filter((id): id is string => id != null),
    ),
  );
  const partnerNameByRegId = new Map<string, string>();
  if (partnerRegIds.length > 0) {
    const { data: partnerRegs, error: pErr } = await supabase
      .from("event_registrations")
      .select("id, players(first_name, last_name)")
      .in("id", partnerRegIds);
    if (pErr) throw new Error(pErr.message);
    type RawPartner = {
      id: string;
      players: { first_name: string; last_name: string } | null;
    };
    for (const pr of (partnerRegs ?? []) as unknown as RawPartner[]) {
      if (pr.players) {
        partnerNameByRegId.set(
          pr.id,
          `${pr.players.first_name} ${pr.players.last_name}`.trim(),
        );
      }
    }
  }

  const out: PlayerReg[] = [];
  for (const r of rawRegs) {
    if (!r.events) continue;
    const t = tournamentById.get(r.events.tournament_id);
    if (!t) continue;
    out.push({
      regId: r.id,
      eventId: r.event_id,
      eventName: r.events.name,
      format: r.events.format,
      tournamentId: t.id,
      tournamentName: t.name,
      tournamentSlug: t.slug,
      status: r.status,
      partnerStatus: r.partner_status,
      partnerRegId: r.partner_registration_id,
      partnerName: r.partner_registration_id
        ? (partnerNameByRegId.get(r.partner_registration_id) ?? null)
        : null,
      eventFeeCents: r.event_fee_cents,
    });
  }

  // Order by tournament, then event.
  out.sort(
    (a, b) =>
      a.tournamentName.localeCompare(b.tournamentName) ||
      a.eventName.localeCompare(b.eventName),
  );
  return out;
}

// Re-point a registration at a different player. The caller resolves/creates
// the player (persistPlayerSelection) first and passes the resulting id.
// Mirrors EventConsolePage.saveEdit's `update({ player_id }).eq("id", regId)`.
export async function reassignRegistrationPlayer(
  regId: string,
  newPlayerId: string,
): Promise<void> {
  const { error } = await supabase
    .from("event_registrations")
    .update({ player_id: newPlayerId })
    .eq("id", regId);
  if (error) throw new Error(error.message);
}

// Withdraw a registration from its event. MONEY-SAFE: this issues NO refund and
// touches NO payments — refunds go through the separate withdrawal queue. A
// paid reg becomes 'withdrawn'; anything unpaid/waitlisted becomes 'cancelled'.
// The reg is unpaired (partner_status→solo), and if it had a partner that
// partner is set back to 'seeking' so the organizer can re-pair them.
export async function withdrawRegistration(reg: {
  regId: string;
  status: RegistrationStatus;
  partnerRegId: string | null;
}): Promise<void> {
  const newStatus: RegistrationStatus =
    reg.status === "paid" ? "withdrawn" : "cancelled";

  const { error: selfErr } = await supabase
    .from("event_registrations")
    .update({
      status: newStatus,
      partner_status: "solo",
      partner_registration_id: null,
    })
    .eq("id", reg.regId);
  if (selfErr) throw new Error(selfErr.message);

  if (reg.partnerRegId) {
    const { error: partnerErr } = await supabase
      .from("event_registrations")
      .update({ partner_status: "seeking", partner_registration_id: null })
      .eq("id", reg.partnerRegId);
    if (partnerErr) throw new Error(partnerErr.message);
  }
}

// Pair two registrations — point each at the other and mark both confirmed.
// Copies PairingBoardPage.onPair exactly. On a paired-roles event the
// check_paired_roles_sides trigger may reject two same-side regs; the DB error
// message is surfaced verbatim (it's human-readable) rather than swallowed.
export async function pairRegistrations(
  regAId: string,
  regBId: string,
): Promise<void> {
  const [resA, resB] = await Promise.all([
    supabase
      .from("event_registrations")
      .update({
        partner_registration_id: regBId,
        partner_status: "confirmed",
      })
      .eq("id", regAId),
    supabase
      .from("event_registrations")
      .update({
        partner_registration_id: regAId,
        partner_status: "confirmed",
      })
      .eq("id", regBId),
  ]);
  const err = [resA, resB].find((r) => r.error)?.error;
  if (err) throw new Error(err.message);
}

// Break a pairing — both regs go back to unpaired/seeking. Copies
// PairingBoardPage.onUndo.
export async function unpairRegistration(
  regId: string,
  partnerRegId: string,
): Promise<void> {
  const [resA, resB] = await Promise.all([
    supabase
      .from("event_registrations")
      .update({ partner_registration_id: null, partner_status: "seeking" })
      .eq("id", regId),
    supabase
      .from("event_registrations")
      .update({ partner_registration_id: null, partner_status: "seeking" })
      .eq("id", partnerRegId),
  ]);
  const err = [resA, resB].find((r) => r.error)?.error;
  if (err) throw new Error(err.message);
}

// Create a fresh registration for a chosen partner who has no existing reg in
// the event — an admin comp add. Mirrors EventConsolePage TeamsSection.onAdd's
// doubles insert: event_fee_cents 0 (comped — NO charge), status 'paid',
// partner_status 'confirmed'. Returns the new reg id for the caller to pair.
export async function createPartnerRegistration(
  eventId: string,
  playerId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("event_registrations")
    .insert({
      event_id: eventId,
      player_id: playerId,
      event_fee_cents: 0,
      status: "paid",
      partner_status: "confirmed",
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to create partner registration.");
  }
  return data.id;
}

// Active registrations in an event (candidates to pick as an existing partner).
export async function fetchEventRegistrants(eventId: string): Promise<
  {
    regId: string;
    playerId: string;
    name: string;
    partnerStatus: PartnerStatus;
  }[]
> {
  const { data, error } = await supabase
    .from("event_registrations")
    .select("id, player_id, partner_status, players(first_name, last_name)")
    .eq("event_id", eventId)
    .is("deleted_at", null)
    .not("status", "in", INACTIVE_STATUSES);
  if (error) throw new Error(error.message);

  type RawRow = {
    id: string;
    player_id: string;
    partner_status: PartnerStatus;
    players: { first_name: string; last_name: string } | null;
  };
  return ((data ?? []) as unknown as RawRow[]).map((r) => ({
    regId: r.id,
    playerId: r.player_id,
    name: r.players
      ? `${r.players.first_name} ${r.players.last_name}`.trim()
      : "(unknown)",
    partnerStatus: r.partner_status,
  }));
}
