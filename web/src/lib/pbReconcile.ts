import {
  divisionKey,
  type DivisionMeta,
  type ParsedAttendees,
} from "./pbImport";

// ─────────────────────────────────────────────────────────────────────────
// PB.com import — the pure reconcile planner.
//
// Given the attendees parsed from a PB.com "Export Player w/ Events" file and
// the pbcom-sourced state already in B&E, decide WHAT the import should do — with
// no database access, so the whole decision is unit-testable and previewable.
//
// This is the canonical spec; the import-pb-registrations edge function
// reproduces it at write time, preserving PB.com's source ids on every record:
//   • divisionsToCreate → create a B&E event (division) from the parsed label,
//                          tagged source_division_label (idempotent by label).
//   • players           → create or match by email/name; ALWAYS refresh the
//                          authoritative DUPR id + ratings (they change between
//                          registration open and Wed-night close, and B&E seeds
//                          the draw from them).
//   • toAdd             → insert an event_registration (source_activity_id) if
//                          none exists.
//   • unchanged         → the entry's ActivityID already imported → skip (this
//                          is what makes re-import idempotent — no duplicates).
//   • toDrop            → a pbcom entry in B&E whose ActivityID is gone from the
//                          file → REPORT only; the import never deletes.
//   • pairs             → two entries sharing a TeamID in one division are
//                          doubles partners → link them.
// The bracket DRAW is a separate concern (B&E generates it from DUPR); not here.
// ─────────────────────────────────────────────────────────────────────────

export type PlanPlayer = {
  key: string; // identity key: `email:<lower>` or `name:<first last>`
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  gender: "M" | "F" | "X" | null;
  attendeeHeaderId: string | null;
  // Authoritative DUPR data — first-class (drives B&E seeding). null when absent.
  duprId: string | null;
  duprDoubles: number | null;
  duprSingles: number | null;
};

export type DesiredDivision = DivisionMeta & { key: string };

export type DesiredEntry = {
  activityId: string | null; // PB per-entry id (primary idempotency key)
  playerKey: string;
  divisionKey: string;
  divisionLabel: string;
  teamId: string | null;
};

export type ExistingEntry = {
  activityId: string | null;
  divisionKey: string;
  playerKey: string;
};

export type DesiredPair = {
  divisionKey: string;
  aKey: string;
  bKey: string;
};

export type ImportPlan = {
  players: PlanPlayer[];
  divisionsToCreate: DesiredDivision[];
  divisionsExisting: string[]; // division keys already present as B&E events
  toAdd: DesiredEntry[];
  unchanged: DesiredEntry[];
  toDrop: ExistingEntry[];
  pairs: DesiredPair[];
  skippedRows: number;
  warnings: string[];
};

// ── normalization ─────────────────────────────────────────────────────────

export function normEmail(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().toLowerCase();
  return s && s.includes("@") ? s : null;
}

export function nameKey(first: string, last: string): string {
  return `${first} ${last}`.trim().toLowerCase().replace(/\s+/g, " ");
}

export function playerKeyOf(email: string, first: string, last: string): string {
  const e = normEmail(email);
  if (e) return `email:${e}`;
  const n = nameKey(first, last);
  return n ? `name:${n}` : "";
}

export function normGender(v: string | null | undefined): "M" | "F" | "X" | null {
  const s = (v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "m" || s.startsWith("male") || s === "man" || s === "men") return "M";
  if (s === "f" || s.startsWith("female") || s === "woman" || s === "women") return "F";
  if (s === "x" || s.startsWith("non") || s.startsWith("other")) return "X";
  return null;
}

// PB.com uses 0 to mean "no DUPR rating provided" — treat 0 (and blanks/junk)
// as null so we never seed a bracket off a fake 0.00.
export function parseDupr(v: string | null | undefined): number | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n >= 10) return null;
  return Math.round(n * 100) / 100;
}

export function normDuprId(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s ? s : null;
}

// ── the planner ─────────────────────────────────────────────────────────

