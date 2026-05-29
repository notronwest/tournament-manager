import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../supabase";

// Returns true if the signed-in user has a row in public.platform_admins,
// i.e. they're a super-admin who can do cross-org actions like
// creating a new organization. RLS exposes only the caller's own row
// (read-self) so this single query is enough.
//
// Returns null while the answer is unknown (auth still loading, or
// the query in flight), false otherwise. Callers wanting just the
// boolean can `!!usePlatformAdmin()`.
export function usePlatformAdmin(): boolean | null {
  const { user, loading: authLoading } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setIsAdmin(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("platform_admins")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!cancelled) setIsAdmin(!!data);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, authLoading]);

  return isAdmin;
}
