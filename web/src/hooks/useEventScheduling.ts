import { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabase";
import { SPOT_HOLDING_STATUSES, teamCountFor } from "../lib/registrationStatus";
import {
  eventPlacementFacts,
  toFixedPlacement,
  toPackItem,
  type EventPlacementFacts,
} from "../lib/eventPlacement";
import { packSchedule, type Placement } from "../lib/schedulePacker";
import type { Database } from "../types/supabase";

type EventRow = Database["public"]["Tables"]["events"]["Row"];
type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];

// One already-scheduled sibling event on the same day, as a fixed placement
// the packer routes around.
export type SiblingPlacement = {
  event: EventRow;
  facts: EventPlacementFacts;
  // Its scheduled start (fixed).
  startMs: number;
  placement: Placement;
};

export type EventSchedulingData = {
  loading: boolean;
  error: string | null;
  // Venue court count (locations.court_count). null = no venue selected, or
  // the venue has no court count set — callers show NoCourtCountNotice.
  venueCourts: number | null;
  hasVenue: boolean;
  // The tournament's start moment — the day anchor. Recommendations never
  // start before it.
  anchorMs: number;
  // OTHER events in this tournament scheduled on the same day (dated only),
  // ordered by start — the fixed placements to route around.
  siblings: SiblingPlacement[];
  // This event's placement facts for a candidate court allocation (durations
  // depend on how many courts it runs on).
  factsFor: (courtNumbers: number[]) => EventPlacementFacts;
  // Recommend THIS event's slot: earliest start + court numbers that fit
  // alongside the same-day siblings, with `heldBy` explaining any wait.
  // null when the venue court count is unknown.
  recommend: (courtNumbers: number[]) => Placement | null;
  reload: () => void;
};

