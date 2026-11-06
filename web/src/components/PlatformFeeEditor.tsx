// The ONE platform-fee editor. Mounted in three places on the platform-fee
// page — the global default, an organization's override, a tournament's
// override — via the `variant` prop, so the inputs, the validation, the
// worked example and the inherit/override choice have a single
// implementation instead of three that drift (D-0049).
//
// It previews with computePlatformFeeCents, the same function
// create-payment-intent charges with, so the number shown here is the number
// Stripe is handed.
import { useState } from "react";
import { computePlatformFeeCents } from "../../../supabase/functions/_shared/platformFee";
import { formatFeeShort, type PlatformFeeValue } from "../lib/platformFeeDisplay";
import {
  ink,
  inkSoft,
  inkMuted,
  courtBlue,
  panelStyle,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  ctaSecondaryStyle,
  inputStyle,
  statusPanelStyle,
  dangerFg,
} from "../lib/publicTheme";

const SAMPLE_CENTS = 5000; // the worked example is always a $50 registration

export function PlatformFeeEditor({
  idPrefix,
  variant = "page",
  value,
  inheritLabel,
  inheritedFee,
  saving = false,
  error = null,
  savedAt = null,
  onSave,
  onCancel,
}: {
  // Unique per mount — several editors can be open on one page.
  idPrefix: string;
  // "page" is the global default form (no inherit choice, page-weight CTA);
  // "inline" is a row editor inside an organization or tournament list.
  variant?: "page" | "inline";
  value: PlatformFeeValue;
  // Name of the level this one falls back to, e.g. "the platform default".
  // Omitted for the global default, which has nothing to inherit from.
  inheritLabel?: string;
  // The fee that applies while inheriting — shown so clearing an override
  // is not a guess about what the rate becomes.
  inheritedFee?: { bps: number; fixedCents: number };
  saving?: boolean;
  error?: string | null;
  savedAt?: string | null;
  // null clears the override and goes back to inheriting.
  onSave: (next: PlatformFeeValue) => void;
  onCancel?: () => void;
}) {
  const canInherit = inheritLabel !== undefined;
  // "custom" vs "inherit" is the first choice, so the two number fields only
  // matter once the answer is "custom" — progressive disclosure rather than
  // two inputs whose meaning depends on an empty value.
  const [mode, setMode] = useState<"inherit" | "custom">(
    value === null && canInherit ? "inherit" : "custom",
  );
  const [percentStr, setPercentStr] = useState(() =>
    value ? (value.bps / 100).toFixed(2) : inheritedFee ? (inheritedFee.bps / 100).toFixed(2) : "0.00",
  );
  const [fixedStr, setFixedStr] = useState(() =>
    value
      ? (value.fixedCents / 100).toFixed(2)
      : inheritedFee
        ? (inheritedFee.fixedCents / 100).toFixed(2)
        : "0.00",
  );

  // No re-seeding effect: callers remount this editor (a changing React key)
  // when the saved value moves under it, which is React's own answer to
  // "reset state when a prop changes" and keeps the draft purely local.

  const percentNum = parseFloat(percentStr);
  const fixedNum = parseFloat(fixedStr);
  const percentValid =
    percentStr !== "" && !isNaN(percentNum) && percentNum >= 0 && percentNum <= 100;
  const fixedValid = fixedStr !== "" && !isNaN(fixedNum) && fixedNum >= 0;
  const numbersValid = percentValid && fixedValid;
  const canSave = (mode === "inherit" || numbersValid) && !saving;

  const previewBps = mode === "inherit" ? (inheritedFee?.bps ?? 0) : percentValid ? Math.round(percentNum * 100) : 0;
  const previewFixed =
    mode === "inherit"
      ? (inheritedFee?.fixedCents ?? 0)
      : fixedValid
        ? Math.round(fixedNum * 100)
        : 0;
  const previewKnown = mode === "inherit" || numbersValid;
  const feeCents = computePlatformFeeCents(SAMPLE_CENTS, previewBps, previewFixed);

  const submit = () => {
    if (!canSave) return;
    onSave(
      mode === "inherit"
        ? null
        : { bps: Math.round(percentNum * 100), fixedCents: Math.round(fixedNum * 100) },
    );
  };

  return (
    <div>
      {canInherit && (
        // Choice tiles, not buttons: this selects which fee applies and swaps
        // the form below it (docs/DESIGN_PREFERENCES.md, 2026-06-05).
        <div
          role="radiogroup"
          aria-label="Which platform fee applies"
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}
        >
          {(["inherit", "custom"] as const).map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setMode(m)}
                style={{
                  ...choiceTileStyle,
                  background: active ? "#eff6ff" : "#fff",
                  // Inactive border is inkMuted, not the tile pattern's
                  // #d1d5db: a control's resting edge needs 3:1 against the
                  // surface behind it (D-0157) and #d1d5db on white is 1.5:1.
                  borderColor: active ? "#2563eb" : inkMuted,
                  color: active ? "#1e40af" : ink,
                }}
              >
                {m === "inherit" ? `Use ${inheritLabel}` : "Set a custom fee"}
              </button>
            );
          })}
        </div>
      )}

      {mode === "custom" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
          <div style={fieldStyle}>
            <label style={labelStyle} htmlFor={`${idPrefix}-percent`}>
              Percent of each registration
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                id={`${idPrefix}-percent`}
                type="number"
                inputMode="decimal"
                min="0"
                max="100"
                step="0.01"
                value={percentStr}
                onChange={(e) => setPercentStr(e.target.value)}
                style={{
                  ...inputStyle,
                  minHeight: 44,
                  borderColor: percentStr !== "" && !percentValid ? dangerFg : undefined,
                }}
              />
              <span style={{ fontSize: 14, color: inkSoft }}>%</span>
            </div>
            {percentStr !== "" && !percentValid && (
              <p style={fieldErrorStyle}>Enter a value between 0 and 100.</p>
            )}
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle} htmlFor={`${idPrefix}-fixed`}>
              Plus a fixed amount
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 14, color: inkSoft }}>$</span>
              <input
                id={`${idPrefix}-fixed`}
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={fixedStr}
                onChange={(e) => setFixedStr(e.target.value)}
                style={{
                  ...inputStyle,
                  minHeight: 44,
                  borderColor: fixedStr !== "" && !fixedValid ? dangerFg : undefined,
                }}
              />
            </div>
            {fixedStr !== "" && !fixedValid && (
              <p style={fieldErrorStyle}>Enter a value of 0 or more.</p>
            )}
          </div>
        </div>
      )}

      {/* Worked example — the same math Stripe is handed, on a $50 entry. */}
      <div style={{ ...panelStyle, padding: 14, marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: inkSoft, marginBottom: 6 }}>
          On a $50.00 registration
        </div>
        <div style={{ fontSize: 13, color: ink }}>
          Platform fee <strong>{previewKnown ? `$${(feeCents / 100).toFixed(2)}` : "—"}</strong>
          {previewKnown && (
            <span style={{ color: inkMuted, fontSize: 12 }}>
              {" "}
              ({formatFeeShort(previewBps, previewFixed)})
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: inkMuted, marginTop: 4 }}>
          Organizer receives {previewKnown ? `$${((SAMPLE_CENTS - feeCents) / 100).toFixed(2)}` : "—"}
        </div>
      </div>

      {error && <div style={{ ...statusPanelStyle("danger"), marginBottom: 12 }}>{error}</div>}
      {savedAt && (
        <div style={{ ...statusPanelStyle("success"), marginBottom: 12 }}>
          Saved at {new Date(savedAt).toLocaleTimeString()}.
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <button
          type="button"
          onClick={submit}
          disabled={!canSave}
          style={{
            ...(canSave ? ctaPrimaryStyle : ctaPrimaryDisabledStyle),
            ...(variant === "inline" ? { fontSize: 13, padding: "10px 18px" } : null),
            minHeight: 44,
          }}
        >
          {saving ? "Saving…" : mode === "inherit" && canInherit ? "Use the inherited fee" : "Save fee"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            style={{ ...ctaSecondaryStyle, fontSize: 13, padding: "10px 18px", minHeight: 44 }}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

const fieldStyle = {
  display: "flex" as const,
  flexDirection: "column" as const,
  gap: 4,
  flex: "1 1 180px",
  minWidth: 0,
};

const labelStyle = {
  fontSize: 12,
  fontWeight: 600 as const,
  color: inkSoft,
};

const fieldErrorStyle = {
  margin: "4px 0 0",
  fontSize: 12,
  color: dangerFg,
};

const choiceTileStyle = {
  padding: "10px 12px",
  borderRadius: 6,
  borderWidth: 1,
  borderStyle: "solid" as const,
  fontSize: 13,
  fontWeight: 500 as const,
  fontFamily: "inherit",
  cursor: "pointer",
  minHeight: 44,
  textAlign: "left" as const,
};

// Shared row badge: says which level supplied a row's fee, so a list reads
// at a glance without opening anything.
export function FeeSourceBadge({ source }: { source: "tournament" | "organization" | "default" }) {
  const custom = source !== "default";
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: 99,
        fontSize: 11,
        fontWeight: 500,
        whiteSpace: "nowrap",
        background: custom ? "#eff6ff" : "transparent",
        color: custom ? courtBlue : inkSoft,
        border: custom ? `1px solid ${courtBlue}` : `1px solid ${inkMuted}`,
      }}
    >
      {source === "default" ? "Inherited" : "Custom"}
    </span>
  );
}
