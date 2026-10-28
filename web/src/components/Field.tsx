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
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 12,
        color: inkSoft,
        flex: "1 1 160px",
        minWidth: 0,
      }}
    >
      <span>
        {label}
        {required && <span style={{ color: courtRed, marginLeft: 4 }}>*</span>}
      </span>
      {children}
    </label>
  );
}

export function FieldRow({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>{children}</div>
  );
}
