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

export type PackItem = {
  id: string;
  // Lower runs first. Ties broken by array order.
  order: number;
  minutes: number;
  courtsNeeded: number;
  players: ReadonlySet<string>;
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
  // The disjoint slice of court numbers (1-based) this event gets for its
  // window — lowest free courts at that time.
  courts: number[];
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

  for (const item of ordered) {
    const need = Math.min(total, Math.max(1, item.courtsNeeded));
    const durMs = Math.max(1, item.minutes) * 60_000;

    // Candidate starts: the anchor, and just after every placed end (with
    // the buffer). Earliest feasible wins.
    const candidates = Array.from(
      new Set([anchorMs, ...placed.map((p) => p.endMs + bufferMs)]),
    )
      .filter((t) => t >= anchorMs)
      .sort((a, b) => a - b);

    let chosen: Placement | null = null;
    let lastRejected: HoldReason | null = null;
    for (const t of candidates) {
      const end = t + durMs;
      const overlapping = placed.filter((p) => p.startMs < end && p.endMs > t);
      const busyCourts = new Set(overlapping.flatMap((p) => p.courts));
      const courtsShort = Math.max(0, busyCourts.size + need - total);
      const playerClashes = overlapping
        .map((p) => {
          const theirs = playersById.get(p.id);
          let shared = 0;
          if (theirs) for (const pl of item.players) if (theirs.has(pl)) shared++;
          return { id: p.id, shared };
        })
        .filter((c) => c.shared > 0);
      if (courtsShort > 0 || playerClashes.length > 0) {
        lastRejected = { playerClashes, courtsShort, atMs: t };
        continue;
      }
      const courts: number[] = [];
      for (let c = 1; c <= total && courts.length < need; c++) {
        if (!busyCourts.has(c)) courts.push(c);
      }
      chosen = { id: item.id, startMs: t, endMs: end, courts, heldBy: lastRejected };
      break;
    }
    // Always feasible at the latest end + buffer (nothing overlaps there),
    // so `chosen` is set; the fallback is only for an empty candidate list.
    if (!chosen) {
      const t = Math.max(anchorMs, ...placed.map((p) => p.endMs + bufferMs));
      chosen = {
        id: item.id,
        startMs: t,
        endMs: t + durMs,
        courts: Array.from({ length: need }, (_, i) => i + 1),
        heldBy: lastRejected,
      };
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

// Courts an event can keep busy: floor(teams / 2) per pool, summed over
// pools (all pools play at once). The medal round needs at most
// floor(advancing / 2), never more than pool play in practice.
export function courtsNeededFor(
  teams: number,
  pools: number,
  teamsAdvancing: number,
): number {
  const p = Math.max(1, pools);
  const perPool = Math.max(2, Math.ceil(Math.max(2, teams) / p));
  const poolNeed = p * Math.floor(perPool / 2);
  const medalNeed = Math.floor(Math.max(0, teamsAdvancing) / 2);
  return Math.max(1, poolNeed, medalNeed);
}
