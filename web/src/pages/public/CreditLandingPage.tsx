import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { supabase } from "../../supabase";
import SiteFooter from "../../components/SiteFooter";
import { buildLoginHref } from "../../lib/campaignCapture";
import { CREDIT_OFFER_AMOUNT_USD, isCreditOfferEnabled } from "../../lib/featureFlags";
import {
  bodyFontStack,
  contentColStyle,
  ctaPrimaryStyle,
  displayFontStack,
  ink,
  inkSoft,
  pageWrapStyle,
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
        <h1 style={{ fontFamily: displayFontStack, fontSize: 28, color: ink, margin: "0 0 10px" }}>
          ${CREDIT_OFFER_AMOUNT_USD} toward your next {orgName} tournament
        </h1>
        <p style={{ color: inkSoft, fontSize: 15, lineHeight: 1.65, fontFamily: bodyFontStack }}>
          Create your free account and we&rsquo;ll add a ${CREDIT_OFFER_AMOUNT_USD} credit — good
          on any tournament {orgName} runs.
        </p>
        <ul
          style={{
            color: inkSoft,
            fontSize: 15,
            lineHeight: 1.65,
            fontFamily: bodyFontStack,
            paddingLeft: 22,
            margin: "0 0 24px",
          }}
        >
          <li>{orgName}&rsquo;s tournaments only — it can&rsquo;t be used at other clubs.</li>
          <li>Not cash, and not refundable as cash.</li>
          <li>Expires 12 months after it&rsquo;s added to your account.</li>
        </ul>
        <Link to={loginHref} style={ctaPrimaryStyle}>
          Create your account
        </Link>
      </div>
      <SiteFooter />
    </main>
  );
}
