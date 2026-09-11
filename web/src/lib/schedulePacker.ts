// Auto-schedule packing: give each event the earliest start at which the
// courts it ACTUALLY needs fit alongside whatever else is running, and none
// of its players are busy in another event. Events that fit run side by
// side; otherwise the next one starts when the previous ends, plus the
// buffer. Pure and synchronous so it can be unit-tested and used both for
// the "here's the plan" preview and the real write.
//
// Why "courts needed" and not "courts allocated": a pool of 5 teams can only
// play floor(5/2) = 2 matches at once, so an event of 2 such pools keeps 4
// courts busy no matter how many it was handed. Treating every event as
// owning all 8 courts is what made a 5-event day come out as 9 hours
// end-to-end (PB Angels, 2026-09-11).

// One event = one or two back-to-back segments: pool play (its full court
// need) and, when there is a playoff, the medal round — fewer courts, so the
// next event can start on what pool play released.
export type PackSegment = {
  kind: "pool" | "medal";
  minutes: number;
  courtsNeeded: number;
};

export type PackItem = {
  id: string;
  // Lower runs first. Ties broken by array order.
  order: number;
  segments: PackSegment[];
  players: ReadonlySet<string>;
};

export type PlacedSegment = {
  kind: "pool" | "medal";
  startMs: number;
  endMs: number;
  courts: number[];
};

// Why an event didn't start at the anchor: what was in the way at the last
// candidate time we had to skip. `null` when it starts as early as possible.
export type HoldReason = {
  // Events whose players overlap this one, with the shared count.
  playerClashes: { id: string; shared: number }[];
  // Courts short at that time (0 when players were the only problem).
  courtsShort: number;
  // The candidate time that was rejected.
  atMs: number;
};

export type Placement = {
  id: string;
  startMs: number;
  endMs: number;
  // Union of every segment's courts — what gets written to event_courts.
  courts: number[];
  segments: PlacedSegment[];
  heldBy: HoldReason | null;
};

