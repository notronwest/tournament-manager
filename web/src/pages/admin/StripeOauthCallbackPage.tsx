import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../../supabase";

// Lands here after the user authorizes Tournament Manager on Stripe's
// hosted OAuth page. URL carries ?code + ?state (state is base64url
// JSON of { orgSlug }). We POST both to stripe-connect-oauth-callback,
// which exchanges code → stripe_user_id and saves it to the org, then
// we redirect to /admin/:slug/settings/stripe with a success flag.
//
// Stripe also redirects here with ?error=access_denied when the user
// bails on the OAuth screen — we surface that and offer a back-to-
// settings link.
//
// Route is /admin/oauth/stripe-callback (fixed path so a single
// redirect_uri can be registered in Stripe Connect platform settings).
// The org slug comes through state.
export default function StripeOauthCallbackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const ranRef = useRef(false);

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const stripeError = searchParams.get("error");
  const stripeErrorDescription = searchParams.get("error_description");

  useEffect(() => {
    // StrictMode double-effect guard — exchanging the same code twice
    // would 400 from Stripe ("code already exchanged").
    if (ranRef.current) return;
    ranRef.current = true;

    if (stripeError) {
      setError(
        stripeErrorDescription
          ? `${stripeError}: ${stripeErrorDescription}`
          : `Stripe returned an error: ${stripeError}`,
      );
      return;
    }
    if (!code || !state) {
      setError("Stripe didn't return the expected code + state parameters.");
      return;
    }

    void (async () => {
      const { data, error: fnErr } = await supabase.functions.invoke(
        "stripe-connect-oauth-callback",
        { body: { code, state } },
      );
      if (fnErr) {
        const ctx = (fnErr as unknown as { context?: Response }).context;
        if (ctx) {
          try {
            const body = (await ctx.json()) as { error?: string };
            setError(body.error ?? fnErr.message);
            return;
          } catch {
            /* fall through */
          }
        }
        setError(fnErr.message);
        return;
      }
      if (!data?.ok || !data?.slug) {
        setError(
          (data as { error?: string })?.error ?? "Unexpected response.",
        );
        return;
      }
      // Success — bounce to the org's Stripe settings page with a
      // success flag so the page can show a "✓ Connected" toast.
      navigate(`/admin/${data.slug}/settings/stripe?from=stripe&kind=oauth`, {
        replace: true,
      });
    })();
  }, [code, state, stripeError, stripeErrorDescription, navigate]);

  return (
    <main style={{ padding: 32, maxWidth: 560, margin: "0 auto" }}>
      {error ? (
        <>
          <h1 style={{ fontSize: 22, marginTop: 0 }}>
            Couldn't finish connecting Stripe
          </h1>
          <div
            style={{
              padding: 12,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 6,
              color: "#991b1b",
              fontSize: 13,
              lineHeight: 1.55,
              marginBottom: 16,
            }}
          >
            {error}
          </div>
          <button
            type="button"
            onClick={() => navigate("/admin")}
            style={{
              padding: "9px 18px",
              background: "#fff",
              color: "#555",
              border: "1px solid #e2e2e2",
              borderRadius: 6,
              fontSize: 13,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Back to organizations
          </button>
        </>
      ) : (
        <>
          <h1 style={{ fontSize: 22, marginTop: 0 }}>Connecting Stripe…</h1>
          <p style={{ color: "#666", fontSize: 14 }}>
            Finishing up the handshake with Stripe — this takes a couple
            of seconds.
          </p>
        </>
      )}
    </main>
  );
}
