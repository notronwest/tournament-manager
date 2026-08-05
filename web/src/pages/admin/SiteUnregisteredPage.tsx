import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { usePlatformAdmin } from "../../hooks/usePlatformAdmin";
import { fetchUnregisteredUsers, type UnregisteredUser } from "../../lib/unregisteredUsers";
import {
  ink,
  inkSoft,
  inkMuted,
  cream,
  rule,
  ruleSoft,
  courtBlue,
  bodyFontStack,
  displayFontStack,
  headingFontStack,
  breadcrumbLinkStyle,
  pageH1Style,
  statusPanelStyle,
} from "../../lib/publicTheme";

// Platform-admin, site-level list: people who created a login account and have
// signed in, but never registered — so you can reach out to them.
export default function SiteUnregisteredPage() {
  const isPlatformAdmin = usePlatformAdmin();
  const [users, setUsers] = useState<UnregisteredUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!isPlatformAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchUnregisteredUsers();
        if (!cancelled) setUsers(data);
      } catch (e) {
        if (!cancelled) {
          setError((e as { message?: string })?.message ?? "Could not load the list.");
          setUsers([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPlatformAdmin]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users ?? [];
    return (users ?? []).filter((u) =>
      `${u.firstName} ${u.lastName} ${u.email ?? ""}`.toLowerCase().includes(q),
    );
  }, [users, search]);

  if (isPlatformAdmin === null) {
    return <div style={{ padding: 24, color: inkMuted, fontSize: 14, fontFamily: bodyFontStack }}>Loading…</div>;
  }
  if (!isPlatformAdmin) {
    return (
      <main style={{ padding: "24px 32px", maxWidth: 600, margin: "0 auto", fontFamily: bodyFontStack }}>
        <h1 style={{ ...pageH1Style, fontSize: 20, marginTop: 0 }}>Access denied</h1>
        <p style={{ color: inkSoft, fontSize: 14 }}>This area is restricted to platform administrators.</p>
        <Link to="/admin/site" style={breadcrumbLinkStyle}>← Site Admin</Link>
      </main>
    );
  }

  return (
    <main style={{ padding: "24px 32px", maxWidth: 900, margin: "0 auto", fontFamily: bodyFontStack, color: ink }}>
      <div style={{ marginBottom: 16 }}>
        <Link to="/admin/site" style={breadcrumbLinkStyle}>← Site Admin</Link>
      </div>

      <h1 style={{ fontFamily: displayFontStack, fontSize: 28, margin: "0 0 4px", color: ink }}>
        Signed up, not registered
      </h1>
      <p style={{ fontSize: 13, color: inkSoft, margin: "0 0 20px", maxWidth: 640, lineHeight: 1.55 }}>
        People who created an account and have logged in at least once, but haven't
        registered for anything yet. Good candidates to reach out to.
      </p>

      {error && (
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 16 }} role="alert">{error}</div>
      )}

      {users === null ? (
        <div style={{ color: inkMuted }}>Loading…</div>
      ) : users.length === 0 ? (
        <div style={{ border: `1px dashed ${rule}`, borderRadius: 10, padding: 28, textAlign: "center", color: inkMuted, background: cream }}>
          No one to show — everyone who's logged in has registered for something.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
            <div style={{ fontSize: 13, color: inkMuted }}>
              {visible.length} of {users.length} {users.length === 1 ? "person" : "people"}
            </div>
            <input
              type="search"
              placeholder="Search name or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ padding: "6px 12px", border: `1px solid ${rule}`, borderRadius: 6, fontSize: 13, fontFamily: bodyFontStack, minWidth: 220 }}
            />
          </div>

          <div style={{ overflowX: "auto", border: `1px solid ${rule}`, borderRadius: 10 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 640 }}>
              <thead>
                <tr style={{ background: cream }}>
                  <th style={th}>Name</th>
                  <th style={th}>Email</th>
                  <th style={th}>Signed up</th>
                  <th style={th}>Last login</th>
                  <th style={{ ...th, textAlign: "right" }}></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((u) => (
                  <tr key={u.playerId} style={{ borderTop: `1px solid ${ruleSoft}` }}>
                    <td style={td}>
                      <Link to={`/admin/players/${u.playerId}`} style={{ color: courtBlue, textDecoration: "none", fontWeight: 500 }}>
                        {u.firstName} {u.lastName}
                      </Link>
                    </td>
                    <td style={{ ...td, color: u.email ? ink : inkMuted }}>
                      {u.email ? (
                        <a href={`mailto:${u.email}`} style={{ color: courtBlue, textDecoration: "none" }}>{u.email}</a>
                      ) : "—"}
                    </td>
                    <td style={{ ...td, color: inkMuted }}>{fmtDate(u.createdAt)}</td>
                    <td style={{ ...td, color: inkMuted }}>{fmtDate(u.lastSignInAt)}</td>
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                      {u.email && (
                        <a
                          href={`mailto:${u.email}`}
                          style={{ fontSize: 13, color: courtBlue, textDecoration: "none", fontWeight: 600 }}
                        >
                          Email
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td style={{ ...td, color: inkMuted }} colSpan={5}>No one matches your search.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const th: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 11,
  color: inkMuted,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  fontWeight: 600,
  fontFamily: headingFontStack,
  whiteSpace: "nowrap",
};

const td: CSSProperties = { padding: "10px 12px", verticalAlign: "middle" };
