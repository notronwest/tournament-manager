-- 20260530160000_rating_source_self.sql
--
-- Adds 'self' as a valid value for the rating_source enum so
-- organizers can configure an event to gate eligibility against a
-- player's self-reported rating (rather than DUPR / PB Vision / WMPC
-- Rating Hub).
--
-- Mostly a UI-visibility change: player_ratings rows with source =
-- 'self' have existed in some form already (see migration
-- 20260521141141_player_self_ratings.sql). This makes the source
-- usable as the event's rating_source so the eligibility chip + the
-- rating-restriction check can target it.

alter type public.rating_source add value if not exists 'self';
