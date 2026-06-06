import { type CSSProperties } from "react";
import {
  defaultTiersForPattern,
  makeEmptyTierDraft,
  type PricingPattern,
  type TierDraft,
} from "../lib/pricingTiers";
import { formatUsd } from "../lib/pricing";

// Controlled pricing editor. The parent (TournamentFormPage) owns
// `pattern` + `tiers` state; this component renders the four-pattern
// picker and the active pattern's tier rows, emitting changes via
// onChange. Mirrors mockups/tournament-creation-flow.html Step 3
// (variants 4a–4d), adapted to the app's inline-style conventions.
//
// One concept, two surfaces: the tier dates the organizer sets here
// drive both the dollar amount a player pays AND (eventually) the
// public lifecycle status pill. See the backlog item "Tournament
// lifecycle statuses + early-bird / late pricing windows."

type PatternMeta = {
  value: PricingPattern;
  title: string;
  desc: string;
};

const PATTERNS: PatternMeta[] = [
  {
    value: "single",
    title: "Single price",
    desc: "One flat price for everyone. No dates.",
  },
  {
    value: "early_bird",
    title: "Early bird",
    desc: "Discount up to a date, regular after.",
  },
  {
    value: "early_bird_plus_late",
    title: "Early bird + Late fee",
    desc: "Three windows — early, regular, late surcharge.",
  },
  {
    value: "custom",
    title: "Custom…",
    desc: "Any number of tiers with your own labels & dates.",
  },
];

export function PricingTiersEditor({
  pattern,
  tiers,
  activeRegCount = 0,
  onChange,
}: {
  pattern: PricingPattern;
  tiers: TierDraft[];
  // Paid + pending_payment registrations for this tournament. When > 0
  // the editor is locked — no pricing changes are allowed until those
  // registrations are cancelled/refunded.
  activeRegCount?: number;
  onChange: (pattern: PricingPattern, tiers: TierDraft[]) => void;
}) {
  const locked = activeRegCount > 0;
  const isCustom = pattern === "custom";
  const isSingle = pattern === "single";

  const pickPattern = (next: PricingPattern) => {
    if (locked || next === pattern) return;
    onChange(next, defaultTiersForPattern(next, tiers));
  };

  const updateTier = (key: string, patch: Partial<TierDraft>) => {
    if (locked) return;
    onChange(
      pattern,
      tiers.map((t) => (t.key === key ? { ...t, ...patch } : t)),
    );
  };

  const addTier = () => {
    if (locked) return;
    onChange(pattern, [
      ...tiers,
      makeEmptyTierDraft(`Tier ${tiers.length + 1}`),
    ]);
  };

  const removeTier = (key: string) => {
    if (locked) return;
    const remaining = tiers.filter((t) => t.key !== key);
    // Removing down to a single tier collapses to the Single-price
    // pattern rather than leaving "Custom with one tier" — there's
    // no date to set with one tier, so the distinction is moot.
    if (remaining.length <= 1) {
      const sole = remaining[0] ?? makeEmptyTierDraft("Standard");
      onChange("single", [{ ...sole, label: "Standard", endsOn: "" }]);
      return;
    }
    onChange("custom", remaining);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={labelStyle}>Pricing</div>
        {!locked && (
          <p style={ledeStyle}>
            Pick how pricing should change as the tournament gets closer.
            Most organizers either use a single price or offer an
            early-bird discount to reward people who commit early.
          </p>
        )}
      </div>

      {locked && (
        <div style={lockedNoticeStyle}>
          <strong>
            {activeRegCount === 1
              ? "1 player registered"
              : `${activeRegCount} players registered`}
            {" — pricing is locked."}
          </strong>{" "}
          Cancel + refund affected players from the attendees view first.
        </div>
      )}

      {/* Pattern picker */}
      <div style={patternGridStyle}>
        {PATTERNS.map((p) => {
          const selected = p.value === pattern;
          return (
            <button
              type="button"
              key={p.value}
              onClick={() => pickPattern(p.value)}
              disabled={locked}
              style={patternCardStyle(selected, locked)}
              aria-pressed={selected}
            >
              <span style={patternTitleStyle}>
                <span style={radioDotStyle(selected)} />
                {p.title}
              </span>
              <span style={patternDescStyle}>{p.desc}</span>
            </button>
          );
        })}
      </div>

      {isCustom && !locked && (
        <div style={warnHintStyle}>
          <strong>Heads-up: most organizers don't need Custom.</strong>{" "}
          It's the escape hatch for unusual cases — members-only
          pre-sale, multi-stage discounts. If a preset fits, use it:
          the public page shows cleaner status labels ("Early bird
          ends in 4 days") that match what players expect.
        </div>
      )}

      {/* Tier rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {tiers.map((tier, i) => {
          const isLast = i === tiers.length - 1;
          return (
            <div key={tier.key} style={tierRowStyle}>
              <div style={tierHeaderStyle}>
                {isCustom ? (
                  <input
                    type="text"
                    value={tier.label}
                    readOnly={locked}
                    onChange={(e) =>
                      updateTier(tier.key, { label: e.target.value })
                    }
                    placeholder={`Tier ${i + 1}`}
                    style={locked ? { ...tierLabelInputStyle, ...lockedInputStyle } : tierLabelInputStyle}
                  />
                ) : (
                  <div style={tierLabelStyle}>
                    {isSingle ? "Price" : `Tier ${i + 1} — ${tier.label}`}
                  </div>
                )}

                {/* Date window — only when there's more than one tier,
                    and never on the last (open-ended) tier. */}
                {!isSingle && !isLast && (
                  <div style={tierWindowStyle}>
                    <span>Through</span>
                    <input
                      type="date"
                      value={tier.endsOn}
                      readOnly={locked}
                      onChange={(e) =>
                        updateTier(tier.key, { endsOn: e.target.value })
                      }
                      style={locked ? { ...dateInputStyle, ...lockedInputStyle } : dateInputStyle}
                    />
                  </div>
                )}
                {!isSingle && isLast && (
                  <div style={tierWindowMutedStyle}>
                    Until registration closes
                  </div>
                )}

                {isCustom && tiers.length > 1 && !locked && (
                  <button
                    type="button"
                    onClick={() => removeTier(tier.key)}
                    style={removeBtnStyle}
                  >
                    × Remove
                  </button>
                )}
              </div>

              <div style={feeGridStyle}>
                <label style={feeFieldStyle}>
                  <span>First-event fee (USD)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={tier.firstEventFeeDollars}
                    readOnly={locked}
                    onChange={(e) =>
                      updateTier(tier.key, {
                        firstEventFeeDollars: e.target.value,
                      })
                    }
                    style={locked ? { ...feeInputStyle, ...lockedInputStyle } : feeInputStyle}
                  />
                </label>
                <label style={feeFieldStyle}>
                  <span>Each additional event (USD)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={tier.additionalEventFeeDollars}
                    readOnly={locked}
                    onChange={(e) =>
                      updateTier(tier.key, {
                        additionalEventFeeDollars: e.target.value,
                      })
                    }
                    style={locked ? { ...feeInputStyle, ...lockedInputStyle } : feeInputStyle}
                  />
                </label>
              </div>
            </div>
          );
        })}
      </div>

      {isCustom && !locked && (
        <button type="button" onClick={addTier} style={addTierBtnStyle}>
          + Add another tier
        </button>
      )}

      {/* Preview math */}
      <PreviewMath tiers={tiers} isSingle={isSingle} />
    </div>
  );
}

