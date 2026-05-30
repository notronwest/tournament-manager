-- 20260530180000_backfill_rating_ranges_from_names.sql
--
-- One-off data normalization: parse event names that follow the
-- conventional skill-bucket naming ("Mens 3.5-3.99", "Womens 4.0+")
-- and fill in min_rating + max_rating where both are NULL. Also
-- sets rating_source='self' on backfilled rows so the eligibility
-- chip renders cleanly.
--
-- ─── Patterns parsed ────────────────────────────────────────────
--
--   "... X.X-Y.YY"   → min = X.X, max = Y.YY
--   "... X.X+"       → min = X.X, max = NULL  (open-ended above)
--
-- ─── Safety rails ───────────────────────────────────────────────
--
--   * Only events with BOTH min_rating IS NULL and max_rating IS NULL
--     are touched — we never overwrite an explicit choice.
--   * Parsed values must fall in [2.0, 7.5] to avoid mis-parsing
--     age-bucket names ("Womens 50+" must NOT become a rating of 50).
--     Real pickleball ratings sit in roughly 2.0–7.0; 7.5 leaves a
--     little headroom without admitting age values.
--   * Soft-deleted events are skipped.
--
-- Events like "Open Division" (no rating spec in the name) stay
-- with NULL ranges and NULL source — they're truly unrestricted.

set search_path = public;

-- Range pattern: "...<min>-<max>"
with parsed as (
  select
    id,
    (regexp_match(name, '(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\s*$'))[1]::numeric as min_val,
    (regexp_match(name, '(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\s*$'))[2]::numeric as max_val
  from public.events
  where min_rating is null
    and max_rating is null
    and deleted_at is null
    and name ~ '(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\s*$'
)
update public.events e
   set min_rating    = p.min_val,
       max_rating    = p.max_val,
       rating_source = coalesce(e.rating_source, 'self'),
       updated_at    = now()
  from parsed p
 where e.id = p.id
   and p.min_val between 2.0 and 7.5
   and p.max_val between 2.0 and 7.5;

-- Open-ended pattern: "...<min>+"
with parsed as (
  select
    id,
    (regexp_match(name, '(\d+(?:\.\d+)?)\+\s*$'))[1]::numeric as min_val
  from public.events
  where min_rating is null
    and max_rating is null
    and deleted_at is null
    and name ~ '(\d+(?:\.\d+)?)\+\s*$'
)
update public.events e
   set min_rating    = p.min_val,
       rating_source = coalesce(e.rating_source, 'self'),
       updated_at    = now()
  from parsed p
 where e.id = p.id
   and p.min_val between 2.0 and 7.5;
