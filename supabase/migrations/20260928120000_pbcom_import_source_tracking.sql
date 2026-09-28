-- ─────────────────────────────────────────────────────────────────────
-- PickleballBrackets.com registration import — source-id preservation + DUPR.
--
-- Bridge (D-0045 / #981): PB.com owns registration and the initial
-- division/bracket setup; when registration closes B&E imports the players +
-- divisions + partnerships from PB.com's "Export Player w/ Events (Flat File)"
-- and then RUNS the event. To let the later results-push (#982) map cleanly back
-- to PB.com, every imported B&E record keeps PB.com's identifiers:
--   * events                — the source division label (its identity in PB.com)
--   * event_registrations   — the ActivityID (per-entry), TeamID (partner group),
--                             AttendeeHeaderID (per-attendee)
-- DUPR is first-class on the player because B&E GENERATES the draw seeded by DUPR
-- (the draw is a separate concern from this import). A re-import refreshes DUPR
-- (ratings change between registration open and the Wed-night close).
--
-- All columns are nullable / additive — nothing here affects the existing public
-- registration flow. Writes happen only in the import-pb-registrations edge
-- function (service_role). No RLS change: these columns ride the existing
-- events / event_registrations / players policies.
-- ─────────────────────────────────────────────────────────────────────

set search_path = public;

-- ── players: authoritative DUPR (drives seeding) ─────────────────────────
alter table public.players
  add column if not exists dupr_id text,
  add column if not exists dupr_rating_doubles numeric(4,2)
    check (dupr_rating_doubles is null or (dupr_rating_doubles > 0 and dupr_rating_doubles < 10)),
  add column if not exists dupr_rating_singles numeric(4,2)
    check (dupr_rating_singles is null or (dupr_rating_singles > 0 and dupr_rating_singles < 10));

comment on column public.players.dupr_id is
  'DUPR player id from a PB.com import (source_system=pbcom). Null when the '
  'registrant had no DUPR id on file. Refreshed on re-import.';
comment on column public.players.dupr_rating_doubles is
  'Authoritative DUPR doubles rating; B&E seeds doubles draws from it. Null when '
  'PB.com reported 0 / no rating. Refreshed on re-import.';
comment on column public.players.dupr_rating_singles is
  'Authoritative DUPR singles rating; B&E seeds singles draws from it. Null when '
  'PB.com reported 0 / no rating. Refreshed on re-import.';

-- ── events: source division identity ─────────────────────────────────────
alter table public.events
  add column if not exists source_system text
    check (source_system is null or source_system in ('pbcom')),
  add column if not exists source_division_label text,
  add column if not exists source_division_meta jsonb;

comment on column public.events.source_system is
  'Where this division came from, e.g. ''pbcom'' (PickleballBrackets import). '
  'Null for divisions created directly in B&E.';
comment on column public.events.source_division_label is
  'The exact PB.com division string this event was created from '
  '(e.g. "Mens Doubles Skill: (3.0 To 3.49)"). Its identity for idempotent '
  're-import and for mapping results back to PB.com.';
comment on column public.events.source_division_meta is
  'Parsed division label: {gender, format, bracketType, low, high}. Advisory — '
  'the typed columns (format/gender/min_rating/…) are authoritative.';

-- One event per (tournament, source division label) so a re-import never
-- duplicates a division. Only constrains source-tagged rows.
create unique index if not exists events_source_division_uniq
  on public.events (tournament_id, source_system, source_division_label)
  where deleted_at is null and source_system is not null;

-- ── event_registrations: source entry / team / attendee ids ──────────────
alter table public.event_registrations
  add column if not exists source_system text
    check (source_system is null or source_system in ('pbcom')),
  add column if not exists source_activity_id text,
  add column if not exists source_team_id text,
  add column if not exists source_attendee_header_id text;

comment on column public.event_registrations.source_system is
  'Where this entry came from, e.g. ''pbcom''. Null for B&E-native registrations.';
comment on column public.event_registrations.source_activity_id is
  'PB.com ActivityID for this entry — the per-registration idempotency key; a '
  're-import updates the matching row instead of inserting a duplicate.';
comment on column public.event_registrations.source_team_id is
  'PB.com TeamID — two entries sharing it in one division are doubles partners.';
comment on column public.event_registrations.source_attendee_header_id is
  'PB.com AttendeeHeaderID (per attendee) — kept for mapping results back.';

-- ActivityID is globally unique in PB.com; enforce it so the import is
-- idempotent on the strong key. Only constrains source-tagged rows.
create unique index if not exists event_registrations_source_activity_uniq
  on public.event_registrations (source_system, source_activity_id)
  where source_activity_id is not null;
