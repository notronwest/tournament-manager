import type { CSSProperties } from "react";
import { formatUsd } from "../lib/pricing";

// Shared preset-chip + custom-amount donation input, used by both the
// standalone DonatePage (#377) and the checkout add-a-donation field (#946).
// Each caller owns its own amount state/validation and visual styling
// (colors, fonts) — this component only renders the chips/input and
// forwards interaction back to the caller.
export type DonationAmountPickerProps = {
  presetsCents: number[];
  selectedCents: number | null;
  usingCustom: boolean;
  onSelectPreset: (cents: number) => void;
  onToggleCustom: () => void;
  customValue: string;
  onCustomChange: (value: string) => void;
  customPlaceholder: string;
  customMin: string;
  customMax?: string;
  customMaxWidth: number;
  chipStyle: CSSProperties;
  chipActiveStyle: CSSProperties;
  inputStyle: CSSProperties;
  dollarSignStyle: CSSProperties;
};

export default function DonationAmountPicker({
  presetsCents,
  selectedCents,
  usingCustom,
  onSelectPreset,
  onToggleCustom,
  customValue,
  onCustomChange,
  customPlaceholder,
  customMin,
  customMax,
  customMaxWidth,
  chipStyle,
  chipActiveStyle,
  inputStyle,
  dollarSignStyle,
}: DonationAmountPickerProps) {
  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {presetsCents.map((c) => {
          const active = !usingCustom && selectedCents === c;
          return (
            <button
              key={c}
              type="button"
              onClick={() => onSelectPreset(c)}
              style={active ? chipActiveStyle : chipStyle}
            >
              {formatUsd(c)}
            </button>
          );
        })}
        <button
          type="button"
          onClick={onToggleCustom}
          style={usingCustom ? chipActiveStyle : chipStyle}
        >
          Custom
        </button>
      </div>
      {usingCustom && (
        <div
          style={{ marginTop: 10, position: "relative", maxWidth: customMaxWidth }}
        >
          <span style={dollarSignStyle}>$</span>
          <input
            type="number"
            inputMode="decimal"
            min={customMin}
            max={customMax}
            step="1"
            value={customValue}
            onChange={(e) => onCustomChange(e.target.value)}
            placeholder={customPlaceholder}
            style={{ ...inputStyle, paddingLeft: 24 }}
          />
        </div>
      )}
    </div>
  );
}
