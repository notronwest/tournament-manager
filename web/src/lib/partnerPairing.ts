// Helpers for pairing two partner-seekers inside one division (Attendees →
// "Looking for a partner"). Kept out of the component file so fast refresh
// stays happy and the rules are unit-testable.
import type { Database } from "../types/supabase";

type Player = Database["public"]["Tables"]["players"]["Row"];
type EventGender = Database["public"]["Enums"]["event_gender"];

export type Seeker = {
  regId: string;
  playerId: string;
  player: Player;
};

export type PairableEvent = {
  id: string;
  name: string;
  gender: EventGender;
};

// Mixed doubles is one man + one woman. Players who haven't set a gender
// (null / X — optional and inclusive, see CLAUDE.md) are never blocked; only a
// KNOWN same-gender pair is. Every other division pairs anyone with anyone.
export function isMixedCompatible(
  event: PairableEvent,
  a: Player,
  b: Player,
): boolean {
  if (event.gender !== "mixed") return true;
  const ga = a.gender;
  const gb = b.gender;
  if (!ga || !gb || ga === "X" || gb === "X") return true;
  return ga !== gb;
}

export function genderLabel(g: Player["gender"]): string | null {
  if (g === "M") return "M";
  if (g === "F") return "F";
  return null;
}

// The rating that matters for this division: mixed → self_rating_mixed, else
// doubles. Falls back across the two so a player who only filled one still
// shows something.
export function seekerRating(event: PairableEvent, p: Player): string | null {
  const r =
    event.gender === "mixed"
      ? (p.self_rating_mixed ?? p.self_rating_doubles)
      : (p.self_rating_doubles ?? p.self_rating_mixed);
  return r == null ? null : Number(r).toFixed(2);
}

export function seekerFullName(p: Player): string {
  return `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "(no name)";
}
