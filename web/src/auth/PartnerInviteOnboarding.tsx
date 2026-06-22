import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../supabase";

// Post-login surfacing for pending partner invites. After a genuine sign-in,
// a player who has at least one pending invite is sent to /invites — so the
// invite "supersedes" whatever tournament they were headed to, the way the
// global banner can't (the banner is easy to scroll past). /invites is a soft
// landing: every invite has a "Not now" escape and the persistent banner
// keeps them reachable afterward.
//
// Mirrors ProfileOnboarding's mechanics:
//   * Fires once per signed-in session, NEVER on a page-reload session restore
//     (so reloading doesn't re-nag someone who chose "Not now").
//   * Profile takes precedence — if the profile is incomplete we do nothing and
//     let ProfileOnboarding route to /profile first (accepting an invite needs
//     a complete profile anyway). Once the profile is complete, the next login
//     surfaces the invite.
export function PartnerInviteOnboarding() {
  const navigate = useNavigate();
  const seenInitial = useRef(false);
  const promptedThisSession = useRef(false);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        promptedThisSession.current = false;
        return;
      }
      // First event on mount is a session restore, not a fresh login — skip.
      if (!seenInitial.current) {
        seenInitial.current = true;
        return;
      }
      if (event !== "SIGNED_IN" || promptedThisSession.current) return;
      const uid = session?.user?.id;
      if (!uid) return;

      void (async () => {
        const { data: me } = await supabase
          .from("players")
          .select("id, first_name, last_name, email")
          .eq("auth_user_id", uid)
          .is("deleted_at", null)
          .maybeSingle();
        if (!me) return;

        // Profile-incomplete → defer to ProfileOnboarding (it sends to
        // /profile). We only surface invites once the profile is set.
        const complete = !!(
          me.first_name?.trim() && me.last_name?.trim() && me.email?.trim()
        );
        if (!complete) return;

        const { data: pending } = await supabase
          .from("partner_invites")
          .select("id")
          .eq("invitee_player_id", me.id)
          .eq("status", "pending")
          .limit(1);
        if (!pending || pending.length === 0) return;

        promptedThisSession.current = true;
        if (
          window.location.pathname !== "/invites" &&
          !window.location.pathname.includes("/invites/")
        ) {
          navigate("/invites");
        }
      })();
    });
    return () => data.subscription.unsubscribe();
  }, [navigate]);

  return null;
}
