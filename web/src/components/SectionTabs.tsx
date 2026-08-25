import { useRef, type CSSProperties, type KeyboardEvent } from "react";
import {
  ink,
  inkSoft,
  bg,
  cream,
  rule,
  courtRed,
  headingFontStack,
} from "../lib/publicTheme";

// Segmented-control section tabs for the public tournament page. Replaces the
// old underlined text tabs, which read as inert grey copy — a visitor could
// scroll straight past "Register", the whole point of the page.
//
// `ctaKey` is the trick: that tab stays filled in court red while INACTIVE, so
// the primary action is unmissable, then drops to the normal ink fill once
// you're on it (an active tab doesn't need to advertise itself).
//
// Behaviour follows the shadcn/Radix horizontal-tabs model — roving tabindex,
// arrows move *and* activate, Home/End jump to the ends — but is styled from
// our own tokens, not Tailwind.

export type SectionTabDef<K extends string> = { key: K; label: string };

export function SectionTabs<K extends string>({
  tabs,
  value,
  onChange,
  ctaKey,
  idPrefix,
  ariaLabel,
}: {
  tabs: readonly SectionTabDef<K>[];
  value: K;
  onChange: (key: K) => void;
  /** Tab rendered as the primary CTA while it is not the active one. */
  ctaKey?: K;
  /** Prefix for the tab/panel ids that wire aria-controls ↔ aria-labelledby. */
  idPrefix: string;
  ariaLabel: string;
}) {
  const refs = useRef<Partial<Record<K, HTMLButtonElement | null>>>({});

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.key === value);
    if (i < 0) return;
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const key = tabs[next].key;
    onChange(key);
    refs.current[key]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      style={trackStyle}
    >
      {tabs.map(({ key, label }) => {
        const active = value === key;
        const cta = !active && key === ctaKey;
        return (
          <button
            key={key}
            ref={(el) => {
              refs.current[key] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${key}`}
            aria-selected={active}
            aria-controls={`${idPrefix}-panel-${key}`}
            // Roving tabindex: only the active tab is a tab stop.
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(key)}
            style={{
              ...segmentStyle,
              background: active ? ink : cta ? courtRed : "transparent",
              color: active ? bg : cta ? "#ffffff" : inkSoft,
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// Capped rather than full-bleed: at 1280px an uncapped control stretched to
// ~1000px and read as slack. Below the cap it stays full width, so mobile is
// unaffected and no media query is needed.
const trackStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  maxWidth: 440,
  background: cream,
  border: `1px solid ${rule}`,
  borderRadius: 12,
  padding: 4,
  marginBottom: 24,
};

const segmentStyle: CSSProperties = {
  flex: 1,
  minHeight: 46,
  border: "none",
  borderRadius: 9,
  cursor: "pointer",
  fontFamily: headingFontStack,
  fontSize: 15,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};
