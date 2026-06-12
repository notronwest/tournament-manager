import type { CSSProperties } from "react";

// ─────────────────────────────────────────────────────────────────────
// V5 public theme — extracted from HomePage.tsx so the rest of the
// public-facing pages (RegisterPage, CheckoutPage, PartnerAcceptPage,
// PublicTournamentPage…) can share the same visual language without
// each file re-declaring the same color / font constants.
//
// Tokens here are the SOURCE for the public layer. Admin pages still
// use src/tokens.css (the boring "tournament admin" palette). Public
// pages use this module instead — the brush wordmark, the cream/ink
// surfaces, the Alfa Slab display type, the Anton heading type.
// ─────────────────────────────────────────────────────────────────────

// ── Palette ──────────────────────────────────────────────────────────

export const ink = "#14181f";
export const inkSoft = "#4a5159";
export const inkMuted = "#6b7280";
export const bg = "#fafaf7";
export const cream = "#f6efd6";
export const creamDeep = "#ead9a3";
export const rule = "#e3dec8";
export const ruleSoft = "#ece6cf";

export const courtGreen = "#2c8a3d";
export const courtYellow = "#f3d111";
export const courtRed = "#d8341c";
export const courtBlue = "#1e6cd6";

// Status surfaces — built from the court palette so warnings/success
// don't suddenly drop us out of the V5 world the rest of the page
// lives in.
export const successBg = "#e8f4eb"; // soft court-green wash
export const successFg = "#1e6b2c";
export const dangerBg = "#fdeae6"; // soft court-red wash
export const dangerFg = "#9c2412";
export const warnBg = "#fef6d6"; // soft court-yellow wash
export const warnFg = "#8a6500";
// Info surface — built from courtBlue for completed/done-style states
export const infoBg = "#dceeff"; // soft courtBlue wash
export const infoBorder = "#9ec8f5"; // info panel border — between infoBg and courtBlue
export const infoFg = "#1651a8"; // deep courtBlue

// ── Type stacks ──────────────────────────────────────────────────────

export const bodyFontStack =
  `"Inter", system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
export const displayFontStack =
  `"Alfa Slab One", "Times New Roman", serif`;
export const headingFontStack =
  `"Anton", "Impact", "Arial Narrow", sans-serif`;
export const monoFontStack =
  `"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace`;

// ── Reusable style primitives ────────────────────────────────────────
//
// Use these to wrap pages and standard components so the public flow
// reads as one design system. Inline styles per project convention.

/**
 * Outer wrapper for any public page that isn't the homepage. Gives
 * the whole route the cream-tinted off-white background + Inter type.
 * Lives below the SiteHeader (which is now dark ink), so the contrast
 * is intentional: dark navbar → light content stage.
 */
export const pageWrapStyle: CSSProperties = {
  background: bg,
  color: ink,
  fontFamily: bodyFontStack,
  minHeight: "100vh",
};

/**
 * Inner container — the readable column. Use inside pageWrapStyle.
 * `maxWidth` defaults to 760 (forms), pass 1080 for browse-style
 * pages and 560 for narrow auth/accept screens.
 */
export function contentColStyle(maxWidth = 760): CSSProperties {
  return {
    maxWidth,
    margin: "0 auto",
    padding: "clamp(28px, 5vw, 48px) clamp(20px, 4vw, 32px) clamp(48px, 7vw, 72px)",
  };
}

/**
 * Big page title — Alfa Slab One display face. Matches the homepage
 * hero. Use once per page (the actual <h1>).
 */
export const pageH1Style: CSSProperties = {
  fontFamily: displayFontStack,
  fontSize: "clamp(28px, 4.5vw, 40px)",
  lineHeight: 1.05,
  letterSpacing: "-0.3px",
  margin: "0 0 12px",
};

/**
 * Section heading inside a page — Anton, tracked, uppercase. Smaller
 * than the homepage's section heads; sized for embedded use.
 */
export const sectionH2Style: CSSProperties = {
  fontFamily: headingFontStack,
  fontSize: 18,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  margin: "0 0 12px",
  color: ink,
};

/**
 * Subhead / supporting copy under the h1.
 */
export const pageSubStyle: CSSProperties = {
  fontSize: 15,
  color: inkSoft,
  margin: "0 0 24px",
  lineHeight: 1.55,
  maxWidth: 540,
};

/**
 * Plain text-link style for "back" / breadcrumb links above the title.
 */
