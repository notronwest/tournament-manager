-- 20260622030000_e2e_test_history.sql
--
-- Per-test regression history. The nightly E2E suite (web/e2e/, regression.yml)
-- writes one row per test per run via e2e/record-history.ts, so each test's
-- pass/fail trend over time is queryable. Viewed in the Supabase dashboard
-- (Table editor → e2e_test_results, or the e2e_test_history view).
--
-- Lives in the TEST project (where the suite runs). The prod copy of this table
-- is intentionally never written to — it exists only so schema stays
-- migration-managed. Additive + idempotent (re-applies cleanly).

create table if not exists e2e_test_results (
  id            bigint generated always as identity primary key,
  run_id        text        not null,            -- GitHub Actions run id
  sha           text,                            -- commit sha under test
  recorded_at   timestamptz not null default now(),
  test_id       text        not null,            -- stable: "<file> :: <full title>"
  title         text        not null,            -- the test's own title
  file          text        not null,            -- spec file (relative)
  status        text        not null,            -- passed|failed|timedOut|skipped|interrupted
  expected      text,                            -- the test's expected status
  duration_ms   integer,
  retries       integer     not null default 0
);

create index if not exists e2e_test_results_test_id_idx
  on e2e_test_results (test_id, recorded_at desc);
create index if not exists e2e_test_results_run_idx
  on e2e_test_results (run_id);

-- Only the CI writer (service role, which bypasses RLS) and the dashboard owner
-- touch this. RLS on + no policies = no anon/authenticated access.
alter table e2e_test_results enable row level security;

-- One row per test: how often it passes, its latest outcome, when last seen.
create or replace view e2e_test_history as
select
  test_id,
  max(title)                                                          as title,
  max(file)                                                           as file,
  count(*)                                                            as runs,
  count(*) filter (where status = 'passed')                          as passed,
  count(*) filter (where status in ('failed','timedOut','interrupted')) as failed,
  count(*) filter (where status = 'skipped')                         as skipped,
  round(100.0 * count(*) filter (where status = 'passed')
        / nullif(count(*) filter (where status <> 'skipped'), 0), 1) as pass_rate_pct,
  (array_agg(status order by recorded_at desc))[1]                   as last_status,
  max(recorded_at)                                                   as last_seen
from e2e_test_results
group by test_id;
