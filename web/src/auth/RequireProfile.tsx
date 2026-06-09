import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { supabase } from "../supabase";
import { useAuth } from "./AuthProvider";

// Wraps any route that needs a "complete" player profile — meaning
// the authenticated user has a players row linked to their auth user
// with first_name, last_name, and email set. Anyone missing those is
// bounced to /profile?return=<original-path>; ProfilePage redirects
// back here once they've saved.
//
// "Complete" is intentionally minimal: just the two names + email.
// Email is required because flows like checkout and partner invites
// send messages to the player. Phone, gender, and self-ratings stay
// optional — the profile screen nudges for them but doesn't block.
//
// Always renders RequireAuth's loading UI for the auth-loading phase
// so the two wrappers can stack cleanly without two competing
// spinners.
export function RequireProfile({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const location = useLocation();
  const [checking, setChecking] = useState(true);
  const [hasProfile, setHasProfile] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      // RequireAuth should have redirected — bail out so we don't
      // race a Navigate.
      setChecking(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("players")
        .select("first_name, last_name, email")
        .eq("auth_user_id", user.id)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      setHasProfile(
        !!(
          data &&
          data.first_name?.trim() &&
          data.last_name?.trim() &&
          data.email?.trim()
        ),
      );
      setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, authLoading]);

  if (authLoading || checking) {
    return (
      <div style={{ padding: 24, color: "#666", fontSize: 14 }}>Loading…</div>
    );
  }
  if (!hasProfile) {
    const returnTo = location.pathname + location.search;
    return (
      <Navigate
        to={`/profile?return=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }
  return <>{children}</>;
}
