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
      // Right after login there's a window where `user` is set but the
      // supabase client's session token isn't attached to requests yet. A
      // profile probe fired in that window either ABORTS (error — status -1 in
      // the trace) OR, worse, runs effectively unauthenticated and comes back
      // with ZERO rows via RLS *with no error at all*. Both must be treated as
      // "unknown — retry", NOT as "no profile" — otherwise a fully valid user
      // is wrongly ejected to /profile (the flaky nightly: #546). A settled
      // session returns the row within a moment, so we retry a no-row/errored
      // probe a few times and only bounce once "no row" PERSISTS across every
      // attempt. (A row that EXISTS but is incomplete is a definitive answer —
      // bounce immediately, no retry.)
      const MAX_ATTEMPTS = 6;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !cancelled; attempt++) {
        const { data } = await supabase
          .from("players")
          .select("id, first_name, last_name, email")
          .eq("auth_user_id", user.id)
          .is("deleted_at", null)
          .maybeSingle();
        if (cancelled) return;

        if (data) {
          // Definitive row — final decision, no retry. If it has names but no
          // email and the auth session has one (e.g. Google OAuth supplied it),
          // backfill silently; otherwise gate on name+email completeness.
          if (
            data.first_name?.trim() &&
            data.last_name?.trim() &&
            !data.email?.trim() &&
            user.email
          ) {
            await supabase
              .from("players")
              .update({ email: user.email })
              .eq("id", data.id);
            if (cancelled) return;
            setHasProfile(true);
          } else {
            setHasProfile(
              !!(
                data.first_name?.trim() &&
                data.last_name?.trim() &&
                data.email?.trim()
              ),
            );
          }
          setChecking(false);
          return;
        }

        // No row (errored OR empty). Likely the post-login race — back off and
        // retry before concluding the profile is genuinely absent.
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        // "No row" persisted across every attempt → genuinely no/incomplete
        // profile. Bounce to /profile.
        setHasProfile(false);
        setChecking(false);
        return;
      }
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
