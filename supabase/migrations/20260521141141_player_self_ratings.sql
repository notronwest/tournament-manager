-- 20260521141141_player_self_ratings.sql
--
-- Three self-reported skill ratings on players so registrants can
-- declare what they think they play at without needing a DUPR or PB
-- Vision sync. Used by the public register form's "Your info" step
-- and surfaced on player profiles.
--
-- Categories mirror standard pickleball brackets:
--   self_rating_doubles  — same-gender doubles
--   self_rating_mixed    — mixed doubles
--   self_rating_singles  — singles
--
-- All nullable: nothing forces a player to self-rate.
--
-- Note we keep these as columns on players (not rows in
-- player_ratings) because self-ratings are first-party assertions
-- belonging to the player profile, not external feeds with their
-- own as_of timestamps. Externals stay in player_ratings keyed by
-- rating_source.

set search_path = public;

alter table players
  add column self_rating_doubles numeric(4,2),
  add column self_rating_mixed   numeric(4,2),
  add column self_rating_singles numeric(4,2);

alter table players
  add constraint players_self_rating_doubles_range
    check (self_rating_doubles is null
           or (self_rating_doubles >= 0 and self_rating_doubles <= 9.99)),
  add constraint players_self_rating_mixed_range
    check (self_rating_mixed is null
           or (self_rating_mixed >= 0 and self_rating_mixed <= 9.99)),
  add constraint players_self_rating_singles_range
    check (self_rating_singles is null
           or (self_rating_singles >= 0 and self_rating_singles <= 9.99));
