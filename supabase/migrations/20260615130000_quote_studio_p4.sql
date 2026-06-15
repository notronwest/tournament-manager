-- 20260615130000_quote_studio_p4.sql
--
-- Quote Studio Phase 4: contracts table.
--
-- A contract is generated from an accepted quote revision, merging the
-- agreed line items with a versioned standard-terms template. The
-- terms_version stamp ensures future edits to the terms don't mutate
-- past contracts. document_html stores the frozen rendered output.
--
-- RLS posture: platform_admin full CRUD. No public access.
--
-- Depends on: quote_studio_p1 (quotes, quote_revisions).

set search_path = public;

-- ── contract_status enum ──────────────────────────────────────────────────────

create type public.contract_status as enum ('draft', 'sent', 'signed_offline');

-- ── contracts ─────────────────────────────────────────────────────────────────

create table public.contracts (
  id             uuid             primary key default gen_random_uuid(),
  quote_id       uuid             not null references public.quotes(id) on delete cascade,
  revision_id    uuid             not null references public.quote_revisions(id),
  terms_version  text             not null,
  generated_at   timestamptz      not null default now(),
  status         contract_status  not null default 'draft',
  document_html  text,
  created_by     uuid             references auth.users(id) on delete set null,
  created_at     timestamptz      not null default now()
);

comment on table public.contracts is
  'Independent-contractor agreements generated from accepted quote revisions. '
  'terms_version stamps the template so future edits do not mutate past contracts.';

alter table public.contracts enable row level security;

create policy "contracts platform_admin select"
  on public.contracts
  for select using (is_platform_admin());

create policy "contracts platform_admin insert"
  on public.contracts
  for insert with check (is_platform_admin());

create policy "contracts platform_admin update"
  on public.contracts
  for update using (is_platform_admin()) with check (is_platform_admin());

create policy "contracts platform_admin delete"
  on public.contracts
  for delete using (is_platform_admin());
