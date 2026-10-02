-- 20261002120000_match_timing.sql
--
-- Track how long each match actually takes on court, so a director can see
-- a live clock on the court box and we can measure court efficiency after
-- the event (minutes per game by division, idle time between games, how far
-- the day drifted from the schedule).
--
-- Adds to public.matches:
--   started_at        — when the match was loaded onto a court (status →
--                       in_progress)
--   ended_at          — when the final score was recorded (status → completed)
--   duration_seconds  — generated: ended_at - started_at, null until both set
--
-- The timestamps are stamped by a trigger on the status transition, not by
-- the client, so every writer gets them for free — the tournament and
-- per-event court managers, the event console, the round simulator, and any
-- future scorer app. A writer that supplies its own value in the same UPDATE
-- (a desk back-filling a start time) is respected: the trigger only fills a
-- column the statement left untouched.
--
-- Transitions:
--   → in_progress   started_at = now() (if not set), ended_at cleared
--   → completed     ended_at = now() (if not set). started_at stays null for a
--                   match scored straight from the console without ever being
--                   loaded on a court — duration is simply unknown.
--   → pending       both cleared (the match was unloaded or its score was
--                   reset; it has not been played)
-- A score edit on an already-completed match touches neither.
--
-- No RLS change: the new columns inherit the matches policies. Public can
-- read them on visible events, which is intended — a results page can show
-- game length.

set search_path = public;

alter table public.matches
  add column if not exists started_at timestamptz,
  add column if not exists ended_at   timestamptz;

alter table public.matches
  add column if not exists duration_seconds integer
    generated always as (
      case
        when started_at is not null and ended_at is not null
          then greatest(0, extract(epoch from (ended_at - started_at)))::integer
        else null
      end
    ) stored;

comment on column public.matches.started_at is
  'When the match was loaded onto a court (status became in_progress). Stamped by matches_stamp_timing; a client may supply its own value in the same UPDATE.';
comment on column public.matches.ended_at is
  'When the final score was recorded (status became completed). Stamped by matches_stamp_timing; a client may supply its own value in the same UPDATE.';
comment on column public.matches.duration_seconds is
  'Generated: seconds from started_at to ended_at. Null until both are set (e.g. a match scored from the console without ever being loaded on a court).';

create or replace function public.stamp_match_timing()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'in_progress' and new.started_at is null then
      new.started_at := clock_timestamp();
    elsif new.status = 'completed' and new.ended_at is null then
      new.ended_at := clock_timestamp();
    end if;
    return new;
  end if;

  -- UPDATE: only act on a status change, and only fill columns the
  -- statement itself did not set.
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status = 'in_progress' then
    if new.started_at is not distinct from old.started_at then
      new.started_at := clock_timestamp();
    end if;
    if new.ended_at is not distinct from old.ended_at then
      new.ended_at := null;
    end if;
  elsif new.status = 'completed' then
    if new.ended_at is not distinct from old.ended_at then
      new.ended_at := clock_timestamp();
    end if;
  elsif new.status = 'pending' then
    if new.started_at is not distinct from old.started_at then
      new.started_at := null;
    end if;
    if new.ended_at is not distinct from old.ended_at then
      new.ended_at := null;
    end if;
  end if;
  return new;
end;
$$;

comment on function public.stamp_match_timing() is
  'BEFORE INSERT/UPDATE on matches: fills started_at / ended_at from status transitions (in_progress / completed / pending) unless the statement set them itself.';

drop trigger if exists matches_stamp_timing on public.matches;
create trigger matches_stamp_timing
  before insert or update of status on public.matches
  for each row execute function public.stamp_match_timing();

-- Backfill nothing: historical matches keep null timestamps rather than a
-- guessed value from updated_at, which also moves on court assignment and
-- score edits. Efficiency reporting starts from the first tournament run
-- after this ships.
