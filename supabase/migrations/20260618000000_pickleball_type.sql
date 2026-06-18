-- 20260618000000_pickleball_type.sql
--
-- Adds a free-text "pickleball type" (ball brand/model) column to both
-- locations and tournaments. The venue sets its usual ball; a tournament
-- can override it. Effective value = tournaments.pickleball_type ??
-- locations.pickleball_type.
--
-- Both columns are additive, nullable, and reversible — safe to apply
-- to the existing schema.

set search_path = public;

-- ─── locations: venue default ball ───────────────────────────────────
alter table public.locations
  add column if not exists pickleball_type text;

-- ─── tournaments: per-tournament override ────────────────────────────
alter table public.tournaments
  add column if not exists pickleball_type text;
