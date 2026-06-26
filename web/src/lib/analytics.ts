// web/src/lib/analytics.ts
//
// Consent orchestrator for site analytics. Two tools, ONE cookie-consent gate:
//   • GA4 (gtag.js) — traffic / conversion counts (this file).
//   • PostHog — product analytics + session replay ("where do users get
//     stuck": rage clicks, funnels, recordings) — see ./posthog.ts.
// Nothing loads, no cookies are set, and no session is recorded until the
// visitor accepts the consent banner (#407). Each tool is independently inert
// when its env var is unset, so either, both, or neither can be configured.
//
// The Measurement ID is a build-time env var (VITE_GA_MEASUREMENT_ID) — set
// it in Cloudflare Pages per project (prod = the real property; leave the
// test project unset, or point it at a separate test property, so test
// traffic doesn't pollute prod analytics). If unset, analytics is inert.
//
// Usage:
//   - initAnalytics()        once at app start (loads gtag only if already
//                            consented in a previous visit).
//   - getConsent()/setConsent() drive the ConsentBanner.
//   - trackPageView(path)    on every SPA route change (RouteTracker).
//   - trackEvent(name, ...)  funnel events (checkout_started, etc.).

import {
  posthogConfigured,
  loadPostHog,
  posthogPageView,
  posthogEvent,
} from "./posthog";

const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined;
const CONSENT_KEY = "wmpc_analytics_consent";

type Consent = "granted" | "denied";

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
  }
}

let loaded = false;

// True when EITHER tool is configured for this build. The consent banner stays
// hidden entirely when no analytics is configured.
export function analyticsConfigured(): boolean {
  return Boolean(GA_ID) || posthogConfigured();
}

export function getConsent(): Consent | null {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    return null;
  }
}

export function setConsent(value: Consent): void {
  try {
    localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // Storage blocked (private mode / cookies off) — honor the choice for
    // this session only; just don't persist it.
  }
  if (value === "granted") {
    loadGa();
    void loadPostHog();
  }
}

// Injects the gtag.js script + bootstraps the dataLayer. Idempotent. Only
// ever called after consent === "granted".
function loadGa(): void {
  if (loaded || !GA_ID) return;
  loaded = true;

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  // gtag pushes the raw `arguments` object (GA's canonical snippet) — not
  // an array — so the tag parses commands correctly.
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer.push(arguments);
  };
  window.gtag("js", new Date());
  // SPA: we emit page_view ourselves on route change, so disable the
  // automatic one (it would only fire on hard loads anyway).
  window.gtag("config", GA_ID, { send_page_view: false });
}

// Call once at startup. Loads the configured tools only if the visitor
// consented on a previous visit; otherwise stays inert until the banner is
// accepted.
export function initAnalytics(): void {
  if (getConsent() === "granted") {
    loadGa();
    void loadPostHog();
  }
}

export function trackPageView(path: string): void {
  if (loaded && GA_ID) {
    window.gtag("event", "page_view", {
      page_path: path,
      page_location: window.location.href,
      page_title: document.title,
    });
  }
  // PostHog guards its own loaded/configured state.
  posthogPageView(path);
}

export function trackEvent(
  name: string,
  params?: Record<string, unknown>,
): void {
  if (loaded && GA_ID) {
    window.gtag("event", name, params ?? {});
  }
  posthogEvent(name, params);
}
