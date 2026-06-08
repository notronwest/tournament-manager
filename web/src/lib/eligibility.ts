import type { Database } from "../types/supabase";

type Event = Database["public"]["Tables"]["events"]["Row"];
type Player = Database["public"]["Tables"]["players"]["Row"];

// Check whether a player meets an event's rating and gender requirements.
// Returns eligible=true when there are no restrictions or all are met.
// reasons is empty when eligible; each entry names a specific failing gate.
//
// Rating rule (matches the epic's open assumption): self-rating for the
// event's format/gender combination. Doubles + mixed gender → self_rating_mixed;
// doubles + men/women → self_rating_doubles; singles → self_rating_singles.
// A null self-rating for the required format counts as ineligible.
//
// Gender rule: mixed events never gate on gender. Men's → player.gender "M";
// women's → player.gender "F". Any other player gender (including null or "X")
// is blocked from a gendered event.
export function checkEligibility(
  player: Player,
  event: Event,
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (event.min_rating != null || event.max_rating != null) {
    const isMixedDoubles = event.format === "doubles" && event.gender === "mixed";
    const playerRating =
      event.format === "singles"
        ? player.self_rating_singles
        : isMixedDoubles
          ? player.self_rating_mixed
          : player.self_rating_doubles;

    if (playerRating == null) {
      const formatLabel =
        event.format === "singles"
          ? "singles"
          : isMixedDoubles
            ? "mixed doubles"
            : "doubles";
      reasons.push(`no ${formatLabel} self-rating on file`);
    } else {
      const lo = event.min_rating;
      const hi = event.max_rating;
      if ((lo != null && playerRating < lo) || (hi != null && playerRating > hi)) {
        let range: string;
        if (lo != null && hi != null) {
          range = `${formatRating(lo)}–${formatRating(hi)}`;
        } else if (lo != null) {
          range = `≥${formatRating(lo)}`;
        } else {
          range = `≤${formatRating(hi!)}`;
        }
        reasons.push(`needs rating ${range}`);
      }
    }
  }

  if (event.gender !== "mixed") {
    const required = event.gender === "men" ? "M" : "F";
    if (player.gender !== required) {
      const label = event.gender === "men" ? "men's" : "women's";
      reasons.push(`${label} event`);
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

// Render an event's eligibility settings (rating bounds, rating source,
// age bounds) as a list of compact chips. Returns an empty array when
// nothing is configured. Caller decides how to display them.
export function eligibilityChips(event: Event): string[] {
  const chips: string[] = [];

  if (event.min_rating != null || event.max_rating != null) {
    let r: string;
    if (event.min_rating != null && event.max_rating != null) {
      r = `${formatRating(event.min_rating)}–${formatRating(event.max_rating)}`;
    } else if (event.min_rating != null) {
      r = `≥${formatRating(event.min_rating)}`;
    } else {
      r = `≤${formatRating(event.max_rating!)}`;
    }
    if (event.rating_source) {
      r += ` ${ratingSourceLabel(event.rating_source)}`;
    }
    chips.push(r);
  }

  if (event.min_age != null || event.max_age != null) {
    if (event.min_age != null && event.max_age != null) {
      chips.push(`age ${event.min_age}–${event.max_age}`);
    } else if (event.min_age != null) {
      chips.push(`${event.min_age}+`);
    } else {
      chips.push(`≤${event.max_age}`);
    }
  }

  return chips;
}

function formatRating(n: number): string {
  // Trim trailing zeroes so "3.50" → "3.5", but keep "3.0" → "3.0".
  const s = n.toString();
  return s.includes(".") ? s : `${s}.0`;
}

function ratingSourceLabel(
  s: Database["public"]["Enums"]["rating_source"],
): string {
  switch (s) {
    case "dupr":
      return "DUPR";
    case "pbvision":
      return "PB Vision";
    case "wmpc_rating_hub":
      return "WMPC";
    case "self":
      return "Self-rated";
  }
}
