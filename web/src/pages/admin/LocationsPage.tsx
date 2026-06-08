import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import type { Database } from "../../types/supabase";

type Location = Database["public"]["Tables"]["locations"]["Row"];

export default function LocationsPage() {
  const { org } = useCurrentOrg();
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Inline add form state
  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState("");
  const [addAddress, setAddAddress] = useState("");
  const [addIsDefault, setAddIsDefault] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Inline edit state — only one row editable at a time
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editAddress, setEditAddress] = useState("");
  const [editIsDefault, setEditIsDefault] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    if (!org) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const { data, error: err } = await supabase
        .from("locations")
        .select("*")
        .eq("organization_id", org.id)
        .is("deleted_at", null)
        .order("name", { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
      } else {
        setLocations(data ?? []);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [org]);

  if (!org) return null;
  if (loading) return <div style={{ color: "#888", fontSize: 14 }}>Loading…</div>;

  const startEdit = (loc: Location) => {
    setEditId(loc.id);
    setEditName(loc.name);
    setEditAddress(loc.address ?? "");
    setEditIsDefault(loc.is_default);
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditId(null);
    setEditError(null);
  };

  const saveEdit = async () => {
    if (!editId || !editName.trim()) return;
    setEditError(null);
    setEditBusy(true);
    const { data, error: err } = await supabase
      .from("locations")
      .update({
        name: editName.trim(),
        address: editAddress.trim() || null,
        is_default: editIsDefault,
        updated_at: new Date().toISOString(),
      })
      .eq("id", editId)
      .select()
      .single();
    setEditBusy(false);
    if (err || !data) {
      setEditError(err?.message ?? "Failed to save.");
      return;
    }
    setLocations((prev) =>
      prev.map((l) => (l.id === editId ? data : l)).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );
    setEditId(null);
  };

  const softDelete = async (id: string) => {
    const { error: err } = await supabase
      .from("locations")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (err) {
      setError(err.message);
      return;
    }
    setLocations((prev) => prev.filter((l) => l.id !== id));
  };

  const setDefault = async (id: string) => {
    // Unset all other defaults for this org, then set this one.
    // Two-step: first clear all, then set — avoids unique index conflicts.
    const { error: clearErr } = await supabase
      .from("locations")
      .update({ is_default: false })
      .eq("organization_id", org.id)
      .is("deleted_at", null);
    if (clearErr) {
      setError(clearErr.message);
      return;
    }
    const { data, error: setErr } = await supabase
      .from("locations")
      .update({ is_default: true })
      .eq("id", id)
      .select()
      .single();
    if (setErr || !data) {
      setError(setErr?.message ?? "Failed to set default.");
      return;
    }
    setLocations((prev) =>
      prev.map((l) => ({ ...l, is_default: l.id === id })),
    );
  };

  const addLocation = async () => {
    if (!addName.trim()) return;
    setAddError(null);
    setAddBusy(true);
    const { data, error: err } = await supabase
      .from("locations")
      .insert({
        organization_id: org.id,
        name: addName.trim(),
        address: addAddress.trim() || null,
        is_default: addIsDefault,
      })
      .select()
      .single();
    setAddBusy(false);
    if (err || !data) {
      setAddError(err?.message ?? "Failed to add location.");
      return;
    }
    setLocations((prev) =>
      [...prev, data].sort((a, b) => a.name.localeCompare(b.name)),
    );
    setAddName("");
    setAddAddress("");
    setAddIsDefault(false);
    setShowAdd(false);
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <header style={{ marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Saved venues</h1>
          <p style={{ margin: "4px 0 0", color: "#666", fontSize: 14 }}>
            Reusable venues for your tournaments. Pick one in the creation wizard instead of retyping the address each time.
          </p>
        </div>
        {!showAdd && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            style={primaryBtn}
          >
            + Add venue
          </button>
        )}
      </header>

      {error && (
        <div style={errorBoxStyle}>{error}</div>
      )}

      {showAdd && (
        <div style={{ ...cardStyle, marginBottom: 16 }}>
          <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 8 }}>New venue</div>
          <FieldRow>
            <Field label="Venue name" required>
              <input
                type="text"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="e.g. Riverside Pickleball Club"
                style={inputStyle}
                autoFocus
              />
            </Field>
            <Field label="Address">
              <input
                type="text"
                value={addAddress}
                onChange={(e) => setAddAddress(e.target.value)}
                placeholder="e.g. 123 Main St, City, State"
                style={inputStyle}
              />
            </Field>
          </FieldRow>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: "#555", cursor: "pointer", marginTop: 4 }}>
            <input
              type="checkbox"
              checked={addIsDefault}
              onChange={(e) => setAddIsDefault(e.target.checked)}
            />
            Set as default for new tournaments
          </label>
          {addError && <div style={{ color: "#991b1b", fontSize: 12, marginTop: 4 }}>{addError}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              disabled={!addName.trim() || addBusy}
              onClick={() => void addLocation()}
              style={primaryBtnFn(!addName.trim() || addBusy)}
            >
              {addBusy ? "Saving…" : "Save venue"}
            </button>
            <button
              type="button"
              onClick={() => { setShowAdd(false); setAddName(""); setAddAddress(""); setAddIsDefault(false); setAddError(null); }}
              style={ghostBtn}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {locations.length === 0 && !showAdd && (
        <div style={{ color: "#888", fontSize: 14, padding: 24, textAlign: "center", border: "1px dashed #e2e2e2", borderRadius: 8 }}>
          No saved venues yet. Add one to reuse it across tournaments.
        </div>
      )}

      {locations.map((loc) =>
        editId === loc.id ? (
          <div key={loc.id} style={{ ...cardStyle, marginBottom: 8 }}>
            <FieldRow>
              <Field label="Venue name" required>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  style={inputStyle}
                  autoFocus
                />
              </Field>
              <Field label="Address">
                <input
                  type="text"
                  value={editAddress}
                  onChange={(e) => setEditAddress(e.target.value)}
                  style={inputStyle}
                />
              </Field>
            </FieldRow>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: "#555", cursor: "pointer", marginTop: 4 }}>
              <input
                type="checkbox"
                checked={editIsDefault}
                onChange={(e) => setEditIsDefault(e.target.checked)}
              />
              Default for new tournaments
            </label>
            {editError && <div style={{ color: "#991b1b", fontSize: 12, marginTop: 4 }}>{editError}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                type="button"
                disabled={!editName.trim() || editBusy}
                onClick={() => void saveEdit()}
                style={primaryBtnFn(!editName.trim() || editBusy)}
              >
                {editBusy ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={cancelEdit} style={ghostBtn}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div key={loc.id} style={{ ...rowStyle, marginBottom: 4 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 500, fontSize: 14 }}>{loc.name}</span>
              {loc.is_default && (
                <span style={defaultBadge}>default</span>
              )}
              {loc.address && (
                <div style={{ fontSize: 13, color: "#666", marginTop: 2 }}>{loc.address}</div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              {!loc.is_default && (
                <button
                  type="button"
                  onClick={() => void setDefault(loc.id)}
                  style={ghostBtn}
                >
                  Set default
                </button>
              )}
              <button
                type="button"
                onClick={() => startEdit(loc)}
                style={ghostBtn}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => void softDelete(loc.id)}
                style={dangerGhostBtn}
              >
                Delete
              </button>
            </div>
          </div>
        ),
      )}
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "#555" }}>
      <span>
        {label}
        {required && <span style={{ color: "#ef4444", marginLeft: 4 }}>*</span>}
      </span>
      {children}
    </label>
  );
}

function FieldRow({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      {children}
    </div>
  );
}

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  width: "100%",
};

const cardStyle: CSSProperties = {
  padding: 16,
  background: "#f8f9fa",
  border: "1px solid #e2e2e2",
  borderRadius: 8,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 14px",
  background: "#fff",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
};

const primaryBtn: CSSProperties = {
  padding: "8px 16px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
};

function primaryBtnFn(disabled: boolean): CSSProperties {
  return {
    ...primaryBtn,
    background: disabled ? "#9ca3af" : "#2563eb",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

const ghostBtn: CSSProperties = {
  padding: "6px 12px",
  background: "#fff",
  color: "#555",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "inherit",
};

const dangerGhostBtn: CSSProperties = {
  ...ghostBtn,
  color: "#dc2626",
  borderColor: "#fecaca",
};

const defaultBadge: CSSProperties = {
  marginLeft: 8,
  padding: "2px 8px",
  background: "#eff6ff",
  color: "#2563eb",
  borderRadius: 99,
  fontSize: 11,
  fontWeight: 500,
};

const errorBoxStyle: CSSProperties = {
  marginBottom: 12,
  padding: 12,
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 6,
  color: "#991b1b",
  fontSize: 13,
};
