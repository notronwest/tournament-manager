-- 20261011120000_campaign_registry_and_reporting.sql
--
-- D-0120: the Marketing dashboard's campaign report. Two things live here —
-- a registry so a NEW campaign costs a row instead of a release, and three
-- reporting functions that are the ONLY read surface the dashboard's service
-- is given.
--
-- The credential story, which is the point of this migration: the reporting
-- service does NOT get a service_role key. A service_role key is not narrowed
-- by a function signature — it bypasses RLS on payments and account_credits
-- too. Instead a dedicated `campaign_reporter` role holds EXECUTE on exactly
-- the three functions below and nothing else, so a compromised Worker cannot
-- read a payment row. D-0120 forbids the service_role alternative.
--
-- What this migration does NOT do, deliberately:
--   * It does not touch account_credits. Ron's "archive and delete these"
--     means the REPORT listing, not the ledger (his words: "I mean the
--     report"). The ledger stays append-only per D-0077.
--   * It does not edit grant_account_credit. That is live money code under
--     D-0077 §2's hold, and the corrected scope removes any need to.
--   * It does not delete campaign_events. The 13-month rollup D-0077 intends
--     was never built, so purging would be pure loss rather than aggregation.

set search_path = public;

-- ─────────────────────────────────────────────────────────────────────
-- campaigns — the registry. A campaign is a row, not a string someone
-- typed into a URL.
-- ─────────────────────────────────────────────────────────────────────
--
-- Why a tombstone instead of a DELETE: account_credits_grant_once_idx is
-- UNIQUE on (campaign, player_id) and survives everything in this schema.
-- If a slug could be deleted and then reused, every prior recipient would
-- be SILENTLY refused a re-grant — grant_account_credit returns
-- 'already_granted' and the new campaign would just quietly not pay some
-- people. So `deleted` is a state, the row is never removed, and the slug
-- can never come back. D-0120 forbids reusing a retired slug.

create table if not exists public.campaigns (
  slug            text primary key,
  display_name    text not null,
  organization_id uuid not null references public.organizations(id),
  starts_at       timestamptz,
  ends_at         timestamptz,
  -- Report lifecycle ONLY. Says nothing about whether money may be granted —
  -- that is credit_campaigns.active, which this column must never shadow.
  report_state    text not null default 'active'
                    check (report_state in ('active', 'archived', 'deleted')),
  created_at      timestamptz not null default now(),
  constraint campaigns_window check (ends_at is null or starts_at is null or ends_at > starts_at)
);

comment on table public.campaigns is
  'Registry of marketing campaigns (D-0120): a new campaign is a row, not a deploy. report_state drives the Marketing dashboard LISTING only — active/archived/deleted — and says nothing about whether credit may be granted (that is credit_campaigns.active). Rows are NEVER deleted: account_credits_grant_once_idx is unique on (campaign, player_id) and survives, so a reused slug would silently refuse re-grants to prior recipients. "deleted" is a tombstone that keeps the slug retired forever.';

comment on column public.campaigns.report_state is
  'active = shown in the dashboard listing; archived = hidden, reversible; deleted = hidden and the slug is permanently retired. Never a statement about the money.';

create index if not exists campaigns_report_state_idx on public.campaigns (report_state);

-- Not client-readable. Only the reporting functions below (SECURITY DEFINER)
-- and service_role see it.
alter table public.campaigns enable row level security;
revoke all on public.campaigns from anon, authenticated;

-- Register the one campaign that already exists, so the report has data on
-- day one rather than an empty screen next to a live funnel.
insert into public.campaigns (slug, display_name, organization_id)
select cc.campaign,
       '2nd Annual Leaf Peeper Tournament Recap',
       cc.organization_id
from public.credit_campaigns cc
where cc.campaign = 'leaf-peeper-2026'
on conflict (slug) do nothing;

-- ─────────────────────────────────────────────────────────────────────
-- The outstanding-credit math, factored out so all three reporting
-- functions agree with account_credit_balance() instead of re-deriving it.
-- ─────────────────────────────────────────────────────────────────────
--
-- Mirrors account_credit_balance's PER-GRANT model and its reason: a
-- redemption carries grant_id, so each grant's own unspent remainder is
-- floored at zero independently. A flat ledger sum would let one grant's
-- spend bleed into another still-live grant's balance. Expired grants
-- forfeit their own remainder, so they are excluded from outstanding but
-- still counted as granted.

create or replace view public.campaign_grant_rollup
with (security_invoker = true) as
  select g.campaign,
         g.id   as grant_id,
         g.amount_cents                                   as granted_cents,
         coalesce(-sum(c.amount_cents) filter (where c.kind = 'redemption'), 0) as redeemed_cents,
         greatest(g.amount_cents + coalesce(sum(c.amount_cents), 0), 0)         as remaining_cents,
         (g.expires_at is not null and g.expires_at <= now())                   as expired
  from public.account_credits g
  left join public.account_credits c on c.grant_id = g.id
  where g.kind = 'grant'
    and g.campaign is not null
  group by g.campaign, g.id, g.amount_cents, g.expires_at;

comment on view public.campaign_grant_rollup is
  'Per-grant credit rollup for campaign reporting (D-0120). Mirrors account_credit_balance''s per-grant flooring — a redemption attributes to its grant via grant_id, so one grant''s spend cannot bleed into another''s remainder. security_invoker so it carries the caller''s RLS, not the definer''s; the reporting functions below are the SECURITY DEFINER boundary.';

revoke all on public.campaign_grant_rollup from anon, authenticated;
revoke all on public.campaign_grant_rollup from public;

-- ─────────────────────────────────────────────────────────────────────
-- The three reporting functions — the entire read surface.
-- Aggregates only: no player_id, visitor_id, name or email is returned by
-- any of them. D-0120 forbids returning those across the boundary.
-- ─────────────────────────────────────────────────────────────────────

create or replace function public.campaign_report(p_campaign text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'campaign',           c.slug,
    'display_name',       c.display_name,
    'report_state',       c.report_state,
    'starts_at',          c.starts_at,
    'ends_at',            c.ends_at,
    'recap_views',        (select count(*) from campaign_events e
                            where e.campaign = c.slug and e.kind = 'recap_view'),
    'visitors',           (select count(distinct e.visitor_id) from campaign_events e
                            where e.campaign = c.slug and e.kind = 'recap_view'),
    'signups',            (select count(*) from campaign_events e
                            where e.campaign = c.slug and e.kind = 'signup'),
    'credits_granted',    (select count(*) from campaign_grant_rollup r where r.campaign = c.slug),
    'granted_cents',      (select coalesce(sum(r.granted_cents), 0) from campaign_grant_rollup r
                            where r.campaign = c.slug),
    'redeemed_cents',     (select coalesce(sum(r.redeemed_cents), 0) from campaign_grant_rollup r
                            where r.campaign = c.slug),
    -- Outstanding counts UNEXPIRED grants only: an expired grant forfeits its
    -- own remainder, exactly as account_credit_balance treats it.
    'outstanding_cents',  (select coalesce(sum(r.remaining_cents), 0) from campaign_grant_rollup r
                            where r.campaign = c.slug and not r.expired),
    'first_seen',         (select min(e.created_at) from campaign_events e where e.campaign = c.slug),
    'last_seen',          (select max(e.created_at) from campaign_events e where e.campaign = c.slug)
  )
  from campaigns c
  where c.slug = p_campaign;
$$;

comment on function public.campaign_report(text) is
  'One campaign''s funnel for the Marketing dashboard (D-0120): views, distinct visitors, signups, credits granted/redeemed/outstanding. Aggregates only — never a player id, visitor id, name or email. Executable by campaign_reporter, never by anon or authenticated.';

create or replace function public.campaign_report_series(p_campaign text)
returns table (day date, recap_views bigint, signups bigint)
language sql
stable
security definer
set search_path = public
as $$
  select e.created_at::date as day,
         count(*) filter (where e.kind = 'recap_view') as recap_views,
         count(*) filter (where e.kind = 'signup')     as signups
  from campaign_events e
  where e.campaign = p_campaign
  group by 1
  order by 1;
$$;

comment on function public.campaign_report_series(text) is
  'Per-day recap_view / signup counts for one campaign''s chart (D-0120). Aggregates only.';

-- The listing. Defaults to what the dashboard shows: everything not deleted.
-- p_include_deleted exists so a future admin view can audit retired slugs
-- without a second function.
create or replace function public.campaign_report_list(p_include_deleted boolean default false)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc), '[]'::jsonb)
  from (
    select c.slug,
           c.display_name,
           c.report_state,
           c.created_at,
           (select count(*) from campaign_events e
             where e.campaign = c.slug and e.kind = 'recap_view') as recap_views,
           (select count(*) from campaign_events e
             where e.campaign = c.slug and e.kind = 'signup')     as signups,
           (select coalesce(sum(r.granted_cents), 0) from campaign_grant_rollup r
             where r.campaign = c.slug)                           as granted_cents,
           (select coalesce(sum(r.remaining_cents), 0) from campaign_grant_rollup r
             where r.campaign = c.slug and not r.expired)         as outstanding_cents
    from campaigns c
    where p_include_deleted or c.report_state <> 'deleted'
  ) t;
