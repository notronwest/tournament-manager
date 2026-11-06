// The ONE platform-fee editor. Mounted in three places on the platform-fee
// page — the global default, an organization's override, a tournament's
// override — via the `variant` prop, so the inputs, the validation, the
// worked example and the inherit/override choice have a single
// implementation instead of three that drift (D-0049).
//
// It previews with computePlatformFeeCents, the same function
// create-payment-intent charges with, so the number shown here is the number
// Stripe is handed.
import { useCallback, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { computePlatformFeeCents } from "../../../supabase/functions/_shared/platformFee";
import { formatFeeShort, type PlatformFeeValue } from "../lib/platformFeeDisplay";
import {
  ink,
  inkSoft,
  inkMuted,
  rule,
  courtBlue,
  panelStyle,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
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
  errorAt = null,
  savedAt = null,
  onSave,
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
  // When the refusal happened. Two identical refusals are two events — key
  // the pull on the attempt, or the second one lands below the fold in
  // silence, and the commonest real refusal repeats its words exactly.
  errorAt?: number | null;
  savedAt?: string | null;
  // null clears the override and goes back to inheriting.
  onSave: (next: PlatformFeeValue) => void;
}) {
  const canInherit = inheritLabel !== undefined;
  // "custom" vs "inherit" is the first choice, so the two number fields only
  // matter once the answer is "custom" — progressive disclosure rather than
  // two inputs whose meaning depends on an empty value.
  const [mode, setMode] = useState<"inherit" | "custom">(
    value === null && canInherit ? "inherit" : "custom",
  );
  // A save's confirmation says the fee on screen is the one that will be
  // charged. Edit the fields afterwards and that stops being true, so the
  // first keystroke retires it.
  const [touched, setTouched] = useState(false);
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
                onClick={() => {
                  setTouched(true);
                  setMode(m);
                }}
                style={{
                  ...choiceTileStyle,
                  background: active ? "#eff6ff" : "#fff",
                  // Inactive border is inkMuted, not the tile pattern's
                  // #d1d5db: a control's resting edge needs 3:1 against the
                  // surface behind it (D-0157) and #d1d5db on white is 1.5:1.
                  borderColor: active ? "#2563eb" : inkMuted,
                  borderWidth: active ? 2 : 1,
                  // Keep the text in the same place whichever tile is chosen:
                  // the second border pixel comes out of the padding.
                  padding: active ? "9px 11px" : "10px 12px",
                  fontWeight: active ? 600 : 500,
                  color: active ? "#1e40af" : ink,
                }}
              >
                {/* Which tile is chosen must survive greyscale and
                    colour-blindness, so the tick — not the blue — is what
                    carries it (D-0157: never meaning by colour alone).
                    Darkening the inactive border to inkMuted for the
                    resting-edge floor left the two blues 1.07:1 apart. */}
                <span style={tileInnerStyle}>
                  <span style={tileGlyphSlotStyle} aria-hidden="true">
                    {active && <Check size={16} strokeWidth={3} />}
                  </span>
                  <span>{m === "inherit" ? `Use ${inheritLabel}` : "Set a custom fee"}</span>
                </span>
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
                onChange={(e) => {
                  setTouched(true);
                  setPercentStr(e.target.value);
                }}
                style={{
                  ...inputStyle,
                  minHeight: 44,
                  // Explicit, never undefined: React writes "" for an
                  // undefined value, which strips inputStyle's border
                  // shorthand and leaves the browser's default grey.
                  borderColor: percentValid ? rule : dangerFg,
                }}
              />
              <span style={{ fontSize: 14, color: inkSoft }}>%</span>
            </div>
            {!percentValid && (
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
                onChange={(e) => {
                  setTouched(true);
                  setFixedStr(e.target.value);
                }}
                style={{
                  ...inputStyle,
                  minHeight: 44,
                  borderColor: fixedValid ? rule : dangerFg,
                }}
              />
            </div>
            {!fixedValid && (
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
            <span style={{ color: inkSoft, fontSize: 12 }}>
              {" "}
              ({formatFeeShort(previewBps, previewFixed)})
            </span>
          )}
        </div>
        {/* inkSoft, not inkMuted: this sits on the cream panel, where
            inkMuted measures 4.20:1 — under the 4.5:1 floor — and this line
            is the only place the page says what the organizer keeps. */}
        <div style={{ fontSize: 12, color: inkSoft, marginTop: 4 }}>
          Organizer receives {previewKnown ? `$${((SAMPLE_CENTS - feeCents) / 100).toFixed(2)}` : "—"}
        </div>
      </div>

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
          {saving ? "Saving…" : mode === "inherit" && canInherit ? `Use ${inheritLabel}` : "Save fee"}
        </button>
        {/* No Cancel here: a row already carries "Close" in its header, and
            two verbs 300px apart doing one thing makes a reader check. */}
      </div>

      {/* Both panels sit BELOW the button — rendered above, a confirmation
          pushed the page's only button off the bottom of a 390x844 screen the
          moment it appeared — and ResultPanel pulls itself into view, because
          below the button on a phone IS below the fold. Position alone fixed
          one of those two and caused the other. */}
      {error && (
        <ResultPanel tone="danger" pullKey={`${idPrefix}-err-${errorAt}`}>
          {error}
        </ResultPanel>
      )}
      {savedAt && !touched && (
        <ResultPanel tone="success" pullKey={`${idPrefix}-ok-${savedAt}`}>
          Saved — this fee applies to the next registration taken.
        </ResultPanel>
      )}
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

// A save's outcome, which pulls itself into view when it appears.
//
// Panels sit below the save button so they cannot push it off screen — but
// on a 390x844 phone the button is already near the fold, so "below the
// button" lands below it: a successful default save rendered at 845-913 in
// an 844 viewport, leaving the screen byte-identical to before the tap, and
// a REFUSED one at 845-955. A result nobody sees is worse on the refusal
// path than on the success path, because unchanged-looking reads as fine.
//
// `block: "nearest"` is the whole point: a panel already in view does not
// move the page (no scroll yanked out from under the reader), and one below
// the fold is brought up by the minimum needed. The scroll margin is what
// stops "the minimum" being flush against the bottom edge, and it is sized
// to carry the audit line that follows the panel, not just the panel.
//
// `pullKey` is what keeps the page still the rest of the time. A panel
// re-mounts for reasons that are NOT the reader asking for anything —
// clearing the organizer search re-renders the list, switching tabs and
// back rebuilds it — and scrolling on each of those moves the page under
// someone who did not act. One pull per key, remembered across remounts, so
// the scroll belongs to the save and nothing else.
const pulled = new Set<string>();

export function ResultPanel({
  tone,
  pullKey,
  children,
}: {
  tone: "success" | "danger";
  // Identifies the save this panel is reporting. Omit it and the panel never
  // moves the page.
  pullKey?: string;
  children: ReactNode;
}) {
  const pull = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !pullKey || pulled.has(pullKey)) return;
      pulled.add(pullKey);
      // Deferred: a ref callback runs during the commit, before the browser
      // has laid the page out, and the scroll is a silent no-op there —
      // measured scrollY 0 with the panel at 845 in an 844 viewport. A
      // timeout rather than requestAnimationFrame, because rAF does not fire
      // in a background tab and the result would be left off-screen for
      // whoever comes back to it.
      setTimeout(() => {
        // "auto", not "smooth": a smooth scroll is an ANIMATION, and the
        // re-render after a save cancelled it — the success panel scrolled
        // and the failure panel, one render further along, did not, which is
        // the one that must never be missed.
        node.scrollIntoView({ block: "nearest", behavior: "auto" });
      }, 0);
    },
    [pullKey],
  );
  return (
    <div
      ref={pull}
      // A refusal interrupts; a confirmation does not. The rest of this
      // repo's save errors are alerts, and this one is no different.
      role={tone === "danger" ? "alert" : "status"}
      aria-live={tone === "danger" ? "assertive" : "polite"}
      style={{
        ...statusPanelStyle(tone),
        marginTop: 12,
        fontSize: 13,
        // Deep enough to carry the "Last saved … by …" line that follows the
        // panel on the default tab; at 24 it left that line 5px under.
        scrollMarginBlock: 56,
      }}
    >
      {children}
    </div>
  );
}

// A fixed slot for the tick so the two tiles' labels line up whether or not
// the tile is the chosen one.
const tileInnerStyle = {
  display: "flex" as const,
  alignItems: "flex-start" as const,
  gap: 6,
};

const tileGlyphSlotStyle = {
  width: 16,
  flexShrink: 0,
  display: "inline-flex" as const,
  alignItems: "center" as const,
  height: 18,
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
