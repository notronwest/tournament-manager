import { useState } from "react";
import {
  bg,
  bodyFontStack,
  headingFontStack,
  ink,
  inkSoft,
  rule,
  successBg,
  successFg,
} from "../lib/publicTheme";

// Paired "Open ↗" + "Copy link" buttons for a public-facing route —
// shared so an admin page that wants to hand someone a public URL
// (the public tournament page, the recap page, …) never grows its own
// copy of this (D-0049). "Open" launches a new tab so the admin keeps
// their workspace; "Copy" puts the full URL on the clipboard, with a
// brief "Copied!" flash and a window.prompt fallback if the Clipboard
// API throws (non-secure context / iframe — not a primary UX, just the
// one case where it can fail).
export function PublicPageLink({
  path,
  label = "Public page ↗",
  copyLabel = "Copy link",
}: {
  path: string;
  label?: string;
  copyLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const fullUrl =
    typeof window !== "undefined" ? `${window.location.origin}${path}` : path;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy this URL:", fullUrl);
    }
  };

  return (
    <div style={{ display: "flex", gap: 4 }}>
      <a
        href={path}
        target="_blank"
        rel="noreferrer"
        title={`Open ${fullUrl}`}
        style={{
          padding: "8px 14px",
          background: "transparent",
          color: ink,
          textDecoration: "none",
          border: `2px solid ${ink}`,
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 600,
          fontFamily: headingFontStack,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          whiteSpace: "nowrap",
          display: "inline-block",
        }}
      >
        {label}
      </a>
      <button
        onClick={onCopy}
        title={`Copy ${fullUrl}`}
        style={{
          padding: "8px 12px",
          background: copied ? successBg : bg,
          color: copied ? successFg : inkSoft,
          border: `1px solid ${copied ? successFg : rule}`,
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 500,
          cursor: "pointer",
          fontFamily: bodyFontStack,
          whiteSpace: "nowrap",
        }}
      >
        {copied ? "Copied!" : copyLabel}
      </button>
    </div>
  );
}
