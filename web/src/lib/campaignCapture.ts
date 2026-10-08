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
