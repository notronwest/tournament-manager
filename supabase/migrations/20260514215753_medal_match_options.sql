-- 20260514215753_medal_match_options.sql
--
-- Splits medal-round settings out from round-robin settings so an
-- event can play 11 win-by-2 in pool play but switch to 15 win-by-2
-- (or best-of-3) for the medal matches — a common pickleball pattern.
--
-- Adds to events:
--   * medal_match_format (single_game | best_of_3): how each medal
--     match is structured. Affects time estimates today and will
--     gate match generation once we ship best-of-3 score capture.
--   * medal_points_to_win / medal_win_by: scorecard values that get
--     printed on medal-round cards. Default 15/2 — the typical
--     longer-format medal game.
--   * medal_minutes_per_game: per-game estimate just for medal
--     matches (medal games tend to run longer than pool games).
--
-- All non-destructive: existing rows pick up sensible defaults.

set search_path = public;

-- ─────────────────────────────────────────────────────────────────────
-- medal match format enum
-- ─────────────────────────────────────────────────────────────────────

create type medal_match_format as enum ('single_game', 'best_of_3');

-- ─────────────────────────────────────────────────────────────────────
-- events: medal-round columns
-- ─────────────────────────────────────────────────────────────────────

alter table events
  add column medal_match_format     medal_match_format not null default 'single_game',
  add column medal_points_to_win    smallint not null default 15,
  add column medal_win_by           smallint not null default 2,
  add column medal_minutes_per_game smallint not null default 20;

alter table events
  add constraint events_medal_points_to_win_range
    check (medal_points_to_win >= 1 and medal_points_to_win <= 99),
  add constraint events_medal_win_by_range
    check (medal_win_by >= 1 and medal_win_by <= 9),
  add constraint events_medal_minutes_range
    check (medal_minutes_per_game >= 1 and medal_minutes_per_game <= 120);
