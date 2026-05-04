import type { ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";

// Two-column layout: org-scoped sidebar nav on the left, route content on
// the right. The class names (`admin-layout`, `admin-sidebar`,
// `admin-main`) are kept stable so index.css mobile overrides can target
// them when we add responsive rules later.
export default function AdminLayout() {
  const { user, signOut } = useAuth();
  const { org, role, loading, error } = useCurrentOrg();
  const navigate = useNavigate();

  if (loading) {
    return (
      <div style={{ padding: 24, color: "#666", fontSize: 14 }}>Loading…</div>
    );
  }

  if (error || !org) {
    return (
      <main style={{ padding: 24, maxWidth: 600, margin: "0 auto" }}>
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
      style={{ display: "flex", minHeight: "100vh" }}
    >
      <aside
        className="admin-sidebar"
        style={{
          width: 220,
          background: "#fafafa",
          borderRight: "1px solid #e2e2e2",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: 16, borderBottom: "1px solid #e2e2e2" }}>
          <div
            style={{
              fontSize: 11,
              color: "#888",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            Organization
          </div>
          <div style={{ fontWeight: 500, marginTop: 4, fontSize: 14 }}>
            {org.name}
          </div>
          {role && (
            <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
              {role}
            </div>
          )}
        </div>

        <nav style={{ flex: 1, padding: "12px 0" }}>
          <SideLink to={`/admin/${org.slug}`} end>
            Overview
          </SideLink>
          <SideLink to={`/admin/${org.slug}/tournaments`}>Tournaments</SideLink>
        </nav>

        <div
          style={{
            padding: 16,
            borderTop: "1px solid #e2e2e2",
            fontSize: 12,
            color: "#666",
          }}
        >
          <div style={{ wordBreak: "break-all" }}>{user?.email}</div>
          <button
            onClick={async () => {
              await signOut();
              navigate("/login");
            }}
            style={{
              marginTop: 8,
              padding: "4px 10px",
              fontSize: 12,
              background: "transparent",
              border: "1px solid #e2e2e2",
              borderRadius: 4,
              cursor: "pointer",
              color: "#555",
              fontFamily: "inherit",
            }}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main
        className="admin-main"
        style={{ flex: 1, padding: 32, overflowX: "auto" }}
      >
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
        padding: "8px 16px",
        textDecoration: "none",
        color: isActive ? "#2563eb" : "#555",
        borderLeft: `3px solid ${isActive ? "#2563eb" : "transparent"}`,
        fontSize: 14,
        background: isActive ? "#eff6ff" : "transparent",
      })}
    >
      {children}
    </NavLink>
  );
}
