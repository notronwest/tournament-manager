-- 20260615120000_quote_studio_p3.sql
--
-- Quote Studio Phase 3: customer customization via shareable link.
--
-- New table:
--   quote_share_tokens — tokenized share links per quote
--
-- New security-definer RPCs (run as postgres, bypassing RLS):
--   get_quote_by_token(token)           → quote + current revision + line items
--   submit_customer_revision(token, ...) → creates a customer revision
--
-- RLS posture:
--   quote_share_tokens: platform_admin SELECT/INSERT/UPDATE (generate + revoke)
--   Anon access to quote data flows exclusively through the two RPCs;
--   no direct anon SELECT on quotes/revisions/line_items is added here.

set search_path = public;

-- ── quote_share_tokens ────────────────────────────────────────────────────────

create table public.quote_share_tokens (
  id          uuid        primary key default gen_random_uuid(),
  quote_id    uuid        not null references public.quotes(id) on delete cascade,
  token       text        not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  expires_at  timestamptz,
  revoked     boolean     not null default false,
  created_at  timestamptz not null default now()
);

comment on table public.quote_share_tokens is
  'Tokenized share links for a quote. A valid (non-revoked, non-expired) token grants the customer read access to that quote''s current revision and the ability to submit a customization.';

alter table public.quote_share_tokens enable row level security;

create policy "quote_share_tokens platform_admin select"
  on public.quote_share_tokens
  for select using (is_platform_admin());

create policy "quote_share_tokens platform_admin insert"
  on public.quote_share_tokens
  for insert with check (is_platform_admin());

create policy "quote_share_tokens platform_admin update"
  on public.quote_share_tokens
  for update using (is_platform_admin()) with check (is_platform_admin());

-- ── Helper: resolve a token to its quote_id (or null if invalid) ──────────────

create or replace function public.resolve_share_token(p_token text)
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select quote_id
  from   public.quote_share_tokens
  where  token    = p_token
    and  revoked  = false
    and  (expires_at is null or expires_at > now())
  limit 1
$$;

-- ── RPC: get_quote_by_token ───────────────────────────────────────────────────
--
-- Returns a JSON object with the quote, its current admin/admin-flavored
-- revision, and that revision's line items. Returns null if the token is
-- invalid. Runs as postgres (security definer) so anon callers can't bypass
-- the token check by calling the underlying tables directly.

create type public.quote_share_payload as (
  quote_id              uuid,
  event_name            text,
  event_dates           text,
  num_days              integer,
  num_events            integer,
  num_entries           integer,
  multi_event_players   integer,
  distance_miles        integer,
  platform              text,
  first_event_fee_cents integer,
  additional_event_fee_cents integer,
  revision_id           uuid,
  revision_number       integer,
  revision_notes        text,
  subtotal_cents        integer,
  estimated_revenue_cents integer,
  estimated_net_cents   integer,
  line_items            json
);

create or replace function public.get_quote_by_token(p_token text)
returns public.quote_share_payload
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_quote_id  uuid;
  v_result    public.quote_share_payload;
begin
  -- Validate token
  v_quote_id := public.resolve_share_token(p_token);
  if v_quote_id is null then
    return null;
  end if;

  -- Fetch quote + current revision + line items
  select
    q.id,
    q.event_name,
    q.event_dates,
    q.num_days,
    q.num_events,
    q.num_entries,
    q.multi_event_players,
    q.distance_miles,
    q.platform::text,
    q.first_event_fee_cents,
    q.additional_event_fee_cents,
    r.id,
    r.revision_number,
    r.notes,
    r.subtotal_cents,
    r.estimated_revenue_cents,
    r.estimated_net_cents,
    (
      select json_agg(
        json_build_object(
          'id',                    li.id,
          'service_key',           li.service_key,
          'label',                 li.label,
          'qty',                   li.qty,
          'unit_price_cents',      li.unit_price_cents,
          'passthrough_cost_cents',li.passthrough_cost_cents,
          'line_total_cents',      li.line_total_cents
        )
        order by li.service_key
      )
      from public.quote_line_items li
      where li.revision_id = r.id
    )
  into v_result
  from public.quotes q
  join public.quote_revisions r
    on r.quote_id = q.id
   and r.is_current = true
  where q.id = v_quote_id;

  return v_result;
end;
$$;

-- Grant anon execute so the public customer page can call it directly.
grant execute on function public.get_quote_by_token(text) to anon;

-- ── RPC: submit_customer_revision ─────────────────────────────────────────────
--
-- Accepts a share token and the customer's selected line items (as a JSON array
-- of objects matching the line_items shape above, minus id). Creates a new
-- quote_revision with created_by='customer' and marks it current, then inserts
-- the line items. Returns the new revision_id, or raises an exception if the
-- token is invalid.
--
-- Line-item prices are passed in from the client-side snapshot of the admin
-- revision — the customer cannot choose prices. The function does NOT recompute
-- totals; the client computes them via quotePricing.ts and sends them.

create or replace function public.submit_customer_revision(
  p_token        text,
  p_line_items   json,
  p_subtotal_cents          integer,
  p_estimated_revenue_cents integer,
  p_estimated_net_cents     integer,
  p_notes                   text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote_id   uuid;
  v_next_num   integer;
  v_rev_id     uuid;
begin
  -- Validate token
  v_quote_id := public.resolve_share_token(p_token);
  if v_quote_id is null then
    raise exception 'invalid or expired share token';
  end if;

  -- Mark existing current revision as not current
  update public.quote_revisions
  set    is_current = false
  where  quote_id   = v_quote_id
    and  is_current = true;

  -- Next revision number
  select coalesce(max(revision_number), 0) + 1
  into   v_next_num
  from   public.quote_revisions
  where  quote_id = v_quote_id;

  -- Insert new revision
  insert into public.quote_revisions (
    quote_id, revision_number, created_by,
    subtotal_cents, estimated_revenue_cents, estimated_net_cents,
    is_current, notes
  )
  values (
    v_quote_id, v_next_num, 'customer',
    p_subtotal_cents, p_estimated_revenue_cents, p_estimated_net_cents,
    true, p_notes
  )
  returning id into v_rev_id;

  -- Insert line items from JSON array
  insert into public.quote_line_items (
    revision_id, service_key, label, qty,
    unit_price_cents, passthrough_cost_cents, line_total_cents
  )
  select
    v_rev_id,
    (item->>'service_key')::text,
    (item->>'label')::text,
    (item->>'qty')::integer,
    (item->>'unit_price_cents')::integer,
    coalesce((item->>'passthrough_cost_cents')::integer, 0),
    (item->>'line_total_cents')::integer
  from json_array_elements(p_line_items) as item;

  return v_rev_id;
end;
$$;

-- Grant anon execute so the public customer page can call it.
grant execute on function public.submit_customer_revision(text, json, integer, integer, integer, text) to anon;
