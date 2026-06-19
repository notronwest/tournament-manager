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
  discount_value: string;
  max_uses: string;
  starts_at: string;
  expires_at: string;
  active: boolean;
};

const emptyDraft = (): DraftCoupon => ({
  code: "",
  discount_type: "percent",
  discount_value: "",
  max_uses: "",
  starts_at: "",
  expires_at: "",
  active: true,
});

function validateDraft(draft: DraftCoupon): string | null {
  if (!draft.code.trim()) return "Code is required.";
  const val = parseFloat(draft.discount_value);
  if (isNaN(val) || val <= 0) return "Discount value must be greater than 0.";
  if (draft.discount_type === "percent" && (val < 1 || val > 100 || !Number.isInteger(val))) {
    return "Percent discount must be a whole number between 1 and 100.";
  }
  if (draft.max_uses !== "" && (isNaN(parseInt(draft.max_uses)) || parseInt(draft.max_uses) < 1)) {
    return "Max uses must be a positive number if set.";
  }
  return null;
}

function toPayload(draft: DraftCoupon, tournamentId: string) {
  const val =
    draft.discount_type === "fixed_amount"
      ? Math.round(parseFloat(draft.discount_value) * 100)
      : parseInt(draft.discount_value);
  return {
    tournament_id: tournamentId,
    code: draft.code.trim().toUpperCase(),
    discount_type: draft.discount_type,
    discount_value: val,
    max_uses: draft.max_uses !== "" ? parseInt(draft.max_uses) : null,
    starts_at: draft.starts_at ? new Date(draft.starts_at).toISOString() : null,
    expires_at: draft.expires_at ? new Date(draft.expires_at).toISOString() : null,
    active: draft.active,
  };
}

function couponToEditDraft(c: Coupon): DraftCoupon {
  const displayValue =
    c.discount_type === "fixed_amount"
      ? (c.discount_value / 100).toFixed(2)
      : String(c.discount_value);
  return {
    code: c.code,
    discount_type: c.discount_type,
    discount_value: displayValue,
    max_uses: c.max_uses != null ? String(c.max_uses) : "",
    starts_at: c.starts_at ? c.starts_at.slice(0, 16) : "",
    expires_at: c.expires_at ? c.expires_at.slice(0, 16) : "",
    active: c.active,
  };
}

