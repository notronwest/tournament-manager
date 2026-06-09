import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { usePlatformAdmin } from "../../hooks/usePlatformAdmin";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../supabase";
import {
  ink,
  courtYellow,
  courtGreen,
  bg,
  warnBg,
  warnFg,
  monoFontStack,
  headingFontStack,
  displayFontStack,
} from "../../lib/publicTheme";

// Sidebar-specific surface values. The sidebar lives on a dark ink
// canvas so it needs its own opacity-based palette derived from the
// V5 cream (#fafaf7) foreground.
const SIDEBAR_BG = ink;
const SIDEBAR_FG = bg; // cream-white on dark
const SIDEBAR_FG_DIM = "rgba(250, 250, 247, 0.65)";
const SIDEBAR_RULE = "rgba(250, 250, 247, 0.1)";
const SIDEBAR_CHIP_BG = "rgba(250, 250, 247, 0.08)";

type OrgSummary = { slug: string; name: string };

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
  const isPlatformAdmin = usePlatformAdmin();
  const { user } = useAuth();

  const [memberOrgs, setMemberOrgs] = useState<OrgSummary[]>([]);
  const [overrideOrgs, setOverrideOrgs] = useState<OrgSummary[]>([]);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Fetch the org list once the platform-admin check resolves to true.
  // Only platform admins get the switcher, so non-admins never fetch.
  useEffect(() => {
    if (isPlatformAdmin !== true || !user) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("organization_members")
        .select("organizations(slug, name)")
        .eq("user_id", user.id);
      if (cancelled) return;
      const list: OrgSummary[] = (data ?? [])
        .map((row) => row.organizations)
        .filter((o): o is OrgSummary => !!o);
      setMemberOrgs(list);

      const memberSlugs = new Set(list.map((o) => o.slug));
      const { data: allOrgs } = await supabase
        .from("organizations")
        .select("slug, name")
        .is("deleted_at", null)
        .order("name", { ascending: true });
      if (cancelled) return;
      setOverrideOrgs(
        (allOrgs ?? []).filter(
          (o): o is OrgSummary => !!o && !memberSlugs.has(o.slug),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [isPlatformAdmin, user]);

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

  const totalOrgs = memberOrgs.length + overrideOrgs.length;

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
        {/* Brand chip + org identity — hidden on mobile via index.css */}
        <div className="admin-sidebar-chrome">
          {/* Brand mark */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "20px 18px 16px",
              borderBottom: `1px solid ${SIDEBAR_RULE}`,
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                background: courtYellow,
                borderRadius: 4,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: displayFontStack,
                color: ink,
                fontSize: 18,
                flexShrink: 0,
                lineHeight: 1,
              }}
            >
              b
            </div>
            <span
              style={{
                fontFamily: headingFontStack,
                fontSize: 14,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: SIDEBAR_FG,
              }}
            >
              bert &amp; erne
            </span>
          </div>

          {/* Org chip */}
          <div
            style={{
              margin: "12px 14px 4px",
              padding: "10px 12px",
              background: SIDEBAR_CHIP_BG,
              borderRadius: 6,
              position: "relative",
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

            {/* Org switcher — platform admins only; hidden while isPlatformAdmin is null */}
            {isPlatformAdmin === true && (
              <button
                onClick={() => setSwitcherOpen((o) => !o)}
                style={{
                  marginTop: 8,
                  padding: "3px 8px",
                  background: "rgba(250, 250, 247, 0.12)",
                  border: "1px solid rgba(250, 250, 247, 0.2)",
                  borderRadius: 4,
                  color: SIDEBAR_FG_DIM,
                  fontSize: 11,
                  fontFamily: monoFontStack,
                  cursor: "pointer",
                  letterSpacing: "0.04em",
                }}
              >
                switch org
              </button>
            )}

            {/* Switcher dropdown */}
            {switcherOpen && (
              <>
                {/* Invisible backdrop to close on outside click */}
                <div
                  style={{
                    position: "fixed",
                    inset: 0,
                    zIndex: 200,
                  }}
                  onClick={() => setSwitcherOpen(false)}
                />
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 4px)",
                    left: 0,
                    right: 0,
                    background: "#fff",
                    border: "1px solid #e2e2e2",
                    borderRadius: 6,
                    boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
                    zIndex: 201,
                    overflow: "hidden",
                  }}
                >
                  {/* Member orgs */}
                  {memberOrgs.length > 0 && (
                    <div>
                      {totalOrgs > memberOrgs.length && (
                        <div
                          style={{
                            padding: "6px 12px 2px",
                            fontSize: 10,
                            fontFamily: monoFontStack,
                            textTransform: "uppercase",
                            letterSpacing: "0.12em",
                            color: "#999",
                          }}
                        >
                          Your orgs
                        </div>
                      )}
                      {memberOrgs.map((o) => (
                        <OrgSwitcherItem
                          key={o.slug}
                          org={o}
                          isCurrent={o.slug === org.slug}
                          onSelect={() => setSwitcherOpen(false)}
                        />
                      ))}
                    </div>
                  )}

                  {/* Override orgs (platform-admin access) */}
                  {overrideOrgs.length > 0 && (
                    <div>
                      <div
                        style={{
                          padding: "6px 12px 2px",
                          fontSize: 10,
                          fontFamily: monoFontStack,
                          textTransform: "uppercase",
                          letterSpacing: "0.12em",
                          color: "#999",
                          borderTop: memberOrgs.length > 0 ? "1px solid #f0f0f0" : undefined,
                        }}
                      >
                        Platform-admin access
                      </div>
                      {overrideOrgs.map((o) => (
                        <OrgSwitcherItem
                          key={o.slug}
                          org={o}
                          isCurrent={o.slug === org.slug}
                          isOverride
                          onSelect={() => setSwitcherOpen(false)}
                        />
                      ))}
                    </div>
                  )}

                  {/* Divider + create org */}
                  <div
                    style={{
                      borderTop: "1px solid #f0f0f0",
                    }}
                  >
                    <Link
                      to="/admin/new-org"
                      onClick={() => setSwitcherOpen(false)}
                      style={{
                        display: "block",
                        padding: "9px 12px",
                        fontSize: 13,
                        color: "#2563eb",
                        textDecoration: "none",
                        fontWeight: 500,
                      }}
                    >
                      + Create organization
                    </Link>
                  </div>
                </div>
              </>
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

function OrgSwitcherItem({
  org,
  isCurrent,
  isOverride,
  onSelect,
}: {
  org: OrgSummary;
  isCurrent: boolean;
  isOverride?: boolean;
  onSelect: () => void;
}) {
  return (
    <Link
      to={`/admin/${org.slug}`}
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 12px",
        fontSize: 13,
        color: isCurrent ? ink : "#333",
        textDecoration: "none",
        fontWeight: isCurrent ? 600 : 400,
        background: isCurrent ? "#f5f5f2" : "transparent",
      }}
    >
      <span style={{ width: 14, flexShrink: 0, color: courtGreen }}>
        {isCurrent ? "✓" : ""}
      </span>
      <span style={{ flex: 1 }}>{org.name}</span>
      {isOverride && (
        <span
          style={{
            fontSize: 10,
            color: "#7a5d00",
            background: "#fef3c7",
            padding: "1px 6px",
            borderRadius: 3,
            fontWeight: 500,
          }}
        >
          admin
        </span>
      )}
    </Link>
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
