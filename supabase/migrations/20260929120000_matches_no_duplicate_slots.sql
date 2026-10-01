-- 20260929120000_matches_no_duplicate_slots.sql
--
-- Bug #993 backstop: bracket generation was non-idempotent — the round-robin
-- and playoff generate paths INSERTed a fresh set of matches without first
-- clearing the event's existing ones, so a second invocation (double-click, a
-- re-render/effect re-firing, a partial regen) APPENDED a duplicate set. A
-- real 5-team round-robin ended with 12 matches / 10 distinct pairs, two
-- pairings duplicated with conflicting scores.
--
-- The app fix (idempotent delete-then-insert + a re-entrancy guard) lives in
-- web/src/lib/matchGeneration.ts. This migration is the DB-level backstop so a
-- regression — or a concurrent interleave that slips past the app guard —
-- still can't land duplicate rows.
--
-- The invariant: within one event + stage, a match occupies a unique
-- (round, position) SLOT. Where a slot repeats it is keyed further by
-- `bracket` — double-elimination puts a Winners round-1 position-0 match and a
-- Consolation round-1 position-0 match in the same event, distinguished only
-- by bracket. So the unique key is:
--
--     (event_id, stage, round, position, coalesce(bracket::text, ''))
--
-- coalesce(...) collapses the NULL `bracket` that round-robin and single-elim
-- playoff rows carry into one equivalence class (a bare NULLS-DISTINCT index
-- would let those NULL-bracket duplicates through). This is intentionally
-- version-independent — it does not rely on Postgres 15 `NULLS NOT DISTINCT`.
--
-- Why this does NOT break the legitimate repeat cases:
--   * play_each_team_times > 1 — the same pair legitimately plays again, but
--     the round-robin generator increments `position` GLOBALLY across reps and
--     pools, so each repeat lands at a distinct position. Allowed.
--   * multi-pool round robin — positions increment globally across pools, so
--     no two matches share a (round, position). Allowed.
--   * double elimination — the same (round, position) across different
--     brackets differs by `bracket`. Allowed.

set search_path = public;

-- ─────────────────────────────────────────────────────────────────────
-- 1. Dedupe any existing duplicate slots so the unique index can build.
--    Per slot key we keep the "best" row — a row that has been scored /
--    completed wins over an empty placeholder, then earliest created — and
--    delete the rest. (The #993 incident produced exactly this shape; the
--    test tournament may still carry it.)
-- ─────────────────────────────────────────────────────────────────────

with ranked as (
  select
    id,
    row_number() over (
      partition by event_id, stage, round, position, coalesce(bracket::text, '')
      order by
        (winner_reg_id is not null) desc,   -- keep a decided match over a placeholder
        (status = 'completed')      desc,   -- then a completed one
        (team_a_score is not null or team_b_score is not null) desc,
        created_at asc,                      -- then the earliest created
        id asc
    ) as rn
  from matches
)
delete from matches m
using ranked r
where m.id = r.id
  and r.rn > 1;

-- ─────────────────────────────────────────────────────────────────────
-- 2. The unique-slot backstop.
-- ─────────────────────────────────────────────────────────────────────

create unique index if not exists matches_event_slot_uidx
  on matches (event_id, stage, round, position, coalesce(bracket::text, ''));

comment on index matches_event_slot_uidx is
  'Bug #993 backstop: one match per (event, stage, round, position, bracket) '
  'slot. Prevents non-idempotent bracket generation from appending duplicate '
  'matches. NULL bracket (round-robin / single-elim playoff) collapses to one '
  'class via coalesce so those duplicates are caught too.';
