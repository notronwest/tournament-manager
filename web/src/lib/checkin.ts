// Day-of player check-in — the pure logic behind the check-in screen, the
// printable roster, and the "everyone checked in" gate on Generate matches /
// Start event.
//
// Check-in is a PLAYER action that applies to ALL of that player's
// registrations in the tournament: one walk-up at the desk marks them present
// for every event they're in. We stamp event_registrations.checked_in_at
// (migration 20260912120000) with the same now() on all their spot-holding
// rows; undo nulls them.
//
// Everything here is a pure function over plain rows so it can be unit-tested
// without a database (see checkin.test.ts) and reused by every surface.

import type { Database } from "../types/supabase";
import { SPOT_HOLDING_STATUSES } from "./registrationStatus";

type RegistrationStatus = Database["public"]["Enums"]["registration_status"];

// event_registrations.checked_in_at is newer than the generated Database types
// (they lag until a `gen types` runs against the linked project), so we model
// the minimum shape the check-in logic needs rather than fight the stale Row
// type. Callers cast their `select("*")` rows to this.
export type CheckInReg = {
  id: string;
  event_id: string;
  player_id: string;
  status: RegistrationStatus;
  checked_in_at: string | null;
};

export type CheckInPlayerLite = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
};

export type CheckInEventLite = { id: string; name: string };

// A registration counts for check-in when it holds a spot in the event — the
// same set that becomes a bracket team and appears on the roster
// (SPOT_HOLDING_STATUSES). Free-waitlisted / withdrawn / cancelled / refunded
// players aren't expected at the desk, so they never show on the sheet, never
// count toward the running total, and never block a Start.
export function countsForCheckIn(status: RegistrationStatus): boolean {
  return SPOT_HOLDING_STATUSES.includes(status);
}

export function fullName(p: { first_name: string; last_name: string }): string {
  return `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim();
}

// The registrations a check-in / undo should touch for one player: all of that
// player's spot-holding rows in the tournament. Pass every reg the player has
// across the tournament's events — this is the "check ALL their events at
// once" rule in one place.
export function checkInRegIds(playerRegs: CheckInReg[]): string[] {
  return playerRegs.filter((r) => countsForCheckIn(r.status)).map((r) => r.id);
}

export type CheckInRosterEntry = {
  playerId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  /** Events the player holds a spot in, by event name. */
  events: CheckInEventLite[];
  /** Spot-holding reg ids across the tournament — what check-in/undo stamp. */
  regIds: string[];
  /** True once every spot-holding reg for this player is checked in. */
  checkedIn: boolean;
  /** Earliest check-in stamp among their regs, for display; null if not in. */
  checkedInAt: string | null;
  /** Lowercased name + email + phone, for the search box. */
  search: string;
};

// One row per player, A–Z by last name (then first), each with the events they
// hold a spot in and their combined check-in state. Mirrors the paper sheet in
// backups/checkin-sheet.html: player, events, one box.
export function buildCheckInRoster(
  players: CheckInPlayerLite[],
  regs: CheckInReg[],
  events: CheckInEventLite[],
): CheckInRosterEntry[] {
  const eventNameById = new Map(events.map((e) => [e.id, e.name]));
  const playerById = new Map(players.map((p) => [p.id, p]));

  type Acc = {
    player: CheckInPlayerLite;
    events: Map<string, string>; // eventId -> name
    regIds: string[];
    stamps: (string | null)[];
  };
  const byPlayer = new Map<string, Acc>();

  for (const r of regs) {
    if (!countsForCheckIn(r.status)) continue;
    const player = playerById.get(r.player_id);
    if (!player) continue;
    let acc = byPlayer.get(r.player_id);
    if (!acc) {
      acc = { player, events: new Map(), regIds: [], stamps: [] };
      byPlayer.set(r.player_id, acc);
    }
    acc.regIds.push(r.id);
    acc.stamps.push(r.checked_in_at);
    acc.events.set(r.event_id, eventNameById.get(r.event_id) ?? "Event");
  }

  const entries: CheckInRosterEntry[] = [];
  for (const acc of byPlayer.values()) {
    const p = acc.player;
    const stamped = acc.stamps.filter((s): s is string => s !== null);
    const checkedIn = acc.stamps.length > 0 && stamped.length === acc.stamps.length;
    const checkedInAt =
      stamped.length > 0 ? stamped.slice().sort()[0] : null;
    const eventList = [...acc.events.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    entries.push({
      playerId: p.id,
      firstName: p.first_name ?? "",
      lastName: p.last_name ?? "",
      fullName: fullName(p),
      email: p.email,
      phone: p.phone,
      events: eventList,
      regIds: acc.regIds,
      checkedIn,
      checkedInAt,
      search: [p.first_name, p.last_name, p.email, p.phone]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    });
  }

  return entries.sort((a, b) =>
    `${a.lastName} ${a.firstName}`
      .toLowerCase()
      .localeCompare(`${b.lastName} ${b.firstName}`.toLowerCase()),
  );
}

// Typeahead filter over the roster: every whitespace-separated token must
// match the entry's search string (name / email / phone), the same "all tokens
// match" behaviour as PlayerPicker. Empty query returns everyone.
export function filterCheckInRoster(
  entries: CheckInRosterEntry[],
  query: string,
): CheckInRosterEntry[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return entries;
  return entries.filter((e) => tokens.every((t) => e.search.includes(t)));
}

export type CheckInGate = {
  /** Distinct spot-holding players registered in the event. */
  total: number;
  checkedIn: number;
  allCheckedIn: boolean;
  /** Players not yet fully checked in, by name. */
  missing: { playerId: string; name: string }[];
};

// The gate behind "Generate matches" and "Start event": is every registered
// player in THIS event checked in? Pass the event's registrations (extra rows
// are filtered defensively) and a name lookup. A player is checked in only when
// every spot-holding reg they have in the event is stamped — in doubles both
// partners must be present. Returns the missing players so the caller can list
// them.
export function eventCheckInGate(
  regs: CheckInReg[],
  playerById: Map<string, CheckInPlayerLite>,
): CheckInGate {
  const byPlayer = new Map<string, boolean>(); // player_id -> all regs checked in
  for (const r of regs) {
    if (!countsForCheckIn(r.status)) continue;
    const prior = byPlayer.get(r.player_id);
    const thisChecked = r.checked_in_at !== null;
    byPlayer.set(r.player_id, prior === undefined ? thisChecked : prior && thisChecked);
  }

  const missing: { playerId: string; name: string }[] = [];
  let checkedIn = 0;
  for (const [playerId, isChecked] of byPlayer) {
    if (isChecked) {
      checkedIn++;
    } else {
      const p = playerById.get(playerId);
      missing.push({
        playerId,
        name: p ? fullName(p) : "Unknown player",
      });
    }
  }
  missing.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  const total = byPlayer.size;
  return { total, checkedIn, allCheckedIn: total > 0 && checkedIn === total, missing };
}
