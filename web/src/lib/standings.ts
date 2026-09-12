import type { Database } from "../types/supabase";
import type { Standing, Team } from "../pages/admin/EventConsolePage";

type Match = Database["public"]["Tables"]["matches"]["Row"];

// Round-robin standings, used for BOTH the Standings tab and playoff
// seeding — so this ordering decides who advances and how they're seeded.
//
// Tiebreak order: record (wins) -> HEAD-TO-HEAD -> point differential ->
// points-for. Head-to-head is scored within the tied group as a mini
// round-robin (each team's wins over the other tied teams), which is
// correct for a 2-way tie (who won their match) and a multi-way tie; a
// circular tie (everyone 1-1 within the group) falls through to
// differential, then points-for.
//
// Kept free of React so the ordering is unit-testable (see
// standings.test.ts), mirroring lib/resultsExport.ts.
export function computeStandings(
  teams: Team[],
  rrMatches: Match[],
): Standing[] {
  const byCap = new Map<string, Standing>();
  for (const t of teams) {
    byCap.set(t.captainRegId, {
      team: t,
      wins: 0,
      losses: 0,
      pf: 0,
      pa: 0,
      diff: 0,
    });
  }

  // Head-to-head wins: h2h.get(`${winnerReg}|${loserReg}`) = times winner beat loser.
  const h2h = new Map<string, number>();
  for (const m of rrMatches) {
    if (m.status !== "completed") continue;
    if (
      m.team_a_reg_id === null ||
      m.team_b_reg_id === null ||
      m.team_a_score === null ||
      m.team_b_score === null
    ) {
      continue;
    }
    const a = byCap.get(m.team_a_reg_id);
    const b = byCap.get(m.team_b_reg_id);
    if (!a || !b) continue;
    a.pf += m.team_a_score;
    a.pa += m.team_b_score;
    b.pf += m.team_b_score;
    b.pa += m.team_a_score;
    if (m.winner_reg_id === m.team_a_reg_id) {
      a.wins++;
      b.losses++;
    } else if (m.winner_reg_id === m.team_b_reg_id) {
      b.wins++;
      a.losses++;
    }
    if (m.winner_reg_id) {
      const loser =
        m.winner_reg_id === m.team_a_reg_id
          ? m.team_b_reg_id
          : m.team_a_reg_id;
      const key = `${m.winner_reg_id}|${loser}`;
      h2h.set(key, (h2h.get(key) ?? 0) + 1);
    }
  }
  const h2hWins = (a: string, b: string) => h2h.get(`${a}|${b}`) ?? 0;

  const standings = Array.from(byCap.values());
  for (const s of standings) s.diff = s.pf - s.pa;

  // Order by wins, then break ties HEAD-TO-HEAD first, then point differential,
  // then points for. Head-to-head is scored within the tied group (a mini
  // round-robin), so it's correct for both 2-way ties (who won their match) and
  // multi-way ties; a circular tie falls through to differential.
  standings.sort((x, y) => y.wins - x.wins);
  const ordered: Standing[] = [];
  let i = 0;
  while (i < standings.length) {
    let j = i;
    while (j < standings.length && standings[j].wins === standings[i].wins) j++;
    const group = standings.slice(i, j);
    if (group.length > 1) {
      const h2hRec = new Map<string, number>();
      for (const s of group) {
        let w = 0;
        for (const o of group) {
          if (o === s) continue;
          w += h2hWins(s.team.captainRegId, o.team.captainRegId);
        }
        h2hRec.set(s.team.captainRegId, w);
      }
      group.sort(
        (a, b) =>
          (h2hRec.get(b.team.captainRegId) ?? 0) -
            (h2hRec.get(a.team.captainRegId) ?? 0) ||
          b.diff - a.diff ||
          b.pf - a.pf,
      );
    }
    ordered.push(...group);
    i = j;
  }
  return ordered;
}