// `embedded` is set when rendered inside the tournament edit wizard as a
// step pane — drops the breadcrumb + page padding so it sits cleanly in the
// wizard's content area instead of as a standalone page.
export default function TournamentCouponsPage({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const { org, role } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();
  const outerStyle: CSSProperties = embedded ? {} : pageStyle;
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

  const isAdmin = role === "owner" || role === "admin";

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
    const validErr = validateDraft(addDraft);
    if (validErr) { setAddError(validErr); return; }
    setAddBusy(true);
    setAddError(null);
    const { error: err } = await supabase
      .from("coupons")
      .insert(toPayload(addDraft, tournament.id));
    setAddBusy(false);
    if (err) { setAddError(err.message); return; }
    setShowAdd(false);
    setAddDraft(emptyDraft());
    void load();
  };

  const startEdit = (c: Coupon) => {
    setEditingId(c.id);
    setEditDraft(couponToEditDraft(c));
    setEditError(null);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !tournament) return;
    const validErr = validateDraft(editDraft);
    if (validErr) { setEditError(validErr); return; }
    setEditBusy(true);
    setEditError(null);
    const payload = toPayload(editDraft, tournament.id);
    const { error: err } = await supabase
      .from("coupons")
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq("id", editingId);
    setEditBusy(false);
    if (err) { setEditError(err.message); return; }
    setEditingId(null);
    void load();
  };

  const handleToggleActive = async (c: Coupon) => {
    await supabase
      .from("coupons")
      .update({ active: !c.active, updated_at: new Date().toISOString() })
      .eq("id", c.id);
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

  if (!org || loading) return <div style={outerStyle}>Loading…</div>;
  if (error) return <div style={outerStyle}><div style={errorStyle}>{error}</div></div>;
  if (!tournament) return null;

  return (
    <div style={outerStyle}>
      {!embedded && (
        <nav style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
          <Link
            to={`/admin/${org.slug}/tournaments/${tournament.slug}`}
            style={{ color: "#2563eb", textDecoration: "none" }}
          >
            {tournament.name}
          </Link>
          {" / Coupons"}
        </nav>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Coupons</h1>
        {isAdmin && !showAdd && (
          <button
            onClick={() => { setShowAdd(true); setAddDraft(emptyDraft()); setAddError(null); }}
            style={primaryBtn}
          >
            + New coupon
          </button>
        )}
      </div>

      {!isAdmin && (
        <div style={noticeStyle}>
          Only tournament admins can manage coupons.
        </div>
      )}

      {isAdmin && showAdd && (
        <div style={formCardStyle}>
          <h2 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600 }}>New coupon</h2>
          <CouponForm
            draft={addDraft}
            onChange={setAddDraft}
            error={addError}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button onClick={handleAdd} disabled={addBusy} style={primaryBtn}>
              {addBusy ? "Saving…" : "Create coupon"}
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
          {isAdmin ? "No coupons yet. Create one to offer discounts at checkout." : "No coupons."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {coupons.map((c) =>
            isAdmin && editingId === c.id ? (
              <div key={c.id} style={formCardStyle}>
                <h2 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600 }}>Edit coupon</h2>
                <CouponForm
                  draft={editDraft}
                  onChange={setEditDraft}
                  error={editError}
                />
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
                isAdmin={isAdmin}
                onEdit={() => startEdit(c)}
                onToggleActive={() => handleToggleActive(c)}
                onDelete={() => setPendingDelete(c)}
              />
            )
          )}
        </div>
      )}

      {pendingDelete && (
        <ConfirmModal
          title={`Delete coupon "${pendingDelete.code}"?`}
          body="This coupon will be soft-deleted and immediately stop validating at checkout."
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
          style={inputStyle}
          value={draft.code}
          onChange={(e) => onChange({ ...draft, code: e.target.value.toUpperCase() })}
          placeholder="e.g. SUMMER20"
          autoFocus
        />
      </div>
      <div style={fieldRowStyle}>
        <label style={labelStyle}>Type *</label>
        <select
          style={inputStyle}
          value={draft.discount_type}
          onChange={(e) => onChange({ ...draft, discount_type: e.target.value as DiscountType, discount_value: "" })}
        >
          <option value="percent">Percent off (%)</option>
          <option value="fixed_amount">Fixed amount ($)</option>
        </select>
      </div>
      <div style={fieldRowStyle}>
        <label style={labelStyle}>
          {draft.discount_type === "percent" ? "% off *" : "$ off *"}
        </label>
        <input
          style={inputStyle}
          type="number"
          min={draft.discount_type === "percent" ? 1 : 0.01}
          max={draft.discount_type === "percent" ? 100 : undefined}
          step={draft.discount_type === "percent" ? 1 : 0.01}
          value={draft.discount_value}
          onChange={(e) => onChange({ ...draft, discount_value: e.target.value })}
          placeholder={draft.discount_type === "percent" ? "1–100" : "e.g. 10.00"}
        />
      </div>
      <div style={fieldRowStyle}>
        <label style={labelStyle}>Max uses</label>
        <input
          style={inputStyle}
          type="number"
          min={1}
          step={1}
          value={draft.max_uses}
          onChange={(e) => onChange({ ...draft, max_uses: e.target.value })}
          placeholder="Unlimited"
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
          {" Active (can be used at checkout)"}
        </label>
      </div>
    </div>
  );
}

function fmtDiscount(c: Coupon): string {
  if (c.discount_type === "percent") return `${c.discount_value}% off`;
  return `$${(c.discount_value / 100).toFixed(2)} off`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function CouponRow({
  coupon,
  isAdmin,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  coupon: Coupon;
  isAdmin: boolean;
  onEdit: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  const usesLabel =
    coupon.max_uses != null
      ? `${coupon.uses_count} / ${coupon.max_uses} uses`
      : `${coupon.uses_count} uses`;

  return (
    <div style={rowCardStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: 14, fontFamily: "monospace", letterSpacing: "0.05em" }}>
            {coupon.code}
          </span>
          <span style={{ fontSize: 13, color: "#555" }}>{fmtDiscount(coupon)}</span>
          {coupon.active ? (
            <span style={activeBadgeStyle}>Active</span>
          ) : (
            <span style={inactiveBadgeStyle}>Inactive</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 4, flexWrap: "wrap", fontSize: 12, color: "#777" }}>
          <span>{usesLabel}</span>
          {coupon.starts_at && <span>Starts {fmtDate(coupon.starts_at)}</span>}
          {coupon.expires_at && <span>Expires {fmtDate(coupon.expires_at)}</span>}
        </div>
      </div>

      {isAdmin && (
        <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
          <button onClick={onEdit} style={rowActionBtn}>Edit</button>
          <button onClick={onToggleActive} style={rowActionBtn}>
            {coupon.active ? "Deactivate" : "Activate"}
          </button>
          <button onClick={onDelete} style={rowDeleteBtn}>Delete</button>
        </div>
      )}
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

const noticeStyle: CSSProperties = {
  padding: "10px 14px",
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  fontSize: 13,
  color: "#6b7280",
  marginBottom: 16,
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
  alignItems: "center",
};

const fieldRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "120px 1fr",
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

const activeBadgeStyle: CSSProperties = {
  padding: "2px 6px",
  background: "#dcfce7",
  color: "#16a34a",
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 500,
};

const inactiveBadgeStyle: CSSProperties = {
  padding: "2px 6px",
  background: "#f3f4f6",
  color: "#6b7280",
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 500,
};
