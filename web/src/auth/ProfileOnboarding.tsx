import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../supabase";

// Post-login nudge. After a genuine sign-in, send a user who hasn't finished
// their profile to /profile — the first-fill "Welcome" screen, which has an
// "I'll do this later" escape so it's a soft prompt, not a wall. Registration
// stays the hard gate (RequireProfile bounces incomplete profiles right back).
//
// Fires once per signed-in session and NEVER on a page-reload session restore,
// so reloading doesn't re-nag a user who chose to finish later.
//
// "Complete" = first_name + last_name + email (same as RequireProfile). Gender
// and ratings are optional, so they never trigger the prompt.
export function ProfileOnboarding() {
  const navigate = useNavigate();
  // The first auth event on mount is a session *restore* (INITIAL_SESSION, or
  // a SIGNED_IN standing in for it) — not a fresh login. Skip it.
  const seenInitial = useRef(false);
  const promptedThisSession = useRef(false);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        promptedThisSession.current = false;
        return;
      }
      if (!seenInitial.current) {
        seenInitial.current = true;
        return;
      }
      if (event !== "SIGNED_IN" || promptedThisSession.current) return;
      const uid = session?.user?.id;
      if (!uid) return;

      void (async () => {
        const { data: p } = await supabase
          .from("players")
          .select("first_name, last_name, email")
          .eq("auth_user_id", uid)
          .is("deleted_at", null)
          .maybeSingle();
        const complete = !!(
          p?.first_name?.trim() && p?.last_name?.trim() && p?.email?.trim()
        );
        if (complete) return;

        promptedThisSession.current = true;
        if (window.location.pathname !== "/profile") {
          navigate("/profile?return=/");
        }
      })();
    });
    return () => data.subscription.unsubscribe();
  }, [navigate]);

  return null;
}
