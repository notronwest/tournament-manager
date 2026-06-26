// web/src/lib/posthog.ts
//
// PostHog product analytics + session replay, gated on the SAME cookie consent
// as GA4 (see analytics.ts). This is the "where do people get stuck?" layer:
// autocapture powers rage-click / dead-click detection + heatmaps, and session
// replay records the interactions (NOT the content — see masking below).
// Nothing loads, no cookies are set, and no session is recorded until the
// visitor accepts the consent banner.
//
// Config via build-time env (set in Cloudflare Pages PER PROJECT — prod = the
// real PostHog project; leave the test project unset, or point it at a separate
// PostHog project, so test traffic doesn't pollute prod). If the key is unset,
// PostHog is INERT — importing this module does nothing.
//   VITE_PUBLIC_POSTHOG_KEY   — project API key (phc_…)
//   VITE_PUBLIC_POSTHOG_HOST  — ingestion host (default https://us.i.posthog.com;
//                               use https://eu.i.posthog.com for EU Cloud)
//
// Driven by analytics.ts (single consent orchestrator): loadPostHog() on
// consent grant, posthogPageView() / posthogEvent() forwarded from
// trackPageView() / trackEvent().

import type { PostHog } from "posthog-js";

const KEY = import.meta.env.VITE_PUBLIC_POSTHOG_KEY as string | undefined;
const HOST =
  (import.meta.env.VITE_PUBLIC_POSTHOG_HOST as string | undefined) ??
  "https://us.i.posthog.com";

// Holds the initialised client once loaded. null until consent + dynamic import
// resolve, so the capture helpers below are safe no-ops before then.
let ph: PostHog | null = null;
let loading = false;

// True when a project key is configured for this build. analytics.ts ORs this
// with the GA4 check so the consent banner shows whenever EITHER is configured.
export function posthogConfigured(): boolean {
  return Boolean(KEY);
}

// Initialise PostHog. Idempotent. Only ever called after consent === "granted".
// posthog-js is DYNAMICALLY imported here so it ships as a separate chunk loaded
// only on consent — the main bundle (and visitors who decline) never pay for it.
export async function loadPostHog(): Promise<void> {
  if (ph || loading || !KEY) return;
  loading = true;

  const { default: posthog } = await import("posthog-js");
  posthog.init(KEY, {
    api_host: HOST,
    // SPA: we send $pageview ourselves on every route change (RouteTracker),
    // mirroring GA4, so disable PostHog's automatic one to avoid double counts.
    // Keep pageleave for accurate time-on-page / bounce.
    capture_pageview: false,
    capture_pageleave: true,
    // Autocapture clicks/inputs — this is what surfaces RAGE CLICKS, dead
    // clicks, and powers the heatmaps Ron wants for "where do users get stuck".
    autocapture: true,
    // Stay anonymous: don't create person profiles tied to email/PII unless we
    // explicitly identify (we don't). Device-level stitching still powers
    // funnels + replay.
    person_profiles: "identified_only",
    // Session replay — the recordings for reviewing troubled UX. Masked for
    // privacy: every input is masked (names / emails / card fields are never
    // captured) AND all text is masked, since the app renders player PII
    // (names, emails, rosters) as page text. Recordings show layout +
    // interactions + where clicks land — enough to spot stuck points — without
    // leaking PII. To make recordings more readable later, relax
    // `maskTextSelector` to target only known-PII elements instead of "*".
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
    },
    persistence: "localStorage+cookie",
  });
  ph = posthog;
}

// SPA page view. No-op until loaded (post-consent) and configured.
export function posthogPageView(path: string): void {
  if (!ph) return;
  ph.capture("$pageview", {
    $current_url: window.location.href,
    path,
  });
}

// Funnel / custom event (checkout_started, etc.). No-op until loaded.
export function posthogEvent(
  name: string,
  params?: Record<string, unknown>,
): void {
  if (!ph) return;
  ph.capture(name, params ?? {});
}
