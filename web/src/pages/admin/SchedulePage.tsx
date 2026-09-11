import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import {
  estimateEvent,
  fmtDuration,
  poolPlayExplanation,
  utilizationLabel,
  type EventEstimate,
} from "../../lib/estimator";
import { SPOT_HOLDING_STATUSES, teamCountFor } from "../../lib/registrationStatus";
import {
  medalCourtsNeeded,
  packSchedule,
  parallelGroups,
  poolCourtsNeeded,
  type Placement,
  type PlacedSegment,
} from "../../lib/schedulePacker";
import { ConfirmModal } from "../../components/ConfirmModal";
import { SchedulePrintModal } from "../../components/SchedulePrintModal";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NoCourtCountNotice } from "../../components/NoCourtCountNotice";
import type { Database } from "../../types/supabase";
import {
  ink,
  inkSoft,
  inkMuted,
  bg,
  cream,
  creamDeep,
  rule,
  ruleSoft,
  courtBlue,
  courtGreen,
  courtRed,
  courtYellow,
  dangerBg,
  dangerFg,
  warnBg,
  warnFg,
  bodyFontStack,
  headingFontStack,
} from "../../lib/publicTheme";

// Court count now lives on the selected venue (locations.court_count),
// joined in on the tournament fetch below.
type Tournament = Database["public"]["Tables"]["tournaments"]["Row"] & {
  locations: { court_count: number | null } | null;
  // Migration 20260911210000 — generated types lag it.
  schedule_locked_at?: string | null;
};
// schedule_order landed in migration 20260911170000; the generated types
// lag it, so read it through this widening and write via an untyped client.
type Event = Database["public"]["Tables"]["events"]["Row"] & {
  schedule_order?: number | null;
  playoff_seeding?: "overall" | "cross_pool" | null;
};
const untyped = supabase as unknown as SupabaseClient;

// Organizer order first (1 = first), creation order for anything unset.
function sortEvents(list: Event[]): Event[] {
  return [...list].sort((a, b) => {
    const ao = a.schedule_order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.schedule_order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return a.created_at.localeCompare(b.created_at);
  });
}
type EventCourt = Database["public"]["Tables"]["event_courts"]["Row"];

type EventRow = {
  event: Event;
  teamCount: number;
  teamsPerPool: number;
  courts: number;
  courtNumbers: number[];
  poolMinutes: number;
  medalMinutes: number;
  totalMinutes: number;
  poolBindingConstraint: "court" | "team";
  // Full breakdown for the per-row Details disclosure.
  estimate: EventEstimate;
  // Teams the plan is based on: registered teams, or max_teams before
  // anyone has signed up.
  planTeams: number;
  // Courts pool play can actually keep busy (pools × floor(teams/2)),
  // capped at the venue. Drives parallel auto-scheduling.
  courtsNeeded: number;
  // Courts the medal round keeps busy (one per medal match; 0 = no playoff).
  medalCourtsNeeded: number;
  // Persisted start time on the event, if any. End is computed from
  // start + totalMinutes.
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  // The event's two phases as actually placed on courts (when scheduled):
  // pool play on the lowest `courtsNeeded` of its assigned courts, then the
  // medal round on the lowest `medalCourtsNeeded` of those. Conflicts and
  // the calendar work from these, so a bracket only "holds" the courts it
  // is really using.
  phases: RowPhase[];
};

type RowPhase = { kind: "pool" | "medal"; start: Date; end: Date; courts: number[] };

type Overlap =
  | {
      type: "court";
      a: EventRow;
      b: EventRow;
      courts: number[];
      windowStart: Date;
      windowEnd: Date;
    }
  | {
      type: "player";
      a: EventRow;
      b: EventRow;
      sharedPlayerCount: number;
      windowStart: Date;
      windowEnd: Date;
    };

