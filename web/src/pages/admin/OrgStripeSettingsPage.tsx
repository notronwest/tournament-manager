import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import type { Database } from "../../types/supabase";

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
  const [error, setError] = useState<string | null>(null);
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
    return <div style={{ padding: 24, color: "#666" }}>Loading…</div>;
  }
  if (status === null) {
    return <div style={{ padding: 24, color: "#666" }}>Loading…</div>;
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <Link
        to={`/admin/${org.slug}`}
        style={{ color: "#2563eb", fontSize: 13, textDecoration: "none" }}
      >
        ← {org.name}
      </Link>
      <h1 style={{ fontSize: 24, margin: "12px 0 4px" }}>Stripe Connect</h1>
      <p
        style={{
          margin: 0,
          color: "#666",
          fontSize: 14,
          lineHeight: 1.55,
        }}
      >
        Each organization connects its own Stripe account. Registration
        money lands directly in your account; we collect a small platform
        fee on top. Stripe handles all card data, refunds, and payouts.
      </p>

      <div style={{ marginTop: 22 }}>
        <StripeStatusCard status={status} accountId={accountId} />
      </div>

      {error && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 6,
            color: "#991b1b",
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
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
          <ConnectChoiceCard
            title="Sign in with Stripe"
            blurb="Quick if you already have a Stripe account. Authorize Tournament Manager, and your existing account becomes the destination for tournament payments — no re-entering business info."
            cta={connecting ? "Opening Stripe…" : "Sign in with Stripe →"}
            recommended
            disabled={connecting}
            onClick={() => void onConnect("oauth")}
          />
          <ConnectChoiceCard
            title="Create a new Stripe account"
            blurb="For organizations that don't have Stripe yet. We'll create one for you and walk through the basics (business name, bank info, identity verification) on Stripe's hosted onboarding."
            cta={connecting ? "Opening Stripe…" : "Create a new account →"}
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
              style={primaryBtn(connecting)}
            >
              {connecting
                ? "Opening Stripe…"
                : "Continue Stripe onboarding →"}
            </button>
            <button
              type="button"
              onClick={() => void refreshStatus()}
              disabled={refreshing}
              style={secondaryBtn}
            >
              {refreshing ? "Refreshing…" : "Refresh status"}
            </button>
          </>
        )}
        {(status === "active" || status === "restricted") && (
          <button
            type="button"
            onClick={() => void refreshStatus()}
            disabled={refreshing}
            style={secondaryBtn}
          >
            {refreshing ? "Refreshing…" : "Refresh status"}
          </button>
        )}
        {status === "restricted" && (
          <a
            href="https://dashboard.stripe.com/"
            target="_blank"
            rel="noreferrer"
            style={{ ...secondaryBtn, textDecoration: "none" }}
          >
            Open Stripe dashboard ↗
          </a>
        )}
      </div>

      <details
        style={{
          marginTop: 24,
          padding: "10px 14px",
          background: "#fafafa",
          border: "1px solid #e5e7eb",
          borderRadius: 6,
          fontSize: 12,
          color: "#555",
          lineHeight: 1.55,
        }}
      >
        <summary style={{ cursor: "pointer", fontWeight: 500 }}>
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
        position: "relative",
        padding: 16,
        background: "#fff",
        border: `1px solid ${recommended ? "#2563eb" : "#e5e7eb"}`,
        borderRadius: 8,
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
            background: "#2563eb",
            color: "#fff",
            fontSize: 10,
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 3,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Recommended
        </span>
      )}
      <div style={{ fontSize: 15, fontWeight: 600, color: "#222" }}>
        {title}
      </div>
      <div style={{ fontSize: 13, color: "#555", lineHeight: 1.55, flex: 1 }}>
        {blurb}
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        style={{
          padding: "9px 14px",
          background: disabled ? "#9ca3af" : "#2563eb",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 500,
          cursor: disabled ? "not-allowed" : "pointer",
          fontFamily: "inherit",
          marginTop: 4,
        }}
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
      bg: "#fffbeb",
      border: "#fde68a",
      fg: "#7a5d00",
      label: "Not connected",
      desc:
        "No Stripe account is linked yet. Until one is connected, registrations save as 'paid' without actually charging — fine for testing, not for production.",
    },
    pending: {
      bg: "#fef3c7",
      border: "#fde68a",
      fg: "#92400e",
      label: "Onboarding in progress",
      desc:
        "Your Stripe account exists but verification isn't complete. Either continue onboarding or refresh below to pull the latest status.",
    },
    active: {
      bg: "#dcfce7",
      border: "#bbf7d0",
      fg: "#166534",
      label: "✓ Stripe connected",
      desc:
        "Your organization is ready to accept payments. Registration money will move directly to your Stripe account.",
    },
    restricted: {
      bg: "#fef2f2",
      border: "#fecaca",
      fg: "#991b1b",
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
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
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

function primaryBtn(busy: boolean): CSSProperties {
  return {
    padding: "10px 22px",
    background: busy ? "#9ca3af" : "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 500,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: "inherit",
  };
}

const secondaryBtn: CSSProperties = {
  padding: "10px 22px",
  background: "#fff",
  color: "#555",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  cursor: "pointer",
  fontFamily: "inherit",
};
