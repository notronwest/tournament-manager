// A labelled form field, and the row that lays a couple of them side by side.
//
// Lifted verbatim out of ProfilePage so AddChildForm can render the same
// fields in both places it is mounted (D-0049 — one implementation, not a
// copy per host). Several admin pages still carry their own near-identical
// Field; those predate this file and are left alone, since dragging them in
// would turn a focused change into a sweep. This is the pair the public
// pages share.
import type { ReactNode } from "react";
import { courtRed, inkSoft } from "../lib/publicTheme";

export function Field({
  label,
  required,
  htmlFor,
  children,
}: {
  label: string;
  required?: boolean;
  // Switches from a wrapping <label> to an explicit label/control pair.
  // Needed whenever the field holds a SECOND interactive control beside the
  // input — a wrapping label labels every labelable control inside it, so the
  // input's accessible name silently swallows that control's text and the
  // helper paragraph with it. Pass the input's own id.
  htmlFor?: string;
  children: ReactNode;
}) {
  const boxStyle = {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
    fontSize: 12,
    color: inkSoft,
    flex: "1 1 160px",
    minWidth: 0,
  };
  const labelText = (
    <>
      {label}
      {required && <span style={{ color: courtRed, marginLeft: 4 }}>*</span>}
    </>
  );

  if (htmlFor) {
    return (
      <div style={boxStyle}>
        <label htmlFor={htmlFor}>{labelText}</label>
        {children}
      </div>
    );
  }

  return (
    <label style={boxStyle}>
      <span>{labelText}</span>
      {children}
    </label>
  );
}

export function FieldRow({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>{children}</div>
  );
}
