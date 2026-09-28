/**
 * Domain types for the B&E → PickleballBrackets.com results-push driver.
 *
 * Everything here is defined from the **Bert & Erne (tournament-manager) side** —
 * the shape of what we READ and intend to reflect onto PB.com. The PB.com DOM /
 * form shapes are deliberately NOT modelled here; they are captured in the live
 * director-session trace and land in `src/pbcom/driver.ts`.
 *
 * Source of truth for these columns (tournament-manager, origin/main):
 *   • events, event_registrations, players, matches  — supabase/migrations/20260503000001_init_schema.sql
 *   • matches (scores/bracket)                        — supabase/migrations/20260504030000_matches.sql
 *   • double-elim bracket wiring                       — supabase/migrations/20260914210000_double_elim.sql
 *   • PB.com source-id preservation + DUPR            — supabase/migrations/20260928120000_pbcom_import_source_tracking.sql
 */

// ─────────────────────────────────────────────────────────────────────────────
// B&E domain (input to the push)
// ─────────────────────────────────────────────────────────────────────────────

/** A B&E division = one `events` row imported from PB.com. */
export interface BandeDivision {
  /** events.id */
  eventId: string;
  /** events.tournament_id */
  tournamentId: string;
  /** events.name */
  name: string;
  /** events.source_system — 'pbcom' for imported divisions, null for B&E-native. */
  sourceSystem: "pbcom" | null;
  /**
   * events.source_division_label — the exact PB.com division string
   * (e.g. "Mens Doubles Skill: (3.0 To 3.49)"). This is the division's IDENTITY
   * in PB.com and the join key for the push. Null for B&E-native divisions.
   */
  sourceDivisionLabel: string | null;
  /** events.format */
  format: "singles" | "doubles" | null;
  /** events.gender */
  gender: "men" | "women" | "mixed" | null;
  /** events.bracket_type — how B&E generated the draw. */
  bracketType:
    | "round_robin"
    | "single_elim"
    | "double_elim"
    | "pool_then_bracket"
    | null;
}

/**
 * A B&E entry = one `event_registrations` row. There is ONE row per player per
 * event; a doubles team of two is two rows linked by `partnerRegistrationId`
 * (and, when imported, a shared `sourceTeamId`).
 */
export interface BandeEntry {
  /** event_registrations.id */
  registrationId: string;
  /** event_registrations.event_id */
  eventId: string;
  /** event_registrations.player_id */
  playerId: string;
  /** event_registrations.partner_registration_id — the other half of a doubles team. */
  partnerRegistrationId: string | null;
  /** event_registrations.seed — the DUPR-seeded draw position (populated upstream). */
  seed: number | null;
  /** event_registrations.source_system */
  sourceSystem: "pbcom" | null;
  /** event_registrations.source_activity_id — PB.com per-entry id; strongest push key. */
  sourceActivityId: string | null;
  /** event_registrations.source_team_id — PB.com TeamID; shared by doubles partners. */
  sourceTeamId: string | null;
  /** event_registrations.source_attendee_header_id — PB.com per-attendee id. */
  sourceAttendeeHeaderId: string | null;
}

/**
 * A "team" as PB.com understands it: one entry (singles) or two partnered entries
 * (doubles). Derived from BandeEntry[] by `resolveTeams` (push/plan.ts).
 */
export interface BandeTeam {
  /** Stable local key for this team within its division. */
  teamKey: string;
  /** PB.com TeamID (doubles). Null for singles / solo. */
  sourceTeamId: string | null;
  /** 1 (singles) or 2 (doubles) event_registrations.id. */
  registrationIds: string[];
  /** The PB.com per-entry ids for this team's registrations (sorted, stable). */
  sourceActivityIds: string[];
  /** The team's draw seed (min of its members' seeds; null if unseeded). */
  seed: number | null;
}

/** A B&E match = one `matches` row. */
export interface BandeMatch {
  /** matches.id */
  matchId: string;
  /** matches.event_id */
  eventId: string;
  /** matches.stage */
  stage: "round_robin" | "playoff";
  /** matches.bracket — double-elim wiring; null for RR / single-elim. */
  bracket: "winners" | "consolation" | "final" | null;
  /** matches.round */
  round: number | null;
  /** matches.position — ordering within a round. */
  position: number | null;
  /** matches.slot_key — stable slot identity for double-elim feed-forward. */
  slotKey: string | null;
  /** matches.team_a_reg_id */
  teamARegId: string | null;
  /** matches.team_b_reg_id */
  teamBRegId: string | null;
  /** matches.status */
  status: "pending" | "in_progress" | "completed";
  /** matches.team_a_score — single aggregate score (no per-game table in B&E). */
  teamAScore: number | null;
  /** matches.team_b_score */
  teamBScore: number | null;
  /** matches.winner_reg_id */
  winnerRegId: string | null;
}

/**
 * The full B&E draw for ONE division that we intend to reflect onto PB.com.
 * This is the input the trace-filled form operations consume.
 */
export interface BandeDraw {
  division: BandeDivision;
  entries: BandeEntry[];
  matches: BandeMatch[];
}

// ─────────────────────────────────────────────────────────────────────────────
// PB.com binding (declarative config — NOT hardcoded)
// ─────────────────────────────────────────────────────────────────────────────

/** Optional per-division override of the default label→PB.com mapping. */
export interface PbcomDivisionBinding {
  /** Must equal events.source_division_label. */
  sourceDivisionLabel: string;
  /**
   * PB.com's own division/bracket id, if known after the trace. When absent the
   * driver locates the division on PB.com by its label (the import already proved
   * the label is PB.com's division identity).
   */
  pbcomDivisionId?: string;
}

/** Binds one B&E tournament to one PB.com event. */
export interface PbcomEventBinding {
  /** tournaments.id in B&E. */
  tournamentId: string;
  /** The PB.com event id — the `eid` in PB.com URLs; the tournament-level handle. */
  pbcomEid: string;
  /**
   * Which PB.com account drives this event. Credentials are resolved from the
   * environment (never stored here); this is a human-readable selector only.
   */
  pbcomAccountLabel?: string;
  /** Optional per-division overrides; by default divisions map by label. */
  divisions?: PbcomDivisionBinding[];
}

export interface BindingConfig {
  version: 1;
  events: PbcomEventBinding[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Push ledger (idempotency / reconcile state)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One recorded push. `matchIdentity` and `bracketIdentity` are computed from the
 * preserved PB.com source ids + B&E match identity (see push/plan.ts), so re-runs
 * recognise what already landed and only push the delta.
 */
export interface PushLedgerEntry {
  /** For a bracket-create record: the division identity. For a score: the match identity. */
  key: string;
  kind: "bracket" | "score";
  /** For scores: the score digest last confirmed on PB.com. Empty for brackets. */
  scoreDigest: string;
  /** When it was verified on PB.com. */
  pushedAt: string;
}

/**
 * The reconcile ledger. The scaffold ships an in-memory implementation for tests
 * and a documented DB-backed seam for production (see push/plan.ts §ledger).
 */
export interface PushLedger {
  /** All recorded pushes for a tournament (or division). */
  list(): Promise<PushLedgerEntry[]>;
  /** Record a confirmed push (called only AFTER PB.com verify succeeds). */
  record(entry: PushLedgerEntry): Promise<void>;
}
