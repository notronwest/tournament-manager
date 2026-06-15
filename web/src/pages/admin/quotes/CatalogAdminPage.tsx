import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../../supabase";
import { usePlatformAdmin } from "../../../hooks/usePlatformAdmin";
import {
  bodyFontStack,
  breadcrumbLinkStyle,
  courtGreen,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  ctaSecondaryStyle,
  ghostButtonStyle,
  ink,
  inkMuted,
  inkSoft,
  inputStyle,
  pageH1Style,
  panelMutedStyle,
  rule,
  ruleSoft,
  statusPanelStyle,
} from "../../../lib/publicTheme";
import type { Database } from "../../../types/supabase";

type ServiceRow = Database["public"]["Tables"]["service_catalog"]["Row"];
type ServiceCategory = Database["public"]["Enums"]["service_category"];
type ServiceUnit = Database["public"]["Enums"]["service_unit"];

const CATEGORY_OPTIONS: { value: ServiceCategory; label: string }[] = [
  { value: "core", label: "Core" },
  { value: "setup", label: "Setup" },
  { value: "branding", label: "Branding" },
  { value: "awards", label: "Awards" },
  { value: "equipment", label: "Equipment" },
  { value: "media", label: "Media" },
];

const UNIT_OPTIONS: { value: ServiceUnit; label: string }[] = [
  { value: "per_day", label: "Per day" },
  { value: "per_event", label: "Per event" },
  { value: "per_entrant", label: "Per entrant" },
  { value: "per_player", label: "Per player" },
  { value: "flat", label: "Flat" },
  { value: "each", label: "Each" },
];

type EditState = {
  key: string;
  name: string;
  category: ServiceCategory;
  unit: ServiceUnit;
  unitPriceDollars: string;
  plusPassthrough: boolean;
  active: boolean;
  sortOrder: string;
  notes: string;
};

const emptyEdit = (): EditState => ({
  key: "",
  name: "",
  category: "core",
  unit: "flat",
  unitPriceDollars: "0",
  plusPassthrough: false,
  active: true,
  sortOrder: "0",
  notes: "",
});

function rowToEdit(row: ServiceRow): EditState {
  return {
    key: row.key,
    name: row.name,
    category: row.category,
    unit: row.unit,
    unitPriceDollars: (row.unit_price_cents / 100).toFixed(2),
    plusPassthrough: row.plus_passthrough_cost,
    active: row.active,
    sortOrder: String(row.sort_order),
    notes: row.notes ?? "",
  };
}

