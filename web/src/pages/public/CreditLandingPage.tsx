import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { supabase } from "../../supabase";
import SiteFooter from "../../components/SiteFooter";
import { buildLoginHref } from "../../lib/campaignCapture";
import { CREDIT_OFFER_AMOUNT_USD, isCreditOfferEnabled } from "../../lib/featureFlags";
import {
  bodyFontStack,
  contentColStyle,
  courtRed,
  cream,
  ctaPrimaryStyle,
  displayFontStack,
  ink,
  inkSoft,
  pageWrapStyle,
  rule,
} from "../../lib/publicTheme";

// The $20-credit landing page (#1114, D-0077): what the recap page's CTA
// points at. Explains the offer in plain language before sending the visitor
// on to signup — the recap CTA shouldn't have to carry the whole pitch
// itself. Gated behind the same isCreditOfferEnabled() flag as the recap
// CTA: with the flag off, this route must not promise $20 either (it would
// otherwise be a back door to the same unhonorable promise the flag exists
// to prevent), so it renders the same "isn't available" shape the other
// public pages use instead.

export default function CreditLandingPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const [searchParams] = useSearchParams();
  const campaign = searchParams.get("c");
  const [orgName, setOrgName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orgSlug) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from("organizations")
        .select("name")
        .eq("slug", orgSlug)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      setOrgName(data?.name ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug]);

  const creditOfferEnabled = isCreditOfferEnabled();
  const loginHref = buildLoginHref(campaign);

  if (loading) {
    return (
      <main style={pageWrapStyle}>
        <div style={contentColStyle(760)} />
      </main>
    );
  }

  if (!creditOfferEnabled || !orgName) {
    return (
      <main style={pageWrapStyle}>
        <div style={contentColStyle(760)}>
          <h1 style={{ fontFamily: displayFontStack, fontSize: 28, color: ink, margin: "0 0 10px" }}>
            This offer isn't available
          </h1>
          <p style={{ color: inkSoft, fontSize: 15, lineHeight: 1.6, fontFamily: bodyFontStack }}>
            {orgSlug ? (
              <>
                You can still{" "}
                <Link to={loginHref} style={{ color: ink, fontWeight: 600 }}>
                  create an account
                </Link>{" "}
                to register for tournaments.
              </>
            ) : (
              "This link looks incomplete — check it and try again."
            )}
          </p>
        </div>
        <SiteFooter />
      </main>
    );
  }

  return (
    <main style={pageWrapStyle}>
      <div style={contentColStyle(760)}>
        <h1 style={{ fontFamily: displayFontStack, fontSize: 30, color: ink, margin: "0 0 14px", lineHeight: 1.15 }}>
          ${CREDIT_OFFER_AMOUNT_USD} toward your next {orgName} tournament
        </h1>
        <p style={{ color: inkSoft, fontSize: 16, lineHeight: 1.65, fontFamily: bodyFontStack, margin: "0 0 28px" }}>
          Create your free account and we&rsquo;ll add a ${CREDIT_OFFER_AMOUNT_USD} credit — good
          on any tournament {orgName} runs. Here is why we are doing it.
        </p>

        {/* THE ARGUMENT. Every figure below comes from Ron's own Pickleball.com
            receipts (invoice ids 1963202 and 2080708), eleven weeks apart, as a
            PLAYER. Deliberately the narrow, defensible pair: three different
            organizers set three different base prices, so the RATE comparison is
            the honest one. No claim is made about a published fee schedule, an
            official rate change, or an effective date, because none was found. */}
        <div
          style={{
            background: cream,
            border: `2px solid ${courtRed}`,
            borderRadius: 12,
            padding: "22px 24px",
            margin: "0 0 28px",
          }}
        >
          <p
            style={{
              fontFamily: displayFontStack,
              textTransform: "uppercase",
              letterSpacing: "0.02em",
              fontSize: 22,
              lineHeight: 1.2,
              color: courtRed,
              margin: "0 0 12px",
            }}
          >
            The fees on tournament entries are climbing fast
          </p>
          <p style={{ color: ink, fontSize: 15.5, lineHeight: 1.65, fontFamily: bodyFontStack, margin: "0 0 14px" }}>
            Two entries on the same national platform, eleven weeks apart:
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse", margin: "0 0 14px", fontFamily: bodyFontStack }}>
            <tbody>
              <tr>
                <td style={{ padding: "7px 0", fontSize: 15, color: inkSoft, borderBottom: `1px solid ${rule}` }}>
                  July&nbsp;20 — $50 entry
                </td>
                <td style={{ padding: "7px 0", fontSize: 15, color: ink, fontWeight: 700, textAlign: "right", borderBottom: `1px solid ${rule}`, whiteSpace: "nowrap" }}>
                  $5.00 service fee
                </td>
              </tr>
              <tr>
                <td style={{ padding: "7px 0", fontSize: 15, color: inkSoft }}>October&nbsp;6 — $80 entry</td>
                <td style={{ padding: "7px 0", fontSize: 15, color: courtRed, fontWeight: 800, textAlign: "right", whiteSpace: "nowrap" }}>
                  $11.39 service fee
                </td>
              </tr>
            </tbody>
          </table>
          <p style={{ color: ink, fontSize: 15.5, lineHeight: 1.65, fontFamily: bodyFontStack, margin: "0 0 12px" }}>
            That is <strong>2.3&times; in eleven weeks</strong> — the platform&rsquo;s cut went from
            10% of the entry to 14%. In July a second event was included in the registration. By
            October a second event was a separate $10 charge.
          </p>
          <p style={{ color: ink, fontSize: 15.5, lineHeight: 1.65, fontFamily: bodyFontStack, margin: 0 }}>
            Our last tournament had <strong>116 players</strong>. At that rate, roughly{" "}
            <strong>$1,300 leaves this valley in platform fees</strong> on a single weekend — before
            a club pays for courts, refs, medals or balls.
          </p>
        </div>

        <h2 style={{ fontFamily: displayFontStack, fontSize: 21, color: ink, margin: "0 0 10px", lineHeight: 1.25 }}>
          Why that matters if you run a club
        </h2>
        <p style={{ color: inkSoft, fontSize: 15.5, lineHeight: 1.7, fontFamily: bodyFontStack, margin: "0 0 14px" }}>
          A tournament is one of the few days a small club actually makes money. The margin is thin
          and it is made of entry fees. Every dollar the platform adds on top is a dollar the player
          has already spent before they get to yours — so the club is not choosing between keeping
          the fee or giving it up. It is choosing between raising its own price and watching players
          enter fewer events.
        </p>
        <p style={{ color: inkSoft, fontSize: 15.5, lineHeight: 1.7, fontFamily: bodyFontStack, margin: "0 0 28px" }}>
          We built our own tournament software because we are one of those clubs, and we would
          rather that money stayed here.
        </p>

        <h2 style={{ fontFamily: displayFontStack, fontSize: 21, color: ink, margin: "0 0 10px", lineHeight: 1.25 }}>
          So the ${CREDIT_OFFER_AMOUNT_USD} is the point, not a coupon
        </h2>
        <p style={{ color: inkSoft, fontSize: 15.5, lineHeight: 1.7, fontFamily: bodyFontStack, margin: "0 0 14px" }}>
          It is roughly what a national platform would have taken out of your last two entries.
          We are handing it back to you instead, to spend on playing here again.
        </p>
        <ul
          style={{
            color: inkSoft,
            fontSize: 15,
            lineHeight: 1.7,
            fontFamily: bodyFontStack,
            paddingLeft: 22,
            margin: "0 0 26px",
          }}
        >
          <li>{orgName}&rsquo;s tournaments only — it can&rsquo;t be used at other clubs.</li>
          <li>Not cash, and not refundable as cash.</li>
          <li>Expires 12 months after it&rsquo;s added to your account.</li>
        </ul>

        <Link to={loginHref} style={{ ...ctaPrimaryStyle, background: courtRed, color: cream, fontSize: 15, padding: "13px 24px" }}>
          Create your account
        </Link>
        <p style={{ color: inkSoft, fontSize: 13, lineHeight: 1.6, fontFamily: bodyFontStack, margin: "14px 0 0" }}>
          Free. The credit lands on your account as soon as you sign up.
        </p>
      </div>
      <SiteFooter />
    </main>
  );
}
