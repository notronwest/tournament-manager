import type { Database } from "../types/supabase";

// Bracket-side view of an event's registrations and matches: how paired
// event_registrations become a Team, how round-robin scores become
// standings, and how the final-round playoff matches become a medal podium.
//
// Extracted from EventConsolePage so the tournament summary report (and
// anything else that needs "who won this event?") computes results exactly
// the way the console shows them. Pure functions — no React, no Supabase.

export type Player = Database["public"]["Tables"]["players"]["Row"];
export type EventRegistration =
  Database["public"]["Tables"]["event_registrations"]["Row"];
export type Match = Database["public"]["Tables"]["matches"]["Row"];

export type Medal = {
  team: { label: string; captainRegId: string };
  place: "gold" | "silver" | "bronze";
};

export type Team = {
  // Captain reg id is the canonical id we use in matches. For doubles it
  // is one of the pair (lowest UUID, deterministic). For singles it's
  // just the one reg.
  captainRegId: string;
  partnerRegId: string | null;
  captain: Player;
  partner: Player | null;
  label: string;
  registeredAt: string;
  poolIndex: number | null;
  seed: number | null;
};

export type Standing = {
  team: Team;
  wins: number;
  losses: number;
  pf: number;
  pa: number;
  diff: number;
};

export function buildTeams(regs: EventRegistration[], players: Player[]): Team[] {
  const playerById = new Map(players.map((p) => [p.id, p]));
  const regById = new Map(regs.map((r) => [r.id, r]));

  const teams: Team[] = [];
  const seen = new Set<string>();

  for (const r of regs) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);

    let captainReg: EventRegistration = r;
    let partnerReg: EventRegistration | null = null;
    if (r.partner_registration_id) {
      const pr = regById.get(r.partner_registration_id);
      if (pr) {
        seen.add(pr.id);
        // Pick the lower-id reg as the captain so the choice is stable.
        if (pr.id < captainReg.id) {
          partnerReg = captainReg;
          captainReg = pr;
        } else {
          partnerReg = pr;
        }
      }
    }

    const captain = playerById.get(captainReg.player_id);
    if (!captain) continue;
    const partner = partnerReg
      ? (playerById.get(partnerReg.player_id) ?? null)
      : null;

    teams.push({
      captainRegId: captainReg.id,
      partnerRegId: partnerReg?.id ?? null,
      captain,
      partner,
      registeredAt: captainReg.registered_at,
      // Captain's pool wins ties — the partner-link insert sequence
      // copies it onto the partner row anyway.
      poolIndex: captainReg.pool_index ?? partnerReg?.pool_index ?? null,
      seed: captainReg.seed ?? partnerReg?.seed ?? null,
      label: partner
        ? `${captain.first_name} ${captain.last_name} / ${partner.first_name} ${partner.last_name}`
        : `${captain.first_name} ${captain.last_name}`,
    });
  }

  // Sort by seed (ascending, unseeded last), then registration order so
  // the rank column reads top-to-bottom.
  teams.sort((a, b) => {
    const sa = a.seed ?? Number.POSITIVE_INFINITY;
    const sb = b.seed ?? Number.POSITIVE_INFINITY;
    if (sa !== sb) return sa - sb;
    return a.registeredAt.localeCompare(b.registeredAt);
  });
  return teams;
}

// Map every reg id (captain AND partner) to its team, since a match's
// winner_reg_id may point at either half of a doubles pair.
export function teamByAnyRegId(teams: Team[]): Map<string, Team> {
  const m = new Map<string, Team>();
  for (const t of teams) {
    m.set(t.captainRegId, t);
    if (t.partnerRegId) m.set(t.partnerRegId, t);
  }
  return m;
}

export function computeStandings(teams: Team[], rrMatches: Match[]): Standing[] {
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
  }

  const standings = Array.from(byCap.values());
  for (const s of standings) s.diff = s.pf - s.pa;
  standings.sort(
    (x, y) => y.wins - x.wins || y.diff - x.diff || y.pf - x.pf,
  );
  return standings;
}

// Medal podium from the playoff matches at round = playoff_rounds:
//   * position 0 = the gold-medal match  → winner=gold, loser=silver
//   * position 1 = the bronze-medal game → winner=bronze
// Works for both pairwise (R=1, N=4) and bracket-with-bronze (R=2, N=4)
// since both store the medal matches at the final round. Returns an empty
// array until the gold match is completed; bronze is added later when its
// match finishes.
export function computeMedals(
  event: { teams_advancing_to_playoff: number; playoff_rounds: number },
  playoffMatches: Match[],
  teamByReg: Map<string, Team>,
): Medal[] {
  if (event.teams_advancing_to_playoff <= 0) return [];
  const R = event.playoff_rounds;
  const goldMatch = playoffMatches.find(
    (m) => m.round === R && m.position === 0,
  );
  if (!goldMatch || goldMatch.status !== "completed") return [];

  const result: Medal[] = [];
  if (goldMatch.winner_reg_id) {
    const goldTeam = teamByReg.get(goldMatch.winner_reg_id);
    if (goldTeam) result.push({ team: goldTeam, place: "gold" });
  }
  const silverRegId =
    goldMatch.team_a_reg_id === goldMatch.winner_reg_id
      ? goldMatch.team_b_reg_id
      : goldMatch.team_a_reg_id;
  if (silverRegId) {
    const silverTeam = teamByReg.get(silverRegId);
    if (silverTeam) result.push({ team: silverTeam, place: "silver" });
  }
  const bronzeMatch = playoffMatches.find(
    (m) => m.round === R && m.position === 1,
  );
  if (bronzeMatch?.status === "completed" && bronzeMatch.winner_reg_id) {
    const bronzeTeam = teamByReg.get(bronzeMatch.winner_reg_id);
    if (bronzeTeam) result.push({ team: bronzeTeam, place: "bronze" });
  }
  return result;
}
