import { useState, type CSSProperties, type ReactNode } from "react";
import {
  BRACKET_WIZARD_STEPS,
  type BracketWizardStepId,
  type StepGate,
} from "../../lib/bracketWizard";
import {
  ink,
  inkSoft,
  inkMuted,
  bg,
  cream,
  rule,
  ruleSoft,
  courtGreen,
  courtBlue,
  courtRed,
  warnBg,
  warnFg,
  bodyFontStack,
  headingFontStack,
} from "../../lib/publicTheme";

// One step's live view: the content to render and whether the director
// may advance past it. `content` is supplied by EventConsolePage, which
// wires each step to the EXISTING section component / handler it wraps —
// this shell never touches the data model itself.
export type BracketWizardStepView = {
  id: BracketWizardStepId;
  content: ReactNode;
  // Can the director leave this step? Blocked steps disable Next and
  // show the reason inline. The terminal step ("start") ignores this —
  // its primary button is the Start action, gated by onStart itself.
  gate: StepGate;
};

// Standalone Bracket Setup wizard. Mirrors the tournament-creation
// wizard's UX (numbered stepper, Back/Next, per-step validation, a
// terminal review+action) but laid out mobile-first — a director runs
// this on a phone courtside (#500), so the stepper is a horizontal,
// wrapping strip above a single-column pane rather than a fixed side
// rail.
//
// It launches over the Event Console and reuses that page's own
// sections and handlers for every step (teams / settings / generate /
// mark-ready / start) — it consolidates the path, it does not
// reimplement it.
export function BracketSetupWizard({
  eventName,
  steps,
  onClose,
  onStart,
  starting,
  startDisabledReason,
}: {
  eventName: string;
  steps: BracketWizardStepView[];
  onClose: () => void;
  // Terminal action — starts the event (status → active) with the
  // check-in gate. Owned by EventConsolePage; the wizard just calls it.
  onStart: () => void;
  starting: boolean;
  // Non-null → the Start button is disabled (e.g. no bracket yet).
  startDisabledReason?: string | null;
}) {
  const [index, setIndex] = useState(0);
  const gateById = new Map(steps.map((s) => [s.id, s.gate]));

  const stepMeta = BRACKET_WIZARD_STEPS[index];
  const stepView = steps.find((s) => s.id === stepMeta.id);
  const currentGate = stepView?.gate ?? { ok: true };
  const isLast = index === BRACKET_WIZARD_STEPS.length - 1;

  // A step is reachable only if every earlier step is clear — a blocked
  // step locks everything after it, so the director can't skip the
  // precondition (e.g. jump to Build before teams are confirmed).
  const reachable = (target: number): boolean => {
    for (let i = 0; i < target; i++) {
      const g = gateById.get(BRACKET_WIZARD_STEPS[i].id);
      if (g && !g.ok) return false;
    }
    return true;
  };

  const goNext = () => {
    if (currentGate.ok && !isLast) setIndex((i) => i + 1);
  };
  const goBack = () => setIndex((i) => Math.max(0, i - 1));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Set up & start — ${eventName}`}
      style={overlayStyle}
      onClick={onClose}
    >
      <div style={sheetStyle} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={{ minWidth: 0 }}>
            <div style={eyebrowStyle}>Set up &amp; start</div>
            <div style={titleStyle}>{eventName}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={closeBtnStyle}
          >
            ✕
          </button>
        </div>

        {/* Stepper — horizontal, wraps on narrow screens */}
        <ol style={stepperStyle}>
          {BRACKET_WIZARD_STEPS.map((s, i) => {
            const state =
              i < index ? "done" : i === index ? "active" : "todo";
            const canJump = i <= index || reachable(i);
            return (
              <li key={s.id} style={{ display: "contents" }}>
                <button
                  type="button"
                  disabled={!canJump}
                  onClick={() => canJump && setIndex(i)}
                  title={!canJump ? "Finish the earlier steps first." : s.title}
                  style={{
                    ...stepPillStyle(state),
                    opacity: canJump ? 1 : 0.4,
                    cursor: canJump ? "pointer" : "not-allowed",
                  }}
                >
                  <span style={pillNumStyle(state)}>
                    {state === "done" ? "✓" : i + 1}
                  </span>
                  <span style={pillLabelStyle(state)}>{s.title}</span>
                </button>
              </li>
            );
          })}
        </ol>

        {/* Pane */}
        <div style={paneStyle}>
          <h2 style={stepHeadingStyle}>{stepMeta.title}</h2>
          <p style={stepBlurbStyle}>{stepMeta.blurb}</p>
          <div style={{ marginTop: 6 }}>{stepView?.content}</div>

          {!currentGate.ok && (
            <div role="status" style={blockerStyle}>
              🔒 {currentGate.reason}
            </div>
          )}
        </div>

        {/* Action bar */}
        <div style={actionBarStyle}>
          <button
            type="button"
            onClick={goBack}
            disabled={index === 0 || starting}
            style={btnGhost}
          >
            ← Back
          </button>
          <div style={{ flex: 1 }} />
          {isLast ? (
            <button
              type="button"
              onClick={onStart}
              disabled={starting || !!startDisabledReason}
              title={startDisabledReason ?? undefined}
              style={btnPrimary(starting || !!startDisabledReason)}
            >
              {starting ? "Starting…" : "Start event"}
            </button>
          ) : (
            <button
              type="button"
              onClick={goNext}
              disabled={!currentGate.ok}
              title={currentGate.ok ? undefined : currentGate.reason}
              style={btnPrimary(!currentGate.ok)}
            >
              Next →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Styles — mobile-first (single column, wrapping stepper). Reuses the
// app's publicTheme tokens so the wizard reads as native chrome.
// ─────────────────────────────────────────────────────────────────────

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(20, 24, 31, 0.55)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: 16,
  overflowY: "auto",
  // Below ConfirmModal (zIndex 1000) so the check-in gate + the build
  // step's own confirm dialogs stack above the wizard sheet.
  zIndex: 900,
};

const sheetStyle: CSSProperties = {
  background: "#ffffff",
  border: `1px solid ${rule}`,
  borderRadius: 12,
  width: "100%",
  maxWidth: 640,
  margin: "24px 0",
  display: "flex",
  flexDirection: "column",
  fontFamily: bodyFontStack,
  boxShadow: "0 12px 40px rgba(20,24,31,0.25)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
  padding: "16px 18px",
  borderBottom: `1px solid ${ruleSoft}`,
};

const eyebrowStyle: CSSProperties = {
  fontSize: 11,
  color: inkMuted,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  fontWeight: 600,
};

const titleStyle: CSSProperties = {
  fontSize: 17,
  fontWeight: 700,
  color: ink,
  marginTop: 2,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const closeBtnStyle: CSSProperties = {
  flexShrink: 0,
  width: 32,
  height: 32,
  borderRadius: 6,
  border: `1px solid ${rule}`,
  background: bg,
  color: inkSoft,
  fontSize: 14,
  cursor: "pointer",
  lineHeight: 1,
};

const stepperStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: "12px 18px",
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  borderBottom: `1px solid ${ruleSoft}`,
  background: bg,
};

function stepPillStyle(state: "done" | "active" | "todo"): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 10px 5px 5px",
    borderRadius: 999,
    border: `1px solid ${state === "active" ? courtBlue : rule}`,
    background: state === "active" ? "#ffffff" : "transparent",
    fontFamily: bodyFontStack,
  };
}

function pillNumStyle(state: "done" | "active" | "todo"): CSSProperties {
  return {
    width: 20,
    height: 20,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 11,
    fontWeight: 700,
    flexShrink: 0,
    background:
      state === "done" ? courtGreen : state === "active" ? courtBlue : rule,
    color: state === "todo" ? inkMuted : "#ffffff",
  };
}

function pillLabelStyle(state: "done" | "active" | "todo"): CSSProperties {
  return {
    fontSize: 12.5,
    fontWeight: state === "active" ? 700 : 500,
    color: state === "todo" ? inkMuted : ink,
    whiteSpace: "nowrap",
  };
}

const paneStyle: CSSProperties = {
  padding: "18px",
  minHeight: 220,
};

const stepHeadingStyle: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 700,
  color: ink,
  fontFamily: headingFontStack,
  textTransform: "uppercase",
  letterSpacing: "0.03em",
};

const stepBlurbStyle: CSSProperties = {
  margin: "4px 0 0",
  fontSize: 13.5,
  color: inkSoft,
  lineHeight: 1.5,
};

const blockerStyle: CSSProperties = {
  marginTop: 14,
  padding: "9px 11px",
  background: warnBg,
  border: `1px solid ${warnFg}`,
  borderRadius: 6,
  fontSize: 12.5,
  color: warnFg,
  lineHeight: 1.5,
};

const actionBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "14px 18px",
  borderTop: `1px solid ${ruleSoft}`,
  position: "sticky",
  bottom: 0,
  background: "#ffffff",
  borderBottomLeftRadius: 12,
  borderBottomRightRadius: 12,
};

const btnGhost: CSSProperties = {
  padding: "10px 18px",
  background: "transparent",
  color: inkSoft,
  border: `1px solid ${rule}`,
  borderRadius: 8,
  fontSize: 14,
  cursor: "pointer",
  fontFamily: bodyFontStack,
};

function btnPrimary(disabled: boolean): CSSProperties {
  return {
    padding: "10px 22px",
    background: disabled ? inkMuted : ink,
    color: cream,
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: headingFontStack,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
  };
}

// Small helper EventConsolePage uses to render a plain review row in the
// final step. Exported so the review summary reads consistently with the
// rest of the wizard.
export function WizardReviewRow({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 16,
        padding: "8px 0",
        borderBottom: `1px solid ${ruleSoft}`,
        fontSize: 13.5,
      }}
    >
      <span style={{ color: inkMuted }}>{label}</span>
      <span
        style={{
          color: warn ? courtRed : ink,
          fontWeight: 600,
          textAlign: "right",
        }}
      >
        {value}
      </span>
    </div>
  );
}
