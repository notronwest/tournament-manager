-- 20260504171112_event_format_and_status.sql
-- Phase 2 of multi-event support.
--
--  * Expands event_status enum: ready / on_hold / medal_round / verified
--    are added; 'completed' is renamed to 'complete' to match the
--    organizer-facing vocabulary.
--  * Adds the format-config columns to events:
--      - pool_count                   pool play (1 = single-pool RR)
--      - play_each_team_times         repeat pairings within a pool
--      - points_to_win / win_by       game point totals (printed on
--                                     the scorecard)
--      - timeouts_per_game            controls scorecard layout
--      - teams_advancing_to_playoff   top-N pulled from RR results
--      - playoff_rounds               1 = pairwise medal matches
--                                     (top 4: 1v2 gold, 3v4 bronze);
--                                     2 = traditional semis + final
--                                     + bronze game (top 4 only).
--
-- Defaults are tuned for the common pickleball case (1-pool RR, top 4
-- with 1 playoff round, 11 win by 2). All existing rows pick those up
-- transparently.

set search_path = public;

-- ─────────────────────────────────────────────────────────────────────
-- event_status enum updates
-- ─────────────────────────────────────────────────────────────────────
-- Postgres 12+ allows ADD VALUE inside a transaction; new values just
-- can't be referenced in the same migration's DML — we don't, so this
-- is safe.

alter type event_status rename value 'completed' to 'complete';
alter type event_status add value if not exists 'ready';
alter type event_status add value if not exists 'on_hold';
alter type event_status add value if not exists 'medal_round';
alter type event_status add value if not exists 'verified';

-- ─────────────────────────────────────────────────────────────────────
-- events: format-config columns
-- ─────────────────────────────────────────────────────────────────────

alter table events
  add column pool_count                  smallint not null default 1,
  add column play_each_team_times        smallint not null default 1,
  add column points_to_win               smallint not null default 11,
  add column win_by                      smallint not null default 2,
  add column timeouts_per_game           smallint not null default 1,
  add column teams_advancing_to_playoff  smallint not null default 4,
  add column playoff_rounds              smallint not null default 1;

alter table events
  add constraint events_pool_count_range
    check (pool_count >= 1 and pool_count <= 16),
  add constraint events_play_each_times_range
    check (play_each_team_times >= 1 and play_each_team_times <= 5),
  add constraint events_points_to_win_range
    check (points_to_win >= 1 and points_to_win <= 99),
  add constraint events_win_by_range
    check (win_by >= 1 and win_by <= 9),
  add constraint events_timeouts_range
    check (timeouts_per_game >= 0 and timeouts_per_game <= 5),
  add constraint events_teams_advancing_range
    check (teams_advancing_to_playoff >= 0 and teams_advancing_to_playoff <= 64),
  add constraint events_playoff_rounds_range
    check (playoff_rounds >= 1 and playoff_rounds <= 4);
