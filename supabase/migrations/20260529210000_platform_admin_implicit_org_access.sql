-- 20260529210000_platform_admin_implicit_org_access.sql
--
-- Grant platform admins implicit access to every organization.
--
-- The RLS layer for org-scoped tables runs through two helpers:
--
--   is_org_member(org)            — true when the caller has an
--                                   organization_members row.
--   has_org_role(org, min_role)   — true when the caller's role on
--                                   that org is >= min_role.
--
-- Both are SECURITY DEFINER and used by virtually every admin RLS
-- policy (tournaments, events, registrations, pricing tiers, etc.).
-- Updating them in one place is the surgical way to make platform
-- admins (super-admins from 20260529190000_platform_admins) act as
-- implicit owners of every org without touching the dozens of
-- individual policies.
--
-- Side effects: anywhere these helpers gate a read/write, a
-- platform admin now passes. Combined with the new
-- viaPlatformAdmin signal from the client useCurrentOrg hook, this
-- lets a platform admin walk into any org and operate as an owner
-- with a clear UI marker.

set search_path = public;

create or replace function public.is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from organization_members
    where organization_id = org and user_id = auth.uid()
  )
  or exists (
    select 1 from platform_admins where user_id = auth.uid()
  );
$$;

create or replace function public.has_org_role(org uuid, min_role org_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- Platform admins implicitly satisfy any role check.
  select exists (
    select 1 from platform_admins where user_id = auth.uid()
  )
  or exists (
    select 1 from organization_members
    where organization_id = org
      and user_id = auth.uid()
      and case min_role
            when 'staff' then true
            when 'admin' then role in ('admin', 'owner')
            when 'owner' then role = 'owner'
          end
  );
$$;
