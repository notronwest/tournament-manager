-- 20261010120000_public_tournament_campaign.sql
--
-- Why this exists: the Leaf Peeper thank-you email went out on 2026-10-09
-- with the recap link UNTAGGED — `/t/wmpc/2nd-annual-leaf-peeper-tournament/recap`
-- with no `?c=leaf-peeper-2026` on it (PickleballBrackets wraps every link in
-- its own ct.aspx redirect, and the tag was lost when the URL was pasted in).
-- The recap page keys BOTH its funnel capture and its credit grant off that
-- query param, so with the tag missing: no recap_view is ever recorded, the
-- campaign never reaches sessionStorage, and grant_account_credit() is never
-- called — i.e. the email promises a $20 credit that nobody can actually
-- receive. Verified against PROD on 2026-10-10: campaign_events empty,
-- account_credits empty, the offer flag ON and the page otherwise working.
--
-- The fix is a FALLBACK, not a re-send: when a recap link carries no `?c=`,
-- the page asks the server which campaign is live for that tournament's
-- organization. D-0077 forbids a client-written grant or a client-computed
-- amount, so the client must never *invent* a campaign — hence this function
-- rather than a hardcoded slug in the bundle. The server stays the only
-- authority on which campaign is live; the client only learns its name.
--
-- Exposure, deliberately narrow: credit_campaigns is "never exposed to the
-- client" (20261008150000). This returns ONE text slug and nothing else — no
-- amount, no organization id, no dates, no row — and only for a tournament
-- that is already recap-public (status = 'completed', the same gate
-- public_tournament_recap uses). The slug was always meant to be public: it
-- was supposed to be sitting in the URL in 116 people's inboxes. The amount,
-- which was never public, stays unreadable.

set search_path = public;

create or replace function public_tournament_campaign(
  p_org_slug text,
  p_tournament_slug text
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select cc.campaign
  from tournaments tr
  join organizations o on o.id = tr.organization_id
  join credit_campaigns cc on cc.organization_id = tr.organization_id
  where o.slug = p_org_slug
    and tr.slug = p_tournament_slug
    and tr.deleted_at is null
    -- Same public gate as public_tournament_recap: if the recap isn't
    -- public, its campaign isn't discoverable either.
    and tr.status = 'completed'
    and cc.active
    and (cc.starts_at is null or cc.starts_at <= now())
    and (cc.ends_at is null or cc.ends_at > now())
  -- A deterministic pick if an org ever has two live campaigns at once:
  -- the most recently created one wins. Not expected, but a silent
  -- arbitrary choice between two money offers is not acceptable.
  order by cc.created_at desc
  limit 1;
$$;

comment on function public_tournament_campaign(text, text) is
  'Returns the slug of the live credit campaign for a completed tournament''s organization, or NULL. The fallback for a recap link that arrived with no ?c= tag (the 2026-10-09 Leaf Peeper send). Returns the slug ONLY — never the amount, org or dates — so credit_campaigns stays client-unreadable per D-0077.';

revoke all on function public_tournament_campaign(text, text) from public;
grant execute on function public_tournament_campaign(text, text) to anon, authenticated;

-- Automated check, run on every apply: the slug may be readable, the money
-- must not be. Mirrors the anon-select assertion in 20261008130000.
do $$
begin
  if has_table_privilege('anon', 'credit_campaigns', 'select') then
    raise exception 'credit_campaigns must not be selectable by anon';
  end if;
  if has_table_privilege('authenticated', 'credit_campaigns', 'select') then
    raise exception 'credit_campaigns must not be selectable by authenticated';
  end if;
end $$;
