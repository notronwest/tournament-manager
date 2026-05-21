import { useEffect, useState, type CSSProperties } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../supabase";
import { useAuth } from "../auth/AuthProvider";

// Global top banner. Rendered once at the App level so every page
// gets the same identity controls — Sign in / Profile / Admin /
// Sign out — without each page having to remember to opt in.
//
// Hides itself on /login (showing "Sign in" links from the sign-in
// page would be silly) and while the auth provider is still hydrating
// (avoids a flash of "Sign in" for users who are actually signed in).
//
// "Admin" only shows for users who are members of at least one
// organization. The membership check runs once per user-id change;
// non-members never see the link, so the chunk of UI is cheap.
export default function SiteHeader() {
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Cached identity data keyed by the user.id it was fetched for.
  // Storing the userId alongside the data lets us derive the rendered
  // values: if `cache.userId !== user?.id` (because a different user
  // just signed in, or the user signed out), we hide it rather than
  // showing stale "Hi, Alice" to user B. The cache only ever gets
  // *populated* inside the effect — never cleared synchronously —
  // which keeps the linter happy about effect-driven state writes.
  const [cache, setCache] = useState<{
    userId: string;
    firstName: string | null;
    isOrgMember: boolean;
  } | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      // Two reads in parallel — neither blocks the other.
      const [{ data: player }, { data: memberships }] = await Promise.all([
        supabase
          .from("players")
          .select("first_name")
          .eq("auth_user_id", user.id)
          .is("deleted_at", null)
          .maybeSingle(),
        supabase
          .from("organization_members")
          .select("organization_id")
          .eq("user_id", user.id)
          .limit(1),
      ]);
      if (cancelled) return;
      setCache({
        userId: user.id,
        firstName: player?.first_name ?? null,
        isOrgMember: !!memberships && memberships.length > 0,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Only trust the cache if it matches the currently-signed-in user.
  const matches = !!user && cache?.userId === user.id;
  const firstName = matches ? cache!.firstName : null;
  const isOrgMember = matches ? cache!.isOrgMember : false;

  // Hide on /login — the page itself is the sign-in surface, no need
  // for a duplicate Sign-in link in the chrome above it.
  if (location.pathname === "/login") return null;

  const onSignOut = async () => {
    await signOut();
    navigate("/");
  };

  // Use the current pathname as the post-login `from` so that
  // signing in from any page brings the user back. The state shape
  // matches what RequireAuth sets when it bounces — LoginPage reads
  // location.state.from?.pathname.
  const signInState = { from: location };

  return (
    <header
      style={{
        background: "#fff",
        borderBottom: "1px solid #e5e7eb",
        // sticky keeps the bar visible as the user scrolls long
        // tournament / register pages.
        position: "sticky",
        top: 0,
        zIndex: 20,
      }}
    >
      <div
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          padding: "10px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <Link
          to="/"
          style={{
            textDecoration: "none",
            color: "#111",
            fontWeight: 600,
            fontSize: 16,
          }}
        >
          Tournament Manager
        </Link>

        <nav
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
          }}
        >
          {loading ? null : !user ? (
            <Link
              to="/login"
              state={signInState}
              style={primaryLinkStyle}
            >
              Sign in
            </Link>
          ) : (
            <>
              {firstName && (
                <span
                  style={{
                    color: "#666",
                    marginRight: 8,
                    fontSize: 13,
                  }}
                >
                  Hi, {firstName}
                </span>
              )}
              {isOrgMember && (
                <Link to="/admin" style={ghostLinkStyle}>
                  Admin
                </Link>
              )}
              <Link to="/profile" style={ghostLinkStyle}>
                Profile
              </Link>
              <button
                type="button"
                onClick={onSignOut}
                style={ghostButtonStyle}
              >
                Sign out
              </button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Styles — kept inline to match project conventions (no Tailwind).
// ─────────────────────────────────────────────────────────────────────

const ghostLinkStyle: CSSProperties = {
  padding: "6px 12px",
  color: "#444",
  textDecoration: "none",
  borderRadius: 6,
  fontFamily: "inherit",
};

const ghostButtonStyle: CSSProperties = {
  padding: "6px 12px",
  background: "transparent",
  color: "#444",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 13,
};

const primaryLinkStyle: CSSProperties = {
  padding: "6px 14px",
  background: "#2563eb",
  color: "#fff",
  textDecoration: "none",
  borderRadius: 6,
  fontWeight: 500,
  fontFamily: "inherit",
};
