// Playoff seed selection + first-round pairing.
//
// Single source of truth for WHO advances to the playoff and WHO plays
// whom in the first round. Both the "Generate playoff bracket" preview
// (EventConsolePage → PlayoffSection) and the actual bracket generation
// call these helpers, so the preview an organizer confirms can never
// drift from the matches that get created.
//
// Pools are stored 1-indexed (pool 1 = "A", pool 2 = "B"), so cross-pool
// seeding filters on poolIndex 1 and 2 — matching how the standings and
// generation code elsewhere read pool membership.

// Structural shape these helpers need. Standing (EventConsolePage) and any
// row carrying a pool index satisfy it. Kept generic so callers get their
// own concrete type back (a full Standing, not this reduced view).
export type SeedableStanding = {
  team: { poolIndex: number | null };
};

// Teams advancing to the playoff, in seed order (seed 1 first).
//
//  - overall: the top `topN` of the record-sorted standings.
//  - crossPool (2 pools, top 4): [Pool A #1, Pool B #1, Pool A #2, Pool B #2],
//    so seeds 1 & 2 are the pool winners and seeds 3 & 4 the runners-up.
//    Standings arrive record-sorted, so filtering by pool preserves each
//    pool's placement order.
//
// Returns fewer than `topN` (overall) or [] (crossPool) when there aren't
// enough teams to seed a bracket — the caller surfaces the specific error.
export function selectPlayoffSeeds<S extends SeedableStanding>(
  standings: readonly S[],
  topN: number,
  crossPool: boolean,
): S[] {
  if (crossPool) {
    const poolA = standings.filter((s) => s.team.poolIndex === 1);
    const poolB = standings.filter((s) => s.team.poolIndex === 2);
    if (poolA.length < 2 || poolB.length < 2) return [];
    return [poolA[0], poolB[0], poolA[1], poolB[1]];
  }
  return standings.slice(0, topN);
}

// First-round matchups as [higher-seed, lower-seed] pairs.
//
//  - rounds === 1: adjacent seeds — (1,2), (3,4), … Each pair plays
//    directly for a medal slot (Gold/Silver, Bronze/4th, …).
//  - rounds >= 2: highest vs lowest — (1,N), (2,N-1), … the standard
//    semifinal bracket.
//
// Returns [] when there are fewer than two seeds to pair.
export function pairPlayoffSeeds<S>(
  seeds: readonly S[],
  rounds: number,
): [S, S][] {
  const pairs: [S, S][] = [];
  if (seeds.length < 2) return pairs;
  if (rounds === 1) {
    for (let i = 0; i + 1 < seeds.length; i += 2) {
      pairs.push([seeds[i], seeds[i + 1]]);
    }
  } else {
    for (let i = 0; i < Math.floor(seeds.length / 2); i++) {
      pairs.push([seeds[i], seeds[seeds.length - 1 - i]]);
    }
  }
  return pairs;
}
