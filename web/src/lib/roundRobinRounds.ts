import type { Match } from "./bracketTeams";

// Round-robin matches are stored flat (every row has round = 1 — the court
// manager hands them out from a fair queue, not in fixed rounds). For a
// spectator, "Round 2: who do we play?" is still the natural way to read a
// pool, so pack the matches into rounds the way a desk would: walk them in
// play order and drop each into the first round where neither team is
// already playing. Every team appears at most once per round.
export function packRoundRobinRounds<M extends Pick<Match, "position" | "team_a_reg_id" | "team_b_reg_id">>(
  matches: M[],
): M[][] {
  const rounds: { busy: Set<string>; matches: M[] }[] = [];
  const ordered = [...matches].sort((a, b) => a.position - b.position);
  for (const m of ordered) {
    const sides = [m.team_a_reg_id, m.team_b_reg_id].filter((s): s is string => !!s);
    let round = rounds.find((r) => sides.every((s) => !r.busy.has(s)));
    if (!round) {
      round = { busy: new Set(), matches: [] };
      rounds.push(round);
    }
    for (const s of sides) round.busy.add(s);
    round.matches.push(m);
  }
  return rounds.map((r) => r.matches);
}
