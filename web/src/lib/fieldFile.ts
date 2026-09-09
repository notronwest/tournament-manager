import type { Database } from "../types/supabase";

// The "locked field" file: what Ron exports Friday AM (while still online)
// and imports into the offline laptop to seed a tournament's brackets. Plain
// JSON on disk, not an API sync — see issue #736 / the offline epic (#732).
//
// File shape (formatVersion 1):
//   {
//     "formatVersion": 1,
//     "exportedAt": "<ISO timestamp>",
//     "tournamentName": "<string>",
//     "events": [
//       {
//         "name": "<event name — matched against the offline DB's events by
//                   case-insensitive name; the tournament + events themselves
//                   are assumed to already exist offline, only the roster is
//                   imported>",
//         "format": "singles" | "doubles",
//         "gender": "men" | "women" | "mixed" | "open",
//         "teams": [
//           {
//             "seed": <number | null>,
//             "players": [ <FieldPlayer>, <FieldPlayer optional for doubles> ]
//           }
//         ]
//       }
//     ]
//   }
// Only active registrations (not cancelled/refunded/withdrawn) are included —
// that's the field that's actually locked in to play.

type EventFormat = Database["public"]["Enums"]["event_format"];
type EventGender = Database["public"]["Enums"]["event_gender"];
type PlayerGender = Database["public"]["Enums"]["player_gender"];
type RegistrationStatus = Database["public"]["Enums"]["registration_status"];

export type FieldPlayer = {
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  gender: PlayerGender | null;
  dob: string | null;
};

export type FieldTeam = {
  seed: number | null;
  players: FieldPlayer[];
};

export type FieldEvent = {
  name: string;
  format: EventFormat;
  gender: EventGender;
  teams: FieldTeam[];
};

export type FieldFile = {
  formatVersion: 1;
  exportedAt: string;
  tournamentName: string;
  events: FieldEvent[];
};

// Registrations in one of these states are out of the field.
const INACTIVE: RegistrationStatus[] = ["cancelled", "refunded", "withdrawn"];

export type SourcePlayer = {
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  gender: PlayerGender | null;
  dob: string | null;
};

export type SourceReg = {
  id: string;
  partner_registration_id: string | null;
  status: RegistrationStatus;
  seed: number | null;
  player: SourcePlayer;
};

export type SourceEvent = {
  id: string;
  name: string;
  format: EventFormat;
  gender: EventGender;
};

function toFieldPlayer(p: SourcePlayer): FieldPlayer {
  return {
    first_name: p.first_name,
    last_name: p.last_name,
    email: p.email,
    phone: p.phone,
    city: p.city,
    state: p.state,
    gender: p.gender,
    dob: p.dob,
  };
}

export function buildFieldFile(
  tournamentName: string,
  now: Date,
  events: SourceEvent[],
  regsByEvent: Map<string, SourceReg[]>,
): FieldFile {
  const fieldEvents: FieldEvent[] = events.map((ev) => {
    const regs = (regsByEvent.get(ev.id) ?? []).filter(
      (r) => !INACTIVE.includes(r.status),
    );
    const byId = new Map(regs.map((r) => [r.id, r]));
    const seen = new Set<string>();
    const teams: FieldTeam[] = [];
    for (const r of regs) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const partner = r.partner_registration_id
        ? byId.get(r.partner_registration_id)
        : undefined;
      if (partner) seen.add(partner.id);
      teams.push({
        seed: r.seed ?? partner?.seed ?? null,
        players: partner
          ? [toFieldPlayer(r.player), toFieldPlayer(partner.player)]
          : [toFieldPlayer(r.player)],
      });
    }
    return { name: ev.name, format: ev.format, gender: ev.gender, teams };
  });

  return {
    formatVersion: 1,
    exportedAt: now.toISOString(),
    tournamentName,
    events: fieldEvents,
  };
}

export function parseFieldFile(text: string): FieldFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (!isFieldFile(parsed)) {
    throw new Error(
      "That file doesn't match the expected locked-field format (formatVersion 1).",
    );
  }
  return parsed;
}

function isFieldFile(v: unknown): v is FieldFile {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return (
    f.formatVersion === 1 &&
    typeof f.tournamentName === "string" &&
    Array.isArray(f.events) &&
    f.events.every(isFieldEvent)
  );
}

function isFieldEvent(v: unknown): v is FieldEvent {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.name === "string" &&
    e.name.trim() !== "" &&
    Array.isArray(e.teams) &&
    e.teams.every(isFieldTeam)
  );
}

function isFieldTeam(v: unknown): v is FieldTeam {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return (
    Array.isArray(t.players) &&
    t.players.length >= 1 &&
    t.players.length <= 2 &&
    t.players.every(isFieldPlayer)
  );
}

function isFieldPlayer(v: unknown): v is FieldPlayer {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return typeof p.first_name === "string" && p.first_name.trim() !== "";
}

export function fieldFilename(tournamentName: string, today: Date): string {
  const slug =
    tournamentName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "tournament";
  const date = today.toISOString().slice(0, 10);
  return `field-${slug}-${date}.json`;
}

// Trigger a browser download of `data` as pretty-printed JSON.
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
