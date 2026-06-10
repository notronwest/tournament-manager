-- 29991231000000_demo_db_convention_noop.sql
--
-- DEMO ONLY — DO NOT MERGE. Created to preview how a DB PR looks on the
-- Review board under the WMPC migration convention (db-migration label +
-- [DB] title prefix, merged in migration-timestamp order). The far-future
-- timestamp keeps it last in sort order so it can never be "next" in line.
--
-- This is a deliberate no-op: it does nothing to the schema. Safe to delete.
do $$ begin
  raise notice 'demo: db-convention preview migration — no schema change';
end $$;
