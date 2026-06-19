import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  analyticsConfigured,
  getConsent,
  setConsent,
  initAnalytics,
  trackPageView,
} from "../lib/analytics";
import {
  ink,
  inkSoft,
  bg,
  rule,
  courtGreen,
  bodyFontStack,
  headingFontStack,
} from "../lib/publicTheme";

// Loads consent on first mount and sends a GA4 page_view on every SPA route
// change (gtag's automatic page_view only fires on hard loads). Renders
// nothing. Must live inside the Router.
export function RouteTracker() {
  const location = useLocation();

  useEffect(() => {
    initAnalytics();
  }, []);

  useEffect(() => {
    trackPageView(location.pathname + location.search);
  }, [location.pathname, location.search]);

  return null;
}

// Cookie-consent banner (#407). GA4 stays unloaded until the visitor
// accepts. Hidden entirely when analytics isn't configured or a choice was
// already made.
export function ConsentBanner() {
  const [decided, setDecided] = useState(() => getConsent() !== null);

  if (!analyticsConfigured() || decided) return null;

  const choose = (value: "granted" | "denied") => {
    setConsent(value);
    setDecided(true);
  };

  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      style={{
        position: "fixed",
        left: 16,
        right: 16,
        bottom: 16,
        zIndex: 1000,
        margin: "0 auto",
        maxWidth: 720,
        background: bg,
        border: `1px solid ${rule}`,
        borderRadius: 10,
        boxShadow: "0 6px 24px rgba(0,0,0,0.12)",
        padding: "14px 18px",
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
        fontFamily: bodyFontStack,
      }}
    >
      <p style={{ margin: 0, flex: 1, minWidth: 240, fontSize: 13, color: inkSoft, lineHeight: 1.5 }}>
        We use cookies for analytics to understand how the site is used and
        make it better. No ads, no selling data.
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={() => choose("denied")}
          style={{
            padding: "9px 16px",
            background: "transparent",
            color: ink,
            border: `1px solid ${rule}`,
            borderRadius: 6,
            fontSize: 13,
            fontFamily: headingFontStack,
            cursor: "pointer",
          }}
        >
          Decline
        </button>
        <button
          type="button"
          onClick={() => choose("granted")}
          style={{
            padding: "9px 16px",
            background: courtGreen,
            color: "#ffffff",
            border: "none",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 700,
            fontFamily: headingFontStack,
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            cursor: "pointer",
          }}
        >
          Accept
        </button>
      </div>
    </div>
  );
}
