import type { CSSProperties } from "react";
import {
  ink,
  rule,
  courtBlue,
  dangerBg,
  dangerFg,
  bodyFontStack,
} from "../lib/publicTheme";

// Segmented self-rating picker: discrete skill-level chips (2.5–5.0) instead of
// a free-text number box. Used on the profile screen and the registration
// rating gate so the two share one control + one scale.
//
// - Optional by design: clicking the selected chip again clears it (→ null).
// - Preserves an off-scale saved value (e.g. a legacy 3.7) by injecting it into
//   the scale so switching to chips never silently drops or rounds a rating.
// - When min/max are passed (an event's eligibility range), a selected chip
//   outside the range renders in a "warning" style so the player can see their
//   rating won't qualify for that event.
export const RATING_SCALE = [2.5, 3.0, 3.5, 4.0, 4.5, 5.0] as const;

export function RatingPicker({
  value,
  onChange,
  disabled = false,
  min = null,
  max = null,
  size = "md",
  ariaLabel,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  // Optional eligibility range — a selected chip outside it is flagged.
  min?: number | null;
  max?: number | null;
  size?: "sm" | "md";
  ariaLabel?: string;
}) {
  const scale: number[] =
    value != null && !RATING_SCALE.includes(value as (typeof RATING_SCALE)[number])
      ? [...RATING_SCALE, value].sort((a, b) => a - b)
      : [...RATING_SCALE];

  const dim = size === "sm" ? 40 : 46;
  const fontSize = size === "sm" ? 13.5 : 15;

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel ?? "Self-rating"}
      style={{ display: "flex", gap: 7, flexWrap: "wrap", fontFamily: bodyFontStack }}
    >
      {scale.map((v) => {
        const selected = value === v;
        const outOfRange =
          selected &&
          ((min != null && v < min) || (max != null && v > max));
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(selected ? null : v)}
            style={chipStyle(selected, !!outOfRange, disabled, dim, fontSize)}
          >
            {v.toFixed(1)}
          </button>
        );
      })}
    </div>
  );
}

function chipStyle(
  selected: boolean,
  outOfRange: boolean,
  disabled: boolean,
  dim: number,
  fontSize: number,
): CSSProperties {
  const base: CSSProperties = {
    minWidth: dim,
    height: dim,
    padding: "0 10px",
    border: `1.5px solid ${rule}`,
    borderRadius: 9,
    background: "#fff",
    color: ink,
    fontSize,
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
    fontFamily: "inherit",
    transition: "background .12s, border-color .12s, color .12s",
  };
  if (outOfRange) {
    return { ...base, background: dangerBg, borderColor: "#f3c3b8", color: dangerFg };
  }
  if (selected) {
    return { ...base, background: courtBlue, borderColor: courtBlue, color: "#fff" };
  }
  return base;
}

