import { useEffect, useState, type CSSProperties } from "react";
import { supabase } from "../supabase";
import type { Database } from "../types/supabase";

type Location = Database["public"]["Tables"]["locations"]["Row"];

const MANUAL_SENTINEL = "__manual__";
const CREATE_SENTINEL = "__create__";

// Location picker for the tournament wizard and edit form. Lets the
// organizer choose a saved org location (or inline-create a new one).
// When a saved location is chosen, location_id is set and the legacy
// text fields are left empty. When "manual" is chosen, location_id is
// null and the text fields are used (legacy fallback path).
export function LocationPicker({
  orgId,
  locationId,
  setLocationId,
  locationName,
  setLocationName,
  locationAddress,
  setLocationAddress,
}: {
  orgId: string;
  locationId: string | null;
  setLocationId: (id: string | null) => void;
  locationName: string;
  setLocationName: (s: string) => void;
  locationAddress: string;
  setLocationAddress: (s: string) => void;
}) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newIsDefault, setNewIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("locations")
        .select("*")
        .eq("organization_id", orgId)
        .is("deleted_at", null)
        .order("name", { ascending: true });
      if (cancelled) return;
      const rows = data ?? [];
      setLocations(rows);
      setLoading(false);
      // For a brand-new tournament (nothing set yet), pre-select the
      // org default if one exists.
      if (!locationId && !locationName && !locationAddress) {
        const def = rows.find((l) => l.is_default);
        if (def) setLocationId(def.id);
      }
    })();
    return () => {
      cancelled = true;
    };
    // intentional: only re-run when org changes, not on every parent
    // render; initial locationId/name/address are read once for setup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const selectValue = locationId
    ? locationId
    : showCreate
      ? CREATE_SENTINEL
      : MANUAL_SENTINEL;

  const handleSelect = (val: string) => {
    setShowCreate(false);
    setSaveError(null);
    if (val === CREATE_SENTINEL) {
      setShowCreate(true);
      setLocationId(null);
    } else if (val === MANUAL_SENTINEL) {
      setLocationId(null);
    } else {
      setLocationId(val);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setSaveError(null);
    setSaving(true);
    const { data, error } = await supabase
      .from("locations")
      .insert({
        organization_id: orgId,
        name: newName.trim(),
        address: newAddress.trim() || null,
        is_default: newIsDefault,
      })
      .select()
      .single();
    setSaving(false);
    if (error || !data) {
      setSaveError(error?.message ?? "Failed to save location.");
      return;
    }
    setLocations((prev) =>
      [...prev, data].sort((a, b) => a.name.localeCompare(b.name)),
    );
    setLocationId(data.id);
    setShowCreate(false);
    setNewName("");
    setNewAddress("");
    setNewIsDefault(false);
  };

  if (loading) {
    return <div style={{ color: "#888", fontSize: 13 }}>Loading venues…</div>;
  }

  const selectedLoc = locations.find((l) => l.id === locationId);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <select
        value={selectValue}
        onChange={(e) => handleSelect(e.target.value)}
        style={selectStyle}
      >
        {locations.length === 0 && (
          <option value={MANUAL_SENTINEL}>No saved venues yet</option>
        )}
        {locations.map((loc) => (
          <option key={loc.id} value={loc.id}>
            {loc.name}
            {loc.is_default ? " (default)" : ""}
            {loc.address ? ` — ${loc.address}` : ""}
          </option>
        ))}
        {locations.length > 0 && (
          <option value={MANUAL_SENTINEL}>— Enter address manually (one-time)</option>
        )}
        <option value={CREATE_SENTINEL}>+ Save & use new venue</option>
      </select>

      {selectedLoc && !showCreate && (
        <div style={{ fontSize: 13, color: "#555" }}>
          {selectedLoc.address || "(no address on file)"}
        </div>
      )}

      {!locationId && !showCreate && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={labelStyle}>
            <span>Venue name</span>
            <input
              type="text"
              value={locationName}
              onChange={(e) => setLocationName(e.target.value)}
              placeholder="e.g. Riverside Pickleball Club"
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            <span>Address</span>
            <input
              type="text"
              value={locationAddress}
              onChange={(e) => setLocationAddress(e.target.value)}
              placeholder="e.g. 123 Main St, City, State"
              style={inputStyle}
            />
          </label>
        </div>
      )}

      {showCreate && (
        <div style={createFormStyle}>
          <div style={{ fontWeight: 500, fontSize: 13, color: "#333", marginBottom: 4 }}>
            New saved venue
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={labelStyle}>
              <span>
                Venue name <span style={{ color: "#ef4444" }}>*</span>
              </span>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Riverside Pickleball Club"
                style={inputStyle}
                autoFocus
              />
            </label>
            <label style={labelStyle}>
              <span>Address</span>
              <input
                type="text"
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value)}
                placeholder="e.g. 123 Main St, City, State"
                style={inputStyle}
              />
            </label>
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: "#555", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={newIsDefault}
              onChange={(e) => setNewIsDefault(e.target.checked)}
            />
            Set as default for new tournaments
          </label>
          {saveError && (
            <div style={{ color: "#991b1b", fontSize: 12 }}>{saveError}</div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              disabled={!newName.trim() || saving}
              onClick={() => void handleCreate()}
              style={saveBtnStyle(!newName.trim() || saving)}
            >
              {saving ? "Saving…" : "Save & select"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowCreate(false);
                setNewName("");
                setNewAddress("");
                setNewIsDefault(false);
                setSaveError(null);
              }}
              style={cancelBtnStyle}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const selectStyle: CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  width: "100%",
  background: "#fff",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  width: "100%",
};

const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 13,
  color: "#555",
};

const createFormStyle: CSSProperties = {
  padding: 12,
  background: "#f8f9fa",
  borderRadius: 6,
  border: "1px solid #e2e2e2",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

function saveBtnStyle(disabled: boolean): CSSProperties {
  return {
    padding: "6px 14px",
    background: disabled ? "#9ca3af" : "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
  };
}

const cancelBtnStyle: CSSProperties = {
  padding: "6px 14px",
  background: "#fff",
  color: "#555",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "inherit",
};
