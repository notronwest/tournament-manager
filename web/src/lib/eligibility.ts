import type { Database } from "../types/supabase";

type Event = Database["public"]["Tables"]["events"]["Row"];

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