// Local YYYY-MM-DD key so "same day" is the organizer's wall-clock day.
function dayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Shared data + recommendation engine for the Bracket Setup wizard's Courts
// and Start-time steps. Both steps recommend for THIS event by treating the
// same-day sibling events as fixed and running the ONE scheduling engine
// (schedulePacker via eventPlacement) — no bespoke packing here (D-0049).
//
// "What else is scheduled that day" is strictly other Bert & Erne events in
// the SAME tournament on the same day (this repo has no Court Reserve
// integration). Recommendations account for those events' courts, times and
// player rosters (clash detection).
export function useEventScheduling(args: {
  event: EventRow;
  tournament: Tournament;
  // Teams holding a spot in THIS event (roster count).
  teamCount: number;
  // Player ids on THIS event's roster, for clash detection.
  players: ReadonlySet<string>;
}): EventSchedulingData {
  const { event, tournament, teamCount, players } = args;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [venueCourts, setVenueCourts] = useState<number | null>(null);
  const [siblings, setSiblings] = useState<SiblingPlacement[]>([]);

  const anchorMs = new Date(tournament.starts_at).getTime();
  const hasVenue = tournament.location_id != null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    // Venue court count — the cap on court needs (locations.court_count),
    // same source the Schedule page uses. Not tournaments.court_count.
    let courts: number | null = null;
    if (tournament.location_id) {
      const { data: loc, error: locErr } = await supabase
        .from("locations")
        .select("court_count")
        .eq("id", tournament.location_id)
        .maybeSingle();
      if (locErr) {
        setError(locErr.message);
        setLoading(false);
        return;
      }
      courts = loc?.court_count ?? null;
    }

    const [evRes, courtsRes, regsRes] = await Promise.all([
      supabase
        .from("events")
        .select("*")
        .eq("tournament_id", tournament.id)
        .is("deleted_at", null)
        .neq("id", event.id),
      supabase
        .from("event_courts")
        .select("*, events!inner(tournament_id)")
        .eq("events.tournament_id", tournament.id),
      supabase
        .from("event_registrations")
        .select(
          "event_id, player_id, status, partner_status, events!inner(tournament_id)",
        )
        .eq("events.tournament_id", tournament.id)
        .in("status", SPOT_HOLDING_STATUSES)
        .is("deleted_at", null),
    ]);
    if (evRes.error || courtsRes.error || regsRes.error) {
      setError(
        (evRes.error ?? courtsRes.error ?? regsRes.error)?.message ??
          "Couldn't load the day's schedule.",
      );
      setLoading(false);
      return;
    }

    const courtsByEvent = new Map<string, number[]>();
    for (const ec of (courtsRes.data ?? []) as unknown as {
      event_id: string;
      court_number: number;
    }[]) {
      const arr = courtsByEvent.get(ec.event_id) ?? [];
      arr.push(ec.court_number);
      courtsByEvent.set(ec.event_id, arr);
    }

    type RegRow = {
      event_id: string;
      player_id: string;
      status: Database["public"]["Enums"]["registration_status"];
      partner_status: Database["public"]["Enums"]["partner_status"];
    };
    const regsByEvent = new Map<string, RegRow[]>();
    const playersByEvent = new Map<string, Set<string>>();
    for (const r of (regsRes.data ?? []) as unknown as RegRow[]) {
      const list = regsByEvent.get(r.event_id) ?? [];
      list.push(r);
      regsByEvent.set(r.event_id, list);
      const set = playersByEvent.get(r.event_id) ?? new Set<string>();
      set.add(r.player_id);
      playersByEvent.set(r.event_id, set);
    }

    const anchorDay = dayKey(anchorMs);
    const sibs: SiblingPlacement[] = [];
    for (const ev of (evRes.data ?? []) as EventRow[]) {
      if (!ev.scheduled_start_at) continue; // undated → no fixed slot to avoid
      const startMs = new Date(ev.scheduled_start_at).getTime();
      if (dayKey(startMs) !== anchorDay) continue; // different day
      const evCourts = courtsByEvent.get(ev.id) ?? [];
      const facts = eventPlacementFacts({
        event: ev,
        teamCount: teamCountFor(ev.format, regsByEvent.get(ev.id) ?? []),
        courtNumbers: evCourts,
        venueCourts: courts ?? Math.max(1, evCourts.length),
        players: playersByEvent.get(ev.id) ?? new Set<string>(),
      });
      sibs.push({
        event: ev,
        facts,
        startMs,
        placement: toFixedPlacement(facts, startMs),
      });
    }
    sibs.sort((a, b) => a.startMs - b.startMs);

    setVenueCourts(courts);
    setSiblings(sibs);
    setLoading(false);
  }, [event.id, tournament.id, tournament.location_id, anchorMs]);

  useEffect(() => {
    void load();
  }, [load]);

  const factsFor = useCallback(
    (courtNumbers: number[]) =>
      eventPlacementFacts({
        event,
        teamCount,
        courtNumbers,
        venueCourts: venueCourts ?? Math.max(1, courtNumbers.length),
        players,
      }),
    [event, teamCount, venueCourts, players],
  );

  const recommend = useCallback(
    (courtNumbers: number[]): Placement | null => {
      if (venueCourts == null || venueCourts < 1) return null;
      const bufferMs =
        Math.max(0, tournament.inter_event_buffer_minutes ?? 0) * 60_000;
      const fixed = siblings.map((s) => s.placement);
      const fixedPlayers = new Map<string, ReadonlySet<string>>(
        siblings.map((s) => [s.event.id, s.facts.players]),
      );
      const out = packSchedule(
        [toPackItem(factsFor(courtNumbers), 0)],
        anchorMs,
        bufferMs,
        venueCourts,
        fixed,
        fixedPlayers,
      );
      return out[0] ?? null;
    },
    [venueCourts, tournament.inter_event_buffer_minutes, siblings, factsFor, anchorMs],
  );

  return {
    loading,
    error,
    venueCourts,
    hasVenue,
    anchorMs,
    siblings,
    factsFor,
    recommend,
    reload: () => void load(),
  };
}
