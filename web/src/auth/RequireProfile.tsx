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
      // The profile probe can be ABORTED by the post-login auth transition:
      // supabase-js swaps the session mid-flight, so this request fails with no
      // response (seen in the trace as status -1). An errored probe must be
      // treated as "unknown — retry", NOT as "no profile" — otherwise a fully
      // valid, complete user is wrongly ejected to /profile (the flaky-nightly
      // bug: #546). Only a SUCCESSFUL query that genuinely returns no complete
      // row should bounce. Retry with backoff; the race resolves within an
      // attempt or two once the new session settles.
      for (let attempt = 0; attempt < 6 && !cancelled; attempt++) {
        const { data, error } = await supabase
          .from("players")
          .select("id, first_name, last_name, email")
          .eq("auth_user_id", user.id)
          .is("deleted_at", null)
          .maybeSingle();
        if (cancelled) return;
        if (error) {
          // Transient (usually the aborted request during the auth swap).
          // Back off and retry rather than ejecting the user.
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }

        // If the player row has names but no email and the auth session
        // already has one (e.g. Google OAuth supplied it), backfill
        // silently rather than bouncing the user to the profile form.
        if (
          data &&
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
              data &&
              data.first_name?.trim() &&
              data.last_name?.trim() &&
              data.email?.trim()
            ),
          );
        }
        setChecking(false);
        return;
      }
      // Every attempt errored — a real backend outage, not the routine
      // auth-swap race. Do NOT bounce a possibly-valid user on a transient
      // failure: stay in the loading state (checking stays true) and let the
      // next auth/user change re-run this check.
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
