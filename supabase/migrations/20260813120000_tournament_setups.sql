-- ─────────────────────────────────────────────────────────────────────
-- tournament_setups — the customer's tournament-details intake, kicked off
-- from a signed quote (funnel Stage 3: accepted+signed → gather details).
-- One setup per quote. Platform admins manage it via RLS; the customer reaches
-- ONLY their own setup, via a token, through SECURITY DEFINER RPCs (mirrors the
-- quote_share_tokens / get_quote_by_token pattern). answers is a jsonb blob so
-- the intake form's fields can evolve without a migration each time.
-- ─────────────────────────────────────────────────────────────────────

set search_path = public, extensions;

create type public.tournament_setup_status as enum
  ('sent', 'in_progress', 'submitted', 'complete');

create table public.tournament_setups (
  id           uuid                    primary key default gen_random_uuid(),
  quote_id     uuid                    not null unique references public.quotes(id) on delete cascade,
  status       tournament_setup_status not null default 'sent',
  answers      jsonb                   not null default '{}'::jsonb,
  token        text                    not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  created_at   timestamptz             not null default now(),
  updated_at   timestamptz             not null default now(),
  submitted_at timestamptz
);

alter table public.tournament_setups enable row level security;

-- Platform admins: full control (creating/reviewing setups). No anon table
-- policy — the customer's only path is the token RPCs below (SECURITY DEFINER).
create policy "setups platform_admin select" on public.tournament_setups for select using (is_platform_admin());
create policy "setups platform_admin insert" on public.tournament_setups for insert with check (is_platform_admin());
create policy "setups platform_admin update" on public.tournament_setups for update using (is_platform_admin());
create policy "setups platform_admin delete" on public.tournament_setups for delete using (is_platform_admin());

-- ── Customer token access ────────────────────────────────────────────────

-- Read a setup (+ its quote's event context) by its token. Null on no match.
create or replace function public.get_setup_by_token(p_token text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v jsonb;
begin
  select jsonb_build_object(
    'id',           s.id,
    'status',       s.status,
    'answers',      s.answers,
    'submitted_at', s.submitted_at,
    'event_name',   q.event_name,
    'event_dates',  q.event_dates
  )
  into v
  from public.tournament_setups s
  join public.quotes q on q.id = s.quote_id
  where s.token = p_token;
  return v;
end;
$$;

-- Save the customer's answers by token. p_submit=true finalizes (status
-- 'submitted' + submitted_at); otherwise a first save flips 'sent' → 'in_progress'.
create or replace function public.save_setup_by_token(
  p_token   text,
  p_answers jsonb,
  p_submit  boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id     uuid;
  v_status tournament_setup_status;
begin
  select id into v_id from public.tournament_setups where token = p_token;
  if v_id is null then
    raise exception 'invalid setup link';
  end if;

  update public.tournament_setups
    set answers      = coalesce(p_answers, answers),
        status       = case
                         when p_submit then 'submitted'::tournament_setup_status
                         when status = 'sent' then 'in_progress'::tournament_setup_status
                         else status
                       end,
        submitted_at = case when p_submit then now() else submitted_at end,
        updated_at   = now()
    where id = v_id
    returning status into v_status;

  return jsonb_build_object('ok', true, 'status', v_status);
end;
$$;

revoke all on function public.get_setup_by_token(text)               from public;
revoke all on function public.save_setup_by_token(text, jsonb, boolean) from public;
grant execute on function public.get_setup_by_token(text)               to anon, authenticated;
grant execute on function public.save_setup_by_token(text, jsonb, boolean) to anon, authenticated;
