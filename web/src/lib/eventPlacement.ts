// Event → schedule mapping: the ONE place an events row becomes the
// segments / court needs / fixed placement the auto-scheduler
// (schedulePacker) works with. This logic used to live inline in
// SchedulePage's `rows` useMemo and its `placementFor` helper; it was
// pulled out here so the Schedule page and the Bracket Setup wizard's
// Courts / Start-time steps recommend from the SAME implementation
// (D-0049 — no second copy of the packing/duration mapping).
//
// It reuses the estimator (durations) and schedulePacker (court needs)
// primitives; it does not recompute either.

import {
  doubleElimCourtsNeeded,
  estimateEvent,
  type EstimableEvent,
  type EventEstimate,
} from "./estimator";
import {
  medalCourtsNeeded,
  poolCourtsNeeded,
  type PackItem,
  type PackSegment,
  type PlacedSegment,
  type Placement,
} from "./schedulePacker";

// The fields of an events row the placement math reads: the estimator's
// needs (EstimableEvent) plus the id, team cap, pools, playoff size and
// bracket type the court math keys on. A full events Row satisfies this.
export type PlaceableEvent = EstimableEvent & {
  id: string;
  max_teams: number | null;
  pool_count: number;
  teams_advancing_to_playoff: number;
  bracket_type?: string | null;
};

export type EventPlacementInput = {
  event: PlaceableEvent;
  // Teams holding a spot (roster count). Drives the estimate + planTeams.
  teamCount: number;
  // Courts currently assigned to the event (event_courts). Empty is fine —
  // the estimate falls back to 1 court, pessimistically.
  courtNumbers: number[];
  // Courts at the VENUE (locations.court_count) — the cap on courtsNeeded.
  venueCourts: number;
  // Player ids on the event's roster, for the packer's clash check.
  players: ReadonlySet<string>;
};

// Everything the packer and the scheduling UI need about one event,
// derived once. The single source of truth for the event→schedule shape.
export type EventPlacementFacts = {
  id: string;
  estimate: EventEstimate;
  // Teams the plan is based on: registered teams, or max_teams before
  // anyone has signed up.
  planTeams: number;
  // Courts the estimate used (max(1, assigned) — pessimistic when none).
  courts: number;
  courtNumbers: number[];
  poolMinutes: number;
  medalMinutes: number;
  totalMinutes: number;
  // Courts pool play can keep busy (pools × floor(teams/2)), capped at the
  // venue. Drives parallel packing.
  courtsNeeded: number;
  // Courts the medal round keeps busy (one per medal match; 0 = no playoff).
  medalCourtsNeeded: number;
  players: ReadonlySet<string>;
};

// The core mapping: an events row + its roster / court allocation → the
// durations and court needs the scheduler reasons about.
export function eventPlacementFacts(
  input: EventPlacementInput,
): EventPlacementFacts {
  const { event, teamCount, courtNumbers, venueCourts, players } = input;
  const sortedCourts = [...courtNumbers].sort((a, b) => a - b);
  // Fall back to 1 court when an event hasn't claimed any — the estimate
  // still renders, just pessimistically.
  const courts = Math.max(1, sortedCourts.length);
  const estimate = estimateEvent(event, teamCount, courts);
  const { pool, medal, totalMinutes } = estimate;
  const planTeams =
    teamCount >= 2 ? teamCount : Math.max(2, event.max_teams ?? 2);
  const cap = Math.max(1, venueCourts);
  const isDE = event.bracket_type === "double_elim";
  const courtsNeeded = Math.min(
    cap,
    isDE
      ? doubleElimCourtsNeeded(planTeams)
      : poolCourtsNeeded(planTeams, event.pool_count),
  );
  const medalNeed = Math.min(
    cap,
    isDE ? 1 : medalCourtsNeeded(event.teams_advancing_to_playoff),
  );
  return {
    id: event.id,
    estimate,
    planTeams,
    courts,
    courtNumbers: sortedCourts,
    poolMinutes: pool.totalMinutes,
    medalMinutes: medal?.totalMinutes ?? 0,
    totalMinutes,
    courtsNeeded,
    medalCourtsNeeded: medalNeed,
    players,
  };
}

// The pool (and, when there's a playoff, medal) segments the packer walks.
export function placementSegments(
  f: Pick<
    EventPlacementFacts,
    "poolMinutes" | "medalMinutes" | "courtsNeeded" | "medalCourtsNeeded"
  >,
): PackSegment[] {
  return [
    { kind: "pool", minutes: f.poolMinutes, courtsNeeded: f.courtsNeeded },
    ...(f.medalMinutes > 0
      ? [
          {
            kind: "medal" as const,
            minutes: f.medalMinutes,
            courtsNeeded: f.medalCourtsNeeded,
          },
        ]
      : []),
  ];
}

// A MOVABLE item for packSchedule. `order` decides run order (ties broken
// by array order). `minStartMs` is the item's day floor (see dayFloors) — the
// packer won't place it before then, which is how a pinned later day survives
// auto-schedule. Use for the event(s) being (re)placed.
export function toPackItem(
  f: EventPlacementFacts,
  order: number,
  minStartMs?: number,
): PackItem {
  return { id: f.id, order, segments: placementSegments(f), players: f.players, minStartMs };
}

// Day floors from pinned start times. Given events IN RUN ORDER, each with the
// start time the organizer pinned it to (or null when unpinned), return each
// event's earliest allowed start:
//   • no event starts before `anchorMs` (the tournament/day-1 start), and
//   • once a pinned start is passed in run order, nothing after it starts
//     earlier — the floor only ever moves forward.
// So pinning the FIRST event of day 2 keeps every later event on day 2 instead
// of the greedy packer pulling them back onto day 1 (the "all collapses to one
// day" bug). A pin earlier in wall-clock than the running floor doesn't lower
// it; the pinned event itself is still placed at/after its own pin because its
// own floor is raised to it.
export function dayFloors(
  ordered: ReadonlyArray<{ id: string; pinnedStartMs: number | null }>,
  anchorMs: number,
): Map<string, number> {
  const floors = new Map<string, number>();
  let running = anchorMs;
  for (const o of ordered) {
    if (o.pinnedStartMs != null) running = Math.max(running, o.pinnedStartMs);
    floors.set(o.id, running);
  }
  return floors;
}

// The event as a FIXED placement — an already-scheduled sibling the packer
// must route around. Pool play holds the lowest `courtsNeeded` of the
// event's assigned courts; the medal round the lowest `medalCourtsNeeded`
// of those, so the next event can start on courts pool play released while
// a bracket finishes. Mirrors the calendar's phase model.
export function toFixedPlacement(
  f: EventPlacementFacts,
  startMs: number,
): Placement {
  const poolCourts = f.courtNumbers.slice(
    0,
    Math.max(1, Math.min(f.courtNumbers.length || 1, f.courtsNeeded)),
  );
  const pc = poolCourts.length ? poolCourts : [1];
  const poolEnd = startMs + f.poolMinutes * 60_000;
  const segments: PlacedSegment[] = [
    { kind: "pool", startMs, endMs: poolEnd, courts: pc },
  ];
  if (f.medalMinutes > 0) {
    segments.push({
      kind: "medal",
      startMs: poolEnd,
      endMs: poolEnd + f.medalMinutes * 60_000,
      courts: pc.slice(0, Math.max(1, f.medalCourtsNeeded)),
    });
  }
  return {
    id: f.id,
    startMs,
    endMs: startMs + f.totalMinutes * 60_000,
    courts: f.courtNumbers,
    segments,
    heldBy: null,
  };
}
