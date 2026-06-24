import { useEffect, useState, type CSSProperties } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../supabase";
import { useAuth } from "../auth/AuthProvider";
// V5 brush wordmark — outlined SVG, no font dependency. Cream BERT &
// ERNE with a court-yellow ampersand, transparent background so it
// drops onto the dark navbar (or any ink surface) without a panel.
import logoUrl from "../assets/bert-and-erne-brush-mark.svg";

// sessionStorage key the test-players tool writes to before signing
// in as a test user. Same constant used here for the "Switch back"
// detection — keep in sync with TestPlayersPage.
const IMPERSONATION_KEY = "tm:admin-session";

type StashedSession = {
  access_token: string;
  refresh_token: string;
  email: string | null | undefined;
};

function readStashedSession(): StashedSession | null {
  try {
    const raw = sessionStorage.getItem(IMPERSONATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StashedSession;
    if (!parsed?.access_token || !parsed?.refresh_token) return null;
    return parsed;
  } catch {
    return null;
  }
}

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
    isPlatformAdmin: boolean;
  } | null>(null);

  // Responsive chrome. The signed-in nav is wide (greeting + up to 4 links +
  // Sign out beside a 240px logo); below the 767px breakpoint it overflows and
  // clips — "Sign out" gets cut off and a phone user is trapped (#500 audit).
  // So on mobile we collapse the nav into a hamburger + dropdown. matchMedia
  // (not a CSS media query) because the styles are inline, per project convention.
  const [menuOpen, setMenuOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 767px)");
    // setState inside this change callback (not synchronously in the effect
    // body) is the recommended subscribe pattern. Also collapse any open menu
    // when the viewport crosses the breakpoint. Route-change closing is handled
    // by each menu item's onClick (tapping a link navigates and closes it).
    const onChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      setMenuOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      // Three reads in parallel — none blocks the others.
      const [{ data: player }, { data: memberships }, { data: adminRow }] =
        await Promise.all([
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
          // Platform admins have implicit org access (see useCurrentOrg), so
          // they get the Admin link even with no organization_members row —
          // otherwise a super-admin can't reach the admin area from the header.
          supabase
            .from("platform_admins")
            .select("user_id")
            .eq("user_id", user.id)
            .maybeSingle(),
        ]);
      if (cancelled) return;
      setCache({
        userId: user.id,
        firstName: player?.first_name ?? null,
        isOrgMember: !!memberships && memberships.length > 0,
        isPlatformAdmin: !!adminRow,
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
  const isPlatformAdmin = matches ? cache!.isPlatformAdmin : false;
  // Platform admins reach the admin area even without an org membership.
  const showAdminLink = isOrgMember || isPlatformAdmin;

  // Impersonation: if there's a stashed admin session in sessionStorage
  // it means TestPlayersPage signed us in as a test user and the admin
  // can switch back. Read sessionStorage directly each render — it's
  // cheap, and the value can only change due to navigations that
  // already trigger a re-render (stash + navigate from
  // TestPlayersPage, clear + navigate from onSwitchBack / onSignOut).
  // Keeping it out of React state avoids the set-state-in-effect
  // lint flag without any behavioral compromise.
  const stashed = readStashedSession();
  const impersonating = !!stashed && !!user;

  // Hide on /login — the page itself is the sign-in surface, no need
  // for a duplicate Sign-in link in the chrome above it.
  if (location.pathname === "/login") return null;

  const onSignOut = async () => {
    // Sign-out should also clear any impersonation state — otherwise
    // a stale stashed session would haunt the next sign-in.
    sessionStorage.removeItem(IMPERSONATION_KEY);
    await signOut();
    navigate("/");
  };

  const onSwitchBack = async () => {
    if (!stashed) return;
    const { error: setErr } = await supabase.auth.setSession({
      access_token: stashed.access_token,
      refresh_token: stashed.refresh_token,
    });
    sessionStorage.removeItem(IMPERSONATION_KEY);
    if (setErr) {
      // Refresh token expired (default is hours, but possible if the
      // admin spent a long time testing). Fall back to a clean
      // sign-out and let them re-authenticate.
      await signOut();
      navigate("/login");
      return;
    }
    navigate("/admin");
  };

  // Use the current pathname as the post-login `from` so that
  // signing in from any page brings the user back. The state shape
  // matches what RequireAuth sets when it bounces — LoginPage reads
  // location.state.from?.pathname.
  const signInState = { from: location };

  // The nav as data — used to render the mobile dropdown. Desktop keeps its
  // own inline markup below (unchanged), so the two layouts stay independent
  // and desktop carries zero regression risk.
  type NavEntry = {
    key: string;
    label: string;
    to?: string;
    onClick?: () => void;
    state?: typeof signInState;
    variant: "ghost" | "cta" | "primary";
  };
  const mobileEntries: NavEntry[] = [
    { key: "getting-started", label: "Getting Started", to: "/getting-started", variant: "ghost" },
  ];
  if (!loading) {
    if (!user) {
      mobileEntries.push({ key: "signin", label: "Sign in", to: "/login", state: signInState, variant: "primary" });
    } else {
      mobileEntries.push({ key: "my-tournaments", label: "My Tournaments", to: "/my-tournaments", variant: "cta" });
      if (showAdminLink) mobileEntries.push({ key: "admin", label: "Admin", to: "/admin", variant: "ghost" });
      mobileEntries.push({ key: "profile", label: "Profile", to: "/profile", variant: "ghost" });
      mobileEntries.push({ key: "signout", label: "Sign out", onClick: () => void onSignOut(), variant: "ghost" });
    }
  }
  // On mobile there's no floating Feedback FAB (it crowded the bottom CTA), so
  // surface Feedback here for everyone. Tapping it fires the event the
  // FeedbackWidget listens for, which opens its panel.
  mobileEntries.push({
    key: "feedback",
    label: "Feedback",
    onClick: () => window.dispatchEvent(new CustomEvent("wmpc:open-feedback")),
    variant: "ghost",
  });

  return (
    <>
      {impersonating && (
        <div
          style={{
            background: "#fef3c7",
            borderBottom: "1px solid #fde68a",
            color: "#7a5d00",
            fontSize: 13,
            position: "sticky",
            top: 0,
            zIndex: 21,
          }}
        >
          <div
            style={{
              maxWidth: 1080,
              margin: "0 auto",
              padding: "8px 24px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <span>
              Testing as <strong>{firstName ?? user?.email}</strong>.
              You'll switch back to{" "}
              <strong>{stashed?.email ?? "your admin account"}</strong>.
            </span>
            <button
              type="button"
              onClick={() => void onSwitchBack()}
              style={{
                padding: "5px 12px",
                background: "#fff",
                border: "1px solid #d4a017",
                color: "#7a5d00",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Switch back
            </button>
          </div>
        </div>
      )}
      <header
      style={{
        background: INK,
        borderBottom: `1px solid ${INK}`,
        // sticky keeps the bar visible as the user scrolls long
        // tournament / register pages. When the impersonation banner
        // is showing, both bars stack at the top.
        position: "sticky",
        top: impersonating ? 36 : 0,
        zIndex: 20,
      }}
    >
      <div
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          padding: "12px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <Link
          to="/"
          aria-label="bert & erne — pickleball tournaments"
          style={{
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          <img
            src={logoUrl}
            alt="bert & erne"
            // Brush wordmark viewBox is 395×61 (~6.5:1). 240px wide →
            // ~37px tall — keeps the Permanent Marker letters legible
            // and reads as a wordmark, not a chip, in the dark navbar.
            width="240"
            height="37"
            style={{ display: "block" }}
          />
        </Link>

        {isMobile ? (
          <button
            type="button"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            style={hamburgerStyle}
          >
            {menuOpen ? "✕" : "☰"}
          </button>
        ) : (
        <nav
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
          }}
        >
          <Link to="/getting-started" style={ghostLinkStyle}>
            Getting Started
          </Link>
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
                    color: CREAM_DIM,
                    marginRight: 8,
                    fontSize: 13,
                  }}
                >
                  Hi, {firstName}
                </span>
              )}
              <Link to="/my-tournaments" style={myTournamentsLinkStyle}>
                My Tournaments
              </Link>
              {showAdminLink && (
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
        )}
      </div>

      {isMobile && menuOpen && (
        <div style={mobileMenuStyle}>
          {user && firstName && (
            <div style={mobileGreetingStyle}>Hi, {firstName}</div>
          )}
          {mobileEntries.map((e) =>
            e.to ? (
              <Link
                key={e.key}
                to={e.to}
                state={e.state}
                onClick={() => setMenuOpen(false)}
                style={mobileItemStyle(e.variant)}
              >
                {e.label}
              </Link>
            ) : (
              <button
                key={e.key}
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  e.onClick?.();
                }}
                style={mobileItemStyle(e.variant)}
              >
                {e.label}
              </button>
            ),
          )}
        </div>
      )}
    </header>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Styles — kept inline to match project conventions (no Tailwind).
// V5 dark navbar palette: ink background, cream nav links, court-yellow
// for the primary "Sign in" CTA so it pops without competing with the
// brush logo's yellow ampersand.
// ─────────────────────────────────────────────────────────────────────

const INK = "#14181f";
const CREAM = "#fafaf7";
const CREAM_DIM = "rgba(250, 250, 247, 0.7)";
const CREAM_BORDER = "rgba(250, 250, 247, 0.16)";
const COURT_YELLOW = "#f3d111";

const ghostLinkStyle: CSSProperties = {
  padding: "6px 12px",
  color: CREAM,
  textDecoration: "none",
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 13,
};

const ghostButtonStyle: CSSProperties = {
  padding: "6px 12px",
  background: "transparent",
  color: CREAM,
  border: `1px solid ${CREAM_BORDER}`,
  borderRadius: 6,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 13,
};

const myTournamentsLinkStyle: CSSProperties = {
  padding: "6px 14px",
  background: COURT_YELLOW,
  color: INK,
  textDecoration: "none",
  borderRadius: 6,
  fontWeight: 600,
  fontFamily: "inherit",
  fontSize: 13,
};

const primaryLinkStyle: CSSProperties = {
  padding: "6px 14px",
  background: COURT_YELLOW,
  color: INK,
  textDecoration: "none",
  borderRadius: 6,
  fontWeight: 600,
  fontFamily: "inherit",
  fontSize: 13,
};

// ── Mobile (≤767px) chrome ───────────────────────────────────────────
// The authed nav collapses into a hamburger + full-width dropdown so it
// never clips and every item (incl. Sign out) is a ≥44px tap target (#500).

const hamburgerStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 44,
  height: 44,
  background: "transparent",
  color: CREAM,
  border: `1px solid ${CREAM_BORDER}`,
  borderRadius: 8,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 20,
  lineHeight: 1,
};

const mobileMenuStyle: CSSProperties = {
  borderTop: `1px solid ${CREAM_BORDER}`,
  background: INK,
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const mobileGreetingStyle: CSSProperties = {
  color: CREAM_DIM,
  fontSize: 14,
  padding: "6px 12px 2px",
};

function mobileItemStyle(
  variant: "ghost" | "cta" | "primary",
): CSSProperties {
  const base: CSSProperties = {
    display: "flex",
    alignItems: "center",
    minHeight: 44,
    padding: "10px 14px",
    borderRadius: 8,
    fontFamily: "inherit",
    fontSize: 15,
    textDecoration: "none",
    textAlign: "left",
    width: "100%",
    boxSizing: "border-box",
    cursor: "pointer",
  };
  if (variant === "ghost") {
    return {
      ...base,
      color: CREAM,
      background: "transparent",
      border: `1px solid ${CREAM_BORDER}`,
    };
  }
  // cta + primary share the court-yellow filled look.
  return {
    ...base,
    color: INK,
    background: COURT_YELLOW,
    border: "none",
    fontWeight: 600,
  };
}
