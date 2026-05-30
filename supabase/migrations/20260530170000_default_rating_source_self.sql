-- 20260530170000_default_rating_source_self.sql
--
-- Default new events to Self-rating, and backfill existing
-- rating-restricted events that were missing a source.
--
-- Two parts:
--
--   1. Column default → 'self'. Any future events.insert that
--      doesn't explicitly set rating_source gets self-rating. This
--      includes the wizard's "Add default divisions" bulk insert
--      (which doesn't specify a source), so first-time organizers
--      walk away with self-rated divisions out of the box.
--
--   2. Backfill: existing events with rating_source = NULL AND a
--      min_rating or max_rating set get rating_source = 'self'.
--      Rationale: those events DO restrict by rating but had no
--      source attached, so the eligibility chip + the rating-source
--      check were ambiguous. Self-rated is the safe default.
--      Events with no rating range at all stay NULL — they're
--      "open to any rating" and shouldn't sprout a source.

set search_path = public;

alter table public.events
  alter column rating_source set default 'self';

update public.events
   set rating_source = 'self',
       updated_at = now()
 where rating_source is null
   and (min_rating is not null or max_rating is not null)
   and deleted_at is null;