$$;

comment on function public.campaign_report_list(boolean) is
  'Every registered campaign with its headline numbers and report_state (D-0120). Excludes deleted by default. Aggregates only.';

-- ─────────────────────────────────────────────────────────────────────
-- campaign_reporter — the narrow role the Worker authenticates as.
-- ─────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'campaign_reporter') then
    create role campaign_reporter nologin noinherit;
  end if;
end $$;

-- Nothing but schema usage and the three functions. No table grants at all,
-- so even a leaked token cannot read a payment, a player or the ledger
-- directly — only the aggregates above.
grant usage on schema public to campaign_reporter;

-- NAME THE CLIENT ROLES. `revoke ... from public` alone is NOT a lock here:
-- Supabase ships an ALTER DEFAULT PRIVILEGES granting EXECUTE on new
-- functions to anon and authenticated DIRECTLY, and a direct grant survives
-- revoking from the PUBLIC pseudo-role. The assertion at the bottom of this
-- migration caught exactly that mistake in this file's own first draft, and
-- the same trap had already shipped in three money functions (see
-- 20261011110000).
revoke all on function public.campaign_report(text) from anon, authenticated, public;
revoke all on function public.campaign_report_series(text) from anon, authenticated, public;
revoke all on function public.campaign_report_list(boolean) from anon, authenticated, public;

