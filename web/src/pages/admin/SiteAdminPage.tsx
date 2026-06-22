import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Users, Building2, Settings2, FileText, ChevronRight } from "lucide-react";
import { supabase } from "../../supabase";
import { usePlatformAdmin } from "../../hooks/usePlatformAdmin";
import {
  ink,
  inkSoft,
  inkMuted,
  rule,
  courtBlue,
  bodyFontStack,
  displayFontStack,
  breadcrumbLinkStyle,
  pageH1Style,
} from "../../lib/publicTheme";

// Platform-admin home. Gathers every SITE-level tool (across all orgs) in
// one place, so the org picker (/admin) stays purely about organizations.
// Each card links to that tool's existing page.
export default function SiteAdminPage() {
  const isPlatformAdmin = usePlatformAdmin();
  const [playerCount, setPlayerCount] = useState<number | null>(null);
  const [orgCount, setOrgCount] = useState<number | null>(null);

  useEffect(() => {
    if (!isPlatformAdmin) return;
    let cancelled = false;
    (async () => {
      const [{ count: players }, { count: orgs }] = await Promise.all([
        supabase
          .from("players")
          .select("*", { count: "exact", head: true })
          .is("deleted_at", null),
        supabase
          .from("organizations")
          .select("*", { count: "exact", head: true })
          .is("deleted_at", null),
      ]);
      if (cancelled) return;
      setPlayerCount(players ?? null);
      setOrgCount(orgs ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [isPlatformAdmin]);

  if (isPlatformAdmin === null) {
    return (
      <div style={{ padding: 24, color: inkMuted, fontSize: 14, fontFamily: bodyFontStack }}>
        Loading…
      </div>
    );
  }
  if (!isPlatformAdmin) {
    return (
      <main style={{ padding: "24px 32px", maxWidth: 600, margin: "0 auto", fontFamily: bodyFontStack }}>
        <h1 style={{ ...pageH1Style, fontSize: 20, marginTop: 0 }}>Access denied</h1>
        <p style={{ color: inkSoft, fontSize: 14 }}>
          This area is restricted to platform administrators.
        </p>
        <Link to="/admin" style={breadcrumbLinkStyle}>
          ← Back to admin
        </Link>
      </main>
    );
  }

  const fmtCount = (n: number | null) =>
    n == null ? "…" : n.toLocaleString();

  return (
    <main style={{ padding: "24px 32px", maxWidth: 860, margin: "0 auto", fontFamily: bodyFontStack }}>
      <div style={{ marginBottom: 16 }}>
        <Link to="/admin" style={breadcrumbLinkStyle}>
          ← Organizations
        </Link>
      </div>

      <h1 style={{ fontFamily: displayFontStack, fontSize: 28, margin: "0 0 4px", color: ink }}>
        Site Admin
      </h1>
      <p style={{ fontSize: 13, color: inkSoft, margin: "0 0 28px" }}>
        Platform-level tools across every organization.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
          gap: 14,
        }}
      >
        <Card
          to="/admin/attendees"
          icon={<Users size={20} />}
          title="All players"
          meta={`${fmtCount(playerCount)} player${playerCount === 1 ? "" : "s"}`}
          body="Search every player; manage profiles, ratings, login email, password, and profile image."
        />
        <Card
          to="/admin/new-org"
          icon={<Building2 size={20} />}
          title="Organizations"
          meta={`${fmtCount(orgCount)} organization${orgCount === 1 ? "" : "s"}`}
          body="Create a new organization. Browse and switch into existing ones from the Organizations picker."
        />
        <Card
          to="/admin/platform"
          icon={<Settings2 size={20} />}
          title="Platform settings"
          body="Stripe platform fee (percentage + fixed) applied to every checkout."
        />
        <Card
          to="/admin/quotes"
          icon={<FileText size={20} />}
          title="Quotes"
          body="Quote Studio — build and manage sponsorship / service quotes and contracts."
        />
      </div>
    </main>
  );
}

function Card({
  to,
  icon,
  title,
  meta,
  body,
}: {
  to: string;
  icon: ReactNode;
  title: string;
  meta?: string;
  body: string;
}) {
  return (
    <Link to={to} style={cardStyle} className="site-admin-card">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{ color: courtBlue, display: "flex" }}>{icon}</span>
        <span style={{ fontSize: 15, fontWeight: 700, color: ink, flex: 1 }}>{title}</span>
        <ChevronRight size={16} color={inkMuted} />
      </div>
      {meta && (
        <div style={{ fontSize: 12, color: courtBlue, fontWeight: 600, marginBottom: 6 }}>
          {meta}
        </div>
      )}
      <div style={{ fontSize: 12.5, color: inkSoft, lineHeight: 1.5 }}>{body}</div>
    </Link>
  );
}

const cardStyle: CSSProperties = {
  display: "block",
  padding: 16,
  background: "#fff",
  border: `1px solid ${rule}`,
  borderRadius: 10,
  textDecoration: "none",
  color: ink,
};
