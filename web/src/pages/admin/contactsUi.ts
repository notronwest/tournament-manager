import { type CSSProperties } from "react";
import {
  ink,
  inkSoft,
  inkMuted,
  rule,
  bodyFontStack,
  headingFontStack,
  displayFontStack,
} from "../../lib/publicTheme";

// Shared constants + helpers between the Contacts (management) and Email
// (compose + history) admin pages, which were split out of a single overloaded
// screen. Components live in their own files (react-refresh wants component-only
// modules), so this file stays JSX-free.

// Lightweight email shape check (mirrors the edge functions' server-side guard).
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const displayHeading: CSSProperties = {
  fontFamily: displayFontStack,
  fontSize: "clamp(24px, 3.5vw, 32px)",
  lineHeight: 1.1,
  margin: "0 0 6px",
};

export const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 11,
  color: inkMuted,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  fontWeight: 600,
  fontFamily: headingFontStack,
  whiteSpace: "nowrap",
};

export const tdStyle: CSSProperties = {
  padding: "10px 12px",
  verticalAlign: "middle",
};

export const fieldLabel: CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: inkSoft,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  marginBottom: 6,
};

export const unsubPill: CSSProperties = {
  display: "inline-block",
  marginLeft: 8,
  background: "#fdeae6",
  color: "#9c2412",
  fontSize: 10,
  fontWeight: 600,
  padding: "1px 6px",
  borderRadius: 999,
};

// Segmented toggle button (Plain-text / HTML, and reused for the Email tabs).
export function modeBtnStyle(active: boolean): CSSProperties {
  return {
    padding: "4px 11px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 5,
    cursor: "pointer",
    fontFamily: bodyFontStack,
    border: `1px solid ${active ? ink : rule}`,
    background: active ? ink : "transparent",
    color: active ? "#ffffff" : inkSoft,
  };
}

// Unwrap a supabase FunctionsError — the edge function's JSON body is on
// err.context as a Response.
export async function readFnError(err: unknown): Promise<string> {
  const ctx = (err as { context?: Response })?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const b = (await ctx.json()) as { error?: string };
      if (b?.error) return b.error;
    } catch {
      /* fall through */
    }
  }
  return (err as { message?: string })?.message ?? "Something went wrong.";
}
