-- 20260504174123_event_pool_index.sql
--
-- Adds pool assignment to event registrations. NULL means "no pool"
-- (single-pool events ignore the column). Multi-pool events use
-- 1..events.pool_count.
--
-- Pairing rule (doubles): both partners must share a pool. Enforced in
-- the UI by updating both rows together; we don't add a DB constraint
-- because partner_registration_id can briefly be NULL during the
-- two-step partner-link write that already exists.

set search_path = public;

alter table event_registrations
  add column pool_index smallint;

alter table event_registrations
  add constraint event_regs_pool_index_range
  check (pool_index is null or (pool_index >= 1 and pool_index <= 16));

create index event_registrations_pool_idx
  on event_registrations (event_id, pool_index)
  where pool_index is not null and deleted_at is null;
