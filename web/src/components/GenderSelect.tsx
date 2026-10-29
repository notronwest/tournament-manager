// The one list of gender options (#1183, D-0049).
//
// Lifted verbatim out of ProfilePage, which had it inline, and out of the
// organizer's PlayerDetailPage, which had the same four options copied. A
// guardian setting a child's gender is the third place that needs it, and a
// third copy is the defect the reuse gate rejects.
//
// Only the <select> is shared, not a label: the profile pages mount it inside
// `Field` and the family row labels it for one named child, so the wrapper is
// the host's business and the option list is this file's.
//
// "" is the UI's "unset" and the column's null. Gender is optional by design
// — only a men's or women's bracket ever reads it (lib/eligibility.ts) — so
// the blank option is a real answer, not a prompt to fill something in.
import type { CSSProperties } from "react";
import type { Database } from "../types/supabase";
import { inputStyle } from "../lib/publicTheme";

export type PlayerGender = Database["public"]["Enums"]["player_gender"];

export function GenderSelect({
  value,
  onChange,
  disabled = false,
  id,
  ariaLabel,
  style,
}: {
  value: PlayerGender | "";
  onChange: (v: PlayerGender | "") => void;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  // Merged over the public input style, for the admin pages which have their
  // own field metrics. The option list is what is shared here; the box it
  // sits in belongs to the screen around it.
  style?: CSSProperties;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value as PlayerGender | "")}
      style={style ? { ...inputStyle, ...style } : inputStyle}
      disabled={disabled}
    >
      <option value="">—</option>
      <option value="M">Male</option>
      <option value="F">Female</option>
      <option value="X">Other / prefer not to say</option>
    </select>
  );
}
