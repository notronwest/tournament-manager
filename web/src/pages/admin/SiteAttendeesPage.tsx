import { Fragment, useState, useEffect, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../supabase";
import { usePlatformAdmin } from "../../hooks/usePlatformAdmin";

type Player = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  auth_user_id: string | null;
};

const PAGE_SIZE = 50;

export default function SiteAttendeesPage() {
  const isPlatformAdmin = usePlatformAdmin();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [players, setPlayers] = useState<Player[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!isPlatformAdmin) return;
    let cancelled = false;
    (async () => {
      if (!cancelled) setLoading(true);
      if (!cancelled) setLoadError(null);
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      let query = supabase
        .from("players")
        .select("id, first_name, last_name, email, auth_user_id", {
          count: "exact",
        })
        .is("deleted_at", null)
        .range(from, to)
        .order("last_name", { ascending: true })
        .order("first_name", { ascending: true });

      const q = debouncedSearch.trim();
      if (q) {
        const pct = `%${q}%`;
        query = query.or(
          `first_name.ilike.${pct},last_name.ilike.${pct},email.ilike.${pct}`,
        );
      }

      const { data, error, count } = await query;
      if (cancelled) return;
      setLoading(false);
      if (error) {
        setLoadError(error.message);
        return;
      }
      setPlayers((data as Player[]) ?? []);
      setTotal(count ?? 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [isPlatformAdmin, debouncedSearch, page]);

  if (isPlatformAdmin === null) {
    return <div style={{ padding: 24, color: "#666", fontSize: 14 }}>Loading…</div>;
  }

  if (!isPlatformAdmin) {
    return (
      <main style={{ padding: 24, maxWidth: 600, margin: "0 auto" }}>
        <h1 style={{ fontSize: 20, marginTop: 0 }}>Access denied</h1>
        <p style={{ color: "#666", fontSize: 14 }}>
          This page is restricted to platform administrators.
        </p>
        <Link to="/admin" style={linkStyle}>
          ← Back to admin
        </Link>
      </main>
    );
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <main style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <div style={{ marginBottom: 16 }}>
        <Link to="/admin" style={linkStyle}>
          ← Back to admin
        </Link>
      </div>
      <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>All players</h1>
      <p style={{ fontSize: 13, color: "#666", margin: "0 0 20px" }}>
        Site-wide — every player across all organizations.
      </p>

      <div
        style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}
      >
        <input
          type="search"
          placeholder="Search by name or email…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
            setEditingId(null);
          }}
          style={{ ...inputStyle, width: 300 }}
        />
        {!loading && total > 0 && (
          <span style={{ fontSize: 13, color: "#888" }}>
            {total.toLocaleString()} player{total !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {loadError && <div style={errorPanelStyle}>{loadError}</div>}

      {!loadError && (
        <div
          style={{ border: "1px solid #e2e2e2", borderRadius: 8, overflow: "hidden" }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f9fafb", borderBottom: "1px solid #e2e2e2" }}>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Contact email</th>
                <th style={thStyle}>Account</th>
                <th style={{ ...thStyle, width: 64 }} />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={4}
                    style={{ padding: "20px 16px", color: "#888", textAlign: "center" }}
                  >
                    Loading…
                  </td>
                </tr>
              ) : players.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    style={{ padding: "20px 16px", color: "#888", textAlign: "center" }}
                  >
                    {debouncedSearch ? "No players match that search." : "No players yet."}
                  </td>
                </tr>
              ) : (
                players.map((p) => (
                  <Fragment key={p.id}>
                    <tr
                      style={{
                        borderBottom:
                          editingId === p.id ? "none" : "1px solid #f0f0f0",
                      }}
                    >
                      <td style={tdStyle}>
                        {p.first_name} {p.last_name}
                      </td>
                      <td style={tdStyle}>
                        {p.email ?? (
                          <span style={{ color: "#aaa" }}>—</span>
                        )}
                      </td>
                      <td style={tdStyle}>
                        {p.auth_user_id ? (
                          <span style={linkedBadgeStyle}>linked</span>
                        ) : (
                          <span style={noAccountBadgeStyle}>no account</span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        <button
                          onClick={() =>
                            setEditingId(editingId === p.id ? null : p.id)
                          }
                          style={editBtnStyle}
                        >
                          {editingId === p.id ? "Cancel" : "Edit"}
                        </button>
                      </td>
                    </tr>
                    {editingId === p.id && (
                      <tr style={{ borderBottom: "1px solid #e2e2e2" }}>
                        <td colSpan={4} style={{ padding: 0 }}>
                          <EditEmailPanel
                            player={p}
                            onSaved={(updates) => {
                              setPlayers((prev) =>
                                prev.map((r) =>
                                  r.id === p.id ? { ...r, ...updates } : r,
                                ),
                              );
                              setEditingId(null);
                            }}
                            onCancel={() => setEditingId(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginTop: 14,
            fontSize: 13,
          }}
        >
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            style={paginationBtnStyle(page === 0)}
          >
            ← Previous
          </button>
          <span style={{ color: "#666" }}>
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            style={paginationBtnStyle(page >= totalPages - 1)}
          >
            Next →
          </button>
        </div>
      )}
    </main>
  );
}

function EditEmailPanel({
  player,
  onSaved,
  onCancel,
}: {
  player: Player;
  onSaved: (updates: Partial<Player>) => void;
  onCancel: () => void;
}) {
  const [contactEmail, setContactEmail] = useState(player.email ?? "");
  const [loginEmail, setLoginEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const contactChanged = contactEmail.trim() !== (player.email ?? "");
  const loginChanged = !!player.auth_user_id && loginEmail.trim() !== "";
  const hasChange = contactChanged || loginChanged;

  const onSave = async () => {
    if (!hasChange) {
      onCancel();
      return;
    }
    setSaving(true);
    setError(null);

    const body: { playerId: string; contactEmail?: string; loginEmail?: string } =
      { playerId: player.id };
    if (contactChanged) body.contactEmail = contactEmail.trim();
    if (loginChanged) body.loginEmail = loginEmail.trim();

    const { data, error: fnErr } = await supabase.functions.invoke(
      "admin-update-player-email",
      { body },
    );

    setSaving(false);

    if (fnErr) {
      let message = fnErr.message;
      try {
        const ctx = (fnErr as unknown as { context?: Response }).context;
        if (ctx) {
          const b = (await ctx.json()) as { error?: string };
          if (b.error) message = b.error;
        }
      } catch {
        // fall through
      }
      setError(message);
      return;
    }
    if (data && !(data as { ok?: boolean }).ok) {
      setError((data as { error?: string }).error ?? "Failed.");
      return;
    }

    onSaved({
      email: contactChanged ? contactEmail.trim() || null : player.email,
    });
  };

  return (
    <div
      style={{
        padding: "12px 16px",
        background: "#fafafa",
        borderTop: "1px solid #e2e2e2",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          alignItems: "flex-end",
        }}
      >
        <label
          style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#555" }}
        >
          Contact email
          <input
            type="email"
            value={contactEmail}
            onChange={(e) => {
              setContactEmail(e.target.value);
              setError(null);
            }}
            style={{ ...inputStyle, width: 240 }}
          />
        </label>

        {player.auth_user_id && (
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              fontSize: 12,
              color: "#555",
            }}
          >
            Login email (auth)
            <input
              type="email"
              value={loginEmail}
              placeholder="Leave blank to keep unchanged"
              onChange={(e) => {
                setLoginEmail(e.target.value);
                setError(null);
              }}
              style={{ ...inputStyle, width: 240 }}
            />
          </label>
        )}

        <div style={{ display: "flex", gap: 8, paddingBottom: 1 }}>
          <button
            onClick={onSave}
            disabled={saving}
            style={{
              ...btnPrimaryStyle,
              opacity: saving ? 0.6 : 1,
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button onClick={onCancel} disabled={saving} style={btnSecondaryStyle}>
            Cancel
          </button>
        </div>
      </div>

      {error && <div style={{ ...errorPanelStyle, marginTop: 10 }}>{error}</div>}
    </div>
  );
}

// ─── styles ───────────────────────────────────────────────────────────────────

const linkStyle: CSSProperties = {
  fontSize: 13,
  color: "#2563eb",
  textDecoration: "none",
};

const inputStyle: CSSProperties = {
  padding: "7px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 5,
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
  boxSizing: "border-box",
};

const thStyle: CSSProperties = {
  padding: "10px 14px",
  textAlign: "left",
  fontSize: 12,
  fontWeight: 600,
  color: "#555",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "10px 14px",
  verticalAlign: "middle",
};

const badgeBase: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 500,
};

const linkedBadgeStyle: CSSProperties = {
  ...badgeBase,
  background: "#f0fdf4",
  color: "#166534",
  border: "1px solid #bbf7d0",
};

const noAccountBadgeStyle: CSSProperties = {
  ...badgeBase,
  background: "#f9fafb",
  color: "#888",
  border: "1px solid #e2e2e2",
};

const editBtnStyle: CSSProperties = {
  padding: "4px 10px",
  background: "#fff",
  border: "1px solid #e2e2e2",
  borderRadius: 5,
  fontSize: 12,
  color: "#555",
  cursor: "pointer",
  fontFamily: "inherit",
};

const btnPrimaryStyle: CSSProperties = {
  padding: "7px 16px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 5,
  fontSize: 13,
  fontWeight: 500,
  fontFamily: "inherit",
};

const btnSecondaryStyle: CSSProperties = {
  padding: "7px 14px",
  background: "#fff",
  color: "#555",
  border: "1px solid #e2e2e2",
  borderRadius: 5,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "inherit",
};

const errorPanelStyle: CSSProperties = {
  padding: "8px 12px",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 5,
  fontSize: 13,
  color: "#dc2626",
};

function paginationBtnStyle(disabled: boolean): CSSProperties {
  return {
    padding: "6px 12px",
    background: "#fff",
    border: "1px solid #e2e2e2",
    borderRadius: 5,
    fontSize: 12,
    color: disabled ? "#bbb" : "#555",
    cursor: disabled ? "default" : "pointer",
    fontFamily: "inherit",
  };
}
