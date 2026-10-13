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

        {/* THE ARGUMENT, now from the platform's OWN PUBLISHED SCHEDULE rather
            than inferred from receipts: pickleballtournaments.com/pricing states
            "$5 plus 7.99% of the total registration checkout", effective for
            tournaments opening for registration on 2026-08-03 or later. Verified
            against Ron's own invoice 2080708 — $80 checkout, $11.39 fee, which is
            $5 + 7.99% to the cent — and it reproduces both of their own worked
            examples. The comparison figure ($5.00 on a $50 checkout) is what he
            actually paid on 2026-07-20 under the legacy plan, invoice 1963202. */}
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
            The big platform now takes $5 + 7.99% of every entry
          </p>
          <p style={{ color: ink, fontSize: 15.5, lineHeight: 1.65, fontFamily: bodyFontStack, margin: "0 0 14px" }}>
            That is their published rate, and it applies to any tournament that opened for
            registration on or after <strong>August 3, 2026</strong>. It is charged on your{" "}
            <em>whole</em> checkout — the entry fee plus every event you add.
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse", margin: "0 0 14px", fontFamily: bodyFontStack }}>
            <tbody>
              <tr>
                <td style={{ padding: "7px 0", fontSize: 15, color: inkSoft, borderBottom: `1px solid ${rule}` }}>
                  A $50 entry, last July
                </td>
                <td style={{ padding: "7px 0", fontSize: 15, color: ink, fontWeight: 700, textAlign: "right", borderBottom: `1px solid ${rule}`, whiteSpace: "nowrap" }}>
                  $5.00 fee
                </td>
              </tr>
              <tr>
                <td style={{ padding: "7px 0", fontSize: 15, color: inkSoft, borderBottom: `1px solid ${rule}` }}>
                  The same $50 entry, now
                </td>
                <td style={{ padding: "7px 0", fontSize: 15, color: courtRed, fontWeight: 800, textAlign: "right", borderBottom: `1px solid ${rule}`, whiteSpace: "nowrap" }}>
                  $9.00 fee
                </td>
              </tr>
              <tr>
                <td style={{ padding: "7px 0", fontSize: 15, color: inkSoft }}>
                  An $80 entry — two events
                </td>
                <td style={{ padding: "7px 0", fontSize: 15, color: courtRed, fontWeight: 800, textAlign: "right", whiteSpace: "nowrap" }}>
                  $11.39 fee
                </td>
              </tr>
            </tbody>
          </table>
          <p style={{ color: ink, fontSize: 15.5, lineHeight: 1.65, fontFamily: bodyFontStack, margin: "0 0 12px" }}>
            Our last tournament had <strong>116 players</strong>. At $11.39 each, roughly{" "}
            <strong>$1,300 leaves this valley in platform fees</strong> on a single weekend — before
            the club pays for courts, refs, medals or balls.
          </p>
          <p style={{ color: ink, fontSize: 15.5, lineHeight: 1.65, fontFamily: bodyFontStack, margin: 0 }}>
            And if a club comps a player, or takes cash at the desk, their own terms say{" "}
            <strong>the club owes that fee instead</strong>.
          </p>
        </div>

        <h2 style={{ fontFamily: displayFontStack, fontSize: 21, color: ink, margin: "0 0 10px", lineHeight: 1.25 }}>
          Why that matters if you run a club
        </h2>
        <p style={{ color: inkSoft, fontSize: 15.5, lineHeight: 1.7, fontFamily: bodyFontStack, margin: "0 0 14px" }}>
          A tournament is one of the few days a small club actually makes money. The margin is thin
          and it is made of entry fees. Because the fee is a percentage of your <em>whole</em>
          checkout, every event a club adds and every dollar it charges raises the platform&rsquo;s
          cut too — and the player has already spent that money before they reach the club&rsquo;s
          price. So the choice is not whether to keep the fee. It is whether to raise your own price
          or watch people enter fewer events.
        </p>
        <p style={{ color: inkSoft, fontSize: 15.5, lineHeight: 1.7, fontFamily: bodyFontStack, margin: "0 0 28px" }}>
          We built our own tournament software because we are one of those clubs, and we would
          rather that money stayed here.
        </p>

        <h2 style={{ fontFamily: displayFontStack, fontSize: 21, color: ink, margin: "0 0 10px", lineHeight: 1.25 }}>
          So the ${CREDIT_OFFER_AMOUNT_USD} is the point, not a coupon
        </h2>
        <p style={{ color: inkSoft, fontSize: 15.5, lineHeight: 1.7, fontFamily: bodyFontStack, margin: "0 0 14px" }}>
          It is about what the big platform now takes out of two entries. We are handing it back to
          you instead, to spend on playing here again.
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
