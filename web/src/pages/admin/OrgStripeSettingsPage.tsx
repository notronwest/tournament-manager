import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { ConfirmModal } from "../../components/ConfirmModal";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import type { Database } from "../../types/supabase";
import {
  ink,
  inkSoft,
  bg,
  creamDeep,
  rule,
  courtBlue,
  courtGreen,
  courtRed,
  successBg,
  successFg,
  warnBg,
  warnFg,
  dangerBg,
  dangerFg,
  monoFontStack,
  bodyFontStack,
  breadcrumbLinkStyle,
  pageH1Style,
  pageSubStyle,
  panelMutedStyle,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  statusPanelStyle,
} from "../../lib/publicTheme";

type StripeStatus = Database["public"]["Enums"]["org_stripe_status"];

// Per-org Stripe Connect dashboard. Shows the current connection
// status, drives the hosted-onboarding flow, and (when the user
// returns from Stripe with ?from=stripe) pulls the live account
// state and updates org.stripe_account_status to match.
//
// Lives at /admin/:orgSlug/settings/stripe — gated by AdminLayout
// (org membership or platform-admin override).
export default function OrgStripeSettingsPage() {
  const { org } = useCurrentOrg();
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState<StripeStatus | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live Stripe-side diagnostics from the most recent refresh — so
  // when status isn't active we can show the organizer WHY (which
  // requirements are due, what Stripe's disabled_reason actually
  // says, etc.) and link them to fix it.
  const [diagnostics, setDiagnostics] = useState<{
    chargesEnabled: boolean;
    detailsSubmitted: boolean;
    disabledReason: string | null;
  } | null>(null);
  const cameFromStripe = searchParams.get("from") === "stripe";

  // Hydrate from the org row. useCurrentOrg already fetched it.
  useEffect(() => {
    if (!org) return;
    setStatus(org.stripe_account_status);
    setAccountId(org.stripe_account_id);
  }, [org]);

  const refreshStatus = useCallback(async () => {
    if (!org) return;
    setError(null);
    setRefreshing(true);
    const { data, error: fnErr } = await supabase.functions.invoke(
      "stripe-account-status-refresh",
      { body: { orgSlug: org.slug } },
    );
    setRefreshing(false);
    if (fnErr) {
      setError(await extractError(fnErr));
      return;
    }
    if (data?.status) setStatus(data.status as StripeStatus);
    if (data && typeof data === "object" && "chargesEnabled" in data) {
      setDiagnostics({
        chargesEnabled: !!data.chargesEnabled,
        detailsSubmitted: !!data.detailsSubmitted,
        disabledReason: (data.disabledReason as string | null) ?? null,
      });
    }
  }, [org]);

  // When the user comes back from Stripe (return_url or refresh_url
  // both land here with ?from=stripe), poll the account once so the
  // status reflects what they just did. Strip the query param after
  // so a manual refresh of the page doesn't keep re-polling.
  useEffect(() => {
    if (!cameFromStripe || !org) return;
    void refreshStatus().then(() => {
      const next = new URLSearchParams(searchParams);
      next.delete("from");
      next.delete("kind");
      setSearchParams(next, { replace: true });
    });
  }, [cameFromStripe, org, refreshStatus, searchParams, setSearchParams]);

  // Clears the org's Stripe link locally (resets stripe_account_id +
  // status to not_connected). Does NOT delete the underlying Stripe
  // account — that lives on Stripe's side and can be cleaned up from
  // their dashboard if needed. After disconnect the picker reappears
  // and the org can choose OAuth or Express afresh.
  //
  // RLS: org admins (and platform admins via has_org_role) can update
  // the organizations row, so this works as a direct client write.
  const onDisconnect = async () => {
    if (!org) return;
    setError(null);
    setDisconnecting(true);
    const { error: updErr } = await supabase
      .from("organizations")
      .update({
        stripe_account_id: null,
        stripe_account_status: "not_connected",
      })
      .eq("id", org.id);
    setDisconnecting(false);
    setConfirmDisconnect(false);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    setStatus("not_connected");
    setAccountId(null);
  };

  const onConnect = async (mode: "oauth" | "express") => {
    if (!org) return;
    setError(null);
    setConnecting(true);
    const { data, error: fnErr } = await supabase.functions.invoke(
      "stripe-connect-onboarding",
      {
        body: {
          orgSlug: org.slug,
          baseUrl: window.location.origin,
          mode,
        },
      },
    );
    if (fnErr) {
      setConnecting(false);
      setError(await extractError(fnErr));
      return;
    }
    if (!data?.onboardingUrl) {
      setConnecting(false);
      setError(
        (data as { error?: string })?.error ??
          "No onboarding URL returned from Stripe.",
      );
      return;
    }
    // Redirect to Stripe — either their OAuth screen or the hosted
    // onboarding flow. We stay in "connecting" state so the button
    // is disabled during the brief gap before the browser actually
    // navigates away.
    window.location.href = data.onboardingUrl as string;
  };

  if (!org) {
    return <div style={{ padding: 24, color: inkSoft, fontFamily: bodyFontStack }}>Loading…</div>;
  }
  if (status === null) {
    return <div style={{ padding: 24, color: inkSoft, fontFamily: bodyFontStack }}>Loading…</div>;
  }

  return (
    <div style={{ maxWidth: 720, fontFamily: bodyFontStack }}>
      <Link to={`/admin/${org.slug}`} style={breadcrumbLinkStyle}>
        ← {org.name}
      </Link>
      <h1 style={{ ...pageH1Style, fontSize: 24, margin: "12px 0 4px" }}>Stripe Connect</h1>
      <p style={pageSubStyle}>
        Each organization connects its own Stripe account. Registration
        money lands directly in your account; we collect a small platform
        fee on top. Stripe handles all card data, refunds, and payouts.
      </p>

      <div style={{ marginTop: 22 }}>
        <StripeStatusCard status={status} accountId={accountId} />
      </div>

      {error && (
        <div style={{ ...statusPanelStyle("danger"), marginTop: 16 }}>
          {error}
        </div>
      )}

      {status === "not_connected" && (
        <div
          style={{
            marginTop: 18,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 12,
          }}
        >
          {/* Express (hosted onboarding via Account Links) is the only path:
              Stripe deprecated OAuth for Standard Connect on new platforms, so
              it can't be enabled in prod — exposing it was a dead end (it 500s
              on the missing STRIPE_CONNECT_CLIENT_ID). */}
          <ConnectChoiceCard
            title="Connect your Stripe account"
            blurb="We'll set up your organization's payout account through Stripe's hosted onboarding — business name, bank info, and identity verification. It takes a few minutes, and you can pause and resume."
            cta={connecting ? "Opening Stripe…" : "Set up Stripe →"}
            disabled={connecting}
            onClick={() => void onConnect("express")}
          />
        </div>
      )}

      <div
        style={{
          marginTop: 18,
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        {status === "pending" && (
          <>
            {/* Continue an in-progress Express onboarding — re-issues
                an AccountLink to the existing account. */}
            <button
              type="button"
              onClick={() => void onConnect("express")}
              disabled={connecting}
              style={connecting ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
            >
              {connecting
                ? "Opening Stripe…"
                : "Continue Stripe onboarding →"}
            </button>
            <button
              type="button"
              onClick={() => void refreshStatus()}
              disabled={refreshing}
              style={refreshing ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
            >
              {refreshing ? "Refreshing…" : "Refresh status"}
            </button>
          </>
        )}
        {status === "restricted" && (
          <button
            type="button"
            onClick={() => void onConnect("express")}
            disabled={connecting}
            style={connecting ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
          >
            {connecting ? "Opening Stripe…" : "Continue Stripe onboarding →"}
          </button>
        )}
        {(status === "active" || status === "restricted") && (
          <button
            type="button"
            onClick={() => void refreshStatus()}
            disabled={refreshing}
            style={refreshing ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
          >
            {refreshing ? "Refreshing…" : "Refresh status"}
          </button>
        )}
        {status === "restricted" && accountId && (
          <a
            href={`https://dashboard.stripe.com/test/connect/accounts/${accountId}`}
            target="_blank"
            rel="noreferrer"
            style={stripeExternalLinkStyle}
          >
            Open this account in Stripe ↗
          </a>
        )}
        {status !== "not_connected" && (
          <button
            type="button"
            onClick={() => setConfirmDisconnect(true)}
            disabled={disconnecting}
            style={disconnectBtnStyle}
          >
            Disconnect Stripe
          </button>
        )}
      </div>

      {diagnostics && status !== "active" && status !== "not_connected" && (
        <div
          style={{
            ...panelMutedStyle,
            marginTop: 14,
            fontSize: 12,
            color: inkSoft,
            fontFamily: monoFontStack,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4, color: ink }}>
            Stripe says
          </div>
          <div>charges_enabled: {String(diagnostics.chargesEnabled)}</div>
          <div>details_submitted: {String(diagnostics.detailsSubmitted)}</div>
          {diagnostics.disabledReason && (
            <div>disabled_reason: {diagnostics.disabledReason}</div>
          )}
          <div
            style={{
              marginTop: 8,
              fontFamily: bodyFontStack,
              color: inkSoft,
            }}
          >
            {diagnostics.chargesEnabled
              ? "Charges are enabled — refresh again to flip status to active."
              : diagnostics.detailsSubmitted
                ? "All details submitted, but Stripe hasn't enabled charges yet. Usually means a verification step is still under review or a required field was missed — Continue onboarding above to fix."
                : "Onboarding wasn't fully completed. Click Continue onboarding above to finish."}
          </div>
        </div>
      )}

      <details
        style={{
          ...panelMutedStyle,
          marginTop: 24,
          fontSize: 12,
          color: inkSoft,
        }}
      >
        <summary style={{ cursor: "pointer", fontWeight: 500, color: ink }}>
          How does Stripe Connect work?
        </summary>
        <div style={{ marginTop: 8 }}>
          When a player pays for a registration, Stripe routes the money
          directly to your organization's account ("destination charge").
          We add a small platform fee on top — that's how Tournament
          Manager pays for itself. You see every transaction in your own
          Stripe dashboard, can issue refunds yourself, and own the
          payout schedule. Test-mode connections use fake bank info so
          you can try the whole flow without committing real money.
        </div>
      </details>

      {confirmDisconnect && (
        <ConfirmModal
          title="Disconnect Stripe?"
          body={
            <>
              This unlinks <strong>{org?.name}</strong> from its Stripe
              account ({accountId ?? "—"}). After disconnect you can
              reconnect with either OAuth (sign in) or a new Express
              account. The Stripe account itself isn't deleted — it
              still exists in your Stripe dashboard if you want to
              clean it up separately.
            </>
          }
          confirmLabel={disconnecting ? "Disconnecting…" : "Disconnect"}
          onCancel={() => setConfirmDisconnect(false)}
          onConfirm={onDisconnect}
        />
      )}
    </div>
  );
}

// ─── status card ─────────────────────────────────────────────────────

// One of the two cards in the not-connected picker: "Sign in with
// Stripe" vs. "Create a new Stripe account."
function ConnectChoiceCard({
  title,
  blurb,
  cta,
  recommended,
  disabled,
  onClick,
}: {
  title: string;
  blurb: string;
  cta: string;
  recommended?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      style={{
        ...panelMutedStyle,
        position: "relative",
        border: `1px solid ${recommended ? courtBlue : rule}`,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {recommended && (
        <span
          style={{
            position: "absolute",
            top: -10,
            left: 12,
            background: courtBlue,
            color: bg,
            fontSize: 10,
            fontWeight: 700,
            padding: "2px 8px",
            borderRadius: 3,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            fontFamily: "inherit",
          }}
        >
          Recommended
        </span>
      )}
      <div style={{ fontSize: 15, fontWeight: 600, color: ink }}>
        {title}
      </div>
      <div style={{ fontSize: 13, color: inkSoft, lineHeight: 1.55, flex: 1 }}>
        {blurb}
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        style={disabled ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
      >
        {cta}
      </button>
    </div>
  );
}

function StripeStatusCard({
  status,
  accountId,
}: {
  status: StripeStatus;
  accountId: string | null;
}) {
  const palette: Record<
    StripeStatus,
    { bg: string; border: string; fg: string; label: string; desc: string }
  > = {
    not_connected: {
      bg: warnBg,
      border: creamDeep,
      fg: warnFg,
      label: "Not connected",
      desc:
        "No Stripe account is linked yet. Until one is connected, registrations save as 'paid' without actually charging — fine for testing, not for production.",
    },
    pending: {
      bg: warnBg,
      border: creamDeep,
      fg: warnFg,
      label: "Onboarding in progress",
      desc:
        "Your Stripe account exists but verification isn't complete. Either continue onboarding or refresh below to pull the latest status.",
    },
    active: {
      bg: successBg,
      border: courtGreen,
      fg: successFg,
      label: "✓ Stripe connected",
      desc:
        "Your organization is ready to accept payments. Registration money will move directly to your Stripe account.",
    },
    restricted: {
      bg: dangerBg,
      border: courtRed,
      fg: dangerFg,
      label: "⚠ Account restricted",
      desc:
        "Stripe has restricted this account — usually missing verification or a compliance flag. Resolve from your Stripe dashboard, then come back and refresh.",
    },
  };
  const p = palette[status];
  return (
    <div
      style={{
        padding: 14,
        background: p.bg,
        border: `1px solid ${p.border}`,
        borderRadius: 8,
      }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: p.fg,
          marginBottom: 6,
        }}
      >
        {p.label}
      </div>
      <div style={{ fontSize: 13, color: p.fg, lineHeight: 1.55 }}>
        {p.desc}
      </div>
      {accountId && (
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: p.fg,
            opacity: 0.7,
            fontFamily: monoFontStack,
          }}
        >
          Account: {accountId}
        </div>
      )}
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────

async function extractError(fnErr: unknown): Promise<string> {
  // supabase.functions.invoke surfaces a FunctionsError whose
  // `.context` carries the underlying Response — that's where our
  // edge functions put their JSON `{ error: "..." }` body.
  const ctxFromUnknown = (fnErr as { context?: Response }).context;
  if (ctxFromUnknown) {
    try {
      const body = (await ctxFromUnknown.json()) as { error?: string };
      if (body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return (fnErr as { message?: string }).message ?? "Unknown error.";
}

// ─── styles ──────────────────────────────────────────────────────────

const stripeExternalLinkStyle: CSSProperties = {
  ...ctaPrimaryStyle,
  textDecoration: "none",
  background: "transparent",
  color: ink,
  boxShadow: `inset 0 0 0 2px ${ink}`,
};

const disconnectBtnStyle: CSSProperties = {
  padding: "10px 22px",
  background: "transparent",
  color: courtRed,
  border: `2px solid ${courtRed}`,
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer",
  fontFamily: "inherit",
};

