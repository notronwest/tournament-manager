-- 20260514231000_semifinal_format.sql
--
-- Splits the medal-format event-level config in two when the event
-- runs a 2-round bracket. Common case in pickleball:
--   * Semis: same rules as pool play (e.g. 11 win-by-2, single game)
--   * Final + bronze: longer format (15 win-by-2, best of 3)
--
-- Before this migration the event had one medal_* set that applied
-- to every playoff match, so organizers either ran semis-as-final-
-- length (uncommon) or had to override every semifinal match
-- individually after the bracket was generated.
--
-- For R=1 (pairwise medal matches) the semifinal_* columns are
-- ignored — there's no separate semi round, every match is a medal
-- match and uses medal_*.
--
-- Defaults intentionally match pool-play defaults so existing rows
-- pick up sensible values without re-saving.

set search_path = public;

alter table events
  add column semifinal_match_format     medal_match_format not null default 'single_game',
  add column semifinal_points_to_win    smallint not null default 11,
  add column semifinal_win_by           smallint not null default 2,
  add column semifinal_minutes_per_game smallint not null default 15;

alter table events
  add constraint events_semifinal_points_to_win_range
    check (semifinal_points_to_win between 1 and 99),
  add constraint events_semifinal_win_by_range
    check (semifinal_win_by between 1 and 9),
  add constraint events_semifinal_minutes_range
    check (semifinal_minutes_per_game between 1 and 120);
