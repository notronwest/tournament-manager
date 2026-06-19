import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { supabase } from "../../supabase";
import { stripePromise, stripeConfigured } from "../../lib/stripe";
import { formatUsd } from "../../lib/pricing";
import {
  ink,
  inkSoft,
  inkMuted,
  bg,
  rule,
  courtRed,
  courtGreen,
  successBg,
  successFg,
  dangerBg,
  dangerFg,
  bodyFontStack,
  headingFontStack,
  displayFontStack,
} from "../../lib/publicTheme";

// Standalone, anonymous charity donation (#377). No login: the donor enters
// an amount + name + email (+ optional message) and pays by card. The amount
// is re-validated server-side by create-donation-intent; this page only
// guards the UX. On success Stripe emails the donor a receipt and we show a
// thank-you.

const PRESET_CENTS = [1000, 2500, 5000];
const MIN_CENTS = 100;
const MAX_CENTS = 100_000_00;

type TournamentLite = {
  id: string;
  name: string;
  status: string;
  accepts_donations: boolean;
  donation_prompt: string | null;
  organizations: { name: string; slug: string } | null;
};

type Phase = "form" | "pay" | "done";

export default function DonatePage() {
  const { orgSlug, tournamentSlug } = useParams<{
    orgSlug: string;
    tournamentSlug: string;
  }>();

  const [tournament, setTournament] = useState<TournamentLite | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Form state.
  const [amountCents, setAmountCents] = useState<number>(2500);
  const [customDollars, setCustomDollars] = useState("");
  const [usingCustom, setUsingCustom] = useState(false);
  const [donorName, setDonorName] = useState("");
  const [donorEmail, setDonorEmail] = useState("");
  const [message, setMessage] = useState("");

  // Flow state.
  const [phase, setPhase] = useState<Phase>("form");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      const { data, error } = await supabase
        .from("tournaments")
        .select(
          "id, name, status, accepts_donations, donation_prompt, organizations(name, slug)",
        )
        .eq("slug", tournamentSlug ?? "")
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setLoadError(error.message);
      } else if (!data) {
        setLoadError("Tournament not found.");
      } else {
        setTournament(data as unknown as TournamentLite);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tournamentSlug]);

  // Resolve the effective amount (preset or custom), validated to bounds.
  const effectiveCents = useMemo(() => {
    if (!usingCustom) return amountCents;
    const dollars = Number(customDollars);
    if (!Number.isFinite(dollars)) return NaN;
    return Math.round(dollars * 100);
  }, [usingCustom, amountCents, customDollars]);

  const amountValid =
    Number.isInteger(effectiveCents) &&
    effectiveCents >= MIN_CENTS &&
    effectiveCents <= MAX_CENTS;

  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(donorEmail.trim());
  const formValid = amountValid && donorName.trim().length > 0 && looksLikeEmail;

  const startPayment = async (e: FormEvent) => {
    e.preventDefault();
    if (!formValid || !tournament) return;
    setFormError(null);
    setSubmitting(true);
    const { data, error: fnErr } = await supabase.functions.invoke(
      "create-donation-intent",
      {
        body: {
          orgSlug,
          tournamentSlug,
          amountCents: effectiveCents,
          donorName: donorName.trim(),
          donorEmail: donorEmail.trim(),
          message: message.trim() || undefined,
          baseUrl: window.location.origin,
        },
      },
    );
    setSubmitting(false);
    const res = data as { clientSecret?: string; error?: string } | null;
    const cs = res?.clientSecret;
    if (fnErr || !cs) {
      const code = await readEdgeErrorCode(fnErr, data);
      setFormError(donationErrorMessage(code));
      return;
    }
    setClientSecret(cs);
    setPhase("pay");
  };

  if (loading) {
    return (
      <Wrap>
        <p style={{ color: inkSoft, fontFamily: bodyFontStack }}>Loading…</p>
      </Wrap>
    );
  }

  if (loadError || !tournament) {
    return (
      <Wrap>
        <h1 style={h1Style}>Donate</h1>
        <Panel tone="danger">{loadError ?? "Tournament not found."}</Panel>
        <BackLink orgSlug={orgSlug} tournamentSlug={tournamentSlug} />
      </Wrap>
    );
  }

  const orgName = tournament.organizations?.name ?? "the organizer";

  // Donations turned off (or unpublished, or Stripe not set up) — never show
  // a payable form. The server enforces this too.
  if (!tournament.accepts_donations || tournament.status !== "published") {
    return (
      <Wrap>
        <h1 style={h1Style}>Donate</h1>
        <Panel tone="muted">
          {tournament.name} isn’t accepting donations right now.
        </Panel>
        <BackLink orgSlug={orgSlug} tournamentSlug={tournamentSlug} />
      </Wrap>
    );
  }

  if (!stripeConfigured) {
    return (
      <Wrap>
        <h1 style={h1Style}>Donate</h1>
        <Panel tone="danger">
          Payments aren’t configured. Please try again later.
        </Panel>
        <BackLink orgSlug={orgSlug} tournamentSlug={tournamentSlug} />
      </Wrap>
    );
  }

  if (phase === "done") {
    return (
      <Wrap>
        <h1 style={h1Style}>Thank you ♥</h1>
        <Panel tone="success">
          Your {formatUsd(effectiveCents)} donation to {orgName} went through.
          A receipt is on its way to {donorEmail.trim()}.
        </Panel>
        <BackLink orgSlug={orgSlug} tournamentSlug={tournamentSlug} />
      </Wrap>
    );
  }

  return (
    <Wrap>
      <h1 style={h1Style}>Donate to {tournament.name}</h1>
      {tournament.donation_prompt && (
        <p
          style={{
            margin: "0 0 20px",
            color: inkSoft,
            fontSize: 15,
            fontFamily: bodyFontStack,
            lineHeight: 1.5,
          }}
        >
          {tournament.donation_prompt}
        </p>
      )}
      <p
        style={{
          margin: "0 0 24px",
          color: inkMuted,
          fontSize: 13,
          fontFamily: bodyFontStack,
        }}
      >
        100% of your donation (minus card-processing fees) goes to {orgName}.
      </p>

      {phase === "form" && (
        <form
          onSubmit={(e) => void startPayment(e)}
          style={{ display: "flex", flexDirection: "column", gap: 16 }}
        >
          <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
            <legend style={labelStyle}>Amount</legend>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {PRESET_CENTS.map((c) => {
                const active = !usingCustom && amountCents === c;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      setUsingCustom(false);
                      setAmountCents(c);
                    }}
                    style={active ? amountBtnActive : amountBtn}
                  >
                    {formatUsd(c)}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setUsingCustom(true)}
                style={usingCustom ? amountBtnActive : amountBtn}
              >
                Custom
              </button>
            </div>
            {usingCustom && (
              <div style={{ marginTop: 10, position: "relative", maxWidth: 200 }}>
                <span
                  style={{
                    position: "absolute",
                    left: 12,
                    top: "50%",
                    transform: "translateY(-50%)",
                    color: inkMuted,
                    fontFamily: bodyFontStack,
                  }}
                >
                  $
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="1"
                  max="100000"
                  step="1"
                  value={customDollars}
                  onChange={(e) => setCustomDollars(e.target.value)}
                  placeholder="50"
                  style={{ ...fieldStyle, paddingLeft: 24 }}
                />
              </div>
            )}
            {usingCustom && customDollars !== "" && !amountValid && (
              <p style={{ ...errorTextStyle, marginTop: 6 }}>
                Enter an amount between $1 and $100,000.
              </p>
            )}
          </fieldset>

          <label style={fieldWrap}>
            <span style={labelStyle}>Your name</span>
            <input
              type="text"
              required
              value={donorName}
              onChange={(e) => setDonorName(e.target.value)}
              style={fieldStyle}
            />
          </label>

          <label style={fieldWrap}>
            <span style={labelStyle}>Email (for your receipt)</span>
            <input
              type="email"
              required
              value={donorEmail}
              onChange={(e) => setDonorEmail(e.target.value)}
              style={fieldStyle}
            />
          </label>

          <label style={fieldWrap}>
            <span style={labelStyle}>Message (optional)</span>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              maxLength={1000}
              style={{ ...fieldStyle, resize: "vertical" }}
            />
          </label>

          {formError && <Panel tone="danger">{formError}</Panel>}

          <button
            type="submit"
            disabled={!formValid || submitting}
            style={formValid && !submitting ? ctaStyle : ctaDisabledStyle}
          >
            {submitting
              ? "Starting…"
              : amountValid
                ? `Continue — ${formatUsd(effectiveCents)}`
                : "Continue"}
          </button>
          <BackLink orgSlug={orgSlug} tournamentSlug={tournamentSlug} />
        </form>
      )}

      {phase === "pay" && clientSecret && (
        <div>
          <div
            style={{
              marginBottom: 16,
              padding: "12px 14px",
              background: bg,
              border: `1px solid ${rule}`,
              borderRadius: 8,
              fontFamily: bodyFontStack,
              fontSize: 14,
              color: ink,
            }}
          >
            Donating <strong>{formatUsd(effectiveCents)}</strong> to {orgName}.
          </div>
          <Elements
            stripe={stripePromise}
            options={{ clientSecret, appearance: { theme: "stripe" } }}
          >
            <DonationPaymentForm
              amountCents={effectiveCents}
              onConfirmed={() => setPhase("done")}
              onError={setFormError}
              onBack={() => {
                setClientSecret(null);
                setFormError(null);
                setPhase("form");
              }}
            />
          </Elements>
          {formError && (
            <div style={{ marginTop: 12 }}>
              <Panel tone="danger">{formError}</Panel>
            </div>
          )}
        </div>
      )}
    </Wrap>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Payment Element form (inside <Elements>).
// ─────────────────────────────────────────────────────────────────────

function DonationPaymentForm({
  amountCents,
  onConfirmed,
  onError,
  onBack,
}: {
  amountCents: number;
  onConfirmed: () => void;
  onError: (msg: string) => void;
  onBack: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const canPay = ready && !!stripe && !!elements && !submitting;

  const handlePay = async () => {
    if (!stripe || !elements || !ready) return;
    setSubmitting(true);
    onError("");
    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
      confirmParams: { return_url: window.location.href },
    });
    if (error) {
      onError(
        error.message ?? "Your card was declined. Please try a different card.",
      );
      setSubmitting(false);
      return;
    }
    if (
      paymentIntent &&
      (paymentIntent.status === "succeeded" ||
        paymentIntent.status === "processing")
    ) {
      onConfirmed();
      return;
    }
    onError("Payment didn’t complete. Please try again.");
    setSubmitting(false);
  };

  return (
    <div>
      <PaymentElement
        onReady={() => setReady(true)}
        onLoadError={(e) =>
          onError(
            e.error?.message ??
              "Couldn’t load the payment form. Please refresh and try again.",
          )
        }
      />
      <button
        type="button"
        onClick={() => void handlePay()}
        disabled={!canPay}
        style={{
          ...(canPay ? ctaStyle : ctaDisabledStyle),
          width: "100%",
          marginTop: 16,
        }}
      >
        {submitting
          ? "Processing…"
          : !ready
            ? "Loading payment form…"
            : `Donate ${formatUsd(amountCents)} →`}
      </button>
      <button
        type="button"
        onClick={onBack}
        disabled={submitting}
        style={{
          background: "none",
          border: "none",
          color: inkSoft,
          cursor: submitting ? "not-allowed" : "pointer",
          fontFamily: bodyFontStack,
          fontSize: 13,
          textDecoration: "underline",
          width: "100%",
          padding: "10px 0 0",
          textAlign: "center",
        }}
      >
        Back
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bits
// ─────────────────────────────────────────────────────────────────────

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: bg,
        padding: "48px 20px",
      }}
    >
      <div style={{ maxWidth: 520, margin: "0 auto" }}>{children}</div>
    </div>
  );
}

