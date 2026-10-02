import { supabase } from "../supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/supabase";
import { winnerTarget, bronzeTarget, type FeedTarget } from "./playoffBracket";

type Match = Database["public"]["Tables"]["matches"]["Row"];
// Double-elimination wiring (migration 20260914210000) — generated types lag it.
type Wired = Match & {
  bracket?: "winners" | "consolation" | "final" | null;
  if_necessary?: boolean | null;
  feeds_winner_to?: string | null;
  feeds_winner_side?: "a" | "b" | null;
  feeds_loser_to?: string | null;
  feeds_loser_side?: "a" | "b" | null;
};
const untyped = supabase as unknown as SupabaseClient;

// After a playoff match is completed, populate the next-round slot(s). The
// bracket's topology lives entirely in (round, position) — there's no explicit
// next-match pointer — so routing is pure position arithmetic driven by the
// event's playoff_rounds (R). See playoffBracket.ts for the math and tests.
//
//   * Pairwise (R <= 1): each match is its own medal slot — nothing to do.
//   * Single-elim bracket (R >= 2): the winner advances to floor(position/2)
//     of the next round (winnerTarget); a semifinal LOSER drops into the
//     bronze game (bronzeTarget). Earlier-round losers are eliminated.
//
// This is the same scheme for Top-4 (R=2), Top-6 and Top-8 (R=3). Each update
// is guarded by the target match actually existing (maybeSingle), so a bracket
// that happens to lack a bronze game just no-ops rather than erroring.
export async function feedForwardPlayoffWinners(
  match: Match,
  winnerRegId: string,
  loserRegId: string | null,
) {
  if (match.stage !== "playoff" || !winnerRegId) return;

  // Data-driven (double elimination): the row says where its winner and
  // loser go. Crossover final: if the Winners champion (side a) wins F1, the
  // if-necessary F2 is deleted instead of fed.
  const w = match as Wired;
  if (w.bracket) {
    if (w.bracket === "final" && !w.if_necessary && winnerRegId === match.team_a_reg_id) {
      await untyped.from("matches").delete().eq("event_id", match.event_id).eq("if_necessary", true);
      return;
    }
    if (w.feeds_winner_to && w.feeds_winner_side) {
      await supabase
        .from("matches")
        .update(w.feeds_winner_side === "a" ? { team_a_reg_id: winnerRegId } : { team_b_reg_id: winnerRegId })
        .eq("id", w.feeds_winner_to);
    }
    if (w.feeds_loser_to && w.feeds_loser_side && loserRegId) {
      await supabase
        .from("matches")
        .update(w.feeds_loser_side === "a" ? { team_a_reg_id: loserRegId } : { team_b_reg_id: loserRegId })
        .eq("id", w.feeds_loser_to);
    }
    return;
  }

  const { data: event } = await supabase
    .from("events")
    .select("playoff_rounds")
    .eq("id", match.event_id)
    .maybeSingle();
  if (!event) return;

  const R = event.playoff_rounds;
  // R <= 1: pairwise medal matches are self-contained.
  if (R <= 1) return;

  const fill = async (target: FeedTarget | null, regId: string | null) => {
    if (!target || !regId) return;
    const { data: next } = await supabase
      .from("matches")
      .select("id")
      .eq("event_id", match.event_id)
      .eq("stage", "playoff")
      .eq("round", target.round)
      .eq("position", target.position)
      .maybeSingle();
    if (!next) return;
    await supabase
      .from("matches")
      .update(
        target.slot === "a"
          ? { team_a_reg_id: regId }
          : { team_b_reg_id: regId },
      )
      .eq("id", next.id);
  };

  // Winner advances; a semifinal loser drops to the bronze game.
  await fill(winnerTarget(match.round, match.position, R), winnerRegId);
  await fill(bronzeTarget(match.round, match.position, R), loserRegId);
}
