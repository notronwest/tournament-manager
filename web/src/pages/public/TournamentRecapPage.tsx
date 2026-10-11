import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../../supabase";
import SiteFooter from "../../components/SiteFooter";
import type { EventRegistration, Match, Player } from "../../lib/bracketTeams";
import {
  buildTournamentSummary,
  type ReportHeader,
  type SummaryEvent,
  type TournamentSummary,
} from "../../lib/tournamentSummary";
import { TournamentSummaryReport } from "../../components/TournamentSummaryReport";
import {
  buildCreditLandingHref,
  buildLoginHref,
  captureCampaign,
  recordRecapViewEvent,
  resolveTournamentCampaign,
} from "../../lib/campaignCapture";
import { CREDIT_OFFER_AMOUNT_USD, isCreditOfferEnabled } from "../../lib/featureFlags";
import {
  bodyFontStack,
  contentColStyle,
  courtRed,
  cream,
  ctaPrimaryStyle,
  displayFontStack,
  ink,
  inkMuted,
  inkSoft,
  pageWrapStyle,
} from "../../lib/publicTheme";

// Public RECAP page (#1101, D-0077 §1): a COMPLETED tournament's end-of-event
// summary, open to anyone with the link — this is what Ron sends in the
// thank-you email. Data comes from the public_tournament_recap RPC (a
// curated, money/contact-free payload; see the 20261008140000 migration),
// and the page reuses the admin's own buildTournamentSummary +
// TournamentSummaryReport so the public sheet can't disagree with the
// console (D-0049). No publish toggle — reaching 'completed' is what makes
// it public.

const untyped = supabase as unknown as SupabaseClient;

type RecapPayload = {
  tournament: {
    name: string;
    slug: string;
    starts_at: string;
    ends_at: string;
    status: string;
    org_name: string;
    venue_name: string | null;
    venue_address: string | null;
  };
  events: SummaryEvent[];
  registrations: EventRegistration[];
  players: Player[];
  matches: Match[];
};