export function buildPlan(
  parsed: ParsedAttendees,
  existing: {
    // division keys already created as B&E events for this tournament
    divisionKeys: string[];
    // pbcom entries already imported (by ActivityID / division / player)
    entries: ExistingEntry[];
  },
): ImportPlan {
  const warnings: string[] = [];
  const players = new Map<string, PlanPlayer>();
  const divisions = new Map<string, DesiredDivision>();
  const desiredEntries: DesiredEntry[] = [];
  // For pairing: (divisionKey, teamId) → list of playerKeys.
  const teams = new Map<string, { playerKey: string; entryKey: string }[]>();
  let skippedRows = parsed.skippedRows;

  for (const a of parsed.attendees) {
    const key = playerKeyOf(a.email, a.firstName, a.lastName);
    if (!key) {
      // No email and no name → can't create a player.
      skippedRows += Math.max(1, a.entries.length);
      continue;
    }

    // Dedupe/merge the player. DUPR fields prefer any non-null value seen.
    const prev = players.get(key);
    const merged: PlanPlayer = {
      key,
      firstName: prev?.firstName || a.firstName || a.lastName,
      lastName: prev?.lastName || (a.firstName ? a.lastName : ""),
      email: prev?.email ?? normEmail(a.email),
      phone: prev?.phone ?? (a.phone.trim() || null),
      gender: prev?.gender ?? normGender(a.gender),
      attendeeHeaderId: prev?.attendeeHeaderId ?? (a.attendeeHeaderId || null),
      duprId: prev?.duprId ?? normDuprId(a.duprId),
      duprDoubles: prev?.duprDoubles ?? parseDupr(a.ratingDuprDbl),
      duprSingles: prev?.duprSingles ?? parseDupr(a.ratingDuprS),
    };
    players.set(key, merged);

    for (const entry of a.entries) {
      const dkey = divisionKey(entry.divisionLabel);
      if (!divisions.has(dkey)) {
        divisions.set(dkey, { key: dkey, ...entry.division });
      }
      const desired: DesiredEntry = {
        activityId: entry.activityId || null,
        playerKey: key,
        divisionKey: dkey,
        divisionLabel: entry.divisionLabel,
        teamId: entry.teamId || null,
      };
      desiredEntries.push(desired);

      // Group doubles partners by shared TeamID within the division.
      if (entry.division.format === "doubles" && entry.teamId) {
        const teamKey = `${dkey}::${entry.teamId}`;
        const list = teams.get(teamKey) ?? [];
        list.push({ playerKey: key, entryKey: `${key}::${dkey}` });
        teams.set(teamKey, list);
      }
    }
  }

  // Pairs: exactly two members of a TeamID → a confirmed doubles team.
  const pairs: DesiredPair[] = [];
  for (const [teamKey, members] of teams) {
    const [dkey] = teamKey.split("::");
    const uniq = [...new Map(members.map((m) => [m.playerKey, m])).values()];
    if (uniq.length === 2) {
      pairs.push({ divisionKey: dkey, aKey: uniq[0].playerKey, bKey: uniq[1].playerKey });
    } else if (uniq.length > 2) {
      warnings.push(
        `TeamID in "${dkey}" has ${uniq.length} members — expected 2 for a doubles team; left unpaired.`,
      );
    }
  }

  // Divisions: create the ones not already present as B&E events.
  const existingDivKeys = new Set(existing.divisionKeys);
  const divisionsToCreate: DesiredDivision[] = [];
  const divisionsExisting: string[] = [];
  for (const d of divisions.values()) {
    if (existingDivKeys.has(d.key)) divisionsExisting.push(d.key);
    else divisionsToCreate.push(d);
    if (!d.format) warnings.push(`Division "${d.raw}" — couldn't detect singles/doubles; defaulting to doubles.`);
    if (!d.gender) warnings.push(`Division "${d.raw}" — couldn't detect gender; defaulting to mixed.`);
  }

  // Reconcile desired entries vs existing, keyed by (player, division) — the
  // SAME identity the edge function writes on (one registration per player per
  // division). PB.com's ActivityID is the DIVISION id, shared by every
  // registrant in a division, so it is NEVER a per-entry key: matching on it
  // marks a NEW player in an existing division as "unchanged" (0 to add) and a
  // whole division collapses to one registration. (#985/#987 fixed the writer;
  // this is the same fix in the preview/plan layer.)
  const existingByCompound = new Set(
    existing.entries.map((e) => `${e.playerKey}::${e.divisionKey}`),
  );
  const toAdd: DesiredEntry[] = [];
  const unchanged: DesiredEntry[] = [];
  const desiredCompound = new Set<string>();
  for (const e of desiredEntries) {
    const key = `${e.playerKey}::${e.divisionKey}`;
    desiredCompound.add(key);
    if (existingByCompound.has(key)) unchanged.push(e);
    else toAdd.push(e);
  }

  // Drops: pbcom entries in B&E no longer in the file (by player+division).
  const toDrop = existing.entries.filter(
    (e) => !desiredCompound.has(`${e.playerKey}::${e.divisionKey}`),
  );

  return {
    players: [...players.values()],
    divisionsToCreate,
    divisionsExisting,
    toAdd,
    unchanged,
    toDrop,
    pairs,
    skippedRows,
    warnings,
  };
}

// Convenience: attendees + entries totals for the preview summary line.
export function planTotals(plan: ImportPlan) {
  return {
    players: plan.players.length,
    divisions: plan.divisionsToCreate.length + plan.divisionsExisting.length,
    divisionsNew: plan.divisionsToCreate.length,
    entries: plan.toAdd.length + plan.unchanged.length,
    add: plan.toAdd.length,
    unchanged: plan.unchanged.length,
    drop: plan.toDrop.length,
    pairs: plan.pairs.length,
  };
}