export const breadcrumbLinkStyle: CSSProperties = {
  color: courtBlue,
  textDecoration: "none",
  fontSize: 13,
  fontWeight: 500,
};

/**
 * Cream card / panel surface — for grouped form sections, summary
 * blocks, info panels. Soft ruleSoft border keeps the edges quiet so
 * the cream fill carries the surface tone.
 */
export const panelStyle: CSSProperties = {
  background: cream,
  border: `1px solid ${ruleSoft}`,
  borderRadius: 10,
  padding: 18,
};

/**
 * Subtler panel — off-white-on-bg instead of cream. Use when stacking
 * panels and the cream + cream would read flat.
 */
export const panelMutedStyle: CSSProperties = {
  background: "#ffffff",
  border: `1px solid ${rule}`,
  borderRadius: 10,
  padding: 18,
};

/**
 * Primary CTA — ink block, cream label, Anton uppercase. The V5
 * signature button (same as the homepage hero CTAs).
 */
export const ctaPrimaryStyle: CSSProperties = {
  display: "inline-block",
  padding: "12px 22px",
  background: ink,
  color: bg,
  textDecoration: "none",
  border: "none",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 14,
  fontFamily: headingFontStack,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  cursor: "pointer",
};

/**
 * Disabled variant of ctaPrimaryStyle — keep the shape, drop the
 * weight. Apply to <button disabled> states so users see "this is
 * still the primary action, just not ready yet."
 */
export const ctaPrimaryDisabledStyle: CSSProperties = {
  ...ctaPrimaryStyle,
  background: inkMuted,
  cursor: "not-allowed",
  opacity: 0.85,
};

/**
 * Secondary CTA — transparent body, ink outline, ink text. Less
 * weighty than the primary but the same typographic voice (Anton
 * caps). Use for "Cancel", "Back", etc.
 */
export const ctaSecondaryStyle: CSSProperties = {
  ...ctaPrimaryStyle,
  background: "transparent",
  color: ink,
  boxShadow: `inset 0 0 0 2px ${ink}`,
};

/**
 * Ghost button — quiet inline action ("Clear search", "Edit"). Keeps
 * the body font instead of Anton because it's meant to fade into copy.
 */
export const ghostButtonStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: courtRed,
  cursor: "pointer",
  fontSize: 13,
  fontFamily: bodyFontStack,
  fontWeight: 600,
  textDecoration: "underline",
  padding: 0,
};

/**
 * Small status pill — ink fill, court-yellow label, IBM Plex Mono.
 * Mirrors the cards on the homepage. Use for "Registration open",
 * "Doubles", "Awaiting partner", etc.
 */
export const pillStyle: CSSProperties = {
  display: "inline-block",
  background: ink,
  color: courtYellow,
  fontFamily: monoFontStack,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  padding: "3px 8px",
  borderRadius: 3,
};

/**
 * Inline status panel — success / warning / danger. Pass a tone.
 */
export function statusPanelStyle(
  tone: "success" | "warn" | "danger" | "info",
): CSSProperties {
  if (tone === "success") {
    return {
      background: successBg,
      border: `1px solid ${courtGreen}`,
      color: successFg,
      borderRadius: 8,
      padding: "12px 16px",
      fontSize: 14,
      lineHeight: 1.5,
    };
  }
  if (tone === "warn") {
    return {
      background: warnBg,
      border: `1px solid ${courtYellow}`,
      color: warnFg,
      borderRadius: 8,
      padding: "12px 16px",
      fontSize: 14,
      lineHeight: 1.5,
    };
  }
  if (tone === "danger") {
    return {
      background: dangerBg,
      border: `1px solid ${courtRed}`,
      color: dangerFg,
      borderRadius: 8,
      padding: "12px 16px",
      fontSize: 14,
      lineHeight: 1.5,
    };
  }
  // info — quiet, sand-toned to fit the rest of the palette
  return {
    background: cream,
    border: `1px solid ${creamDeep}`,
    color: inkSoft,
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 14,
    lineHeight: 1.5,
  };
}

/**
 * Standard text input — cream-friendly border + cream focus ring.
 * Use as a base; spread and override per field as needed.
 */
export const inputStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: `1px solid ${rule}`,
  borderRadius: 6,
  fontSize: 14,
  fontFamily: bodyFontStack,
  background: "#ffffff",
  color: ink,
};
