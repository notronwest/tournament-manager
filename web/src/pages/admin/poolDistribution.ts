// Pool distribution — pure planning logic, extracted from EventConsolePage so
// the "locked once games exist" guard is unit-testable without a React harness.

export type PoolPattern = "alternate" | "snake";

/**
 * Snake-draft pool index (1-based): seeds fill pools 1,2,2,1,1,2,… so the
 * average seed stays even across pools.
 */
export function snakePoolIndex(i: number, poolCount: number): number {
  const round = Math.floor(i / poolCount);
  const within = i % poolCount;
  const idx = round % 2 === 0 ? within : poolCount - 1 - within;
  return idx + 1;
}

export interface PoolDistributionTeam {
  captainRegId: string;
  partnerRegId?: string | null;
  seed: number | null;
}

export interface PoolAssignment {
  /** Registration ids to move together (captain + partner if any). */
  ids: string[];
  /** 1-based pool index to write to event_registrations.pool_index. */
  poolIndex: number;
}

/**
 * Plan which registrations move to which pool, in seeded order.
 *
 * Returns an EMPTY plan (i.e. a no-op) when games already exist: generated
 * matches reference each team's pool assignment, so re-pooling after match
 * creation would corrupt the bracket/standings. It is also a no-op for a
 * single pool. Callers own surfacing the lock to the user — this function
 * simply refuses to produce any writes.
 */
export function planPoolDistribution(opts: {
  teams: PoolDistributionTeam[];
  poolCount: number;
  pattern: PoolPattern;
  hasMatches: boolean;
}): PoolAssignment[] {
  const { teams, poolCount, pattern, hasMatches } = opts;
  if (hasMatches) return [];
  if (poolCount < 2) return [];

  const sorted = teams
    .slice()
    .sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9));

  return sorted.map((team, i) => {
    const ids = [team.captainRegId];
    if (team.partnerRegId) ids.push(team.partnerRegId);
    const poolIndex =
      pattern === "alternate"
        ? (i % poolCount) + 1
        : snakePoolIndex(i, poolCount);
    return { ids, poolIndex };
  });
}
