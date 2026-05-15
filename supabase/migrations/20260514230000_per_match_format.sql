-- 20260514230000_per_match_format.sql
--
-- Per-match medal-format overrides. Currently medal-round game rules
-- (format / points / win-by / minutes) live on the event and apply to
-- every playoff match uniformly. This adds per-match override columns
-- so an organizer can run different formats across the playoff —
-- e.g. semis as single 11-game, gold final as best-of-three to 15 —
-- and even differ between gold and bronze matches in the same round.
--
-- Columns are nullable. Read order:
--   match.match_*  → if set, wins (explicit per-match)
--   event.medal_*  → fallback (event-level default)
--
-- At playoff-generation time the client copies event.medal_* into each
-- new match so the values are concrete in the DB from the moment the
-- bracket is created. That lets per-match edits diverge from the
-- event default without ambiguity, and means changing the event
-- default later doesn't retroactively rewrite an in-flight bracket.
--
-- Round-robin matches don't use these columns — pool play uses
-- event.points_to_win / event.win_by directly. NULLs are fine there.

set search_path = public;

alter table matches
  add column match_format          medal_match_format,
  add column match_points_to_win   smallint,
  add column match_win_by          smallint,
  add column match_minutes_per_game smallint;

alter table matches
  add constraint matches_points_to_win_range
    check (
      match_points_to_win is null
      or (match_points_to_win between 1 and 99)
    ),
  add constraint matches_win_by_range
    check (
      match_win_by is null
      or (match_win_by between 1 and 9)
    ),
  add constraint matches_minutes_range
    check (
      match_minutes_per_game is null
      or (match_minutes_per_game between 1 and 120)
    );
