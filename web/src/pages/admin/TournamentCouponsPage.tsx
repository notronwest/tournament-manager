import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { ConfirmModal } from "../../components/ConfirmModal";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Coupon = Database["public"]["Tables"]["coupons"]["Row"];
type DiscountType = Database["public"]["Enums"]["coupon_discount_type"];

type DraftCoupon = {
  code: string;
  discount_type: DiscountType;
  // Display value: percent = whole number 1-100; fixed_amount = dollars (decimal)
  discount_display: string;
  max_uses: string; // "" = unlimited
  starts_at: string; // datetime-local string or ""
  expires_at: string; // datetime-local string or ""
  active: boolean;
};

const emptyDraft = (): DraftCoupon => ({
  code: "",
  discount_type: "percent",
  discount_display: "",
  max_uses: "",
  starts_at: "",
  expires_at: "",
  active: true,
});

function draftFromCoupon(c: Coupon): DraftCoupon {
  return {
    code: c.code,
    discount_type: c.discount_type,
    discount_display:
      c.discount_type === "fixed_amount"
        ? (c.discount_value / 100).toFixed(2)
        : String(c.discount_value),
    max_uses: c.max_uses != null ? String(c.max_uses) : "",
    starts_at: c.starts_at ? toDatetimeLocal(c.starts_at) : "",
    expires_at: c.expires_at ? toDatetimeLocal(c.expires_at) : "",
    active: c.active,
  };
}

