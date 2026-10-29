// The three self-rating pickers, as one group (#1183, D-0049).
//
// ONE implementation, mounted three ways:
//
//   * variant="page"   — the "Self-reported rating" block a player fills in
//     for themselves on their profile, and the same block on the organizer's
//     player detail page.
//   * variant="inline" — the per-child editor on My family, where the group
//     sits inside a row that already names the child, so the heading would
//     repeat what the row says.
//
// The chips are the same size in both: the smaller size RatingPicker offers
// is 40px tall, under the 44px tap target this stack treats as a hard rule,
// and a form a parent fills in on a phone is the last place to shave it.
//
// Three hand-rolled copies of the heading + three labels + three pickers is
// what this replaces; the row-label style existed twice with identical
// bodies. RatingPicker itself was already shared — it is the group around it
// that kept being rebuilt.
import type { CSSProperties } from "react";
import { RatingPicker } from "./RatingPicker";
import { ink, inkMuted, inkSoft } from "../lib/publicTheme";
import {
  FORMAT_LABEL,
  FORMAT_SHORT,
  RATING_FORMATS,
  type RatingFormat,
  type RatingValues,
} from "../lib/selfRatings";

export function RatingFields({
  values,
  onChange,
  disabled = false,
  variant = "page",
  ownerName,
}: {
  values: RatingValues;
  onChange: (format: RatingFormat, value: number | null) => void;
  disabled?: boolean;
  variant?: "page" | "inline";
  // Whose rating this is. A parent with three children on one screen needs
  // "Ivy: doubles self-rating", not three controls all named the same.
  ownerName?: string;
}) {
  const inline = variant === "inline";
  return (
    <div>
      {!inline && (
        <div style={{ fontSize: 13, color: ink, marginBottom: 4 }}>
          <strong>Self-reported rating</strong>{" "}
          <span style={{ color: inkMuted }}>
            (optional — helps organizers seed brackets; tap a level, tap again
            to clear)
          </span>
        </div>
      )}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: inline ? 12 : 16,
          marginTop: inline ? 0 : 8,
        }}
      >
        {RATING_FORMATS.map((f) => (
          <div key={f}>
            <div style={rowLabelStyle}>{FORMAT_LABEL[f]}</div>
            <RatingPicker
              value={values[f]}
              onChange={(v) => onChange(f, v)}
              disabled={disabled}
              fill={inline}
              ariaLabel={
                ownerName
                  ? `${ownerName}: ${FORMAT_SHORT[f]} self-rating`
                  : `${FORMAT_SHORT[f]} self-rating`
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}

const rowLabelStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: inkSoft,
  marginBottom: 8,
};