export function packSchedule(
  items: PackItem[],
  anchorMs: number,
  bufferMs: number,
  courtCount: number,
): Placement[] {
  const total = Math.max(1, courtCount);
  const ordered = [...items].sort((a, b) => a.order - b.order);
  const placed: Placement[] = [];
  const playersById = new Map(items.map((i) => [i.id, i.players]));

  // Court numbers busy at time t, from every placed segment.
  const busyAt = (t: number, end: number, except?: string) => {
    const busy = new Set<number>();
    for (const p of placed) {
      if (p.id === except) continue;
      for (const seg of p.segments) {
        if (seg.startMs < end && seg.endMs > t) for (const c of seg.courts) busy.add(c);
      }
    }
    return busy;
  };

  for (const item of ordered) {
    const segs = item.segments.length
      ? item.segments.map((g) => ({ ...g, minutes: Math.max(1, g.minutes), courtsNeeded: Math.min(total, Math.max(1, g.courtsNeeded)) }))
      : [{ kind: "pool" as const, minutes: 1, courtsNeeded: 1 }];
    const durMs = segs.reduce((m, g) => m + g.minutes * 60_000, 0);

    // Candidate starts: the anchor, and just after every placed segment end
    // (with the buffer) — pool play ending frees courts even while that
    // event's bracket is still running. Earliest feasible wins.
    const candidates = Array.from(
      new Set([anchorMs, ...placed.flatMap((p) => p.segments.map((g) => g.endMs + bufferMs))]),
    )
      .filter((t) => t >= anchorMs)
      .sort((a, b) => a - b);

    let chosen: Placement | null = null;
    let lastRejected: HoldReason | null = null;
    for (const t of candidates) {
      const end = t + durMs;
      // Player clash is checked over the whole event window.
      const overlappingEvents = placed.filter((p) => p.startMs < end && p.endMs > t);
      const playerClashes = overlappingEvents
        .map((p) => {
          const theirs = playersById.get(p.id);
          let shared = 0;
          if (theirs) for (const pl of item.players) if (theirs.has(pl)) shared++;
          return { id: p.id, shared };
        })
        .filter((c) => c.shared > 0);
      // Courts are checked per segment; the medal round takes the lowest
      // courts of the pool slice so it never grabs anything new.
      let cursor = t;
      let courtsShort = 0;
      const placedSegs: PlacedSegment[] = [];
      let poolCourts: number[] = [];
      for (const g of segs) {
        const segEnd = cursor + g.minutes * 60_000;
        const busy = busyAt(cursor, segEnd);
        let courts: number[];
        if (g.kind === "medal" && poolCourts.length) {
          courts = poolCourts.filter((c) => !busy.has(c)).slice(0, g.courtsNeeded);
          if (courts.length < g.courtsNeeded) {
            for (let c = 1; c <= total && courts.length < g.courtsNeeded; c++) if (!busy.has(c) && !courts.includes(c)) courts.push(c);
          }
        } else {
          courts = [];
          for (let c = 1; c <= total && courts.length < g.courtsNeeded; c++) if (!busy.has(c)) courts.push(c);
          if (g.kind === "pool") poolCourts = courts;
        }
        courtsShort = Math.max(courtsShort, g.courtsNeeded - courts.length);
        placedSegs.push({ kind: g.kind, startMs: cursor, endMs: segEnd, courts });
        cursor = segEnd;
      }
      if (courtsShort > 0 || playerClashes.length > 0) {
        lastRejected = { playerClashes, courtsShort, atMs: t };
        continue;
      }
      chosen = {
        id: item.id,
        startMs: t,
        endMs: end,
        courts: Array.from(new Set(placedSegs.flatMap((g) => g.courts))).sort((a, b) => a - b),
        segments: placedSegs,
        heldBy: lastRejected,
      };
      break;
    }
    if (!chosen) {
      // Only reachable with an empty candidate list; place after everything.
      const t = Math.max(anchorMs, ...placed.map((p) => p.endMs + bufferMs));
      let cursor = t;
      const placedSegs: PlacedSegment[] = segs.map((g) => {
        const seg = { kind: g.kind, startMs: cursor, endMs: cursor + g.minutes * 60_000, courts: Array.from({ length: g.courtsNeeded }, (_, i) => i + 1) };
        cursor = seg.endMs;
        return seg;
      });
      chosen = { id: item.id, startMs: t, endMs: cursor, courts: Array.from(new Set(placedSegs.flatMap((g) => g.courts))), segments: placedSegs, heldBy: lastRejected };
    }
    placed.push(chosen);
  }
  return placed;
}

// Groups of placements that overlap in time — "these run together".
export function parallelGroups(placements: Placement[]): Placement[][] {
  const sorted = [...placements].sort((a, b) => a.startMs - b.startMs);
  const groups: Placement[][] = [];
  for (const p of sorted) {
    const g = groups.find((grp) => grp.some((q) => q.startMs < p.endMs && q.endMs > p.startMs));
    if (g) g.push(p);
    else groups.push([p]);
  }
  return groups.filter((g) => g.length > 1);
}

// Courts POOL PLAY can keep busy: floor(teams / 2) per pool, summed over
// pools (all pools play at once).
export function poolCourtsNeeded(teams: number, pools: number): number {
  const p = Math.max(1, pools);
  const perPool = Math.max(2, Math.ceil(Math.max(2, teams) / p));
  return Math.max(1, p * Math.floor(perPool / 2));
}

// Courts the MEDAL ROUND keeps busy: one per simultaneous medal match —
// floor(advancing / 2) (semis of a 2-round bracket are the same count; the
// final + bronze are 2). 0 when there is no playoff.
export function medalCourtsNeeded(teamsAdvancing: number): number {
  if (teamsAdvancing <= 0) return 0;
  return Math.max(1, Math.floor(teamsAdvancing / 2));
}

// Kept for callers that want a single number: the larger of the two.
export function courtsNeededFor(teams: number, pools: number, teamsAdvancing: number): number {
  return Math.max(poolCourtsNeeded(teams, pools), medalCourtsNeeded(teamsAdvancing));
}
