-- Add archived_at to tournaments (soft-archive, mirrors deleted_at pattern).
-- Nullable timestamptz: NULL = active, non-NULL = archived.
-- Applied by CI on merge; never run manually.
--
-- IF NOT EXISTS: this migration was physically applied on 2026-06-10 but its
-- version row went missing from the remote migration history (an --include-all
-- drift), so `db push --include-all` re-attempts it. Making it idempotent lets
-- that retry succeed as a no-op (and finally record the version) instead of
-- erroring `column already exists` and wedging every later migration.
alter table public.tournaments
  add column if not exists archived_at timestamptz;
