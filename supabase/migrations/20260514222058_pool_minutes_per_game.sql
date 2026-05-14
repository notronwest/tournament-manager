-- 20260514222058_pool_minutes_per_game.sql
--
-- Pool-play counterpart to medal_minutes_per_game. Lets the time
-- estimator (and the per-tournament schedule view) compute each
-- event's pool-play duration without asking the organizer to enter
-- it every time. Defaults to 15 — the typical 11-win-by-2 game with
-- changeover.

set search_path = public;

alter table events
  add column pool_minutes_per_game smallint not null default 15;

alter table events
  add constraint events_pool_minutes_range
    check (pool_minutes_per_game >= 1 and pool_minutes_per_game <= 120);
