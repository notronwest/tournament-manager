import { supabase } from "../supabase";
import type { Database } from "../types/supabase";

type Match = Database["public"]["Tables"]["matches"]["Row"];

// After a playoff match is completed, populate the next-round slot(s).
// Reads the parent event's playoff_rounds + teams_advancing_to_playoff
// to decide what shape the bracket has, so this works for both
// pairwise-medal (R=1) and traditional bracket-with-bronze (R=2, N=4)
// structures.
//
// Pairwise (R=1): each match is its own medal slot — nothing to do.
// 2-round bracket with bronze (R=2, N=4): R1 winners feed the gold
// final; R1 losers feed the bronze game.
// Legacy fallback: simple winner-only feed-forward into the next round
// (used by playoff matches generated before the format-config migration).
export async function feedForwardPlayoffWinners(
  match: Match,
  winnerRegId: string,
  loserRegId: string | null,
) {
  if (match.stage !== "playoff" || !winnerRegId) return;

  const { data: event } = await supabase
    .from("events")
    .select("playoff_rounds, teams_advancing_to_playoff")
    .eq("id", match.event_id)
    .maybeSingle();
  if (!event) return;

  // R=1: each match is self-contained.
  if (event.playoff_rounds <= 1) return;

  // R=2, N=4: bronze on round 2 position 1, gold on round 2 position 0.
  if (event.playoff_rounds === 2 && event.teams_advancing_to_playoff === 4) {
    if (match.round !== 1) return;
    const slot: "a" | "b" = match.position % 2 === 0 ? "a" : "b";

    const { data: gold } = await supabase
      .from("matches")
      .select("id")
      .eq("event_id", match.event_id)
      .eq("stage", "playoff")
      .eq("round", 2)
      .eq("position", 0)
      .maybeSingle();
    if (gold) {
      await supabase
        .from("matches")
        .update(
          slot === "a"
            ? { team_a_reg_id: winnerRegId }
            : { team_b_reg_id: winnerRegId },
        )
        .eq("id", gold.id);
    }

    if (loserRegId) {
      const { data: bronze } = await supabase
        .from("matches")
        .select("id")
        .eq("event_id", match.event_id)
        .eq("stage", "playoff")
        .eq("round", 2)
        .eq("position", 1)
        .maybeSingle();
      if (bronze) {
        await supabase
          .from("matches")
          .update(
            slot === "a"
              ? { team_a_reg_id: loserRegId }
              : { team_b_reg_id: loserRegId },
          )
          .eq("id", bronze.id);
      }
    }
    return;
  }

  // Legacy single-elim bracket fallback.
  const nextRound = match.round + 1;
  const nextPos = Math.floor(match.position / 2);
  const nextSlot: "a" | "b" = match.position % 2 === 0 ? "a" : "b";
  const { data: next } = await supabase
    .from("matches")
    .select("id")
    .eq("event_id", match.event_id)
    .eq("stage", "playoff")
    .eq("round", nextRound)
    .eq("position", nextPos)
    .maybeSingle();
  if (next) {
    await supabase
      .from("matches")
      .update(
        nextSlot === "a"
          ? { team_a_reg_id: winnerRegId }
          : { team_b_reg_id: winnerRegId },
      )
      .eq("id", next.id);
  }
}
