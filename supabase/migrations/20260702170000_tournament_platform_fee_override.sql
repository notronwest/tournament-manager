-- Per-tournament platform-fee override.
--
-- platform_settings holds the GLOBAL default fee (issue #20). This adds an
-- optional per-tournament override: when set, create-payment-intent uses it
-- instead of the global default; when null, the tournament inherits the
-- default (so changing the global default moves all non-overridden
-- tournaments).
--
-- Money-path safety: the platform fee is the PLATFORM's cut, so an org admin
-- must NOT be able to set/zero it on their own tournament. A BEFORE trigger
-- restricts changes to the fee columns to platform admins (is_platform_admin);
-- ordinary tournament edits by org admins pass through untouched because the
-- trigger only fires when a fee column actually changes.

-- ── Columns ───────────────────────────────────────────────────────────
-- Both null  → inherit the global default (platform_settings).
-- Both set   → override. Mirrors platform_settings' bps + fixed_cents shape:
--              application_fee_amount = round(total * bps / 10000) + fixed.
alter table public.tournaments
  add column platform_fee_bps         integer,
  add column platform_fee_fixed_cents integer;

comment on column public.tournaments.platform_fee_bps is
  'Per-tournament platform-fee percent in basis points. NULL = inherit platform_settings default. Set together with platform_fee_fixed_cents. Platform-admin-only (enforced by trg_enforce_tournament_fee_admin).';
comment on column public.tournaments.platform_fee_fixed_cents is
  'Per-tournament fixed platform fee in cents. NULL = inherit platform_settings default. Set together with platform_fee_bps. Platform-admin-only.';

-- ── Constraints ───────────────────────────────────────────────────────
alter table public.tournaments
  -- both-or-neither: no half-set (ambiguous) override.
  add constraint tournament_platform_fee_both_or_neither
    check ((platform_fee_bps is null) = (platform_fee_fixed_cents is null)),
  -- same ranges platform_settings enforces.
  add constraint tournament_platform_fee_bps_range
    check (platform_fee_bps is null or platform_fee_bps between 0 and 10000),
  add constraint tournament_platform_fee_fixed_nonneg
    check (platform_fee_fixed_cents is null or platform_fee_fixed_cents >= 0);

-- ── Platform-admin-only guard ─────────────────────────────────────────
-- Blocks non-platform-admins from setting (INSERT) or changing (UPDATE) the
-- fee columns. Fires only when a fee column actually changes, so org admins
-- editing other tournament fields are unaffected. The create-payment-intent
-- function only READS these columns (never writes them), so service_role
-- writes to other columns never trip this.
create or replace function public.enforce_tournament_fee_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if (new.platform_fee_bps is not null or new.platform_fee_fixed_cents is not null)
       and not public.is_platform_admin() then
      raise exception 'Only platform admins can set a tournament platform-fee override'
        using errcode = 'check_violation';
    end if;
  elsif tg_op = 'UPDATE' then
    if (new.platform_fee_bps is distinct from old.platform_fee_bps
        or new.platform_fee_fixed_cents is distinct from old.platform_fee_fixed_cents)
       and not public.is_platform_admin() then
      raise exception 'Only platform admins can change a tournament platform-fee override'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.enforce_tournament_fee_admin() is
  'Restricts changes to tournaments.platform_fee_* to platform admins. SECURITY DEFINER so is_platform_admin() resolves under the caller''s auth.uid().';

create trigger trg_enforce_tournament_fee_admin
  before insert or update on public.tournaments
  for each row execute function public.enforce_tournament_fee_admin();
