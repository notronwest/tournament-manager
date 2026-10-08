// Campaign funnel capture (D-0077) — the client half of the
// recap-view / view-to-signup attribution. No third-party analytics
// script; everything here talks only to our own record_campaign_event RPC.
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../supabase";
import { getOrCreateVisitorId } from "./visitorId";

// record_campaign_event isn't in the generated types yet (it ships in a
// separate migration PR) — same untyped-client pattern as merge_events.
const untyped = supabase as unknown as SupabaseClient;

const CAMPAIGN_KEY = "tm:campaign";

// Reads `?c=<campaign>` off the current URL and persists it for the rest
// of the browser session, so it survives the redirect through login /
// magic-link / OAuth and is still there when the player signs up. Call on
// every route change (see components/CampaignCapture.tsx) — a page with no
// `?c=` leaves a previously-captured campaign untouched.
export function captureCampaignParam(search: string): void {
  const campaign = new URLSearchParams(search).get("c");
  if (!campaign) return;
  try {
    sessionStorage.setItem(CAMPAIGN_KEY, campaign);
  } catch {
    // Storage blocked — attribution just won't survive this visit.
  }
}

export function getCapturedCampaign(): string | null {
  try {
    return sessionStorage.getItem(CAMPAIGN_KEY);
  } catch {
    return null;
  }
}

// Fires the one-shot `signup` event for a brand-new player row. No-op when
// no campaign was ever captured this session — there's nothing to
// attribute. Best-effort: a failure here must never block account creation.
export async function recordSignupEvent(): Promise<void> {
  const campaign = getCapturedCampaign();
  if (!campaign) return;
  try {
    await untyped.rpc("record_campaign_event", {
      p_campaign: campaign,
      p_kind: "signup",
      p_visitor_id: getOrCreateVisitorId(),
    });
  } catch {
    // Best-effort — attribution is not worth failing signup over.
  }
}

// Grants the one-shot account credit (#1102, D-0077 §2) for a brand-new
// player row — same call site and the same "no-op without a captured
// campaign" shape as recordSignupEvent() right above. Whether the
// campaign is actually live, whether it's already been granted, and how
// much/which org are all decided server-side by grant_account_credit();
// this is just "don't bother calling when we never captured one". Best-
// effort: a failure here must never block account creation.
export async function grantAccountCreditIfEligible(): Promise<void> {
  const campaign = getCapturedCampaign();
  if (!campaign) return;
  try {
    await untyped.rpc("grant_account_credit", { p_campaign: campaign });
  } catch {
    // Best-effort — a missed credit grant is not worth failing signup over.
  }
}

// Fires the one-shot `recap_view` event when a recap page is opened with a
// `?c=<campaign>` param (#1101's own acceptance criterion). Takes the
// campaign directly rather than reading getCapturedCampaign() — a recap view
// is attributed to the link's OWN `?c=`, not whatever an earlier page in this
// session happened to set. Best-effort: a failure here must never block the
// recap page from rendering.
export async function recordRecapViewEvent(campaign: string): Promise<void> {
  try {
    await untyped.rpc("record_campaign_event", {
      p_campaign: campaign,
      p_kind: "recap_view",
      p_visitor_id: getOrCreateVisitorId(),
    });
  } catch {
    // Best-effort — attribution is not worth failing the recap page over.
  }
}

// Shared link builders so every page that forwards `?c=<campaign>` (recap →
// credit landing → login) does it the same way, rather than each page
// re-deriving its own ternary (#1114).

/** The credit landing page's own link, carrying `?c=` through hop 1. */
export function buildCreditLandingHref(
  orgSlug: string,
  campaign: string | null,
): string {
  const base = `/t/${orgSlug}/credit`;
  return campaign ? `${base}?c=${encodeURIComponent(campaign)}` : base;
}

/** The signup/login link, carrying `?c=` through the final hop. */
export function buildLoginHref(campaign: string | null): string {
  return campaign ? `/login?c=${encodeURIComponent(campaign)}` : "/login";
}
