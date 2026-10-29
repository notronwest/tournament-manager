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
    const playerRating = selfRatingFor(player, event);

    if (playerRating == null) {
      reasons.push(`no ${ratingFormatLabel(event)} self-rating on file`);
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

// Exported because the family list and the rating chips show the same
// numbers; one reading of "3.50" → "3.5" keeps the bracket's bound and a
// player's own rating from printing differently.
export function formatRating(n: number): string {
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

// Which of the player's three self-rating columns this event reads. The
// format/gender pairing is the rule itself, so it lives in one place: the
// gate below and the "what is missing" answer above must never disagree
// about which rating they are talking about.
function selfRatingFor(player: Player, event: Event): number | null {
  if (event.format === "singles") return player.self_rating_singles;
  if (event.format === "doubles" && event.gender === "mixed") return player.self_rating_mixed;
  return player.self_rating_doubles;
}

function ratingFormatLabel(event: Event): string {
  if (event.format === "singles") return "singles";
  if (event.format === "doubles" && event.gender === "mixed") return "mixed doubles";
  return "doubles";
}

// What this player is missing that whoever is looking at the screen can
// actually go and supply — the refusals that are a BLANK FIELD rather than a
// mismatch, named in the words the form that fills them uses.
//
// A rating that is simply outside the bracket's range is NOT in here, and
// neither is a gender that is set to the other one. The fix for those is a
// different bracket; advising someone to edit the value until it fits is
// advice the same gate rejects on the next bracket along, which is the defect
// the design gate caught twice on the register form (#1182) — copy that named
// a move the gate would refuse.
//
// `coversEverything` is the question the caller actually has: may I tell this
// person that filling these fields will let them in? Only when every reason
// the gate gave is one of these blanks. A 40+ bracket refusing an adult for
// their age AND their missing rating is not fixable by filling the rating in,
// so the advice there has to stay "pick a different event".
export function profileGaps(
  player: Player,
  event: Event,
  tournamentStartsAt?: string | null,
): { fields: string[]; coversEverything: boolean } {
  const fields: string[] = [];

  if (event.min_rating != null || event.max_rating != null) {
    if (selfRatingFor(player, event) == null) fields.push("a rating");
  }
  if ((event.gender === "men" || event.gender === "women") && player.gender == null) {
    fields.push("a gender");
  }
  if ((event.min_age != null || event.max_age != null) && player.dob == null) {
    fields.push("a date of birth");
  }

  const { reasons } = checkEligibility(player, event, tournamentStartsAt);
  return { fields, coversEverything: fields.length > 0 && fields.length === reasons.length };
}

// "a rating", "a rating and a gender", "a rating, a gender and a date of
// birth" — the gaps above, read as a sentence.
export function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
