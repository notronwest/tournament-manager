-- 20260606140000_enforce_event_eligibility.sql
--
-- Issue #56 (sub-story of the #13 eligibility epic): server-side
-- enforcement of event eligibility as a TRUST BOUNDARY.
--
-- The client guard (issue #55, PR #75) renders a friendly "not eligible"
-- message, but a determined player can bypass JavaScript and POST a row
-- straight to event_registrations. This migration adds a BEFORE INSERT
-- trigger that re-checks the same rule at the database, so an ineligible
-- registration is rejected no matter how it arrives.
--
-- ─── The rule (mirrors web/src/lib/eligibility.ts checkEligibility) ──
--
--   Rating gate — only when the event sets min_rating or max_rating.
--     Pick the player's self-rating by the event's format/gender:
--       singles                  → self_rating_singles
--       doubles + mixed gender   → self_rating_mixed
--       doubles + men's/women's  → self_rating_doubles
--     A NULL self-rating for that format is ineligible. Otherwise the
--     rating must fall within [min_rating, max_rating] (half-open ends
--     when only one bound is set).
--
--   Gender gate — only when the event is NOT mixed.
--     men's   → player.gender = 'M'
--     women's → player.gender = 'F'
--     Any other gender (NULL or 'X') is ineligible.
--
-- ─── Exemptions (decided in the #56 design pass) ────────────────────
--
--   * service_role / edge functions / seed tooling — auth.uid() IS NULL
--     means there's no end-user JWT subject; these are trusted backends
--     (seed-event tool, edge functions), so we skip the check.
--   * Org staff / admins / owners — has_org_role(org, 'staff') lets an
--     organizer hand-place a player into a bracket (e.g. seeding an
--     exception). The gate is for self-service player registration only.
--
-- Extensible for the future "play up" flag (#14): when events gain
-- allow_play_up, relax the max_rating arm of the rating check below.

-- Rating → display string, matching the client's formatRating():
-- trims trailing zeros but always keeps one decimal ("3.0", "3.5",
-- "4.25"). Used only to build the human-readable rejection message.
create or replace function public.format_rating(n numeric)
returns text
language sql
immutable
as $$
  select case when strpos(t, '.') = 0 then t || '.0' else t end
  from (select to_char(n, 'FM999990.99') as t) s
$$;

create or replace function public.enforce_event_eligibility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ev            events%rowtype;
  pl            players%rowtype;
  org_id        uuid;
  player_rating numeric(4,2);
  rating_label  text;
  range_label   text;
  reasons       text[] := '{}';
begin
  -- Trusted backends (service_role, edge functions, seed tools) carry no
  -- end-user JWT subject. Nothing to enforce against — let them through.
  if auth.uid() is null then
    return new;
  end if;

  select * into ev from events where id = new.event_id;
  if not found then
    -- Let the FK constraint produce the error rather than masking it here.
    return new;
  end if;

  -- Resolve the owning org so staff can hand-place players.
  select t.organization_id into org_id
    from tournaments t where t.id = ev.tournament_id;

  if org_id is not null and has_org_role(org_id, 'staff') then
    return new;
  end if;

  select * into pl from players where id = new.player_id;
  if not found then
    return new;  -- FK will reject; don't mask it.
  end if;

  -- ── Rating gate ──────────────────────────────────────────────────
  if ev.min_rating is not null or ev.max_rating is not null then
    if ev.format = 'singles' then
      player_rating := pl.self_rating_singles;
      rating_label  := 'singles';
    elsif ev.format = 'doubles' and ev.gender = 'mixed' then
      player_rating := pl.self_rating_mixed;
      rating_label  := 'mixed doubles';
    else
      player_rating := pl.self_rating_doubles;
      rating_label  := 'doubles';
    end if;

    if player_rating is null then
      reasons := reasons || format('no %s self-rating on file', rating_label);
    elsif (ev.min_rating is not null and player_rating < ev.min_rating)
       or (ev.max_rating is not null and player_rating > ev.max_rating) then
      if ev.min_rating is not null and ev.max_rating is not null then
        range_label := format_rating(ev.min_rating) || '–' || format_rating(ev.max_rating);
      elsif ev.min_rating is not null then
        range_label := '≥' || format_rating(ev.min_rating);
      else
        range_label := '≤' || format_rating(ev.max_rating);
      end if;
      reasons := reasons || format('needs rating %s', range_label);
    end if;
  end if;

  -- ── Gender gate ──────────────────────────────────────────────────
  if ev.gender <> 'mixed' then
    if (ev.gender = 'men'   and pl.gender is distinct from 'M'::player_gender)
    or (ev.gender = 'women' and pl.gender is distinct from 'F'::player_gender) then
      reasons := reasons || (case when ev.gender = 'men'
                                  then 'men''s event'
                                  else 'women''s event' end);
    end if;
  end if;

  if array_length(reasons, 1) > 0 then
    raise exception 'Not eligible for "%": %', ev.name, array_to_string(reasons, '; ')
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger event_regs_enforce_eligibility
  before insert on event_registrations
  for each row execute function public.enforce_event_eligibility();

comment on function public.enforce_event_eligibility() is
  'Trust-boundary check (issue #56): rejects ineligible event_registrations '
  'inserts by self-service players. Mirrors web/src/lib/eligibility.ts. '
  'Exempts service_role (auth.uid() null) and org staff (has_org_role).';
