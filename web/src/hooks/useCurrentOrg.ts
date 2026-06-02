import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../supabase";
import { useAuth } from "../auth/AuthProvider";
import type { Database } from "../types/supabase";

type Organization = Database["public"]["Tables"]["organizations"]["Row"];
type OrgRole = Database["public"]["Enums"]["org_role"];

type State = {
  org: Organization | null;
  role: OrgRole | null;
  loading: boolean;
  error: string | null;
  // True when the user reaches this org via platform-admin override
  // (no explicit organization_members row). AdminLayout renders a
  // subtle banner so the elevated access is visible. Note this is
  // ALWAYS false when the user is also an explicit member of the
  // org — a real member who happens to be a platform admin sees
  // the normal admin UI without the override banner.
  viaPlatformAdmin: boolean;
};

// Reads :orgSlug from the URL, fetches the org, and confirms the current
// auth user is a member. Returns the org + the user's role on it. Used by
// the AdminLayout to gate access and by inner pages to scope their queries.
//
// Platform admins (rows in public.platform_admins) have implicit owner-
// level access to every org. When the user isn't an explicit member but
// IS a platform admin, the hook returns role='owner' and
// viaPlatformAdmin=true so the UI can render an override banner.
export function useCurrentOrg(): State {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { user, loading: authLoading } = useAuth();
  const [state, setState] = useState<State>({
    org: null,
    role: null,
    loading: true,
    error: null,
    viaPlatformAdmin: false,
  });

  useEffect(() => {
    if (authLoading) return;
    if (!orgSlug) {
      setState({
        org: null,
        role: null,
        loading: false,
        error: "Missing org slug in URL.",
        viaPlatformAdmin: false,
      });
      return;
    }
    if (!user) {
      setState({
        org: null,
        role: null,
        loading: false,
        error: "Not signed in.",
        viaPlatformAdmin: false,
      });
      return;
    }

    let cancelled = false;
    // Don't flip loading=true on subsequent refetches — the initial
    // useState(loading: true) covers the first paint. Without this,
    // every silent JWT refresh (which happens when the tab regains
    // focus) bumps useCurrentOrg's state, AdminLayout sees
    // loading=true, and flashes "Loading…" over the whole admin
    // view. Just clear the error and let the stale org stay visible
    // until the refetch settles.
    setState((s) => ({ ...s, error: null }));

    (async () => {
      const { data: orgData, error: orgErr } = await supabase
        .from("organizations")
        .select("*")
        .eq("slug", orgSlug)
        .is("deleted_at", null)
        .maybeSingle();

      if (cancelled) return;
      if (orgErr) {
        setState({
          org: null,
          role: null,
          loading: false,
          error: orgErr.message,
          viaPlatformAdmin: false,
        });
        return;
      }
      if (!orgData) {
        setState({
          org: null,
          role: null,
          loading: false,
          error: "Organization not found.",
          viaPlatformAdmin: false,
        });
        return;
      }

      const { data: memberData, error: memberErr } = await supabase
        .from("organization_members")
        .select("role")
        .eq("organization_id", orgData.id)
        .eq("user_id", user.id)
        .maybeSingle();

      if (cancelled) return;
      if (memberErr) {
        setState({
          org: null,
          role: null,
          loading: false,
          error: memberErr.message,
          viaPlatformAdmin: false,
        });
        return;
      }
      if (!memberData) {
        // Not an explicit member. Platform admins still get implicit
        // owner-level access; one extra round-trip rather than join
        // the check up front since most users aren't platform admins.
        const { data: padmin } = await supabase
          .from("platform_admins")
          .select("user_id")
          .eq("user_id", user.id)
          .maybeSingle();
        if (cancelled) return;
        if (padmin) {
          setState({
            org: orgData,
            role: "owner",
            loading: false,
            error: null,
            viaPlatformAdmin: true,
          });
          return;
        }
        setState({
          org: orgData,
          role: null,
          loading: false,
          error: "You are not a member of this organization.",
          viaPlatformAdmin: false,
        });
        return;
      }

      setState({
        org: orgData,
        role: memberData.role,
        loading: false,
        error: null,
        viaPlatformAdmin: false,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [orgSlug, user, authLoading]);

  return state;
}
