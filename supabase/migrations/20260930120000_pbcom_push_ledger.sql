-- ─────────────────────────────────────────────────────────────────────
-- PickleballBrackets.com results-PUSH ledger + out-of-sync state.
--
-- Bridge (D-0045 / #982): B&E imports the divisions from PB.com (#981), runs
-- the event, then PUSHES results back by driving PB.com as a human
-- (tournament-manager/pbcom-driver, mac-mini-launchd). The push runs UNATTENDED
-- (a launchd poll ~every 150s on the club mini) so it needs DURABLE, cross-run
-- idempotency state: the in-memory ledger the scaffold shipped cannot survive a
-- crash/restart, and a re-run must push only the DELTA, never double-submit.
--
-- Two tables:
--   * pbcom_push_ledger — one row per CONFIRMED push (a bracket-create, or one
--     match score), written ONLY after the driver reads the write back from
--     PB.com (verify-before-ledger). This is what makes a re-run safe: the
--     planner (pbcom-driver/src/push/plan.ts) compares the desired draw against
--     these rows and emits only what is missing or changed.
--   * pbcom_push_state — one row per division, the human-visible lifecycle state
--     (verify/waiting/running/completed/error/needs_attention). The dashboard
--     reads WHERE state = 'needs_attention' to surface the D-0045 "PB.com out of
--     sync" signal (a lapsed session, or a write that would not verify).
--
-- Identity (mirrors PushLedgerEntry in pbcom-driver/src/push/plan.ts):
--   * bracket entry_key = the division's normalized PB.com label (its identity).
--   * score   entry_key = the match identity = division label + BOTH teams'
--     identity tokens. A team's token is source_team_id (PB.com TeamID) → else
--     the source_attendee_header_id set → else the normalized last-name set — the
--     PRESERVED PB.com source ids from the import (#987: source_activity_id is the
--     DIVISION id, shared by all, so it is NEVER an identity key). Matching is by
--     TEAMS, not by PB.com round/position (B&E and PB.com number rounds
--     differently); the structural stage/bracket coords only disambiguate a
--     double-elim rematch of the same two teams.
--   * score_digest = the score itself, so a CORRECTED score re-pushes (its digest
--     changed) while an unchanged one is skipped.
--
-- Writes happen ONLY in the pbcom-driver (service_role, on the mini). RLS is
-- enabled; a read policy lets org admins see the state for the dashboard, and
-- service_role bypasses RLS for the driver's own reads/writes. Ships via the
-- repo's branch routing (main→TEST, production→PROD) like any other migration —
-- note that the DRIVER itself does NOT ship this way (it is mac-mini-launchd);
-- only this schema does. See pbcom-driver/DEPLOYMENT.md.
-- ─────────────────────────────────────────────────────────────────────

set search_path = public;

-- ── pbcom_push_ledger: confirmed pushes (idempotency / reconcile) ──────────
create table if not exists public.pbcom_push_ledger (
  id             uuid primary key default gen_random_uuid(),
  tournament_id  uuid not null references public.tournaments(id) on delete cascade,
  -- Normalized division key (divisionKeyOf(source_division_label)); the first
  -- segment of a score's entry_key. Kept as a column for scoping + dashboards.
  division_key   text not null,
  kind           text not null check (kind in ('bracket', 'score')),
  -- The reconcile identity: divisionKey for a bracket; the full match identity
  -- for a score. Team identity is source-id-based, NOT round/position (see header).
  entry_key      text not null,
  -- The score last CONFIRMED on PB.com. Empty for a bracket-create record.
  score_digest   text not null default '',
  -- When PB.com was read back and the write verified.
  pushed_at      timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

comment on table public.pbcom_push_ledger is
  'One row per push CONFIRMED on PickleballBrackets.com (written only after the '
  'pbcom-driver verifies the write). The push planner reconciles the desired B&E '
  'draw against these rows and drives only the delta — so a crashed/re-run push '
  'never double-submits. D-0045 / tournament-manager#982.';
comment on column public.pbcom_push_ledger.entry_key is
  'Reconcile identity: normalized division label (bracket) or match identity '
  '(score = division + both teams'' source-id/last-name tokens). NOT keyed on '
  'PB.com round/position — #987: matching is by teams.';
comment on column public.pbcom_push_ledger.score_digest is
  'The confirmed score (e.g. "11-6/w:a"). A changed digest = a corrected score '
  'that must re-push. Empty for bracket-create rows.';

-- IDEMPOTENCY: exactly one confirmed row per (tournament, kind, identity).
-- A re-push of a corrected score UPSERTs this row (updates score_digest) rather
-- than inserting a duplicate; this constraint is what prevents double-recording.
-- tournament_id is in the key because a bracket's entry_key is just the division
-- label, which two different tournaments can share.
create unique index if not exists pbcom_push_ledger_identity_uniq
  on public.pbcom_push_ledger (tournament_id, kind, entry_key);

-- Scoped reads: the driver lists a tournament's ledger each tick.
create index if not exists pbcom_push_ledger_tournament_idx
  on public.pbcom_push_ledger (tournament_id, division_key);

-- ── pbcom_push_state: per-division lifecycle / out-of-sync signal ──────────
create table if not exists public.pbcom_push_state (
  tournament_id   uuid not null references public.tournaments(id) on delete cascade,
  division_key    text not null,
  -- The exact PB.com division string, for a human-readable dashboard row.
  division_label  text not null,
  state           text not null
    check (state in ('verify', 'waiting', 'running', 'completed', 'error', 'needs_attention')),
  -- A human-readable note (why it needs attention, last error detail). No PII.
  detail          text,
  updated_at      timestamptz not null default now(),
  primary key (tournament_id, division_key)
);

comment on table public.pbcom_push_state is
  'The push lifecycle state per B&E division, mirroring pbcom-driver''s state '
  'machine. The dashboard reads state = ''needs_attention'' to surface the D-0045 '
  '"PB.com out of sync" signal (a lapsed PB.com session, or a write that would '
  'not verify). Updated by the pbcom-driver (service_role) each tick.';
comment on column public.pbcom_push_state.state is
  'verify | waiting | running | completed | error | needs_attention. '
  'needs_attention is the human-visible "out of sync" signal.';

create index if not exists pbcom_push_state_attention_idx
  on public.pbcom_push_state (state)
  where state = 'needs_attention';

-- ── RLS ────────────────────────────────────────────────────────────────────
-- The driver writes as service_role (bypasses RLS). Org admins may READ so the
-- dashboard can render the out-of-sync surface. No anon/authenticated write
-- policy: writes are service_role-only (fail-closed).
alter table public.pbcom_push_ledger enable row level security;
alter table public.pbcom_push_state  enable row level security;

create policy "pbcom_push_ledger read by org admins" on public.pbcom_push_ledger
  for select using (
    exists (
      select 1 from public.tournaments t
      where t.id = pbcom_push_ledger.tournament_id
        and has_org_role(t.organization_id, 'admin')
    )
  );

create policy "pbcom_push_state read by org admins" on public.pbcom_push_state
  for select using (
    exists (
      select 1 from public.tournaments t
      where t.id = pbcom_push_state.tournament_id
        and has_org_role(t.organization_id, 'admin')
    )
  );
