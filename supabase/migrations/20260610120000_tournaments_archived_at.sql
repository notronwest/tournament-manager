-- Add archived_at to tournaments (soft-archive, mirrors deleted_at pattern).
-- Nullable timestamptz: NULL = active, non-NULL = archived.
-- Applied by CI on merge; never run manually.
alter table public.tournaments
  add column archived_at timestamptz;
