import type { ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import {
  ink,
  courtYellow,
  courtGreen,
  bg,
  warnBg,
  warnFg,
  monoFontStack,
} from "../../lib/publicTheme";

// Sidebar-specific surface values. The sidebar lives on a dark ink
// canvas so it needs its own opacity-based palette derived from the
// V5 cream (#fafaf7) foreground.
const SIDEBAR_BG = ink;
const SIDEBAR_FG = bg; // cream-white on dark
const SIDEBAR_FG_DIM = "rgba(250, 250, 247, 0.65)";
const SIDEBAR_CHIP_BG = "rgba(250, 250, 247, 0.08)";

// Two-column layout: org-scoped sidebar nav on the left, route content on
// the right. The class names (`admin-layout`, `admin-sidebar`,
// `admin-sidebar-chrome`, `admin-sidebar-nav`, `admin-main`) are kept stable
// so index.css media-query overrides can target them for responsive layouts.
//
// Identity (who am I, sign-out) is owned by the global SiteHeader at the App
// level — this sidebar owns in-org navigation and org context only.
export default function AdminLayout() {
  const { org, role, loading, error, viaPlatformAdmin } = useCurrentOrg();
  const navigate = useNavigate();

  if (loading) {
    return (
      <div
        style={{
          padding: 24,
          color: SIDEBAR_FG_DIM,
          fontSize: 14,
          fontFamily: monoFontStack,
        }}
      >
        Loading…
      </div>
    );
  }

  if (error || !org) {
    return (
      <main
        style={{
          padding: 24,
          maxWidth: 600,
          margin: "0 auto",
          fontFamily: `"Inter", system-ui, sans-serif`,
        }}
      >
        <h1 style={{ margin: "0 0 8px", fontSize: 20 }}>
          Can't load organization
        </h1>
        <p style={{ color: "#666", fontSize: 14 }}>{error}</p>
        <button
          onClick={() => navigate("/admin")}
          style={{
            marginTop: 12,
            padding: "8px 16px",
            background: "#fff",
            border: "1px solid #e2e2e2",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 13,
            fontFamily: "inherit",
          }}
        >
          Back to organizations
        </button>
      </main>
    );
  }

  return (
    <div
      className="admin-layout"
      style={{ display: "flex", minHeight: "calc(100vh - 61px)" }}
    >
      <aside
        className="admin-sidebar"
        style={{
          width: 240,
          background: SIDEBAR_BG,
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
        }}
      >
        {/* Org identity — hidden on mobile via index.css */}
        <div className="admin-sidebar-chrome">
          {/* Org chip */}
          <div
            style={{
              margin: "20px 14px 4px",
              padding: "10px 12px",
              background: SIDEBAR_CHIP_BG,
              borderRadius: 6,
            }}
          >
            <div
              style={{
                fontFamily: monoFontStack,
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.18em",
                color: courtYellow,
                marginBottom: 4,
              }}
            >
              Organization
            </div>
            <div
              style={{ fontSize: 13, color: SIDEBAR_FG, fontWeight: 500 }}
            >
              {org.name}
            </div>
            {role && (
              <div
                style={{
                  fontFamily: monoFontStack,
                  fontSize: 11,
                  color: SIDEBAR_FG_DIM,
                  marginTop: 3,
                  textTransform: "capitalize",
                }}
              >
                {role}
              </div>
            )}
          </div>
        </div>

        {/* Nav links */}
        <nav
          className="admin-sidebar-nav"
          style={{ flex: 1, padding: "8px 0" }}
        >
          <SideLink to={`/admin/${org.slug}/tournaments`}>
            Tournaments
          </SideLink>
          <SideLink to={`/admin/${org.slug}/locations`}>Venues</SideLink>
          <SideLink to={`/admin/${org.slug}/tools/round-robin`}>
            RR estimator
          </SideLink>
          <SideLink to={`/admin/${org.slug}/tools/seed-event`}>
            Seed test data
          </SideLink>
          <SideLink to={`/admin/${org.slug}/tools/test-players`}>
            Test players
          </SideLink>
          <SideLink to={`/admin/${org.slug}/settings/stripe`}>
            Stripe Connect
          </SideLink>
        </nav>
      </aside>

      <main
        className="admin-main"
        style={{ flex: 1, padding: 32, overflowX: "auto", background: bg }}
      >
        {viaPlatformAdmin && (
          <div
            style={{
              marginBottom: 20,
              padding: "10px 14px",
              background: warnBg,
              border: `1px solid ${courtYellow}`,
              borderRadius: 6,
              fontSize: 13,
              color: warnFg,
              lineHeight: 1.5,
            }}
          >
            Viewing as platform admin. You aren't a member of{" "}
            <strong>{org.name}</strong>, but you have implicit owner-level
            access here.
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}

function SideLink({
  to,
  end,
  children,
}: {
  to: string;
  end?: boolean;
  children: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      style={({ isActive }) => ({
        display: "block",
        padding: "8px 12px",
        margin: "1px 8px",
        textDecoration: "none",
        color: SIDEBAR_FG,
        borderRadius: 4,
        fontSize: 13,
        opacity: isActive ? 1 : 0.75,
        background: isActive ? courtGreen : "transparent",
        fontWeight: isActive ? 600 : 400,
      })}
    >
      {children}
    </NavLink>
  );
}
