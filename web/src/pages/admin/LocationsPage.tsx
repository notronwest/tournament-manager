import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import type { Database } from "../../types/supabase";

type Location = Database["public"]["Tables"]["locations"]["Row"];
type NetType = Database["public"]["Enums"]["net_type"];
type SurfaceType = Database["public"]["Enums"]["surface_type"];

const NET_TYPE_LABELS: Record<NetType, string> = {
  permanent: "Permanent",
  moveable: "Moveable",
};

const SURFACE_TYPE_LABELS: Record<SurfaceType, string> = {
  concrete: "Concrete",
  asphalt: "Asphalt",
  cushion_core: "Cushion Core",
  hardwood: "Hardwood",
  polycarbonate: "Polycarbonate",
  polyurethane: "Polyurethane",
  other: "Other",
};

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
  const [addCourtCount, setAddCourtCount] = useState("");
  const [addNetType, setAddNetType] = useState<NetType | "">("");
  const [addSurfaceType, setAddSurfaceType] = useState<SurfaceType | "">("");
  const [addSurfaceNotes, setAddSurfaceNotes] = useState("");
  const [addCeilingMin, setAddCeilingMin] = useState("");
  const [addCeilingMax, setAddCeilingMax] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Inline edit state — only one row editable at a time
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editAddress, setEditAddress] = useState("");
  const [editIsDefault, setEditIsDefault] = useState(false);
  const [editCourtCount, setEditCourtCount] = useState("");
  const [editNetType, setEditNetType] = useState<NetType | "">("");
  const [editSurfaceType, setEditSurfaceType] = useState<SurfaceType | "">("");
  const [editSurfaceNotes, setEditSurfaceNotes] = useState("");
  const [editCeilingMin, setEditCeilingMin] = useState("");
  const [editCeilingMax, setEditCeilingMax] = useState("");
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
    setEditCourtCount(loc.court_count != null ? String(loc.court_count) : "");
    setEditNetType(loc.net_type ?? "");
    setEditSurfaceType(loc.surface_type ?? "");
    setEditSurfaceNotes(loc.surface_notes ?? "");
    setEditCeilingMin(loc.ceiling_height_min_ft != null ? String(loc.ceiling_height_min_ft) : "");
    setEditCeilingMax(loc.ceiling_height_max_ft != null ? String(loc.ceiling_height_max_ft) : "");
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditId(null);
    setEditError(null);
  };

  const saveEdit = async () => {
    if (!editId || !editName.trim()) return;
    setEditError(null);
    const cMin = editCeilingMin !== "" ? parseFloat(editCeilingMin) : null;
    const cMax = editCeilingMax !== "" ? parseFloat(editCeilingMax) : null;
    if (cMin != null && cMax != null && cMin > cMax) {
      setEditError("Ceiling height min must be ≤ max.");
      return;
    }
    setEditBusy(true);
    const { data, error: err } = await supabase
      .from("locations")
      .update({
        name: editName.trim(),
        address: editAddress.trim() || null,
        is_default: editIsDefault,
        court_count: editCourtCount !== "" ? parseInt(editCourtCount, 10) : null,
        net_type: editNetType || null,
        surface_type: editSurfaceType || null,
        surface_notes: editSurfaceType === "other" ? editSurfaceNotes.trim() || null : null,
        ceiling_height_min_ft: cMin,
        ceiling_height_max_ft: cMax,
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
    const cMin = addCeilingMin !== "" ? parseFloat(addCeilingMin) : null;
    const cMax = addCeilingMax !== "" ? parseFloat(addCeilingMax) : null;
    if (cMin != null && cMax != null && cMin > cMax) {
      setAddError("Ceiling height min must be ≤ max.");
      return;
    }
    setAddBusy(true);
    const { data, error: err } = await supabase
      .from("locations")
      .insert({
        organization_id: org.id,
        name: addName.trim(),
        address: addAddress.trim() || null,
        is_default: addIsDefault,
        court_count: addCourtCount !== "" ? parseInt(addCourtCount, 10) : null,
        net_type: addNetType || null,
        surface_type: addSurfaceType || null,
        surface_notes: addSurfaceType === "other" ? addSurfaceNotes.trim() || null : null,
        ceiling_height_min_ft: cMin,
        ceiling_height_max_ft: cMax,
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
    setAddCourtCount("");
    setAddNetType("");
    setAddSurfaceType("");
    setAddSurfaceNotes("");
    setAddCeilingMin("");
    setAddCeilingMax("");
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
          <VenueDetailFields
            courtCount={addCourtCount} onCourtCount={setAddCourtCount}
            netType={addNetType} onNetType={setAddNetType}
            surfaceType={addSurfaceType} onSurfaceType={setAddSurfaceType}
            surfaceNotes={addSurfaceNotes} onSurfaceNotes={setAddSurfaceNotes}
            ceilingMin={addCeilingMin} onCeilingMin={setAddCeilingMin}
            ceilingMax={addCeilingMax} onCeilingMax={setAddCeilingMax}
          />
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
              onClick={() => { setShowAdd(false); setAddName(""); setAddAddress(""); setAddIsDefault(false); setAddCourtCount(""); setAddNetType(""); setAddSurfaceType(""); setAddSurfaceNotes(""); setAddCeilingMin(""); setAddCeilingMax(""); setAddError(null); }}
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
            <VenueDetailFields
              courtCount={editCourtCount} onCourtCount={setEditCourtCount}
              netType={editNetType} onNetType={setEditNetType}
              surfaceType={editSurfaceType} onSurfaceType={setEditSurfaceType}
              surfaceNotes={editSurfaceNotes} onSurfaceNotes={setEditSurfaceNotes}
              ceilingMin={editCeilingMin} onCeilingMin={setEditCeilingMin}
              ceilingMax={editCeilingMax} onCeilingMax={setEditCeilingMax}
            />
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
              <VenueDetailSummary loc={loc} />
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

type VenueDetailFieldsProps = {
  courtCount: string; onCourtCount: (v: string) => void;
  netType: NetType | ""; onNetType: (v: NetType | "") => void;
  surfaceType: SurfaceType | ""; onSurfaceType: (v: SurfaceType | "") => void;
  surfaceNotes: string; onSurfaceNotes: (v: string) => void;
  ceilingMin: string; onCeilingMin: (v: string) => void;
  ceilingMax: string; onCeilingMax: (v: string) => void;
};

function VenueDetailFields({
  courtCount, onCourtCount,
  netType, onNetType,
  surfaceType, onSurfaceType,
  surfaceNotes, onSurfaceNotes,
  ceilingMin, onCeilingMin,
  ceilingMax, onCeilingMax,
}: VenueDetailFieldsProps) {
  return (
    <div style={{ marginTop: 12, borderTop: "1px solid #e2e2e2", paddingTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 500, color: "#888", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
        Court details (optional)
      </div>
      <FieldRow>
        <Field label="Number of courts">
          <input
            type="number"
            min={1}
            max={200}
            value={courtCount}
            onChange={(e) => onCourtCount(e.target.value)}
            placeholder="e.g. 8"
            style={inputStyle}
          />
        </Field>
        <Field label="Net type">
          <select
            value={netType}
            onChange={(e) => onNetType(e.target.value as NetType | "")}
            style={inputStyle}
          >
            <option value="">— select —</option>
            {(Object.keys(NET_TYPE_LABELS) as NetType[]).map((k) => (
              <option key={k} value={k}>{NET_TYPE_LABELS[k]}</option>
            ))}
          </select>
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Surface">
          <select
            value={surfaceType}
            onChange={(e) => onSurfaceType(e.target.value as SurfaceType | "")}
            style={inputStyle}
          >
            <option value="">— select —</option>
            {(Object.keys(SURFACE_TYPE_LABELS) as SurfaceType[]).map((k) => (
              <option key={k} value={k}>{SURFACE_TYPE_LABELS[k]}</option>
            ))}
          </select>
        </Field>
        {surfaceType === "other" && (
          <Field label="Surface notes">
            <input
              type="text"
              value={surfaceNotes}
              onChange={(e) => onSurfaceNotes(e.target.value)}
              placeholder="Describe the surface"
              style={inputStyle}
            />
          </Field>
        )}
      </FieldRow>
      <FieldRow>
        <Field label="Ceiling height min (ft)">
          <input
            type="number"
            min={0}
            step="0.1"
            value={ceilingMin}
            onChange={(e) => onCeilingMin(e.target.value)}
            placeholder="e.g. 18"
            style={inputStyle}
          />
        </Field>
        <Field label="Ceiling height max (ft)">
          <input
            type="number"
            min={0}
            step="0.1"
            value={ceilingMax}
            onChange={(e) => onCeilingMax(e.target.value)}
            placeholder="e.g. 24"
            style={inputStyle}
          />
        </Field>
      </FieldRow>
    </div>
  );
}

function VenueDetailSummary({ loc }: { loc: Location }) {
  const parts: string[] = [];
  if (loc.court_count != null) parts.push(`${loc.court_count} court${loc.court_count !== 1 ? "s" : ""}`);
  if (loc.net_type) parts.push(NET_TYPE_LABELS[loc.net_type] + " nets");
  if (loc.surface_type) {
    const label = SURFACE_TYPE_LABELS[loc.surface_type];
    parts.push(loc.surface_type === "other" && loc.surface_notes ? `${label} (${loc.surface_notes})` : label);
  }
  if (loc.ceiling_height_min_ft != null || loc.ceiling_height_max_ft != null) {
    const min = loc.ceiling_height_min_ft;
    const max = loc.ceiling_height_max_ft;
    if (min != null && max != null) parts.push(`${min}–${max} ft ceiling`);
    else if (max != null) parts.push(`${max} ft ceiling`);
    else if (min != null) parts.push(`${min} ft ceiling min`);
  }
  if (parts.length === 0) return null;
  return (
    <div style={{ fontSize: 12, color: "#888", marginTop: 3 }}>{parts.join(" · ")}</div>
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
  padding: "6px 14px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontSize: 13,
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
