// Self-reported ratings: the three formats, the columns they live in, and the
// one-line summary a family row shows for a child (#1183).
//
// Self-ratings are COLUMNS on the player row (self_rating_doubles / _mixed /
// _singles), not rows in player_ratings — that table holds external feeds
// with their own as_of dates. The player_self_ratings migration records the
// decision; this file is the client's single statement of the same three
// pairs, which the rating group, the register form's rating gate and the
// guardian writer all read instead of repeating them.
import type { Database } from "../types/supabase";
import { formatRating } from "./eligibility";

type Player = Database["public"]["Tables"]["players"]["Row"];
type PlayerGender = Database["public"]["Enums"]["player_gender"];

export type RatingFormat = "doubles" | "mixed" | "singles";

// The three formats, in the order they are always shown.
export const RATING_FORMATS: readonly RatingFormat[] = ["doubles", "mixed", "singles"];

export const RATING_COLUMN = {
  doubles: "self_rating_doubles",
  mixed: "self_rating_mixed",
  singles: "self_rating_singles",
} as const;

// What a bracket calls the format, for the label above a picker. The
// "(same-gender)" matters only where the three sit together and the
// distinction between doubles and mixed is the point.
export const FORMAT_LABEL: Record<RatingFormat, string> = {
  doubles: "Doubles (same-gender)",
  mixed: "Mixed doubles",
  singles: "Singles",
};

// Shorter: an accessible name, and the summary line on a family row.
export const FORMAT_SHORT: Record<RatingFormat, string> = {
  doubles: "Doubles",
  mixed: "Mixed doubles",
  singles: "Singles",
};

export type RatingValues = Record<RatingFormat, number | null>;

export function ratingValuesOf(player: Player): RatingValues {
  return {
    doubles: player.self_rating_doubles,
    mixed: player.self_rating_mixed,
    singles: player.self_rating_singles,
  };
}

// The words the gender select offers, for reading a stored value back.
export function genderLabel(gender: PlayerGender | null): string | null {
  switch (gender) {
    case "M":
      return "Male";
    case "F":
      return "Female";
    case "X":
      return "Other";
    default:
      return null;
  }
}

// What this player has on file that a bracket checks, for the muted line
// under their name on the family list.
//
// A missing rating is NAMED, because most real divisions have a skill bound
// and a child without one is refused. A missing gender is NOT: gender is
// optional by design and only a men's or women's bracket reads it, so
// nagging for it would ask every parent to answer a question almost none of
// them need (see lib/eligibility.ts).
export function selfRatingSummary(player: Player): string {
  const values = ratingValuesOf(player);
  const parts: string[] = [];
  for (const f of RATING_FORMATS) {
    const v = values[f];
    if (v != null) parts.push(`${FORMAT_SHORT[f]} ${formatRating(v)}`);
  }
  if (parts.length === 0) parts.push("No rating yet");

  const g = genderLabel(player.gender);
  if (g) parts.push(g);

  return parts.join(" · ");
}