grant execute on function public.campaign_report(text)            to campaign_reporter;
grant execute on function public.campaign_report_series(text)     to campaign_reporter;
grant execute on function public.campaign_report_list(boolean)    to campaign_reporter;

-- PostgREST switches from `authenticator` into the role named in the JWT's
-- `role` claim, so that switch has to be permitted. Guarded: a local
-- `supabase start` has no `authenticator`, and this migration must not fail
-- there.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'grant campaign_reporter to authenticator';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- Assertions, run on every apply — the same discipline every campaign
-- migration in this repo ships (20261008130000, 20261010120000).
-- ─────────────────────────────────────────────────────────────────────

do $$
begin
  -- The registry is not client-readable.
  if has_table_privilege('anon', 'campaigns', 'select') then
    raise exception 'campaigns must not be selectable by anon';
  end if;
  if has_table_privilege('authenticated', 'campaigns', 'select') then
    raise exception 'campaigns must not be selectable by authenticated';
  end if;

  -- The reporting surface is not client-callable. This is the boundary the
  -- whole decision rests on: if a client could call these, the funnel
  -- numbers would be public.
  if has_function_privilege('anon', 'campaign_report(text)', 'execute')
     or has_function_privilege('authenticated', 'campaign_report(text)', 'execute')
     or has_function_privilege('anon', 'campaign_report_list(boolean)', 'execute')
     or has_function_privilege('authenticated', 'campaign_report_list(boolean)', 'execute')
     or has_function_privilege('anon', 'campaign_report_series(text)', 'execute')
     or has_function_privilege('authenticated', 'campaign_report_series(text)', 'execute')
  then
    raise exception 'campaign reporting functions must not be executable by anon or authenticated';
  end if;

  -- The reporting role must not have grown table rights. If a later
  -- migration grants it a table, this fails loudly rather than quietly
  -- widening what a leaked reporting token can read.
  if has_table_privilege('campaign_reporter', 'account_credits', 'select')
     or has_table_privilege('campaign_reporter', 'payments', 'select')
     or has_table_privilege('campaign_reporter', 'players', 'select')
  then
    raise exception 'campaign_reporter must hold no table privileges — only EXECUTE on the reporting functions';
  end if;
end $$;
