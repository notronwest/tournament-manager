import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import { usePlatformAdmin } from "../../hooks/usePlatformAdmin";

type Row = {
  platform_fee_bps: number;
  platform_fee_fixed_cents: number;
  updated_at: string;
  updated_by: string | null;
};

const SAMPLE_CENTS = 5000; // $50.00

function computeExample(bps: number, fixedCents: number): string {
  const feeCents = Math.round((SAMPLE_CENTS * bps) / 10000) + fixedCents;
  return (feeCents / 100).toFixed(2);
}

export default function PlatformSettingsPage() {
  const { user } = useAuth();
  const isPlatformAdmin = usePlatformAdmin();

  const [row, setRow] = useState<Row | null>(null);
  const [percentStr, setPercentStr] = useState("");
  const [fixedStr, setFixedStr] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Validation helpers
  const percentNum = parseFloat(percentStr);
  const fixedNum = parseFloat(fixedStr);
  const percentValid =
    percentStr !== "" && !isNaN(percentNum) && percentNum >= 0 && percentNum <= 100;
  const fixedValid =
    fixedStr !== "" && !isNaN(fixedNum) && fixedNum >= 0;
  const canSave = percentValid && fixedValid && !saving;

  const bpsForPreview = percentValid ? Math.round(percentNum * 100) : 0;
  const fixedCentsForPreview = fixedValid ? Math.round(fixedNum * 100) : 0;

  useEffect(() => {
    if (!isPlatformAdmin) return;
    (async () => {
      const { data, error } = await supabase
        .from("platform_settings")
        .select("platform_fee_bps, platform_fee_fixed_cents, updated_at, updated_by")
        .single();
      if (error) {
        setLoadError(error.message);
        return;
      }
      if (data) {
        setRow(data);
        setPercentStr((data.platform_fee_bps / 100).toFixed(2));
        setFixedStr((data.platform_fee_fixed_cents / 100).toFixed(2));
      }
    })();
  }, [isPlatformAdmin]);

  const onSave = async () => {
    if (!canSave || !user) return;
    setSaving(true);
    setSaveError(null);
    setSavedAt(null);
    const bps = Math.round(percentNum * 100);
    const fixedCents = Math.round(fixedNum * 100);
    const { data, error } = await supabase
      .from("platform_settings")
      .update({
        platform_fee_bps: bps,
        platform_fee_fixed_cents: fixedCents,
        updated_at: new Date().toISOString(),
        updated_by: user.id,
      })
      .eq("id", true)
      .select("platform_fee_bps, platform_fee_fixed_cents, updated_at, updated_by")
      .single();
    setSaving(false);
    if (error) {
      setSaveError(error.message);
      return;
    }
    if (data) {
      setRow(data);
      setPercentStr((data.platform_fee_bps / 100).toFixed(2));
      setFixedStr((data.platform_fee_fixed_cents / 100).toFixed(2));
      setSavedAt(data.updated_at);
    }
  };

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
        <Link to="/admin" style={linkStyle}>← Back to admin</Link>
      </main>
    );
  }

  if (loadError) {
    return (
      <main style={{ padding: 24, maxWidth: 600, margin: "0 auto" }}>
        <h1 style={{ fontSize: 20, marginTop: 0 }}>Couldn't load settings</h1>
        <p style={{ color: "#666", fontSize: 14 }}>{loadError}</p>
        <Link to="/admin" style={linkStyle}>← Back to admin</Link>
      </main>
    );
  }

  if (row === null) {
    return <div style={{ padding: 24, color: "#666", fontSize: 14 }}>Loading…</div>;
  }

  const exampleFee = computeExample(bpsForPreview, fixedCentsForPreview);

  return (
    <main style={{ padding: 24, maxWidth: 560, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <Link to="/admin" style={linkStyle}>← Back to admin</Link>
      </div>
      <h1 style={{ fontSize: 20, marginTop: 0, marginBottom: 4 }}>Platform fee settings</h1>
      <p style={{ fontSize: 13, color: "#666", marginTop: 0, marginBottom: 28 }}>
        Sets the platform fee charged on every registration payment via Stripe Connect.
        The fee is deducted from the organizer's payout as{" "}
        <code style={{ fontSize: 12 }}>application_fee_amount</code>.
      </p>

      <div style={cardStyle}>
        <div style={fieldRowStyle}>
          <label style={labelStyle} htmlFor="ps-percent">
            Platform fee — percent
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              id="ps-percent"
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={percentStr}
              onChange={(e) => {
                setSaveError(null);
                setSavedAt(null);
                setPercentStr(e.target.value);
              }}
              style={{
                ...inputStyle,
                width: 100,
                borderColor: percentStr !== "" && !percentValid ? "#dc2626" : "#d1d5db",
              }}
            />
            <span style={{ fontSize: 14, color: "#444" }}>%</span>
          </div>
          {percentStr !== "" && !percentValid && (
            <p style={fieldErrorStyle}>Enter a value between 0 and 100.</p>
          )}
        </div>

        <div style={fieldRowStyle}>
          <label style={labelStyle} htmlFor="ps-fixed">
            Platform fee — fixed per transaction
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14, color: "#444" }}>$</span>
            <input
              id="ps-fixed"
              type="number"
              min="0"
              step="0.01"
              value={fixedStr}
              onChange={(e) => {
                setSaveError(null);
                setSavedAt(null);
                setFixedStr(e.target.value);
              }}
              style={{
                ...inputStyle,
                width: 100,
                borderColor: fixedStr !== "" && !fixedValid ? "#dc2626" : "#d1d5db",
              }}
            />
          </div>
          {fixedStr !== "" && !fixedValid && (
            <p style={fieldErrorStyle}>Enter a value of 0 or more.</p>
          )}
        </div>

        {/* Worked example */}
        <div style={exampleBoxStyle}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#555", marginBottom: 6 }}>
            Example — $50.00 registration
          </div>
          <div style={{ fontSize: 13, color: "#333" }}>
            Platform fee:{" "}
            <strong>${(canSave || (percentValid && fixedValid)) ? exampleFee : "—"}</strong>
            {" "}
            <span style={{ color: "#888", fontSize: 12 }}>
              ({percentValid ? `${percentNum.toFixed(2)}% × $50` : "—"}
              {fixedValid && fixedNum > 0 ? ` + $${fixedNum.toFixed(2)} fixed` : ""})
            </span>
          </div>
          <div style={{ fontSize: 11, color: "#999", marginTop: 4 }}>
            Organizer receives: $
            {(percentValid && fixedValid)
              ? (50 - parseFloat(exampleFee)).toFixed(2)
              : "—"}
          </div>
        </div>

        {saveError && (
          <div style={errorPanelStyle}>{saveError}</div>
        )}
        {savedAt && (
          <div style={successPanelStyle}>
            Saved at {new Date(savedAt).toLocaleTimeString()}.
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          <button
            onClick={onSave}
            disabled={!canSave}
            style={{
              ...btnPrimary,
              opacity: canSave ? 1 : 0.5,
              cursor: canSave ? "pointer" : "default",
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {row.updated_at && (
        <p style={{ fontSize: 12, color: "#999", marginTop: 12 }}>
          Last saved:{" "}
          {new Date(row.updated_at).toLocaleString()}
          {row.updated_by ? ` by ${row.updated_by.slice(0, 8)}…` : ""}
        </p>
      )}
    </main>
  );
}

const linkStyle: CSSProperties = {
  fontSize: 13,
  color: "#2563eb",
  textDecoration: "none",
};

const cardStyle: CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e2e2",
  borderRadius: 8,
  padding: "20px 24px",
};

const fieldRowStyle: CSSProperties = {
  marginBottom: 20,
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#333",
  marginBottom: 6,
};

const inputStyle: CSSProperties = {
  fontSize: 14,
  padding: "6px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 5,
  outline: "none",
};

const fieldErrorStyle: CSSProperties = {
  margin: "4px 0 0",
  fontSize: 12,
  color: "#dc2626",
};

const exampleBoxStyle: CSSProperties = {
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  padding: "10px 14px",
  marginTop: 4,
  marginBottom: 4,
};

const errorPanelStyle: CSSProperties = {
  marginTop: 14,
  padding: "8px 12px",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 5,
  fontSize: 13,
  color: "#dc2626",
};

const successPanelStyle: CSSProperties = {
  marginTop: 14,
  padding: "8px 12px",
  background: "#f0fdf4",
  border: "1px solid #bbf7d0",
  borderRadius: 5,
  fontSize: 13,
  color: "#15803d",
};

const btnPrimary: CSSProperties = {
  padding: "8px 18px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 500,
};