// Per-tournament schedule view. Pulls each event's settings plus
// registration counts and court allocation, runs them through the
// shared estimator math, and reports per-event durations. Estimates
// the tournament total by detecting which events share courts
// (sequential) vs. run on disjoint courts (parallel).
//
// This is the planning surface: a TD can scan it before publishing
// to see whether the venue's rental window can absorb everything,
// and tweak event format / court allocation until it fits.
export default function SchedulePage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  // View tab driven by ?view= so refresh + back keep the user where
  // they were. Table is the default since it's the editable view.
  const view: "table" | "calendar" =
    searchParams.get("view") === "calendar" ? "calendar" : "table";
  const setView = (v: "table" | "calendar") => {
    const next = new URLSearchParams(searchParams);
    if (v === "table") next.delete("view");
    else next.set("view", v);
    setSearchParams(next, { replace: true });
  };
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [eventCourts, setEventCourts] = useState<EventCourt[]>([]);
  const [teamsByEvent, setTeamsByEvent] = useState<Map<string, number>>(
    new Map(),
  );
  // Player-id set per event, used for cross-event player-conflict
  // detection. Counts come from teamsByEvent; this is the membership
  // map.
  const [playersByEvent, setPlayersByEvent] = useState<
    Map<string, Set<string>>
  >(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Anchor for auto-schedule. Defaults from tournament.starts_at the
  // first time the tournament loads; the user can override before
  // clicking "Auto-schedule". Stored as a datetime-local-style string
  // (YYYY-MM-DDTHH:MM) so the input renders without timezone goop.
  const [anchorLocal, setAnchorLocal] = useState<string>("");
  // Buffer in minutes inserted between consecutive events sharing a
  // court (announcements, court turnover, etc.). Lives on the
  // tournament row; saved on change.
  const [bufferLocal, setBufferLocal] = useState<string>("");

  useEffect(() => {
    if (!org || !tournamentSlug) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);

      const { data: t, error: tErr } = await supabase
        .from("tournaments")
        .select("*, locations(court_count)")
        .eq("organization_id", org.id)
        .eq("slug", tournamentSlug)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (tErr) {
        setError(tErr.message);
        setLoading(false);
        return;
      }
      if (!t) {
        setError("Tournament not found.");
        setLoading(false);
        return;
      }
      setTournament(t);
      // Seed the anchor input from the tournament's start once on
      // first load. Re-seeds on subsequent reloads only if the
      // organizer hasn't typed a different value yet.
      setAnchorLocal((prev) => prev || toLocalInput(t.starts_at));
      setBufferLocal((prev) => prev || String(t.inter_event_buffer_minutes));

      const [evRes, courtsRes, regsRes] = await Promise.all([
        supabase
          .from("events")
          .select("*")
          .eq("tournament_id", t.id)
          .is("deleted_at", null)
          .order("created_at", { ascending: true }),
        supabase
          .from("event_courts")
          .select("*, events!inner(tournament_id)")
          .eq("events.tournament_id", t.id),
        // Spot-holding registrations only (paid / pending / promoted off the
        // waitlist) — a free waitlister isn't a team to schedule around.
        supabase
          .from("event_registrations")
          .select("event_id, player_id, status, partner_status, events!inner(tournament_id)")
          .eq("events.tournament_id", t.id)
          .in("status", SPOT_HOLDING_STATUSES)
          .is("deleted_at", null),
      ]);
      if (cancelled) return;
      if (evRes.error) {
        setError(evRes.error.message);
        setLoading(false);
        return;
      }
      if (courtsRes.error) {
        setError(courtsRes.error.message);
        setLoading(false);
        return;
      }
      if (regsRes.error) {
        setError(regsRes.error.message);
        setLoading(false);
        return;
      }

      setEvents(sortEvents((evRes.data ?? []) as Event[]));
      setEventCourts((courtsRes.data ?? []) as unknown as EventCourt[]);

      // Count registrations per event so the schedule reflects the
      // *actual* registered team count, not just the max-teams config.
      // Also track which players are in which events so we can flag
      // a player registered in two events scheduled at the same time.
      const counts = new Map<string, number>();
      const players = new Map<string, Set<string>>();
      type RegRow = {
        event_id: string;
        player_id: string;
        status: Database["public"]["Enums"]["registration_status"];
        partner_status: Database["public"]["Enums"]["partner_status"];
      };
      const regsByEvent = new Map<string, RegRow[]>();
      for (const r of (regsRes.data ?? []) as unknown as RegRow[]) {
        const list = regsByEvent.get(r.event_id) ?? [];
        list.push(r);
        regsByEvent.set(r.event_id, list);
        const set = players.get(r.event_id) ?? new Set<string>();
        set.add(r.player_id);
        players.set(r.event_id, set);
      }
      // Teams, not registrations: a confirmed pair is one team; a seeker is
      // a team still forming (same count the roster + capacity check use).
      for (const ev of evRes.data ?? []) {
        counts.set(ev.id, teamCountFor(ev.format, regsByEvent.get(ev.id) ?? []));
      }
      setTeamsByEvent(counts);
      setPlayersByEvent(players);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [org, tournamentSlug]);

  const rows: EventRow[] = useMemo(() => {
    const courtsByEvent = new Map<string, number[]>();
    for (const ec of eventCourts) {
      const arr = courtsByEvent.get(ec.event_id) ?? [];
      arr.push(ec.court_number);
      courtsByEvent.set(ec.event_id, arr);
    }
    return events.map((event) => {
      const teamCount = teamsByEvent.get(event.id) ?? 0;
      const courtNumbers = (courtsByEvent.get(event.id) ?? []).sort(
        (a, b) => a - b,
      );
      // Fall back to 1 court when an event hasn't claimed any — the
      // estimate still renders, just pessimistically.
      const courts = Math.max(1, courtNumbers.length);
      // One adapter for every view (schedule table, calendar, tournament
      // event cards) so they can never disagree on an end time.
      const estimate = estimateEvent(event, teamCount, courts);
      const { teamsPerPool, pool, medal, totalMinutes } = estimate;
      const planTeams = teamCount >= 2 ? teamCount : Math.max(2, event.max_teams ?? 2);
      const venueCourts = tournament?.locations?.court_count ?? courts;
      const courtsNeeded = Math.min(Math.max(1, venueCourts), poolCourtsNeeded(planTeams, event.pool_count));
      const medalNeed = Math.min(Math.max(1, venueCourts), medalCourtsNeeded(event.teams_advancing_to_playoff));
      const scheduledStart = event.scheduled_start_at
        ? new Date(event.scheduled_start_at)
        : null;
      const scheduledEnd = scheduledStart
        ? new Date(scheduledStart.getTime() + totalMinutes * 60_000)
        : null;
      const phases: RowPhase[] = [];
      if (scheduledStart) {
        const poolEnd = new Date(scheduledStart.getTime() + pool.totalMinutes * 60_000);
        const poolCourts = courtNumbers.slice(0, Math.max(1, Math.min(courtNumbers.length || 1, courtsNeeded)));
        phases.push({ kind: "pool", start: scheduledStart, end: poolEnd, courts: poolCourts.length ? poolCourts : [1] });
        if (medal && medal.totalMinutes > 0) {
          phases.push({ kind: "medal", start: poolEnd, end: scheduledEnd!, courts: (poolCourts.length ? poolCourts : [1]).slice(0, Math.max(1, medalNeed)) });
        }
      }
      return {
        event,
        teamCount,
        teamsPerPool,
        courts,
        courtNumbers,
        poolMinutes: pool.totalMinutes,
        medalMinutes: medal?.totalMinutes ?? 0,
        totalMinutes,
        poolBindingConstraint: pool.bindingConstraint,
        estimate,
        planTeams,
        courtsNeeded,
        medalCourtsNeeded: medalNeed,
        scheduledStart,
        scheduledEnd,
        phases,
      };
    });
  }, [events, eventCourts, teamsByEvent, tournament]);

  // The auto-schedule PLAN, recomputed live from order / anchor / buffer so
  // the page can say what parallelism it found before anything is written.
  const plan: Placement[] = useMemo(() => {
    const anchorIso = fromLocalInput(anchorLocal);
    const venueCourts = tournament?.locations?.court_count ?? 0;
    if (!anchorIso || venueCourts < 1 || rows.length === 0) return [];
    const bufferMs = Math.max(0, parseInt(bufferLocal || "0", 10) || 0) * 60_000;
    return packSchedule(
      rows.map((r, i) => ({
        id: r.event.id,
        order: i,
        segments: [
          { kind: "pool" as const, minutes: r.poolMinutes, courtsNeeded: r.courtsNeeded },
          ...(r.medalMinutes > 0 ? [{ kind: "medal" as const, minutes: r.medalMinutes, courtsNeeded: r.medalCourtsNeeded }] : []),
        ],
        players: playersByEvent.get(r.event.id) ?? new Set<string>(),
      })),
      new Date(anchorIso).getTime(),
      bufferMs,
      venueCourts,
    );
  }, [rows, anchorLocal, bufferLocal, tournament, playersByEvent]);
  const planSpanMinutes = plan.length
    ? Math.round((Math.max(...plan.map((p) => p.endMs)) - Math.min(...plan.map((p) => p.startMs))) / 60_000)
    : 0;
  const planGroups = useMemo(() => parallelGroups(plan), [plan]);
  const [confirmAuto, setConfirmAuto] = useState(false);
  // "Moved 3 later events" after a manual start-time change cascaded.
  const [cascadeNote, setCascadeNote] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const locked = !!tournament?.schedule_locked_at;
  // Everything that edits the schedule is off while busy OR locked.
  const frozen = busy || locked;
  // Drag-to-reorder (HTML5 DnD; ▲▼ stay for keyboard + touch).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // Per-row inline save errors (courts / pools / playoff edits).
  const [rowErr, setRowErr] = useState<Record<string, string>>({});

  // Per-row "Details" disclosure — the estimator breakdown that used to live
  // on the retired stand-alone RR estimator tool.
  const [openDetails, setOpenDetails] = useState<Set<string>>(new Set());
  const toggleDetails = (id: string) =>
    setOpenDetails((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const overlaps = useMemo<Overlap[]>(() => {
    const list: Overlap[] = [];
    const scheduled = rows.filter(
      (r) => r.scheduledStart !== null && r.scheduledEnd !== null,
    );
    for (let i = 0; i < scheduled.length; i++) {
      for (let j = i + 1; j < scheduled.length; j++) {
        const a = scheduled[i];
        const b = scheduled[j];
        const aStart = a.scheduledStart!.getTime();
        const aEnd = a.scheduledEnd!.getTime();
        const bStart = b.scheduledStart!.getTime();
        const bEnd = b.scheduledEnd!.getTime();
        // Half-open intervals — events that touch end-to-start aren't
        // a conflict (one ends exactly when the other begins).
        const overlapStart = Math.max(aStart, bStart);
        const overlapEnd = Math.min(aEnd, bEnd);
        if (overlapStart >= overlapEnd) continue;

        // Court overlap — per PHASE, so a bracket running on 2 courts only
        // collides with the next event on those 2 courts, not the whole slice.
        const courtHits = new Map<number, { start: number; end: number }>();
        for (const pa of a.phases) {
          for (const pb of b.phases) {
            const ws = Math.max(pa.start.getTime(), pb.start.getTime());
            const we = Math.min(pa.end.getTime(), pb.end.getTime());
            if (ws >= we) continue;
            const set = new Set(pa.courts);
            for (const c of pb.courts) {
              if (!set.has(c)) continue;
              const prev = courtHits.get(c);
              courtHits.set(c, prev ? { start: Math.min(prev.start, ws), end: Math.max(prev.end, we) } : { start: ws, end: we });
            }
          }
        }
        if (courtHits.size > 0) {
          const courts = Array.from(courtHits.keys()).sort((x, y) => x - y);
          const ws = Math.min(...Array.from(courtHits.values()).map((w) => w.start));
          const we = Math.max(...Array.from(courtHits.values()).map((w) => w.end));
          list.push({
            type: "court",
            a,
            b,
            courts,
            windowStart: new Date(ws),
            windowEnd: new Date(we),
          });
        }

        // Player overlap — count players appearing in both events.
        const aPlayers = playersByEvent.get(a.event.id);
        const bPlayers = playersByEvent.get(b.event.id);
        if (aPlayers && bPlayers) {
          let shared = 0;
          for (const id of aPlayers) if (bPlayers.has(id)) shared++;
          if (shared > 0) {
            list.push({
              type: "player",
              a,
              b,
              sharedPlayerCount: shared,
              windowStart: new Date(overlapStart),
              windowEnd: new Date(overlapEnd),
            });
          }
        }
      }
    }
    return list;
  }, [rows, playersByEvent]);

  // Per-event lookup so the table can render badges on affected rows.
  const overlapsByEventId = useMemo(() => {
    const m = new Map<string, Overlap[]>();
    for (const o of overlaps) {
      for (const id of [o.a.event.id, o.b.event.id]) {
        const arr = m.get(id) ?? [];
        arr.push(o);
        m.set(id, arr);
      }
    }
    return m;
  }, [overlaps]);

  // Tournament time: the real span once every event has a start; until
  // then, the span the auto-schedule plan would produce.
  const tournamentTotalMinutes = useMemo(() => {
    if (rows.length === 0) return 0;
    if (rows.every((r) => r.scheduledStart && r.scheduledEnd)) {
      const start = Math.min(...rows.map((r) => r.scheduledStart!.getTime()));
      const end = Math.max(...rows.map((r) => r.scheduledEnd!.getTime()));
      return Math.round((end - start) / 60_000);
    }
    return planSpanMinutes;
  }, [rows, planSpanMinutes]);

  // ─── Schedule mutations ────────────────────────────────────────────
  // Optimistic local-state updates keep the UI snappy without a full
  // reload of all the joined data each click.

  const updateLocalEventScheduled = (
    eventId: string,
    iso: string | null,
  ) => {
    setEvents((prev) =>
      prev.map((e) =>
        e.id === eventId ? { ...e, scheduled_start_at: iso } : e,
      ),
    );
  };

  // Auto-schedule: walk events in the organizer's order and give each the
  // earliest start where the courts it actually needs fit alongside what's
  // already running (and no player is double-booked). Writes the start
  // times AND each event's court slice (event_courts) so the calendar,
  // the conflicts panel and day-of dispatch all agree.
  const onAutoSchedule = async () => {
    setConfirmAuto(false);
    setError(null);
    if (plan.length === 0) {
      setError("Pick a start date/time first.");
      return;
    }
    setBusy(true);
    const ids = plan.map((p) => p.id);
    const startResults = await Promise.all(
      plan.map((p) =>
        supabase
          .from("events")
          .update({ scheduled_start_at: new Date(p.startMs).toISOString() })
          .eq("id", p.id),
      ),
    );
    const firstErr = startResults.find((r) => r.error)?.error;
    if (firstErr) {
      setError(firstErr.message);
      setBusy(false);
      return;
    }
    // Replace court allocations with the packed slices.
    const { error: delErr } = await supabase.from("event_courts").delete().in("event_id", ids);
    if (delErr) {
      setError(`Start times saved, but couldn't reset court allocations: ${delErr.message}`);
      setBusy(false);
      return;
    }
    const courtRows = plan.flatMap((p) => p.courts.map((c) => ({ event_id: p.id, court_number: c })));
    const { error: insErr } = await supabase.from("event_courts").insert(courtRows);
    if (insErr) {
      setError(`Start times saved, but couldn't assign courts: ${insErr.message}`);
      setBusy(false);
      return;
    }
    setEvents((prev) =>
      prev.map((e) => {
        const p = plan.find((x) => x.id === e.id);
        return p ? { ...e, scheduled_start_at: new Date(p.startMs).toISOString() } : e;
      }),
    );
    setEventCourts((prev) => [
      ...prev.filter((ec) => !ids.includes(ec.event_id)),
      ...(courtRows.map((r) => ({ ...r, created_at: new Date().toISOString() })) as EventCourt[]),
    ]);
    setBusy(false);
  };

  // Reorder: put `eventId` at index `toIdx`; every event in the tournament
  // gets a dense 1..n order so the result is unambiguous. Used by ▲▼ and by
  // drag-and-drop. Optimistic — the plan panel recalculates instantly.
  const reorderTo = async (eventId: string, toIdx: number) => {
    const idx = events.findIndex((e) => e.id === eventId);
    if (idx < 0 || toIdx < 0 || toIdx >= events.length || toIdx === idx) return;
    const next = [...events];
    const [moved] = next.splice(idx, 1);
    next.splice(toIdx, 0, moved);
    const renumbered = next.map((e, i) => ({ ...e, schedule_order: i + 1 }));
    setEvents(renumbered);
    setError(null);
    const results = await Promise.all(
      renumbered.map((e) =>
        untyped.from("events").update({ schedule_order: e.schedule_order }).eq("id", e.id),
      ),
    );
    const firstErr = results.find((r) => r.error)?.error;
    if (firstErr) setError(`Order saved locally but not on the server: ${firstErr.message}`);
  };
  const onMove = (eventId: string, dir: -1 | 1) => {
    const idx = events.findIndex((e) => e.id === eventId);
    return reorderTo(eventId, idx + dir);
  };

  // Inline setup edits — the same columns Edit event writes, saved one field
  // at a time with optimistic local state (the estimate + plan recompute
  // from `events` immediately) and rollback on failure.
  type SetupPatch = Partial<
    Pick<Event, "pool_count" | "play_each_team_times" | "teams_advancing_to_playoff" | "playoff_rounds"> & {
      playoff_seeding: "overall" | "cross_pool";
    }
  >;
  const onPatchEvent = async (eventId: string, patch: SetupPatch) => {
    const before = events.find((e) => e.id === eventId);
    if (!before) return;
    setRowErr((m) => ({ ...m, [eventId]: "" }));
    setEvents((prev) => prev.map((e) => (e.id === eventId ? { ...e, ...patch } : e)));
    // playoff_seeding is newer than the generated types → untyped write.
    const { error: updErr } = await untyped.from("events").update(patch).eq("id", eventId);
    if (updErr) {
      setEvents((prev) => prev.map((e) => (e.id === eventId ? before : e)));
      setRowErr((m) => ({ ...m, [eventId]: `Couldn't save: ${updErr.message}` }));
    }
  };

  // Toggle one court for an event (mirrors the tournament page's pills).
  const onToggleCourt = async (eventId: string, court: number) => {
    const has = eventCourts.some((ec) => ec.event_id === eventId && ec.court_number === court);
    setRowErr((m) => ({ ...m, [eventId]: "" }));
    if (has) {
      setEventCourts((prev) => prev.filter((ec) => !(ec.event_id === eventId && ec.court_number === court)));
      const { error: delErr } = await supabase
        .from("event_courts")
        .delete()
        .eq("event_id", eventId)
        .eq("court_number", court);
      if (delErr) {
        setEventCourts((prev) => [
          ...prev,
          { event_id: eventId, court_number: court, created_at: new Date().toISOString() } as EventCourt,
        ]);
        setRowErr((m) => ({ ...m, [eventId]: `Couldn't release court ${court}: ${delErr.message}` }));
      }
    } else {
      const optimistic = { event_id: eventId, court_number: court, created_at: new Date().toISOString() } as EventCourt;
      setEventCourts((prev) => [...prev, optimistic]);
      const { error: insErr } = await supabase
        .from("event_courts")
        .insert({ event_id: eventId, court_number: court });
      if (insErr) {
        setEventCourts((prev) => prev.filter((ec) => ec !== optimistic));
        setRowErr((m) => ({ ...m, [eventId]: `Couldn't assign court ${court}: ${insErr.message}` }));
      }
    }
  };

  const onClearSchedule = async () => {
    setError(null);
    if (rows.length === 0) return;
    setBusy(true);
    const { error: updErr } = await supabase
      .from("events")
      .update({ scheduled_start_at: null })
      .in(
        "id",
        rows.map((r) => r.event.id),
      );
    if (updErr) {
      setError(updErr.message);
      setBusy(false);
      return;
    }
    setEvents((prev) => prev.map((e) => ({ ...e, scheduled_start_at: null })));
    setBusy(false);
  };

  // Persist the buffer onto the tournament row. Called on input blur
  // (rather than every keystroke) so we don't hammer the DB while
  // typing.
  const onSaveBuffer = async () => {
    if (!tournament) return;
    const value = Math.max(0, Math.min(240, parseInt(bufferLocal || "0", 10) || 0));
    if (value === tournament.inter_event_buffer_minutes) return;
    setError(null);
    const { error: updErr } = await supabase
      .from("tournaments")
      .update({ inter_event_buffer_minutes: value })
      .eq("id", tournament.id);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    setTournament({ ...tournament, inter_event_buffer_minutes: value });
    setBufferLocal(String(value));
  };

  const onToggleLock = async () => {
    if (!tournament) return;
    setError(null);
    const next = locked ? null : new Date().toISOString();
    const { error: updErr } = await untyped
      .from("tournaments")
      .update({ schedule_locked_at: next })
      .eq("id", tournament.id);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    setTournament({ ...tournament, schedule_locked_at: next });
  };

  // A row as a fixed placement for the cascade (its phases → segments).
  const placementFor = (r: EventRow, startMs: number): Placement => {
    const poolCourts = r.courtNumbers.slice(0, Math.max(1, Math.min(r.courtNumbers.length || 1, r.courtsNeeded)));
    const pc = poolCourts.length ? poolCourts : [1];
    const poolEnd = startMs + r.poolMinutes * 60_000;
    const segments: PlacedSegment[] = [{ kind: "pool", startMs, endMs: poolEnd, courts: pc }];
    if (r.medalMinutes > 0) {
      segments.push({ kind: "medal" as const, startMs: poolEnd, endMs: poolEnd + r.medalMinutes * 60_000, courts: pc.slice(0, Math.max(1, r.medalCourtsNeeded)) });
    }
    return { id: r.event.id, startMs, endMs: startMs + r.totalMinutes * 60_000, courts: r.courtNumbers, segments, heldBy: null };
  };

  // Manual start change. Then CASCADE: every event after this one in run
  // order is re-placed with the same rules as Auto-schedule, treating this
  // event and everything before it as fixed. Events that fit alongside stay
  // alongside; the next non-concurrent one follows at end + buffer.
  const onSetEventStart = async (eventId: string, localValue: string) => {
    setError(null);
    setCascadeNote(null);
    const iso = localValue ? fromLocalInput(localValue) : null;
    const { error: updErr } = await supabase
      .from("events")
      .update({ scheduled_start_at: iso })
      .eq("id", eventId);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    updateLocalEventScheduled(eventId, iso);
    if (!iso || locked) return;

    const idx = rows.findIndex((r) => r.event.id === eventId);
    const later = rows.slice(idx + 1);
    const venueCourts = tournament?.locations?.court_count ?? 0;
    if (idx < 0 || later.length === 0 || venueCourts < 1) return;
    const newStartMs = new Date(iso).getTime();
    const fixed: Placement[] = [];
    const fixedPlayers = new Map<string, ReadonlySet<string>>();
    rows.slice(0, idx + 1).forEach((r) => {
      const startMs = r.event.id === eventId ? newStartMs : r.scheduledStart?.getTime();
      if (startMs == null) return;
      fixed.push(placementFor(r, startMs));
      fixedPlayers.set(r.event.id, playersByEvent.get(r.event.id) ?? new Set<string>());
    });
    const bufferMs = Math.max(0, parseInt(bufferLocal || "0", 10) || 0) * 60_000;
    const moved = packSchedule(
      later.map((r, i) => ({
        id: r.event.id,
        order: i,
        segments: [
          { kind: "pool" as const, minutes: r.poolMinutes, courtsNeeded: r.courtsNeeded },
          ...(r.medalMinutes > 0 ? [{ kind: "medal" as const, minutes: r.medalMinutes, courtsNeeded: r.medalCourtsNeeded }] : []),
        ],
        players: playersByEvent.get(r.event.id) ?? new Set<string>(),
      })),
      newStartMs,
      bufferMs,
      venueCourts,
      fixed,
      fixedPlayers,
    );
    const changed = moved.filter((p) => {
      const r = later.find((x) => x.event.id === p.id);
      return !r?.scheduledStart || r.scheduledStart.getTime() !== p.startMs || fmtCourtRange(r.courtNumbers) !== fmtCourtRange(p.courts);
    });
    if (changed.length === 0) return;
    setBusy(true);
    const results = await Promise.all(
      changed.map((p) => supabase.from("events").update({ scheduled_start_at: new Date(p.startMs).toISOString() }).eq("id", p.id)),
    );
    const firstErr = results.find((r) => r.error)?.error;
    if (firstErr) {
      setError(`Start saved, but later events couldn't be moved: ${firstErr.message}`);
      setBusy(false);
      return;
    }
    const ids = changed.map((p) => p.id);
    const { error: delErr } = await supabase.from("event_courts").delete().in("event_id", ids);
    const courtRows = changed.flatMap((p) => p.courts.map((c) => ({ event_id: p.id, court_number: c })));
    const { error: insErr } = delErr ? { error: delErr } : await supabase.from("event_courts").insert(courtRows);
    setEvents((prev) =>
      prev.map((e) => {
        const p = changed.find((x) => x.id === e.id);
        return p ? { ...e, scheduled_start_at: new Date(p.startMs).toISOString() } : e;
      }),
    );
    if (!insErr) {
      setEventCourts((prev) => [
        ...prev.filter((ec) => !ids.includes(ec.event_id)),
        ...(courtRows.map((r) => ({ ...r, created_at: new Date().toISOString() })) as EventCourt[]),
      ]);
    } else {
      setError(`Later events moved, but their courts couldn't be updated: ${insErr.message}`);
    }
    setCascadeNote(
      `Moved ${changed.length} later event${changed.length === 1 ? "" : "s"}: ${changed
        .map((p) => `${later.find((x) => x.event.id === p.id)?.event.name ?? p.id} → ${fmtTime(new Date(p.startMs))}`)
        .join(", ")}.`,
    );
    setBusy(false);
  };

  if (!org) return null;
  if (loading)
    return <div style={{ color: inkMuted, fontSize: 14 }}>Loading…</div>;
  if (error) {
    return (
      <div
        style={{
          padding: 12,
          background: dangerBg,
          border: `1px solid ${courtRed}`,
          borderRadius: 6,
          color: dangerFg,
          fontSize: 13,
        }}
      >
        {error}
      </div>
    );
  }
  if (!tournament) return null;

  const courtCount = tournament.locations?.court_count ?? null;
  if (courtCount == null || courtCount < 1) {
    return (
      <NoCourtCountNotice
        orgSlug={org.slug}
        tournamentSlug={tournament.slug}
        hasVenue={tournament.location_id != null}
      />
    );
  }

  const totalSequentialMinutes = rows.reduce(
    (sum, r) => sum + r.totalMinutes,
    0,
  );

  return (
    <div>
      <Link
        to={`/admin/${org.slug}/tournaments/${tournament.slug}`}
        style={{ color: courtBlue, textDecoration: "none", fontSize: 13 }}
      >
        ← {tournament.name}
      </Link>
      <h1 style={{ margin: "12px 0 4px", fontSize: 22, fontFamily: headingFontStack, textTransform: "uppercase", letterSpacing: "0.04em" }}>Schedule</h1>
      <p style={{ color: inkMuted, margin: 0, fontSize: 13 }}>
        Time estimates per event based on registered teams, court allocation,
        and the format / scoring settings on each event. Numbers update as
        teams register and as you edit event settings.
      </p>

      {/* Auto-schedule controls — visible whenever there are events
          to schedule, so the user can lay out a daily plan from a
          start anchor in one click. */}
      {rows.length > 0 && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: bg,
            border: `1px solid ${rule}`,
            borderRadius: 6,
            display: "flex",
            gap: 12,
            alignItems: "end",
            flexWrap: "wrap",
          }}
        >
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              fontSize: 12,
              color: inkSoft,
            }}
          >
            <span>Tournament start</span>
            <input
              type="datetime-local"
              value={anchorLocal}
              onChange={(e) => setAnchorLocal(e.target.value)}
              style={{
                padding: "6px 10px",
                border: `1px solid ${rule}`,
                borderRadius: 6,
                fontSize: 13,
                fontFamily: bodyFontStack,
              }}
            />
          </label>
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              fontSize: 12,
              color: inkSoft,
            }}
            title="Inserted between consecutive events on the same court (turnover, announcements, etc.). Not added within a single event's pool play."
          >
            <span>Buffer between events (min)</span>
            <input
              type="number"
              min={0}
              max={240}
              value={bufferLocal}
              onChange={(e) => setBufferLocal(e.target.value)}
              onBlur={() => void onSaveBuffer()}
              style={{
                padding: "6px 10px",
                border: `1px solid ${rule}`,
                borderRadius: 6,
                fontSize: 13,
                fontFamily: bodyFontStack,
                width: 90,
              }}
            />
          </label>
          <button
            onClick={() => setConfirmAuto(true)}
            disabled={frozen || !anchorLocal}
            style={{
              padding: "8px 16px",
              background: busy || !anchorLocal ? inkMuted : courtBlue,
              color: "#ffffff",
              border: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              cursor: busy || !anchorLocal ? "not-allowed" : "pointer",
              fontFamily: bodyFontStack,
            }}
            title="Walks events in the order below. Events run side by side when the courts they actually need fit; otherwise the next one follows after the buffer. Replaces court allocations with each event's slice."
          >
            {busy ? "Scheduling…" : "Auto-schedule"}
          </button>
          <button
            onClick={onClearSchedule}
            disabled={frozen || !rows.some((r) => r.scheduledStart)}
            style={{
              padding: "8px 16px",
              background: "#ffffff",
              color: inkSoft,
              border: `1px solid ${rule}`,
              borderRadius: 6,
              fontSize: 13,
              cursor:
                busy || !rows.some((r) => r.scheduledStart)
                  ? "not-allowed"
                  : "pointer",
              fontFamily: bodyFontStack,
              opacity:
                busy || !rows.some((r) => r.scheduledStart) ? 0.6 : 1,
            }}
          >
            Clear schedule
          </button>
          <button
            onClick={() => void onToggleLock()}
            disabled={busy}
            style={{
              padding: "8px 16px",
              background: locked ? warnBg : "#ffffff",
              color: locked ? warnFg : inkSoft,
              border: `1px solid ${locked ? warnFg : rule}`,
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: busy ? "not-allowed" : "pointer",
              fontFamily: bodyFontStack,
            }}
            title={locked ? "Unlock to change start times, order, courts or setup." : "Freeze the schedule so nothing moves on game day."}
          >
            {locked ? "🔒 Unlock schedule" : "🔓 Lock schedule"}
          </button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: inkMuted }}>
            You can also edit any event's start time directly in the
            table below.
          </span>
        </div>
      )}

      {locked && tournament.schedule_locked_at && (
        <div
          role="status"
          style={{ marginTop: 12, padding: "10px 12px", background: warnBg, border: `1px solid ${warnFg}`, borderRadius: 6, fontSize: 13, color: warnFg, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
        >
          <span>
            <strong>Schedule locked</strong> {fmtDayHeading(new Date(tournament.schedule_locked_at))} at {fmtTime(new Date(tournament.schedule_locked_at))}. Start times, order, courts and setup can't change until you unlock.
          </span>
          <button onClick={() => void onToggleLock()} disabled={busy} style={{ ...detailsBtnStyle, color: warnFg, borderColor: warnFg, minHeight: 36 }}>
            Unlock
          </button>
        </div>
      )}
      {cascadeNote && !locked && (
        <div role="status" style={{ marginTop: 12, padding: "8px 12px", background: cream, border: `1px solid ${rule}`, borderRadius: 6, fontSize: 12, color: inkSoft }}>
          {cascadeNote}
        </div>
      )}

      {plan.length > 0 && !locked && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 12px",
            background: cream,
            border: `1px solid ${creamDeep}`,
            borderRadius: 6,
            fontSize: 12,
            color: inkSoft,
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: ink }}>Auto-schedule plan</strong> — {fmtDuration(planSpanMinutes)} from{" "}
          {fmtTime(new Date(plan[0].startMs))}, in the order below, using the courts each event can actually keep busy.
          <ol style={{ margin: "6px 0 0", paddingLeft: 20 }}>
            {rows.map((r) => {
              const p = plan.find((x) => x.id === r.event.id);
              if (!p) return null;
              const alongside = plan.filter((q) => q.id !== p.id && q.startMs < p.endMs && q.endMs > p.startMs);
              const reason = planReason(p, rows);
              return (
                <li key={p.id} style={{ marginBottom: 2 }}>
                  <strong style={{ color: ink }}>{fmtTime(new Date(p.startMs))}</strong> {r.event.name}
                  <span style={{ color: inkMuted }}>
                    {p.segments.map((g) => (
                      <span key={g.kind}>
                        {" "}· {g.kind === "pool" ? "pool" : "medal"} {fmtTime(new Date(g.startMs))}–{fmtTime(new Date(g.endMs))} courts {fmtCourtRange(g.courts)}
                      </span>
                    ))}
                    {alongside.length > 0 && (
                      <> · alongside {alongside.map((q) => rows.find((x) => x.event.id === q.id)?.event.name ?? q.id).join(", ")}</>
                    )}
                  </span>
                  {reason && (
                    <span style={{ marginLeft: 6, padding: "1px 6px", background: warnBg, color: warnFg, borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
                      {reason}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          {planGroups.length === 0 && (
            <div style={{ marginTop: 4 }}>No two events fit side by side with {tournament.locations?.court_count} courts and these players — they run one after another.</div>
          )}
        </div>
      )}

      {confirmAuto && (
        <ConfirmModal
          title="Auto-schedule these events?"
          destructive={false}
          confirmLabel="Auto-schedule"
          onCancel={() => setConfirmAuto(false)}
          onConfirm={onAutoSchedule}
          body={
            <div style={{ fontSize: 13, color: inkSoft, lineHeight: 1.6 }}>
              <p style={{ margin: "0 0 8px" }}>
                Sets a start time for all {plan.length} events in the order shown, running events side by side where their courts fit ({fmtDuration(planSpanMinutes)} total).
              </p>
              <p style={{ margin: 0 }}>
                <strong style={{ color: ink }}>Court allocations will be replaced</strong> with each event's slice for its window (e.g. courts 1–4 for one event, 5–8 for the other). You can still adjust courts on the tournament page afterwards.
              </p>
            </div>
          }
        />
      )}

      {rows.length === 0 ? (
        <Empty>No events yet. Add one to start scheduling.</Empty>
      ) : (
        <>
        <div className="no-print">
          <button
            onClick={() => setPrinting(true)}
            style={{
              marginTop: 16,
              padding: "8px 16px",
              background: "#ffffff",
              color: courtBlue,
              border: `1px solid ${courtBlue}`,
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: bodyFontStack,
            }}
          >
            Print schedule
          </button>
          {/* Stats strip */}
          <div
            style={{
              marginTop: 24,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            <Stat
              label="Events"
              value={String(rows.length)}
              sub={`${rows.filter((r) => r.teamCount > 0).length} with teams registered`}
            />
            <Stat
              label="Tournament time"
              value={fmtDuration(tournamentTotalMinutes)}
              sub={rows.every((r) => r.scheduledStart) ? "First start to last end of the current schedule." : "If auto-scheduled now — events run side by side where the courts they need fit."}
              emphasize
            />
            <Stat
              label="If run end-to-end"
              value={fmtDuration(totalSequentialMinutes)}
              sub="Sum of all event durations, ignoring parallelism."
            />
          </div>

          {overlaps.length > 0 && (
            <ConflictsPanel overlaps={overlaps} />
          )}

          {/* View tabs — Table is editable, Calendar is read-only
              visual. URL-driven so refresh + back behave. */}
          <ViewTabs view={view} onChange={setView} />

          {view === "calendar" && (
            <CourtTimeline
              courtCount={courtCount}
              rows={rows}
            />
          )}

          {view === "table" && (
            <>
              {/* Per-event table */}
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
              marginTop: 24,
            }}
          >
            <thead>
              <tr
                style={{
                  background: bg,
                  borderBottom: `1px solid ${rule}`,
                }}
              >
                <th style={thStyle}>Event</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Teams</th>
                <th style={thStyle}>Courts</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Pool play</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Medal round</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Total</th>
                <th style={thStyle}>Start</th>
                <th style={thStyle}>End</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.event.id}>
                <tr
                  draggable={!frozen}
                  onDragStart={(e) => {
                    setDragId(r.event.id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", r.event.id);
                  }}
                  onDragOver={(e) => {
                    if (!dragId || dragId === r.event.id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragOverId !== r.event.id) setDragOverId(r.event.id);
                  }}
                  onDragLeave={() => {
                    if (dragOverId === r.event.id) setDragOverId(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = dragId ?? e.dataTransfer.getData("text/plain");
                    const toIdx = rows.findIndex((x) => x.event.id === r.event.id);
                    setDragId(null);
                    setDragOverId(null);
                    if (from && toIdx >= 0) void reorderTo(from, toIdx);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setDragOverId(null);
                  }}
                  style={{
                    borderBottom: openDetails.has(r.event.id) ? "none" : `1px solid ${ruleSoft}`,
                    boxShadow: dragOverId === r.event.id ? `inset 0 3px 0 ${courtBlue}` : undefined,
                    opacity: dragId === r.event.id ? 0.5 : 1,
                    background: dragOverId === r.event.id ? cream : undefined,
                  }}
                >
                  <td style={tdStyle}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      <span
                        aria-hidden
                        title="Drag to reorder"
                        style={{
                          cursor: frozen ? "default" : "grab",
                          color: inkMuted,
                          fontSize: 14,
                          lineHeight: 1,
                          padding: "8px 4px",
                          userSelect: "none",
                        }}
                      >
                        ⋮⋮
                      </span>
                      <Link
                        to={`/admin/${org.slug}/tournaments/${tournament.slug}/events/${r.event.id}`}
                        style={{
                          color: ink,
                          textDecoration: "none",
                          fontWeight: 500,
                        }}
                      >
                        {r.event.name}
                      </Link>
                      <RowConflictBadges
                        conflicts={overlapsByEventId.get(r.event.id) ?? []}
                        thisEventId={r.event.id}
                      />
                      <span style={{ display: "inline-flex", gap: 2 }}>
                        <button
                          type="button"
                          onClick={() => void onMove(r.event.id, -1)}
                          disabled={frozen || rows[0]?.event.id === r.event.id}
                          aria-label={`Move ${r.event.name} up`}
                          title="Move up (runs earlier)"
                          style={moveBtnStyle}
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          onClick={() => void onMove(r.event.id, 1)}
                          disabled={frozen || rows[rows.length - 1]?.event.id === r.event.id}
                          aria-label={`Move ${r.event.name} down`}
                          title="Move down (runs later)"
                          style={moveBtnStyle}
                        >
                          ▼
                        </button>
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleDetails(r.event.id)}
                        aria-expanded={openDetails.has(r.event.id)}
                        aria-controls={`estimate-${r.event.id}`}
                        style={detailsBtnStyle}
                      >
                        {openDetails.has(r.event.id) ? "Hide setup ▴" : "Details & setup ▾"}
                      </button>
                    </div>
                    <div
                      style={{ fontSize: 11, color: inkMuted, marginTop: 2 }}
                    >
                      {r.event.format} ·{" "}
                      {r.event.pool_count > 1
                        ? `${r.event.pool_count} pools of ${r.teamsPerPool}`
                        : "single pool"}
                      {r.event.play_each_team_times > 1
                        ? ` · play ${r.event.play_each_team_times}×`
                        : ""}{" "}
                      · {r.event.points_to_win} win by {r.event.win_by}
                      {r.event.teams_advancing_to_playoff > 0 ? (
                        <>
                          {" · "}
                          top {r.event.teams_advancing_to_playoff} (
                          {r.event.playoff_rounds} round
                          {r.event.playoff_rounds === 1 ? "" : "s"},{" "}
                          {r.event.medal_match_format === "best_of_3"
                            ? "best of 3"
                            : "1 game"}
                          )
                        </>
                      ) : (
                        " · no playoff"
                      )}
                    </div>
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: "right",
                      color: r.teamCount === 0 ? inkMuted : inkSoft,
                    }}
                  >
                    {r.teamCount}
                  </td>
                  <td
                    style={tdStyle}
                    title={
                      r.courtNumbers.length === 0
                        ? "No courts assigned — estimate uses 1 court (pessimistic). Allocate courts on the tournament page."
                        : undefined
                    }
                  >
                    <CourtPills
                      total={courtCount}
                      assigned={r.courtNumbers}
                      onToggle={frozen ? undefined : (c) => void onToggleCourt(r.event.id, c)}
                    />
                    <div
                      style={{ fontSize: 10, color: inkMuted, marginTop: 2 }}
                      title={`${r.event.pool_count} pool${r.event.pool_count === 1 ? "" : "s"} × floor(${r.teamsPerPool} teams ÷ 2) matches at once — the most courts this event can keep busy${r.teamCount < 2 ? " (planning on max teams)" : ""}.`}
                    >
                      needs {r.courtsNeeded} of {courtCount}
                      {r.medalCourtsNeeded > 0 ? ` · medal round ${r.medalCourtsNeeded}` : ""}
                    </div>
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: "right",
                      color: inkSoft,
                    }}
                  >
                    {r.teamCount < 2 ? "—" : fmtDuration(r.poolMinutes)}
                    {r.teamCount >= 2 &&
                      r.poolBindingConstraint === "team" && (
                        <div
                          style={{
                            fontSize: 10,
                            color: warnFg,
                            marginTop: 2,
                          }}
                          title="Team-bound: more courts than teams can fill simultaneously."
                        >
                          team-bound
                        </div>
                      )}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: "right",
                      color: inkSoft,
                    }}
                  >
                    {r.event.teams_advancing_to_playoff > 0
                      ? fmtDuration(r.medalMinutes)
                      : "—"}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: "right",
                      fontWeight: 600,
                      color: r.teamCount < 2 ? inkMuted : ink,
                    }}
                  >
                    {r.teamCount < 2 ? "—" : fmtDuration(r.totalMinutes)}
                  </td>
                  <td style={tdStyle}>
                    <input
                      type="datetime-local"
                      value={toLocalInput(r.event.scheduled_start_at)}
                      onChange={(e) =>
                        void onSetEventStart(r.event.id, e.target.value)
                      }
                      disabled={frozen}
                      style={{
                        padding: "4px 6px",
                        border: `1px solid ${rule}`,
                        borderRadius: 4,
                        fontSize: 12,
                        fontFamily: bodyFontStack,
                        background: "#ffffff",
                      }}
                    />
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      color: r.scheduledEnd ? inkSoft : inkMuted,
                    }}
                  >
                    {r.scheduledEnd ? fmtTime(r.scheduledEnd) : "—"}
                  </td>
                </tr>
                {openDetails.has(r.event.id) && (
                  <tr style={{ borderBottom: `1px solid ${ruleSoft}` }}>
                    <td colSpan={8} style={{ padding: "0 12px 12px" }}>
                      {(() => {
                        const p = plan.find((x) => x.id === r.event.id);
                        const reason = p ? planReason(p, rows) : null;
                        return reason ? (
                          <div style={{ margin: "8px 0", fontSize: 12, color: warnFg }}>
                            In the auto-schedule plan this event {reason}.
                          </div>
                        ) : null;
                      })()}
                      <SetupPanel
                        row={r}
                        courtCount={courtCount}
                        busy={frozen}
                        error={rowErr[r.event.id] ?? ""}
                        onPatch={(patch) => void onPatchEvent(r.event.id, patch)}
                        onToggleCourt={(c) => void onToggleCourt(r.event.id, c)}
                      />
                      {r.teamCount >= 2 ? (
                        <EstimateDetails id={`estimate-${r.event.id}`} row={r} />
                      ) : (
                        <div id={`estimate-${r.event.id}`} style={{ fontSize: 12, color: inkMuted, padding: "8px 0 0" }}>
                          Fewer than 2 teams registered — the plan uses Max teams ({r.planTeams}) for this event until teams sign up.
                        </div>
                      )}
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>

          <div
            style={{
              marginTop: 16,
              padding: 12,
              background: bg,
              border: `1px solid ${rule}`,
              borderRadius: 6,
              fontSize: 12,
              color: inkSoft,
              lineHeight: 1.6,
            }}
          >
            <strong>How auto-schedule works.</strong> Events run in the
            order shown (drag the ⋮⋮ handle, or use ▲▼). Each event needs only the courts it can
            keep busy — a pool of 5 teams plays 2 matches at once, so two
            5-team pools need 4 courts, not 8. Events whose needs fit within
            the venue run side by side; the next one otherwise starts after
            the previous ends plus the buffer. A player in two events is
            never double-booked. The medal round is its own phase on fewer
            courts (one per medal match), so the next event can start on the
            courts pool play released while a bracket finishes. Auto-schedule
            also gives each event its own slice of court numbers.
          </div>
            </>
          )}
        </div>
        </>
      )}
      {printing && (
        <SchedulePrintModal
          tournamentName={tournament.name}
          startsAt={tournament.starts_at}
          endsAt={tournament.ends_at}
          venueName={tournament.location_name ?? null}
          courtCount={courtCount}
          rows={rows.map((r) => ({
            id: r.event.id,
            name: r.event.name,
            formatLine: `${r.event.format} · ${r.event.pool_count > 1 ? `${r.event.pool_count} pools of ${r.teamsPerPool}` : "single pool"}${r.event.play_each_team_times > 1 ? ` · play ${r.event.play_each_team_times}×` : ""} · ${r.event.points_to_win} win by ${r.event.win_by}${r.event.teams_advancing_to_playoff > 0 ? ` · top ${r.event.teams_advancing_to_playoff}` : ""}`,
            teamCount: r.teamCount,
            totalMinutes: r.totalMinutes,
            start: r.scheduledStart,
            end: r.scheduledEnd,
            courtNumbers: r.courtNumbers,
            phases: r.phases,
          }))}
          onClose={() => setPrinting(false)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// UI bits
// ─────────────────────────────────────────────────────────────────────

// Compact court chips mirroring the tournament-homepage event-card
// look: one pill per court (1..total). Assigned courts render
// solid-blue; unassigned render outlined-gray. Numbers-only so the
// row stays compact even at 16 courts.
// Court pills. With `onToggle` they're buttons that assign / release a
// court for the event right here (same write as the tournament page).
function CourtPills({
  total,
  assigned,
  onToggle,
}: {
  total: number;
  assigned: number[];
  onToggle?: (court: number) => void;
}) {
  const claimed = new Set(assigned);
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
      }}
      role={onToggle ? "group" : undefined}
      aria-label={onToggle ? "Courts for this event — click to toggle" : undefined}
    >
      {Array.from({ length: total }, (_, i) => i + 1).map((n) => {
        const mine = claimed.has(n);
        const style: CSSProperties = {
          minWidth: onToggle ? 32 : 22,
          minHeight: onToggle ? 32 : undefined,
          padding: "2px 6px",
          background: mine ? courtBlue : "#ffffff",
          color: mine ? "#ffffff" : inkMuted,
          border: `1px solid ${mine ? courtBlue : rule}`,
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 500,
          textAlign: "center",
          lineHeight: 1.4,
          fontFamily: bodyFontStack,
          cursor: onToggle ? "pointer" : undefined,
        };
        return onToggle ? (
          <button
            key={n}
            type="button"
            aria-pressed={mine}
            title={mine ? `Release court ${n}` : `Assign court ${n}`}
            onClick={() => onToggle(n)}
            style={style}
          >
            {n}
          </button>
        ) : (
          <span key={n} style={style}>
            {n}
          </span>
        );
      })}
    </div>
  );
}

