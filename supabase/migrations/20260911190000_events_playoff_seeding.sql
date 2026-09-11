-- 20260911190000_events_playoff_seeding.sql
--
-- Two-pool divisions need a medal round decided by POOL PLACEMENT: pool
-- winners play for gold/silver, runners-up for bronze. The only single-round
-- option so far seeded the top 4 from the overall table (1v2 gold, 3v4
-- bronze), which can rematch two teams from the same pool.
--
-- Additive: a new enum + one column with a default, so every existing event
-- keeps today's behaviour ('overall'). The generator (EventConsolePage
-- PlayoffSection) honours 'cross_pool' only when pool_count = 2, top 4,
-- 1 round; otherwise it falls back to overall seeding.

set search_path = public;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'playoff_seeding') then
    create type playoff_seeding as enum ('overall', 'cross_pool');
  end if;
end;
$$;

alter table events
  add column if not exists playoff_seeding playoff_seeding not null default 'overall';

comment on column events.playoff_seeding is
  'How the single-round medal matches are seeded: overall = top 4 of the overall '
  'standings (1v2 gold, 3v4 bronze); cross_pool = Pool 1 #1 vs Pool 2 #1 for gold, '
  'Pool 1 #2 vs Pool 2 #2 for bronze (2 pools, top 4, 1 round only).';