// Live preview: what a 1 / 2 / 3-event registrant pays under each
// tier. Catches the classic misconfiguration (additional fee set as
// a flat per-event price rather than a surcharge) before publish.
function PreviewMath({
  tiers,
  isSingle,
}: {
  tiers: TierDraft[];
  isSingle: boolean;
}) {
  const dollars = (s: string) => {
    const n = parseFloat(s || "0");
    return Number.isNaN(n) ? 0 : n;
  };
  const hasAnyFee = tiers.some(
    (t) => dollars(t.firstEventFeeDollars) > 0 || dollars(t.additionalEventFeeDollars) > 0,
  );
  if (!hasAnyFee) {
    return (
      <div style={previewBoxStyle}>
        <div style={previewLabelStyle}>Preview math</div>
        <div style={{ color: "#166534" }}>
          Free tournament — players pay nothing to register.
        </div>
      </div>
    );
  }
  return (
    <div style={previewBoxStyle}>
      <div style={previewLabelStyle}>Preview math</div>
      {tiers.map((t, i) => {
        const first = Math.round(dollars(t.firstEventFeeDollars) * 100);
        const add = Math.round(dollars(t.additionalEventFeeDollars) * 100);
        return (
          <div key={t.key}>
            {!isSingle && (
              <div style={previewTierDividerStyle}>
                {t.label.trim() || `Tier ${i + 1}`}:
              </div>
            )}
            <div style={previewRowStyle}>
              <span>1 event</span>
              <span>{formatUsd(first)}</span>
            </div>
            <div style={previewRowStyle}>
              <span>2 events</span>
              <span>{formatUsd(first + add)}</span>
            </div>
            <div style={previewRowStyle}>
              <span>3 events</span>
              <span>{formatUsd(first + add * 2)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── styles ──────────────────────────────────────────────────────────

const labelStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "#333",
  marginBottom: 4,
};
const ledeStyle: CSSProperties = {
  margin: 0,
  color: "#666",
  fontSize: 13,
  lineHeight: 1.55,
};

const patternGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 10,
};
function patternCardStyle(selected: boolean, locked: boolean): CSSProperties {
  return {
    background: locked ? "#f9fafb" : selected ? "#eff6ff" : "#fff",
    border: `2px solid ${locked ? "#e5e7eb" : selected ? "#2563eb" : "#e5e7eb"}`,
    borderRadius: 8,
    padding: 12,
    cursor: locked ? "not-allowed" : "pointer",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    textAlign: "left",
    fontFamily: "inherit",
    opacity: locked ? 0.7 : 1,
  };
}
const patternTitleStyle: CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  color: "#333",
  display: "flex",
  alignItems: "center",
  gap: 6,
};
const patternDescStyle: CSSProperties = {
  color: "#555",
  fontSize: 12,
  lineHeight: 1.5,
};
function radioDotStyle(selected: boolean): CSSProperties {
  return {
    width: 14,
    height: 14,
    borderRadius: "50%",
    border: `2px solid ${selected ? "#2563eb" : "#cbd5e1"}`,
    background: selected ? "#2563eb" : "#fff",
    boxShadow: selected ? "inset 0 0 0 3px #fff" : "none",
    flexShrink: 0,
    boxSizing: "border-box",
  };
}

const warnHintStyle: CSSProperties = {
  background: "#fffbeb",
  border: "1px solid #fde68a",
  borderRadius: 6,
  padding: "10px 12px",
  fontSize: 12,
  color: "#7a5d00",
  lineHeight: 1.55,
};

const lockedNoticeStyle: CSSProperties = {
  background: "#fef9c3",
  border: "1px solid #fde047",
  borderRadius: 6,
  padding: "10px 12px",
  fontSize: 13,
  color: "#713f12",
  lineHeight: 1.55,
};

const lockedInputStyle: CSSProperties = {
  background: "#f9fafb",
  color: "#6b7280",
  cursor: "not-allowed",
};

const tierRowStyle: CSSProperties = {
  background: "#fafafa",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 14,
};
const tierHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 12,
  gap: 10,
  flexWrap: "wrap",
};
const tierLabelStyle: CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  color: "#333",
};
const tierLabelInputStyle: CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: 4,
  padding: "4px 8px",
  fontSize: 13,
  fontWeight: 600,
  fontFamily: "inherit",
  color: "#333",
  background: "#fff",
  minWidth: 160,
};
const tierWindowStyle: CSSProperties = {
  fontSize: 12,
  color: "#666",
  display: "flex",
  alignItems: "center",
  gap: 6,
};
const tierWindowMutedStyle: CSSProperties = {
  fontSize: 12,
  color: "#999",
  fontStyle: "italic",
};
const dateInputStyle: CSSProperties = {
  padding: "4px 8px",
  border: "1px solid #d1d5db",
  borderRadius: 4,
  fontSize: 12,
  fontFamily: "inherit",
};
const removeBtnStyle: CSSProperties = {
  background: "transparent",
  border: "1px solid #fecaca",
  color: "#b91c1c",
  borderRadius: 4,
  padding: "3px 8px",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
};

const feeGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 16,
};
const feeFieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 13,
  color: "#555",
};
const feeInputStyle: CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box",
};

const addTierBtnStyle: CSSProperties = {
  width: "100%",
  background: "#fff",
  border: "1px dashed #d1d5db",
  color: "#2563eb",
  padding: 12,
  borderRadius: 8,
  textAlign: "center",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};

const previewBoxStyle: CSSProperties = {
  background: "#f0fdf4",
  border: "1px solid #bbf7d0",
  borderRadius: 8,
  padding: 14,
  fontSize: 13,
  color: "#166534",
};
const previewLabelStyle: CSSProperties = {
  fontWeight: 600,
  marginBottom: 4,
};
const previewRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  marginTop: 4,
};
const previewTierDividerStyle: CSSProperties = {
  marginTop: 12,
  paddingTop: 8,
  borderTop: "1px dashed #86efac",
  fontSize: 12,
  fontWeight: 500,
};
