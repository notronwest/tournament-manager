// Which pending match to suggest on each open court.
//
// Candidates arrive ranked best-first (fairness order: fewest games played,
// then longest rest — see the court managers' rankedByEvent /
// rankedPending). The old picker walked courts in order and gave each the
// first candidate whose teams weren't already suggested elsewhere. That is
// greedy: courts 1 and 2 could take the two "fairest" games and leave court 3
// with nothing, even though a different pair of picks would have filled all
// three (Ron hit exactly this on a 3-court event).
//
// assignSuggestions instead chooses the set that fills the MOST courts, and
// among those the one that is best by rank (court 1 gets the best candidate
// that still allows a full fill, then court 2, ...). When greedy already
// filled every court the answer is identical to the old behaviour.

export type SuggestionCandidate = {
  id: string;
  team_a_reg_id: string | null;
  team_b_reg_id: string | null;
};

// Safety valve: the search is tiny in practice (a handful of courts, a few
// dozen candidates) but a pathological event could blow up, so cap the
// number of nodes explored and fall back to the best found so far — which is
// never worse than greedy, because greedy is the first path the search walks.
const NODE_BUDGET = 50_000;

export function assignSuggestions<C extends SuggestionCandidate>(
  ranked: readonly C[],
  openCourts: number,
): C[] {
  if (openCourts <= 0 || ranked.length === 0) return [];
  const cands = ranked.filter((c) => c.team_a_reg_id && c.team_b_reg_id);

  let best: C[] = [];
  let nodes = 0;
  const used = new Set<string>();
  const chosen: C[] = [];

  const walk = (from: number): boolean => {
    if (chosen.length === openCourts) {
      best = [...chosen];
      return true; // can't do better than every court filled
    }
    // Bound: even taking every remaining candidate can't beat `best`.
    if (chosen.length + (cands.length - from) <= best.length) return false;
    for (let i = from; i < cands.length; i++) {
      if (++nodes > NODE_BUDGET) return true;
      const c = cands[i];
      const a = c.team_a_reg_id!;
      const b = c.team_b_reg_id!;
      if (a === b || used.has(a) || used.has(b)) continue;
      used.add(a);
      used.add(b);
      chosen.push(c);
      // Depth-first in rank order: the first assignment found at any size
      // is the lexicographically best of that size, so only a strictly
      // larger fill replaces `best`.
      if (chosen.length > best.length) best = [...chosen];
      const done = walk(i + 1);
      chosen.pop();
      used.delete(a);
      used.delete(b);
      if (done) return true;
    }
    return false;
  };

  walk(0);
  return best;
}