function toDatetimeLocal(iso: string): string {
  // Convert ISO string to "YYYY-MM-DDTHH:MM" for datetime-local input
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function validateDraft(draft: DraftCoupon): string | null {
  if (!draft.code.trim()) return "Code is required.";
  const val = parseFloat(draft.discount_display);
  if (isNaN(val) || val <= 0) return "Discount value must be greater than zero.";
  if (draft.discount_type === "percent" && (val < 1 || val > 100 || !Number.isInteger(val)))
    return "Percent discount must be a whole number between 1 and 100.";
  if (draft.max_uses !== "") {
    const mu = parseInt(draft.max_uses, 10);
    if (isNaN(mu) || mu < 1) return "Max uses must be a positive number (or blank for unlimited).";
  }
  if (draft.starts_at && draft.expires_at && draft.expires_at <= draft.starts_at)
    return "Expiry must be after start date.";
  return null;
}

function draftToInsert(
  draft: DraftCoupon,
  tournamentId: string
): Database["public"]["Tables"]["coupons"]["Insert"] {
  const val = parseFloat(draft.discount_display);
  return {
    tournament_id: tournamentId,
    code: draft.code.trim().toUpperCase(),
    discount_type: draft.discount_type,
    discount_value:
      draft.discount_type === "fixed_amount" ? Math.round(val * 100) : Math.round(val),
    max_uses: draft.max_uses !== "" ? parseInt(draft.max_uses, 10) : null,
    starts_at: draft.starts_at ? new Date(draft.starts_at).toISOString() : null,
    expires_at: draft.expires_at ? new Date(draft.expires_at).toISOString() : null,
    active: draft.active,
  };
}

function formatDiscount(c: Coupon): string {
  if (c.discount_type === "percent") {
    return c.discount_value === 100 ? "Free entry (100% off)" : `${c.discount_value}% off`;
  }
  return `$${(c.discount_value / 100).toFixed(2)} off`;
}

export default function TournamentCouponsPage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [addDraft, setAddDraft] = useState<DraftCoupon>(emptyDraft());
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<DraftCoupon>(emptyDraft());
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [pendingDelete, setPendingDelete] = useState<Coupon | null>(null);

  const load = useCallback(async () => {
    if (!org || !tournamentSlug) return;
    setError(null);

    const { data: tData, error: tErr } = await supabase
      .from("tournaments")
      .select("*")
      .eq("organization_id", org.id)
      .eq("slug", tournamentSlug)
      .is("deleted_at", null)
      .maybeSingle();

    if (tErr) { setError(tErr.message); setLoading(false); return; }
    if (!tData) { setError("Tournament not found."); setLoading(false); return; }
    setTournament(tData);

    const { data: cData, error: cErr } = await supabase
      .from("coupons")
      .select("*")
      .eq("tournament_id", tData.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    if (cErr) { setError(cErr.message); setLoading(false); return; }
    setCoupons(cData ?? []);
    setLoading(false);
  }, [org, tournamentSlug]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const handleAdd = async () => {
    if (!tournament) return;
    const err = validateDraft(addDraft);
    if (err) { setAddError(err); return; }
    setAddBusy(true);
    setAddError(null);
    const { error: insErr } = await supabase
      .from("coupons")
      .insert(draftToInsert(addDraft, tournament.id));
    setAddBusy(false);
    if (insErr) {
      setAddError(
        insErr.message.includes("coupons_code_per_tournament")
          ? "A coupon with that code already exists for this tournament."
          : insErr.message
      );
      return;
    }
    setShowAdd(false);
    setAddDraft(emptyDraft());
    void load();
  };

  const startEdit = (c: Coupon) => {
    setEditingId(c.id);
    setEditDraft(draftFromCoupon(c));
    setEditError(null);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !tournament) return;
    const err = validateDraft(editDraft);
    if (err) { setEditError(err); return; }
    setEditBusy(true);
    setEditError(null);
    const insert = draftToInsert(editDraft, tournament.id);
    const { error: updErr } = await supabase
      .from("coupons")
      .update({
        code: insert.code,
        discount_type: insert.discount_type,
        discount_value: insert.discount_value,
        max_uses: insert.max_uses,
        starts_at: insert.starts_at,
        expires_at: insert.expires_at,
        active: insert.active,
        updated_at: new Date().toISOString(),
      })
      .eq("id", editingId);
    setEditBusy(false);
    if (updErr) {
      setEditError(
        updErr.message.includes("coupons_code_per_tournament")
          ? "A coupon with that code already exists for this tournament."
          : updErr.message
      );
      return;
    }
    setEditingId(null);
    void load();
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    await supabase
      .from("coupons")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", pendingDelete.id);
    setPendingDelete(null);
    void load();
  };

  if (!org || loading) return <div style={pageStyle}>Loading…</div>;
  if (error) return <div style={pageStyle}><div style={errorStyle}>{error}</div></div>;
  if (!tournament) return null;

  return (
    <div style={pageStyle}>
      <nav style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
        <Link
          to={`/admin/${org.slug}/tournaments/${tournament.slug}`}
          style={{ color: "#2563eb", textDecoration: "none" }}
        >
          {tournament.name}
        </Link>
        {" / Coupon Codes"}
      </nav>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Coupon Codes</h1>
        {!showAdd && (
          <button
            onClick={() => { setShowAdd(true); setAddDraft(emptyDraft()); setAddError(null); }}
            style={primaryBtn}
          >
            + Add coupon
          </button>
        )}
      </div>

      {showAdd && (
        <div style={formCardStyle}>
          <h2 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600 }}>New coupon</h2>
          <CouponForm draft={addDraft} onChange={setAddDraft} error={addError} />
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button onClick={handleAdd} disabled={addBusy} style={primaryBtn}>
              {addBusy ? "Saving…" : "Save coupon"}
            </button>
            <button
              onClick={() => { setShowAdd(false); setAddError(null); }}
              disabled={addBusy}
              style={secondaryBtn}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {coupons.length === 0 && !showAdd ? (
        <div style={emptyStyle}>
          No coupon codes yet. Add one to offer discounts at checkout.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {coupons.map((c) =>
            editingId === c.id ? (
              <div key={c.id} style={formCardStyle}>
                <h2 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600 }}>Edit coupon</h2>
                <CouponForm draft={editDraft} onChange={setEditDraft} error={editError} />
                <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                  <button onClick={handleSaveEdit} disabled={editBusy} style={primaryBtn}>
                    {editBusy ? "Saving…" : "Save"}
                  </button>
                  <button
                    onClick={() => { setEditingId(null); setEditError(null); }}
                    disabled={editBusy}
                    style={secondaryBtn}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <CouponRow
                key={c.id}
                coupon={c}
                onEdit={() => startEdit(c)}
                onDelete={() => setPendingDelete(c)}
              />
            )
          )}
        </div>
      )}

      {pendingDelete && (
        <ConfirmModal
          title={`Delete coupon "${pendingDelete.code}"?`}
          body="This coupon code will be deactivated. Players who have already used it retain their discount, but no new redemptions will be possible."
          confirmLabel="Delete coupon"
          onCancel={() => setPendingDelete(null)}
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
}

function CouponForm({
  draft,
  onChange,
  error,
}: {
  draft: DraftCoupon;
  onChange: (d: DraftCoupon) => void;
  error: string | null;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {error && <div style={inlineErrorStyle}>{error}</div>}

      <div style={fieldRowStyle}>
        <label style={labelStyle}>Code *</label>
        <input
          style={{ ...inputStyle, fontFamily: "monospace", textTransform: "uppercase" }}
          value={draft.code}
          onChange={(e) => onChange({ ...draft, code: e.target.value.toUpperCase() })}
          placeholder="e.g. EARLYBIRD20"
          autoFocus
          maxLength={40}
        />
      </div>

      <div style={fieldRowStyle}>
        <label style={labelStyle}>Type *</label>
        <select
          style={inputStyle}
          value={draft.discount_type}
          onChange={(e) =>
            onChange({ ...draft, discount_type: e.target.value as DiscountType, discount_display: "" })
          }
        >
          <option value="percent">Percent off (%)</option>
          <option value="fixed_amount">Fixed amount ($)</option>
        </select>
      </div>

      <div style={fieldRowStyle}>
        <label style={labelStyle}>
          {draft.discount_type === "percent" ? "Percent (1–100) *" : "Amount ($) *"}
        </label>
        <input
          style={inputStyle}
          type="number"
          value={draft.discount_display}
          onChange={(e) => onChange({ ...draft, discount_display: e.target.value })}
          placeholder={draft.discount_type === "percent" ? "e.g. 20" : "e.g. 5.00"}
          min={draft.discount_type === "percent" ? 1 : 0.01}
          max={draft.discount_type === "percent" ? 100 : undefined}
          step={draft.discount_type === "percent" ? 1 : 0.01}
        />
      </div>

      <div style={fieldRowStyle}>
        <label style={labelStyle}>Max uses</label>
        <input
          style={inputStyle}
          type="number"
          value={draft.max_uses}
          onChange={(e) => onChange({ ...draft, max_uses: e.target.value })}
          placeholder="Blank = unlimited"
          min={1}
          step={1}
        />
      </div>

      <div style={fieldRowStyle}>
        <label style={labelStyle}>Starts at</label>
        <input
          style={inputStyle}
          type="datetime-local"
          value={draft.starts_at}
          onChange={(e) => onChange({ ...draft, starts_at: e.target.value })}
        />
      </div>

      <div style={fieldRowStyle}>
        <label style={labelStyle}>Expires at</label>
        <input
          style={inputStyle}
          type="datetime-local"
          value={draft.expires_at}
          onChange={(e) => onChange({ ...draft, expires_at: e.target.value })}
        />
      </div>

      <div style={{ marginTop: 4 }}>
        <label style={checkboxLabelStyle}>
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => onChange({ ...draft, active: e.target.checked })}
          />
          {" Active (accepts redemptions)"}
        </label>
      </div>
    </div>
  );
}

function CouponRow({
  coupon,
  onEdit,
  onDelete,
}: {
  coupon: Coupon;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const usesLabel =
    coupon.max_uses != null
      ? `${coupon.uses_count} / ${coupon.max_uses} uses`
      : `${coupon.uses_count} use${coupon.uses_count === 1 ? "" : "s"} (unlimited)`;

  const now = new Date();
  const expired =
    coupon.expires_at != null && new Date(coupon.expires_at) < now;
  const notStarted =
    coupon.starts_at != null && new Date(coupon.starts_at) > now;

  return (
    <div style={rowCardStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 14, letterSpacing: "0.03em" }}>
            {coupon.code}
          </span>
          <span style={discountBadgeStyle}>{formatDiscount(coupon)}</span>
          {!coupon.active && <span style={inactiveBadgeStyle}>Inactive</span>}
          {coupon.active && expired && <span style={inactiveBadgeStyle}>Expired</span>}
          {coupon.active && notStarted && <span style={pendingBadgeStyle}>Not started</span>}
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 4, flexWrap: "wrap" }}>
          <span style={metaStyle}>{usesLabel}</span>
          {coupon.starts_at && (
            <span style={metaStyle}>
              Starts: {new Date(coupon.starts_at).toLocaleDateString()}
            </span>
          )}
          {coupon.expires_at && (
            <span style={metaStyle}>
              Expires: {new Date(coupon.expires_at).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button onClick={onEdit} style={rowActionBtn}>Edit</button>
        <button onClick={onDelete} style={rowDeleteBtn}>Delete</button>
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  padding: "24px 32px",
  maxWidth: 720,
};

const errorStyle: CSSProperties = {
  color: "#dc2626",
  fontSize: 13,
};

const inlineErrorStyle: CSSProperties = {
  color: "#dc2626",
  fontSize: 12,
  padding: "6px 10px",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 4,
};

const emptyStyle: CSSProperties = {
  padding: "24px 0",
  color: "#888",
  fontSize: 13,
};

const formCardStyle: CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: 20,
  marginBottom: 8,
};

const rowCardStyle: CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: "12px 16px",
  display: "flex",
  gap: 12,
  alignItems: "flex-start",
};

const fieldRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "140px 1fr",
  gap: 8,
  alignItems: "center",
};

