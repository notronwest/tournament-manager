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
};

// Reads :orgSlug from the URL, fetches the org, and confirms the current
// auth user is a member. Returns the org + the user's role on it. Used by
// the AdminLayout to gate access and by inner pages to scope their queries.
export function useCurrentOrg(): State {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { user, loading: authLoading } = useAuth();
  const [state, setState] = useState<State>({
    org: null,
    role: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (authLoading) return;
    if (!orgSlug) {
      setState({
        org: null,
        role: null,
        loading: false,
        error: "Missing org slug in URL.",
      });
      return;
    }
    if (!user) {
      setState({
        org: null,
        role: null,
        loading: false,
        error: "Not signed in.",
      });
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

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
        });
        return;
      }
      if (!orgData) {
        setState({
          org: null,
          role: null,
          loading: false,
          error: "Organization not found.",
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
        });
        return;
      }
      if (!memberData) {
        setState({
          org: orgData,
          role: null,
          loading: false,
          error: "You are not a member of this organization.",
        });
        return;
      }

      setState({
        org: orgData,
        role: memberData.role,
        loading: false,
        error: null,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [orgSlug, user, authLoading]);

  return state;
}