export default function CatalogAdminPage() {
  const isPlatformAdmin = usePlatformAdmin();
  const [rows, setRows] = useState<ServiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Editing state: editingId = row id being edited, null = new row form
  const [editingId, setEditingId] = useState<string | null | "new">(undefined as unknown as null);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!isPlatformAdmin) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("service_catalog")
        .select("*")
        .order("sort_order");
      if (cancelled) return;
      setLoading(false);
      if (error) { setLoadError(error.message); return; }
      setRows(data ?? []);
    })();
    return () => { cancelled = true; };
  }, [isPlatformAdmin, refreshTick]);

  function startEdit(row: ServiceRow) {
    setEditingId(row.id);
    setEditState(rowToEdit(row));
    setSaveError(null);
    setSavedMsg(null);
  }

  function startNew() {
    setEditingId("new");
    setEditState(emptyEdit());
    setSaveError(null);
    setSavedMsg(null);
  }

  function cancelEdit() {
    setEditingId(undefined as unknown as null);
    setEditState(null);
    setSaveError(null);
  }

  function updateEdit(patch: Partial<EditState>) {
    setSaveError(null);
    setSavedMsg(null);
    setEditState((prev) => prev ? { ...prev, ...patch } : prev);
  }

  async function handleSave() {
    if (!editState) return;
    const priceCents = Math.round(parseFloat(editState.unitPriceDollars || "0") * 100);
    if (isNaN(priceCents) || priceCents < 0) {
      setSaveError("Price must be 0 or more.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSavedMsg(null);

    const payload = {
      key: editState.key.trim(),
      name: editState.name.trim(),
      category: editState.category,
      unit: editState.unit,
      unit_price_cents: priceCents,
      plus_passthrough_cost: editState.plusPassthrough,
      active: editState.active,
      sort_order: parseInt(editState.sortOrder || "0", 10) || 0,
      notes: editState.notes.trim() || null,
    };

    let error;
    if (editingId === "new") {
      ({ error } = await supabase.from("service_catalog").insert(payload));
    } else {
      ({ error } = await supabase
        .from("service_catalog")
        .update(payload)
        .eq("id", editingId as string));
    }

    setSaving(false);
    if (error) {
      setSaveError(error.message);
      return;
    }
    setSavedMsg(editingId === "new" ? "Service added." : "Saved.");
    setEditingId(undefined as unknown as null);
    setEditState(null);
    setLoading(true);
    setRefreshTick((t) => t + 1);
  }

  if (isPlatformAdmin === null) {
    return <div style={{ padding: 24, color: inkSoft, fontSize: 14, fontFamily: bodyFontStack }}>Loading…</div>;
  }
  if (!isPlatformAdmin) {
    return (
      <main style={{ padding: 24, maxWidth: 600, margin: "0 auto", fontFamily: bodyFontStack }}>
        <h1 style={{ ...pageH1Style, fontSize: 20, marginTop: 0 }}>Access denied</h1>
        <Link to="/admin/quotes" style={breadcrumbLinkStyle}>← Back to quotes</Link>
      </main>
    );
  }

  return (
    <main style={{ padding: "24px 24px 48px", maxWidth: 900, margin: "0 auto", fontFamily: bodyFontStack }}>
      <div style={{ marginBottom: 16 }}>
        <Link to="/admin/quotes" style={breadcrumbLinkStyle}>← Back to quotes</Link>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ ...pageH1Style, fontSize: 22, marginTop: 0, marginBottom: 0 }}>Service catalog</h1>
        <button
          onClick={startNew}
          style={ctaPrimaryStyle}
        >
          + Add service
        </button>
      </div>

      {savedMsg && (
        <div style={{ ...statusPanelStyle("success"), marginBottom: 16 }}>{savedMsg}</div>
      )}

      {loadError && (
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 16 }}>{loadError}</div>
      )}

      {/* New-row form */}
      {editingId === "new" && editState && (
        <div style={{ ...panelMutedStyle, marginBottom: 20 }}>
          <p style={{ fontWeight: 700, fontSize: 14, margin: "0 0 16px", color: ink }}>New service</p>
          <EditForm state={editState} onChange={updateEdit} />
          {saveError && <div style={{ ...statusPanelStyle("danger"), marginTop: 12 }}>{saveError}</div>}
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button onClick={handleSave} disabled={saving} style={saving ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}>
              {saving ? "Saving…" : "Add service"}
            </button>
            <button onClick={cancelEdit} style={ctaSecondaryStyle}>Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ color: inkSoft, fontSize: 14 }}>Loading catalog…</div>
      ) : (
        <div style={{ border: `1px solid ${rule}`, borderRadius: 10, overflow: "hidden" }}>
          {rows.map((row, i) => (
            <div key={row.id}>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  padding: "12px 16px",
                  background: !row.active ? "#fafafa" : "#fff",
                  borderTop: i > 0 ? `1px solid ${ruleSoft}` : "none",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: row.active ? ink : inkMuted }}>
                      {row.name}
                    </span>
                    {!row.active && (
                      <span style={{ fontSize: 11, color: inkMuted, fontStyle: "italic" }}>inactive</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: inkMuted }}>
                    {row.category} · {row.unit.replace(/_/g, " ")} ·{" "}
                    <strong style={{ color: courtGreen }}>${(row.unit_price_cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                    {row.plus_passthrough_cost && " + materials"}
                    {row.notes && <> · <span style={{ fontStyle: "italic" }}>{row.notes}</span></>}
                  </div>
                </div>
                <button onClick={() => startEdit(row)} style={{ ...ghostButtonStyle, color: inkSoft }}>
                  Edit
                </button>
              </div>

              {editingId === row.id && editState && (
                <div style={{ padding: "12px 16px 16px", borderTop: `1px solid ${ruleSoft}`, background: "#f9f9f7" }}>
                  <EditForm state={editState} onChange={updateEdit} />
                  {saveError && <div style={{ ...statusPanelStyle("danger"), marginTop: 12 }}>{saveError}</div>}
                  <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                    <button onClick={handleSave} disabled={saving} style={saving ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}>
                      {saving ? "Saving…" : "Save"}
                    </button>
                    <button onClick={cancelEdit} style={ctaSecondaryStyle}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {rows.length === 0 && (
            <div style={{ padding: 32, textAlign: "center", color: inkMuted, fontSize: 14 }}>
              No services yet.
            </div>
          )}
        </div>
      )}
    </main>
  );
}

function EditForm({ state, onChange }: { state: EditState; onChange: (p: Partial<EditState>) => void }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: "0 16px",
      }}
    >
      <div style={{ marginBottom: 12 }}>
        <label style={labelSt}>Key</label>
        <input
          style={inputStyle}
          value={state.key}
          onChange={(e) => onChange({ key: e.target.value })}
          placeholder="onsite_mgmt_day"
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelSt}>Name</label>
        <input
          style={inputStyle}
          value={state.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="On-site management"
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelSt}>Category</label>
        <select style={{ ...inputStyle, cursor: "pointer" }} value={state.category} onChange={(e) => onChange({ category: e.target.value as ServiceCategory })}>
          {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelSt}>Unit</label>
        <select style={{ ...inputStyle, cursor: "pointer" }} value={state.unit} onChange={(e) => onChange({ unit: e.target.value as ServiceUnit })}>
          {UNIT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelSt}>Unit price ($)</label>
        <input
          style={inputStyle}
          type="number"
          min="0"
          step="0.01"
          value={state.unitPriceDollars}
          onChange={(e) => onChange({ unitPriceDollars: e.target.value })}
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelSt}>Sort order</label>
        <input
          style={inputStyle}
          type="number"
          value={state.sortOrder}
          onChange={(e) => onChange({ sortOrder: e.target.value })}
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelSt}>Notes</label>
        <input
          style={inputStyle}
          value={state.notes}
          onChange={(e) => onChange({ notes: e.target.value })}
          placeholder="Optional note"
        />
      </div>
      <div style={{ marginBottom: 12, display: "flex", flexDirection: "column", gap: 8, justifyContent: "flex-end" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: inkSoft, cursor: "pointer" }}>
          <input type="checkbox" checked={state.plusPassthrough} onChange={(e) => onChange({ plusPassthrough: e.target.checked })} />
          Plus passthrough cost
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: inkSoft, cursor: "pointer" }}>
          <input type="checkbox" checked={state.active} onChange={(e) => onChange({ active: e.target.checked })} />
          Active
        </label>
      </div>
    </div>
  );
}

const labelSt: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: inkSoft,
  marginBottom: 4,
  fontFamily: bodyFontStack,
};