// Inline event setup — courts, pools, playoff — with the same rules as Edit
// event (multi-pool from 8 teams, smallest pool ≥ 4; 2-round playoffs are
// top-4 only; single-round needs an even Top-N). Saves per field.
function SetupPanel({
  row,
  courtCount,
  busy,
  error,
  onPatch,
  onToggleCourt,
}: {
  row: EventRow;
  courtCount: number;
  busy: boolean;
  error: string;
  onPatch: (
    patch: Partial<
      Pick<Event, "pool_count" | "play_each_team_times" | "teams_advancing_to_playoff" | "playoff_rounds"> & {
        playoff_seeding: "overall" | "cross_pool";
      }
    >,
  ) => void;
  onToggleCourt: (court: number) => void;
}) {
  const { event } = row;
  const teams = row.planTeams;
  const maxPools = teams >= 8 ? Math.max(1, Math.floor(teams / 4)) : 1;
  const poolOptions = Array.from({ length: Math.max(maxPools, event.pool_count) }, (_, i) => i + 1);
  const advancing = event.teams_advancing_to_playoff;
  const rounds = event.playoff_rounds;
  const advancingOptions = [0, 2, 4, 6, 8, 10, 12, 16].filter((n) => n === 0 || n <= Math.max(teams, advancing));
  if (!advancingOptions.includes(advancing)) advancingOptions.push(advancing);
  advancingOptions.sort((a, b) => a - b);
  const warning =
    advancing === 0
      ? null
      : rounds === 1 && advancing % 2 !== 0
        ? "Single-round playoffs need an even Top-N (pairs play for each medal slot)."
        : rounds === 2 && advancing !== 4
          ? "2-round playoffs (semis + final + bronze) support Top-4 only."
          : null;
  const label: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: inkSoft };
  const select: CSSProperties = {
    padding: "8px 10px",
    border: `1px solid ${rule}`,
    borderRadius: 6,
    fontSize: 13,
    fontFamily: bodyFontStack,
    background: "#ffffff",
    minHeight: 40,
  };
  return (
    <div
      style={{
        marginBottom: 8,
        padding: 12,
        background: cream,
        border: `1px solid ${creamDeep}`,
        borderRadius: 6,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, alignItems: "end" }}>
        <div style={{ ...label, gridColumn: "1 / -1" }}>
          <span>Courts <span style={{ color: inkMuted }}>· click to assign or release · needs {row.courtsNeeded} of {courtCount}</span></span>
          <CourtPills total={courtCount} assigned={row.courtNumbers} onToggle={busy ? undefined : onToggleCourt} />
        </div>
        <label style={label}>
          <span>Pools <span style={{ color: inkMuted }}>· {teams} teams{row.teamCount < 2 ? " (max)" : ""}</span></span>
          <select
            value={event.pool_count}
            disabled={busy}
            onChange={(e) => onPatch({ pool_count: parseInt(e.target.value, 10) })}
            style={select}
            title={maxPools === 1 ? "Multiple pools need at least 8 teams (smallest pool holds 4)." : `Up to ${maxPools} pools for ${teams} teams (smallest pool ≥ 4).`}
          >
            {poolOptions.map((n) => (
              <option key={n} value={n} disabled={n > maxPools}>
                {n} {n === 1 ? "pool" : "pools"}{n > maxPools ? " — too few teams" : ""}
              </option>
            ))}
          </select>
        </label>
        <label style={label}>
          <span>Play each opponent</span>
          <select
            value={event.play_each_team_times}
            disabled={busy}
            onChange={(e) => onPatch({ play_each_team_times: parseInt(e.target.value, 10) })}
            style={select}
          >
            <option value={1}>1 time</option>
            <option value={2}>2 times</option>
            <option value={3}>3 times</option>
          </select>
        </label>
        <label style={label}>
          <span>Playoff — teams advancing</span>
          <select
            value={advancing}
            disabled={busy}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              // Leaving top-4 makes a 2-round bracket invalid — drop to 1 round.
              onPatch(n !== 4 && rounds === 2 ? { teams_advancing_to_playoff: n, playoff_rounds: 1 } : { teams_advancing_to_playoff: n });
            }}
            style={select}
          >
            {advancingOptions.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "No playoff" : `Top ${n}`}
              </option>
            ))}
          </select>
        </label>
        {event.pool_count === 2 && advancing === 4 && rounds === 1 && (
          <label style={label}>
            <span>Medal seeding</span>
            <select
              value={event.playoff_seeding ?? "overall"}
              disabled={busy}
              onChange={(e) => onPatch({ playoff_seeding: e.target.value as "overall" | "cross_pool" })}
              style={select}
              title="Cross-pool: Pool 1 winner v Pool 2 winner for gold; the two runners-up for bronze."
            >
              <option value="overall">Overall standings (1v2 gold, 3v4 bronze)</option>
              <option value="cross_pool">Cross-pool (pool winners → gold, runners-up → bronze)</option>
            </select>
          </label>
        )}
        <label style={label}>
          <span>Playoff rounds</span>
          <select
            value={rounds}
            disabled={busy || advancing === 0}
            onChange={(e) => onPatch({ playoff_rounds: parseInt(e.target.value, 10) })}
            style={select}
            title={advancing !== 4 ? "2 rounds (semis + final + bronze) is available for Top-4 only." : undefined}
          >
            <option value={1}>1 round (pairwise medal matches)</option>
            <option value={2} disabled={advancing !== 4}>
              2 rounds (semis + final + bronze){advancing !== 4 ? " — Top-4 only" : ""}
            </option>
          </select>
        </label>
      </div>
      {warning && (
        <div style={{ marginTop: 8, padding: "6px 10px", background: warnBg, color: warnFg, borderRadius: 4, fontSize: 12 }}>
          {warning}
        </div>
      )}
      {error && (
        <div style={{ marginTop: 8, padding: "6px 10px", background: dangerBg, color: dangerFg, borderRadius: 4, fontSize: 12 }}>
          {error}
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 11, color: inkMuted }}>
        Format changes apply to matches generated from now on. Existing matches keep their pairings — reset and regenerate on the event console. Scoring, minutes per game and fees stay on Edit event.
      </div>
    </div>
  );
}