const labelStyle: CSSProperties = {
  fontSize: 13,
  color: "#555",
  fontWeight: 500,
};

const checkboxLabelStyle: CSSProperties = {
  fontSize: 13,
  color: "#444",
  display: "flex",
  alignItems: "center",
  gap: 6,
  cursor: "pointer",
};

const inputStyle: CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #e2e2e2",
  borderRadius: 4,
  fontSize: 13,
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box",
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
};

const secondaryBtn: CSSProperties = {
  padding: "6px 14px",
  background: "#fff",
  color: "#555",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "inherit",
};

const rowActionBtn: CSSProperties = {
  padding: "4px 10px",
  background: "#fff",
  color: "#2563eb",
  border: "1px solid #2563eb",
  borderRadius: 4,
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
};

const rowDeleteBtn: CSSProperties = {
  padding: "4px 10px",
  background: "#fff",
  color: "#dc2626",
  border: "1px solid #fecaca",
  borderRadius: 4,
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
};

const discountBadgeStyle: CSSProperties = {
  padding: "2px 6px",
  background: "#f0fdf4",
  color: "#16a34a",
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
};

const inactiveBadgeStyle: CSSProperties = {
  padding: "2px 6px",
  background: "#f3f4f6",
  color: "#6b7280",
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 500,
};

const pendingBadgeStyle: CSSProperties = {
  padding: "2px 6px",
  background: "#fffbeb",
  color: "#b45309",
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 500,
};

const metaStyle: CSSProperties = {
  fontSize: 12,
  color: "#666",
};
