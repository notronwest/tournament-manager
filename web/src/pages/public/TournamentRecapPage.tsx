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
  bodyFontStack,
  contentColStyle,
  courtRed,
  ctaPrimaryStyle,
  displayFontStack,
  ink,
  inkMuted,
  inkSoft,
  pageWrapStyle,
  rule,
} from "../../lib/publicTheme";

// Public RECAP page (#1101, D-0077 §1): a COMPLETED tournament's end-of-event
// summary, open to anyone with the link — this is what Ron sends in the
// thank-you email. Data comes from the public_tournament_recap RPC (a
// curated, money/contact-free payload; see the 20261008140000 migration),
// and the page reuses the admin's own buildTournamentSummary +
// TournamentSummaryReport so the public sheet can't disagree with the
// console (D-0049). No publish toggle — reaching 'completed' is what makes
// it public.
//
// recap_view campaign-funnel tracking (record_campaign_event RPC, merged in
// #1104) is deliberately NOT wired up here: the shared visitor-id / campaign
// capture helper this would need to call it without a second, diverging
// implementation is still mid-flight on the sibling PR #1106
// (feature/issue-1100-campaign-events) and isn't on main yet. The CTA below
// still forwards ?c= into the signup URL so whichever capture mechanism is
// live by the time this merges sees it. See the PR's Reviewer notes.

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
  const campaign = searchParams.get("c");
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

  const signupHref = campaign ? `/login?c=${encodeURIComponent(campaign)}` : "/login";

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

        <TournamentSummaryReport header={header} summary={summary} note="" />

        <div
          style={{
            marginTop: 28,
            padding: "24px 20px",
            textAlign: "center",
            border: `1px solid ${rule}`,
            borderRadius: 10,
          }}
        >
          <p style={{ margin: "0 0 14px", fontSize: 15, color: inkSoft, fontFamily: bodyFontStack }}>
            Want to see your own tournament history and sign up for the next one?
          </p>
          <Link to={signupHref} style={ctaPrimaryStyle}>
            Create your account
          </Link>
        </div>
      </div>
      <SiteFooter />
    </main>
  );
}