function ViewTabs({
  view,
  onChange,
}: {
  view: "table" | "calendar";
  onChange: (v: "table" | "calendar") => void;
}) {
  const tabs: { key: "table" | "calendar"; label: string }[] = [
    { key: "table", label: "Table" },
    { key: "calendar", label: "Calendar" },
  ];
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        gap: 4,
        marginTop: 16,
        borderBottom: `1px solid ${rule}`,
      }}
    >
      {tabs.map((t) => {
        const active = t.key === view;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            style={{
              padding: "8px 14px",
              background: "transparent",
              border: "none",
              borderBottom: `2px solid ${active ? courtBlue : "transparent"}`,
              color: active ? courtBlue : inkSoft,
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: bodyFontStack,
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// Pixels per minute for the timeline. 1.4 ≈ 84px per hour — readable
// at typical viewport widths without burning vertical space.
const PIXELS_PER_MIN = 1.4;
// Minimum block height for very short events so the label still fits.
const MIN_BLOCK_PX = 28;

// Color palette for event blocks. Cycled by event index so the same
// event keeps the same color across renders. Hand-picked for decent
// contrast against the white timeline background and white block
// text.
const EVENT_PALETTE = [
  { bg: courtBlue, border: courtBlue }, // blue
  { bg: courtGreen, border: courtGreen }, // green
  { bg: "#9333ea", border: "#6b21a8" }, // purple
  { bg: courtRed, border: "#b02a16" }, // red/orange
  { bg: "#0891b2", border: "#155e75" }, // teal
  { bg: "#db2777", border: "#9d174d" }, // pink
  { bg: "#65a30d", border: "#3f6212" }, // lime
  { bg: "#7c3aed", border: "#5b21b6" }, // violet
];

// Visual schedule: one column per court, time runs top-to-bottom,
// events render as colored blocks positioned by start time and sized
// by duration. Events using multiple courts appear in each of their
// court columns so multi-court events are obvious at a glance.
//
// Multi-day tournaments render one timeline section per calendar
// day (events grouped by their start date) so a 4-day tournament
// doesn't collapse into one unreadable 96-hour column.
//
// Skips rendering when no event has a scheduled_start_at — there's
// nothing to draw yet, and a blank timeline is worse than no
// timeline.
function CourtTimeline({
  courtCount,
  rows,
}: {
  courtCount: number;
  rows: EventRow[];
}) {
  const scheduled = rows.filter(
    (r) => r.scheduledStart !== null && r.scheduledEnd !== null,
  );
  if (scheduled.length === 0) return null;

  // Color assignment by stable event index — sorting by scheduled
  // start so colors map to chronological order, which makes the
  // visual flow easier to track. The map is shared across days so
  // an event appears in the same color on every day it touches.
  const colorByEvent = new Map<string, (typeof EVENT_PALETTE)[number]>();
  const sortedByStart = scheduled
    .slice()
    .sort(
      (a, b) =>
        a.scheduledStart!.getTime() - b.scheduledStart!.getTime() ||
        a.event.name.localeCompare(b.event.name),
    );
  sortedByStart.forEach((r, i) => {
    colorByEvent.set(r.event.id, EVENT_PALETTE[i % EVENT_PALETTE.length]);
  });

  // Group events by start day. Events that cross midnight stay
  // attached to their start day; in practice pickleball events
  // rarely span midnight, and the alternative (clipping at midnight
  // and continuing the next day) adds a lot of UI complexity for
  // very little win.
  const byDay = new Map<string, EventRow[]>();
  for (const r of scheduled) {
    const key = dayKey(r.scheduledStart!);
    const arr = byDay.get(key) ?? [];
    arr.push(r);
    byDay.set(key, arr);
  }
  const days = Array.from(byDay.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return (
    <section style={{ marginTop: 16 }}>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: inkMuted }}>
        Each column is one court. Events using multiple courts appear in
        every column they claim, so multi-court events are obvious at a
        glance. Hover a block for details.
      </p>
      {days.map(([key, dayRows]) => (
        <DayTimeline
          key={key}
          dayLabel={fmtDayHeading(new Date(key))}
          rows={dayRows}
          courtCount={courtCount}
          colorByEvent={colorByEvent}
          showHeading={days.length > 1}
        />
      ))}
    </section>
  );
}

// Stable per-day key (YYYY-MM-DD in local time) so two events on the
// same calendar day group together even when they were entered
// minutes apart.
function dayKey(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDayHeading(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function DayTimeline({
  dayLabel,
  rows,
  courtCount,
  colorByEvent,
  showHeading,
}: {
  dayLabel: string;
  rows: EventRow[];
  courtCount: number;
  colorByEvent: Map<string, (typeof EVENT_PALETTE)[number]>;
  showHeading: boolean;
}) {
  // Window for this day's timeline: clamp to the hour on both sides
  // so the gridlines land cleanly.
  let minMs = Math.min(...rows.map((r) => r.scheduledStart!.getTime()));
  let maxMs = Math.max(...rows.map((r) => r.scheduledEnd!.getTime()));
  minMs = floorToHour(minMs);
  maxMs = ceilToHour(maxMs);
  const totalMinutes = (maxMs - minMs) / 60_000;
  const totalHeight = Math.max(120, totalMinutes * PIXELS_PER_MIN);

  const hourTicks: number[] = [];
  for (let t = minMs; t <= maxMs; t += 3600_000) hourTicks.push(t);

  const courts = Array.from({ length: courtCount }, (_, i) => i + 1);
  // Blocks are PHASES: pool play on its courts, then the medal round on
  // the (fewer) courts it actually uses — so a bracket leaves the other
  // columns free for whatever starts next.
  const blocksOnCourt = (court: number) =>
    rows.flatMap((r) => r.phases.filter((ph) => ph.courts.includes(court)).map((ph) => ({ row: r, phase: ph })));

  return (
    <div style={{ marginBottom: 24 }}>
      {showHeading && (
        <h3
          style={{
            margin: "0 0 8px",
            fontSize: 13,
            fontWeight: 600,
            color: inkSoft,
          }}
        >
          {dayLabel}
        </h3>
      )}
      <div
        style={{
          display: "flex",
          gap: 8,
          overflowX: "auto",
          background: "#ffffff",
          border: `1px solid ${rule}`,
          borderRadius: 6,
          padding: 12,
        }}
      >
        {/* Time axis column */}
        <div
          style={{
            width: 56,
            position: "relative",
            flexShrink: 0,
            paddingTop: 24, // align with court column headers
          }}
        >
          <div style={{ position: "relative", height: totalHeight }}>
            {hourTicks.map((t) => {
              const top = ((t - minMs) / 60_000) * PIXELS_PER_MIN;
              return (
                <div
                  key={t}
                  style={{
                    position: "absolute",
                    top,
                    left: 0,
                    right: 0,
                    fontSize: 10,
                    color: inkMuted,
                    textAlign: "right",
                    paddingRight: 6,
                    transform: "translateY(-50%)",
                  }}
                >
                  {fmtHourTick(t)}
                </div>
              );
            })}
          </div>
        </div>

        {/* One column per court */}
        {courts.map((court) => {
          const events = blocksOnCourt(court);
          return (
            <div
              key={court}
              style={{
                flex: "1 1 140px",
                minWidth: 140,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: inkSoft,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  textAlign: "center",
                  paddingBottom: 4,
                  marginBottom: 4,
                  borderBottom: `1px solid ${rule}`,
                }}
              >
                Court {court}
              </div>
              <div
                style={{
                  position: "relative",
                  height: totalHeight,
                  background: bg,
                  borderRadius: 4,
                  border: `1px solid ${rule}`,
                }}
              >
                {/* Hour gridlines inside the column */}
                {hourTicks.map((t, i) => {
                  if (i === 0) return null; // top edge already shown by border
                  const top = ((t - minMs) / 60_000) * PIXELS_PER_MIN;
                  return (
                    <div
                      key={t}
                      style={{
                        position: "absolute",
                        top,
                        left: 0,
                        right: 0,
                        height: 1,
                        background: rule,
                        pointerEvents: "none",
                      }}
                    />
                  );
                })}

                {events.length === 0 ? (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: inkMuted,
                      fontSize: 11,
                      fontStyle: "italic",
                    }}
                  >
                    No events
                  </div>
                ) : (
                  events.map(({ row: r, phase: ph }) => {
                    const start = ph.start.getTime();
                    const end = ph.end.getTime();
                    const top = ((start - minMs) / 60_000) * PIXELS_PER_MIN;
                    const height = Math.max(
                      MIN_BLOCK_PX,
                      ((end - start) / 60_000) * PIXELS_PER_MIN,
                    );
                    const color =
                      colorByEvent.get(r.event.id) ?? EVENT_PALETTE[0];
                    const isMedal = ph.kind === "medal";
                    return (
                      <div
                        key={`${r.event.id}-${ph.kind}`}
                        title={`${r.event.name} — ${isMedal ? "medal round" : "pool play"} ${fmtRange(ph.start, ph.end)}`}
                        style={{
                          position: "absolute",
                          top: top + 2,
                          left: 2,
                          right: 2,
                          height: Math.max(MIN_BLOCK_PX - 4, height - 4),
                          background: isMedal ? "#ffffff" : color.bg,
                          border: `${isMedal ? 2 : 1}px ${isMedal ? "dashed" : "solid"} ${color.border}`,
                          borderRadius: 4,
                          color: isMedal ? color.border : "#ffffff",
                          padding: "4px 6px",
                          fontSize: 11,
                          fontWeight: 500,
                          lineHeight: 1.2,
                          overflow: "hidden",
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "flex-start",
                        }}
                      >
                        <div
                          style={{
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {r.event.name}{isMedal ? " · medals" : ""}
                        </div>
                        <div
                          style={{
                            fontSize: 10,
                            opacity: 0.85,
                            marginTop: 1,
                          }}
                        >
                          {fmtTime(ph.start)}–
                          {fmtTime(ph.end)}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function fmtHourTick(ms: number): string {
  const d = new Date(ms);
  // Compact label: drop the ":00" so the axis isn't visually noisy.
  return d
    .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    .replace(":00", "");
}

function floorToHour(ms: number): number {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function ceilToHour(ms: number): number {
  const floored = floorToHour(ms);
  return floored === ms ? floored : floored + 3600_000;
}

// Summary panel rendered above the table when any conflict exists.
// Court conflicts are hard errors (red); player conflicts are
// warnings (amber, per docs/DESIGN_PREFERENCES.md "amber = note").
function ConflictsPanel({ overlaps }: { overlaps: Overlap[] }) {
  const courtCount = overlaps.filter((o) => o.type === "court").length;
  const playerCount = overlaps.filter((o) => o.type === "player").length;
  return (
    <div
      style={{
        marginTop: 16,
        padding: 12,
        background: courtCount > 0 ? dangerBg : warnBg,
        border: `1px solid ${courtCount > 0 ? courtRed : courtYellow}`,
        borderRadius: 6,
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: courtCount > 0 ? dangerFg : warnFg,
          marginBottom: 8,
        }}
      >
        {courtCount > 0
          ? `${courtCount} court conflict${courtCount === 1 ? "" : "s"}`
          : ""}
        {courtCount > 0 && playerCount > 0 ? " · " : ""}
        {playerCount > 0
          ? `${playerCount} player conflict${playerCount === 1 ? "" : "s"}`
          : ""}
      </div>
      <ul
        style={{
          margin: 0,
          paddingLeft: 18,
          fontSize: 12,
          color: inkSoft,
          lineHeight: 1.6,
        }}
      >
        {overlaps.map((o, i) => (
          <li key={i}>
            {o.type === "court" ? (
              <>
                <strong>Court {o.courts.join(", ")}</strong> double-booked:{" "}
                <em>{o.a.event.name}</em> and <em>{o.b.event.name}</em> both
                use{" "}
                {o.courts.length === 1
                  ? `court ${o.courts[0]}`
                  : `courts ${o.courts.join(", ")}`}{" "}
                during {fmtRange(o.windowStart, o.windowEnd)}.
              </>
            ) : (
              <>
                <strong>{o.sharedPlayerCount} player(s)</strong> registered
                in both <em>{o.a.event.name}</em> and{" "}
                <em>{o.b.event.name}</em>, which overlap during{" "}
                {fmtRange(o.windowStart, o.windowEnd)}.
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Per-row badges, shown next to the event name in the table. Compact
// — just dot-count of court (red) and player (amber) conflicts that
// involve this row.
function RowConflictBadges({
  conflicts,
  thisEventId,
}: {
  conflicts: Overlap[];
  thisEventId: string;
}) {
  const courtConflicts = conflicts.filter((o) => o.type === "court");
  const playerConflicts = conflicts.filter((o) => o.type === "player");
  if (courtConflicts.length === 0 && playerConflicts.length === 0) return null;

  const partnerNames = (list: Overlap[]) =>
    list
      .map((o) => (o.a.event.id === thisEventId ? o.b.event.name : o.a.event.name))
      .join(", ");

  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      {courtConflicts.length > 0 && (
        <span
          title={`Court conflict with: ${partnerNames(courtConflicts)}`}
          style={{
            padding: "1px 6px",
            background: dangerBg,
            color: dangerFg,
            border: `1px solid ${courtRed}`,
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.3,
          }}
        >
          ⚠ Court
        </span>
      )}
      {playerConflicts.length > 0 && (
        <span
          title={`Player conflict with: ${partnerNames(playerConflicts)}`}
          style={{
            padding: "1px 6px",
            background: warnBg,
            color: warnFg,
            border: `1px solid ${courtYellow}`,
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.3,
          }}
        >
          ⚠ Player
        </span>
      )}
    </span>
  );
}

function fmtRange(start: Date, end: Date): string {
  const time = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay = start.toDateString() === end.toDateString();
  if (sameDay) {
    return `${time(start)} – ${time(end)}`;
  }
  return `${start.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} – ${end.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

// The "why is it this long" breakdown for one event — matches, rounds,
// games per team, utilization, binding constraint, medal structure.
function EstimateDetails({ id, row }: { id: string; row: EventRow }) {
  const { estimate: e, event } = row;
  const pools = Math.max(1, event.pool_count);
  return (
    <div
      id={id}
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
        gap: 8,
        padding: 12,
        background: bg,
        border: `1px solid ${rule}`,
        borderRadius: 6,
      }}
    >
      <Stat
        label="Pool-play matches"
        value={e.pool.totalMatches.toLocaleString()}
        sub={`${pools} pool${pools === 1 ? "" : "s"} × ${e.pool.matchesPerPool} match${e.pool.matchesPerPool === 1 ? "" : "es"} · ${row.teamsPerPool} teams per pool · ${e.courts} court${e.courts === 1 ? "" : "s"}`}
      />
      <Stat
        label="Pool play"
        value={fmtDuration(e.pool.totalMinutes)}
        sub={poolPlayExplanation(e, event)}
      />
      <Stat label="Games per team" value={String(e.pool.gamesPerTeam)} sub="Pool play only." />
      <Stat
        label="Court utilization"
        value={`${Math.round(e.pool.utilization * 100)}%`}
        sub={utilizationLabel(e.pool.utilization)}
      />
      {e.medal ? (
        <Stat label="Medal round" value={fmtDuration(e.medal.totalMinutes)} sub={e.medal.summary} />
      ) : (
        <Stat label="Medal round" value="—" sub="No playoff configured for this event." />
      )}
      <Stat
        label="Total"
        value={fmtDuration(e.totalMinutes)}
        sub="Pool play + medal round, back-to-back. Minutes per game come from the event settings."
        emphasize
      />
    </div>
  );
}

const moveBtnStyle: CSSProperties = {
  minWidth: 44,
  minHeight: 36,
  padding: 0,
  fontSize: 11,
  color: inkSoft,
  background: "#ffffff",
  border: `1px solid ${rule}`,
  borderRadius: 4,
  cursor: "pointer",
  fontFamily: bodyFontStack,
};

const detailsBtnStyle: CSSProperties = {
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 600,
  color: courtBlue,
  background: "transparent",
  border: `1px solid ${courtBlue}`,
  borderRadius: 4,
  cursor: "pointer",
  fontFamily: bodyFontStack,
  minHeight: 24,
};

// "waits for Womens 2.75+ — 1 shared player" / "courts full until 10:35".
function planReason(p: Placement, rows: EventRow[]): string | null {
  const h = p.heldBy;
  if (!h) return null;
  const name = (id: string) => rows.find((r) => r.event.id === id)?.event.name ?? "another event";
  if (h.playerClashes.length > 0) {
    return `waits for ${h.playerClashes
      .map((c) => `${name(c.id)} — ${c.shared} shared player${c.shared === 1 ? "" : "s"}`)
      .join("; ")}`;
  }
  return `courts full until ${fmtTime(new Date(p.startMs))} (${h.courtsShort} short at ${fmtTime(new Date(h.atMs))})`;
}

function fmtCourtRange(courts: number[]): string {
  if (courts.length === 0) return "—";
  const sorted = [...courts].sort((a, b) => a - b);
  const contiguous = sorted.every((c, i) => i === 0 || c === sorted[i - 1] + 1);
  return contiguous && sorted.length > 1 ? `${sorted[0]}–${sorted[sorted.length - 1]}` : sorted.join(", ");
}

function Stat({
  label,
  value,
  sub,
  emphasize,
}: {
  label: string;
  value: string;
  sub?: string;
  emphasize?: boolean;
}) {
  return (
    <div
      style={{
        padding: 12,
        background: emphasize ? cream : bg,
        border: `1px solid ${emphasize ? creamDeep : rule}`,
        borderRadius: 6,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: inkMuted,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: emphasize ? 22 : 18,
          fontWeight: 600,
          marginTop: 4,
          color: emphasize ? courtBlue : ink,
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 12,
            color: inkMuted,
            marginTop: 4,
            lineHeight: 1.4,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        marginTop: 24,
        padding: 32,
        textAlign: "center",
        background: bg,
        border: `1px dashed ${rule}`,
        borderRadius: 6,
        color: inkMuted,
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  fontSize: 11,
  color: inkMuted,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  fontWeight: 500,
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  verticalAlign: "top",
};

// `<input type="datetime-local">` expects "YYYY-MM-DDTHH:MM" in
// **local** time with no timezone suffix. Going either direction:
//   - toLocalInput: ISO/timestamptz → local-time slug for the input
//   - fromLocalInput: local-time slug → ISO with the browser's offset
// Both round-trip the same wall-clock moment the organizer sees.
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(local: string): string | null {
  if (!local) return null;
  // new Date("YYYY-MM-DDTHH:MM") parses as local time in browsers,
  // then .toISOString() gives us the UTC-equivalent storage form.
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

