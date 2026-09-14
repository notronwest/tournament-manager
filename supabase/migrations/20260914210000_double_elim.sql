-- 20260914210000_double_elim.sql
--
-- Double-elimination bracket format (#894, epic #892). Additive only.
--
--   events.double_elim_final     crossover  — Winners champ v Consolation champ
--                                             for gold, if-necessary game, consolation
--                                             runner-up bronze
--                                bronze_only — Winners Final decides gold/silver; its
--                                             loser keeps silver and never drops;
--                                             Consolation champ bronze
--   matches.bracket / slot_key / label / if_necessary — which bracket a match
--                                belongs to and the lib slot it was generated from
--   matches.feeds_winner_to/side, feeds_loser_to/side — data-driven feed-forward:
--                                when a match completes, its winner and loser are
--                                written into the target match's a/b side.
--
-- events.bracket_type already has the 'double_elim' value (init schema); the app
-- starts branching on it with this feature. Round-robin events keep every new
-- column null / default, so nothing changes for them.

set search_path = public;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'double_elim_final') then
    create type double_elim_final as enum ('crossover', 'bronze_only');
  end if;
  if not exists (select 1 from pg_type where typname = 'match_bracket') then
    create type match_bracket as enum ('winners', 'consolation', 'final');
  end if;
end;
$$;

alter table events
  add column if not exists double_elim_final double_elim_final not null default 'crossover';

comment on column events.double_elim_final is
  'Double elimination only: crossover = consolation champ plays the winners champ for gold '
  '(if-necessary game; consolation runner-up bronze); bronze_only = winners final decides '
  'gold/silver, consolation champ bronze.';

alter table matches
  add column if not exists bracket           match_bracket,
  add column if not exists slot_key          text,
  add column if not exists label             text,
  add column if not exists if_necessary      boolean not null default false,
  add column if not exists feeds_winner_to   uuid references matches(id) on delete set null,
  add column if not exists feeds_winner_side text check (feeds_winner_side in ('a', 'b')),
  add column if not exists feeds_loser_to    uuid references matches(id) on delete set null,
  add column if not exists feeds_loser_side  text check (feeds_loser_side in ('a', 'b'));

comment on column matches.bracket is
  'Double elimination: winners | consolation | final. Null for round-robin / legacy playoff matches.';
comment on column matches.slot_key is
  'Double elimination: the lib/doubleElim slot this row was generated from (e.g. W1-1, L3-2, F2).';
comment on column matches.if_necessary is
  'Double elimination crossover: the second final, played only if the consolation champ wins F1.';
comment on column matches.feeds_winner_to is
  'Match whose a/b side (feeds_winner_side) receives this match''s winner. Null = nothing (medal decided).';
comment on column matches.feeds_loser_to is
  'Match whose a/b side (feeds_loser_side) receives this match''s loser. Null = eliminated / medal decided.';

create index if not exists matches_bracket_idx
  on matches (event_id, bracket, round, position)
  where bracket is not null;