function BackLink({
  orgSlug,
  tournamentSlug,
}: {
  orgSlug?: string;
  tournamentSlug?: string;
}) {
  return (
    <div style={{ marginTop: 20 }}>
      <Link
        to={`/t/${orgSlug}/${tournamentSlug}`}
        style={{
          fontSize: 13,
          color: inkSoft,
          textDecoration: "none",
          fontFamily: headingFontStack,
        }}
      >
        ← Back to {tournamentSlug ? "tournament" : "event"}
      </Link>
    </div>
  );
}

function Panel({
  tone,
  children,
}: {
  tone: "success" | "danger" | "muted";
  children: React.ReactNode;
}) {
  const palette =
    tone === "success"
      ? { bg: successBg, fg: successFg, border: courtGreen }
      : tone === "danger"
        ? { bg: dangerBg, fg: dangerFg, border: courtRed }
        : { bg: "#ffffff", fg: inkSoft, border: rule };
  return (
    <div
      style={{
        padding: 14,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 8,
        color: palette.fg,
        fontSize: 14,
        fontFamily: bodyFontStack,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

// Maps the create-donation-intent error codes to user-safe copy. Never
// surface the raw SDK/Stripe string.
function donationErrorMessage(code: string | null): string {
  switch (code) {
    case "amount_out_of_bounds":
    case "invalid_amount":
      return "Please enter an amount between $1 and $100,000.";
    case "invalid_email":
      return "Please enter a valid email for your receipt.";
    case "donor_name_required":
      return "Please enter your name.";
    case "donations_not_enabled":
    case "tournament_not_accepting_donations":
      return "This tournament isn’t accepting donations right now.";
    case "org_stripe_not_active":
      return "The organizer can’t accept donations yet. Please check back later.";
    case "tournament_not_found":
      return "We couldn’t find this tournament.";
    default:
      return "Something went wrong starting your donation. Please try again.";
  }
}

// Pulls the structured { error: code } out of a supabase functions.invoke
// failure. On a non-2xx the SDK leaves `data` null and stashes the real
// response in err.context (a Response). Mirrors CheckoutPage's reader.
async function readEdgeErrorCode(
  err: unknown,
  data: unknown,
): Promise<string | null> {
  const fromData = (data as { error?: string } | null)?.error;
  if (fromData) return fromData;
  const ctx = (err as { context?: unknown } | null)?.context;
  if (ctx && typeof (ctx as Response).json === "function") {
    try {
      const body = await (ctx as Response).json();
      if (body && typeof body.error === "string") return body.error;
    } catch {
      // fall through
    }
  }
  return null;
}

// ─── styles ──────────────────────────────────────────────────────────

const h1Style: React.CSSProperties = {
  margin: "0 0 12px",
  fontSize: 26,
  fontFamily: displayFontStack,
  color: ink,
};

const fieldWrap: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  color: inkSoft,
  fontFamily: bodyFontStack,
  fontWeight: 600,
};

const fieldStyle: React.CSSProperties = {
  padding: "10px 12px",
  border: `1px solid ${rule}`,
  borderRadius: 6,
  fontSize: 15,
  fontFamily: bodyFontStack,
  color: ink,
  background: "#ffffff",
  width: "100%",
};

const amountBtn: React.CSSProperties = {
  padding: "10px 16px",
  border: `1px solid ${rule}`,
  borderRadius: 8,
  background: "#ffffff",
  color: ink,
  fontSize: 15,
  fontFamily: headingFontStack,
  cursor: "pointer",
};

const amountBtnActive: React.CSSProperties = {
  ...amountBtn,
  border: `2px solid ${courtRed}`,
  color: courtRed,
  fontWeight: 700,
};

const ctaStyle: React.CSSProperties = {
  padding: "14px 22px",
  background: courtRed,
  color: "#ffffff",
  border: "none",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 700,
  fontFamily: headingFontStack,
  letterSpacing: "0.03em",
  textTransform: "uppercase",
  cursor: "pointer",
  textAlign: "center",
};

const ctaDisabledStyle: React.CSSProperties = {
  ...ctaStyle,
  background: inkMuted,
  cursor: "not-allowed",
};

const errorTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: dangerFg,
  fontFamily: bodyFontStack,
};