export default function TournamentRecapPage() {
  const { orgSlug, tournamentSlug } = useParams<{ orgSlug: string; tournamentSlug: string }>();
  const [searchParams] = useSearchParams();
  const taggedCampaign = searchParams.get("c");
  // The campaign resolved from the server when the link carried no `?c=`.
  const [fallbackCampaign, setFallbackCampaign] = useState<string | null>(null);
  const campaign = taggedCampaign ?? fallbackCampaign;
  const [payload, setPayload] = useState<RecapPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgSlug || !tournamentSlug) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error: rpcErr } = await untyped.rpc("public_tournament_recap", {
        p_org_slug: orgSlug,
        p_tournament_slug: tournamentSlug,
      });
      if (cancelled) return;
      if (rpcErr) {
        setError(rpcErr.message);
        setLoading(false);
        return;
      }
      setPayload((data as RecapPayload | null) ?? null);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug, tournamentSlug]);

  // recap_view campaign-funnel attribution (#1101's own acceptance
  // criterion): fired once per mount, independent of whether the recap
  // itself loads.
  //
  // The link's own `?c=` wins. When it carries none we ask the server which
  // campaign is live for this tournament and use that — because the
  // 2026-10-09 Leaf Peeper send went out with an untagged link, which
  // recorded no views at all and left every reader unable to receive the $20
  // the email promised them. The client never picks the campaign itself
  // (D-0077 forbids a client-decided grant); it only uses what the server
  // names. Also stamps the tournament on the row: without it,
  // campaign_events' RLS hides the row from every org admin.
  useEffect(() => {
    if (!orgSlug || !tournamentSlug) return;
    let cancelled = false;
    (async () => {
      const resolved =
        taggedCampaign ??
        (await resolveTournamentCampaign(orgSlug, tournamentSlug));
      if (cancelled || !resolved) return;
      if (!taggedCampaign) setFallbackCampaign(resolved);
      // Persist for the credit → login → signup hops, with the tournament
      // it was captured on so the later `signup` row can name it too.
      captureCampaign(resolved, tournamentSlug);
      void recordRecapViewEvent(resolved, tournamentSlug);
    })();
    return () => {
      cancelled = true;
    };
    // Deps pinned to the route, not `taggedCampaign` — this fires once for
    // this page's own link, not on every searchParams identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgSlug, tournamentSlug]);

  const summary = useMemo<TournamentSummary | null>(() => {
    if (!payload) return null;
    return buildTournamentSummary({
      events: payload.events,
      regs: payload.registrations,
      players: payload.players,
      matches: payload.matches,
      window: { startsAt: payload.tournament.starts_at, endsAt: payload.tournament.ends_at },
    });
  }, [payload]);

  const header = useMemo<ReportHeader | null>(() => {
    if (!payload) return null;
    const t = payload.tournament;
    return {
      tournamentName: t.name,
      orgName: t.org_name,
      startsAt: t.starts_at,
      endsAt: t.ends_at,
      venueName: t.venue_name,
      venueAddress: t.venue_address,
    };
  }, [payload]);

  const creditOfferEnabled = isCreditOfferEnabled();
  const ctaHref =
    creditOfferEnabled && orgSlug
      ? buildCreditLandingHref(orgSlug, campaign)
      : buildLoginHref(campaign);

  if (loading) {
    return (
      <main style={pageWrapStyle}>
        <div style={contentColStyle(760)}>
          <p style={{ color: inkMuted, fontSize: 14 }}>Loading recap…</p>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main style={pageWrapStyle}>
        <div style={contentColStyle(760)}>
          <p style={{ color: courtRed, fontSize: 14 }}>{error}</p>
        </div>
      </main>
    );
  }

  if (!payload || !summary || !header) {
    return (
      <main style={pageWrapStyle}>
        <div style={contentColStyle(760)}>
          <h1 style={{ fontFamily: displayFontStack, fontSize: 28, color: ink, margin: "0 0 10px" }}>
            This recap isn't available
          </h1>
          <p style={{ color: inkSoft, fontSize: 15, lineHeight: 1.6, fontFamily: bodyFontStack }}>
            Either this tournament hasn't wrapped up yet, or it doesn't exist. Once the organizer
            marks it complete, the recap will appear here.
          </p>
        </div>
        <SiteFooter />
      </main>
    );
  }

  return (
    <main style={pageWrapStyle}>
      <div style={contentColStyle(760)}>
        <div style={{ marginBottom: 8 }}>
          <Link
            to={`/t/${orgSlug}/${tournamentSlug}`}
            style={{ fontSize: 13, color: inkMuted, textDecoration: "none" }}
          >
            ← {header.tournamentName}
          </Link>
        </div>

        {/* THE OFFER GOES FIRST. It shipped below the fold, under the footer
            rule, in grey — Ron, 2026-10-09: "Move the CTA to the top and add
            some color -- make it noticeable." A player opens this link for the
            results; the offer only works if it is the first thing they see.
            courtRed is the brand accent, used nowhere else on this page. */}
        <div
          style={{
            margin: "0 0 26px",
            padding: "20px 22px",
            borderRadius: 12,
            background: cream,
            border: `2px solid ${courtRed}`,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 16,
            justifyContent: "space-between",
          }}
        >
          <div style={{ flex: "1 1 320px", minWidth: 0 }}>
            {creditOfferEnabled ? (
              <>
                <p
                  style={{
                    margin: "0 0 6px",
                    fontFamily: displayFontStack,
                    textTransform: "uppercase",
                    letterSpacing: "0.02em",
                    lineHeight: 1.1,
                    fontSize: 26,
                    color: courtRed,
                  }}
                >
                  ${CREDIT_OFFER_AMOUNT_USD} toward your next {header.orgName} tournament
                </p>
                <p style={{ margin: 0, fontSize: 14, color: inkSoft, fontFamily: bodyFontStack, lineHeight: 1.45 }}>
                  Create your account and we&rsquo;ll add a ${CREDIT_OFFER_AMOUNT_USD} credit, good on any
                  tournament {header.orgName} runs. Our tournaments only — it isn&rsquo;t cash and
                  can&rsquo;t be used at other clubs.
                </p>
              </>
            ) : (
              <p style={{ margin: 0, fontSize: 15, color: inkSoft, fontFamily: bodyFontStack }}>
                Want to see your own tournament history and sign up for the next one?
              </p>
            )}
          </div>
          <Link
            to={ctaHref}
            style={{
              ...ctaPrimaryStyle,
              flex: "none",
              background: courtRed,
              color: cream,
              fontSize: 15,
              padding: "13px 24px",
              whiteSpace: "nowrap",
            }}
          >
            Learn More →
          </Link>
        </div>

        <TournamentSummaryReport header={header} summary={summary} note="" />
      </div>
      <SiteFooter />
    </main>
  );
}
