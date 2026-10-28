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
// Gender rule: mixed and open events never gate on gender. Men's →
// player.gender "M"; women's → player.gender "F". Any other player gender
// (including null or "X") is blocked from a single-gender event.
//
// Age rule (#1169): only when the event sets min_age or max_age. Age is
// measured at the TOURNAMENT'S START, not today — "18 & under" is a statement
// about the day of play, and measuring at registration time would let
// eligibility drift as a bracket sits open. Pass the tournament's starts_at;
// without it this falls back to today, which is only right for a bracket
// being entered on the day. A null dob is ineligible for an age-restricted
// event (the same treatment the rating gate gives a missing self-rating) and
// irrelevant for an event that sets no bound.
//
// This function is the FRIENDLY HALF of a deliberate double implementation.
// enforce_event_eligibility() in the database is the trust boundary and
// carries the identical rule; a rule added only here is bypassable by posting
// straight to PostgREST. Keep the two in step — including the UTC date both
// sides measure age against, so they cannot disagree by a day over a timezone.
export function checkEligibility(
  player: Player,
  event: Event,
  tournamentStartsAt?: string | null,
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

  // Only the two single-gender divisions gate on gender. `event_gender` has
  // four values — men | women | mixed | open — and both mixed and open are
  // open to any pairing, so they gate on gender for no one. Checking the two
  // gated values explicitly (rather than excusing one) keeps a future enum
  // value from silently falling into the women's branch, which is exactly
  // how `open` came to reject every player who was not female (#1170).
  if (event.gender === "men" || event.gender === "women") {
    const required = event.gender === "men" ? "M" : "F";
    if (player.gender !== required) {
      const label = event.gender === "men" ? "men's" : "women's";
      reasons.push(`${label} event`);
    }
  }

  if (event.min_age != null || event.max_age != null) {
    const age = ageAt(player.dob, tournamentStartsAt);
    if (age == null) {
      reasons.push("needs a date of birth on file");
    } else if (
      (event.min_age != null && age < event.min_age) ||
      (event.max_age != null && age > event.max_age)
    ) {
      reasons.push(`needs age ${ageRangeLabel(event.min_age, event.max_age)}`);
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

// Full years old on the day of the event. Returns null when there's no dob to
// go on, which the caller reads as "can't tell".
//
// Everything here is UTC: the trigger compares against
// (tournaments.starts_at at time zone 'UTC')::date, so reading the same UTC
// calendar date is what keeps the two sides from disagreeing by a day for a
// player whose birthday falls on the event. Parsing dob by its parts rather
// than through Date() avoids the opposite trap — "2015-06-01" through the
// Date constructor is midnight UTC, which is the previous day in any western
// timezone.
export function ageAt(dob: string | null, asOf?: string | null): number | null {
  const birth = isoDateParts(dob);
  if (!birth) return null;

  const at = asOf ? new Date(asOf) : new Date();
  if (Number.isNaN(at.getTime())) return null;
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth() + 1;
  const d = at.getUTCDate();

  let years = y - birth.y;
  if (m < birth.m || (m === birth.m && d < birth.d)) years -= 1;
  return years;
}

function isoDateParts(value: string | null): { y: number; m: number; d: number } | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

// Mirrors the range text enforce_event_eligibility() builds, so the browser's
// message and the database's rejection read the same.
function ageRangeLabel(min: number | null, max: number | null): string {
  if (min != null && max != null) return `${min}–${max}`;
  if (min != null) return `${min}+`;
  return `${max} or under`;
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
