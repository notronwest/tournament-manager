import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import { usePendingPayments } from "../../components/PendingPaymentsContext";
import {
  computeLineItems,
  formatUsd,
  type LineItem,
} from "../../lib/pricing";
import {
  pickActivePricingTier,
  type PricingTier,
} from "../../lib/pricingTiers";
import {
  contentColStyle,
  courtBlue,
  courtGreen,
  courtRed,
  cream,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  ctaSecondaryStyle,
  displayFontStack,
  headingFontStack,
  ink,
  inkSoft,
  inkMuted,
  pageH1Style,
  pageWrapStyle,
  rule,
  ruleSoft,
  statusPanelStyle,
} from "../../lib/publicTheme";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { stripePromise, stripeConfigured } from "../../lib/stripe";
import { trackEvent } from "../../lib/analytics";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];

// Per-event row loaded for the checkout. Carries enough to display
// the event + its current partner state and to fire the partner
// invite email at pay-time.
type PendingRow = {
  regId: string;
  eventId: string;
  eventName: string;
  format: Database["public"]["Enums"]["event_format"];
  partner_status: Database["public"]["Enums"]["partner_status"];
  eventFeeCentsOverride: number;
  // Doubles only. The pending outbound invite created at register
  // time. We fire its email after Stripe takes payment (which is
  // a placeholder for now — see comment in onPay).
  inviteId: string | null;
  partnerLabel: string | null;
  partnerEmail: string | null;
};

// Checkout page at /t/:orgSlug/:tournamentSlug/checkout.
//
// Reads the user's pending_payment registrations for THIS tournament,
// renders them as a review + sticky order summary, and on Pay flips
// each pending reg → 'paid' (with the computed cents snapshotted)
// and fires partner-invite emails for doubles regs.
//
// Payment flow (Stripe Connect destination charge):
//   1. "Continue to payment" calls the create-payment-intent edge
//      function, which computes the authoritative total server-side and
//      returns a clientSecret.
//   2. The Stripe Payment Element renders; the player confirms the card.
//   3. The stripe-webhook edge function (source of truth) flips the
//      registrations pending_payment → paid. The client polls for that
//      flip, then shows the success view. The client never flips status
//      itself.
export default function CheckoutPage() {
  const { orgSlug, tournamentSlug } = useParams<{
    orgSlug: string;
    tournamentSlug: string;
  }>();
  const { user } = useAuth();
  const { refresh: refreshPending } = usePendingPayments();
  const navigate = useNavigate();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  // The tournament's pricing tiers. Loaded alongside the tournament.
  // The active tier (today vs. tier windows) supplies first-event and
  // additional-event fees to computeLineItems — which then snapshots
  // those values onto event_registrations.event_fee_cents at pay-time,
  // locking the price for this checkout regardless of future tier
  // changes.
  const [tiers, setTiers] = useState<PricingTier[]>([]);
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Stripe payment phase. Once create-payment-intent succeeds we hold
  // its clientSecret and render the Payment Element. creatingIntent
  // covers step 1; finalizing covers the post-confirm webhook poll.
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  // The payment row id returned by create-payment-intent. Needed to
  // load the receipt line items from payment_line_items after the
  // webhook confirms.
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [creatingIntent, setCreatingIntent] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  // The structured error code behind paymentError (null for Stripe-element
  // errors). Lets us make specific failures actionable — e.g. an
  // org_stripe_not_active offers a prefilled "message the organizer" link.
  const [paymentErrorCode, setPaymentErrorCode] = useState<string | null>(null);
  // Set when Stripe returns a card-error / decline. Shows a dedicated
  // "payment declined" panel instead of the inline error banner.
  const [paymentDeclined, setPaymentDeclined] = useState<string | null>(null);
  // True when the player already has a paid registration in this
  // tournament from a prior session. Drives the additional-only
  // pricing path in computeLineItems.
  const [alreadyHasPaidEvent, setAlreadyHasPaidEvent] = useState(false);

  // Coupon code (#30). validate_coupon is a read-only RPC for the live
  // preview; create-payment-intent re-validates + applies the code
  // authoritatively at pay-time (and redeem_coupon increments uses via
  // the webhook), so this client-side number is UX only — never trusted
  // for the actual charge.
  const [couponInput, setCouponInput] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<
    { code: string; discountCents: number } | null
  >(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [couponChecking, setCouponChecking] = useState(false);

  // After Pay succeeds we render the receipt view. doneEventNames
  // carries the confirmed events; receiptItems holds the server-side
  // line-item breakdown loaded from payment_line_items.
  const [doneEventNames, setDoneEventNames] = useState<string[] | null>(
    null,
  );
  // Set when payment was taken but the reg flip wasn't observed in the
  // poll window. Shows a "processing" state instead of success so the
  // player isn't falsely told they're confirmed.
  const [processingEventNames, setProcessingEventNames] = useState<
    string[] | null
  >(null);
  const [receiptItems, setReceiptItems] = useState<
    { description: string; amount_cents: number }[]
  >([]);

  const reload = useCallback(async () => {
    if (!orgSlug || !tournamentSlug || !user) return;
    setLoading(true);
    setError(null);

    // Resolve org → tournament so we can scope the pending query
    // and have a tournament object for the pricing helper.
    const { data: org } = await supabase
      .from("organizations")
      .select("id")
      .eq("slug", orgSlug)
      .is("deleted_at", null)
      .maybeSingle();
    if (!org) {
      setError("Organization not found.");
      setLoading(false);
      return;
    }
    const { data: t } = await supabase
      .from("tournaments")
      .select("*")
      .eq("organization_id", org.id)
      .eq("slug", tournamentSlug)
      .is("deleted_at", null)
      .maybeSingle();
    if (!t) {
      setError("Tournament not found.");
      setLoading(false);
      return;
    }
    setTournament(t);

    // Load pricing tiers alongside the tournament. computeLineItems
    // below reads the active tier's first-event + additional-event
    // fees, and the price snapshot on pay-time uses those same values.
    const { data: tierRows } = await supabase
      .from("tournament_pricing_tiers")
      .select("*")
      .eq("tournament_id", t.id)
      .order("sort_order", { ascending: true });
    setTiers(tierRows ?? []);

    // Find my player id, then load my pending regs joined to event
    // info + any pending outbound invite (for partner display +
    // post-pay email send).
    const { data: me } = await supabase
      .from("players")
      .select("id")
      .eq("auth_user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!me) {
      setRows([]);
      setLoading(false);
      return;
    }

    const { data: regs, error: regsErr } = await supabase
      .from("event_registrations")
      .select(
        `id, event_id, partner_status, partner_registration_id,
         event:events!event_id (id, name, format, event_fee_cents)`,
      )
      .eq("player_id", me.id)
      .eq("status", "pending_payment")
      .is("deleted_at", null);
    if (regsErr) {
      setError("We couldn't load your registrations. Please refresh and try again.");
      setLoading(false);
      return;
    }

    // Filter to events that belong to THIS tournament. The query
    // above doesn't constrain by tournament_id directly, so we do
    // it in JS off the joined event.
    type RegRow = {
      id: string;
      event_id: string;
      partner_status: Database["public"]["Enums"]["partner_status"];
      partner_registration_id: string | null;
      event: {
        id: string;
        name: string;
        format: Database["public"]["Enums"]["event_format"];
        event_fee_cents: number;
      } | null;
    };
    const allRegs = (regs ?? []) as unknown as RegRow[];
    const eventIdsThisTournament = new Set<string>();
    // We need the event.tournament_id to filter — fetch in a second
    // query since the embed above is one level only.
    const { data: evMeta } = await supabase
      .from("events")
      .select("id, tournament_id")
      .in(
        "id",
        allRegs.map((r) => r.event_id),
      );
    for (const e of evMeta ?? []) {
      if (e.tournament_id === t.id) eventIdsThisTournament.add(e.id);
    }
    const mine = allRegs.filter((r) => eventIdsThisTournament.has(r.event_id));

    if (mine.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }

    // Resolve each doubles reg's partner via partner_invites — readable by
    // BOTH parties (sender or recipient), unlike the partner's
    // event_registrations row (own-rows-only RLS, so the invitee can't read
    // the inviter's reg). We pull invites in EITHER direction, pending OR
    // accepted, and the partner is simply whichever side of the invite isn't
    // me. This covers:
    //   * outbound pending (I invited, not yet accepted) → partner = invitee,
    //     and we keep the invite id for the deferred pay-time email.
    //   * accepted, either direction (they accepted my invite, OR I accepted
    //     theirs) → partner = the other party; partner_status is 'confirmed'.
    const { data: invites } = await supabase
      .from("partner_invites")
      .select(
        `id, event_id, status, inviter_player_id, invitee_email,
         inviter:players!inviter_player_id (first_name, last_name),
         invitee:players!invitee_player_id (first_name, last_name, email)`,
      )
      .or(`inviter_player_id.eq.${me.id},invitee_player_id.eq.${me.id}`)
      .in("status", ["pending", "accepted"])
      .in(
        "event_id",
        mine.map((r) => r.event_id),
      );
    type InviteRow = {
      id: string;
      event_id: string;
      status: string;
      inviter_player_id: string;
      invitee_email: string | null;
      inviter: { first_name: string; last_name: string } | null;
      invitee: {
        first_name: string;
        last_name: string;
        email: string | null;
      } | null;
    };
    // At most one relevant invite per event; prefer an accepted one.
    const inviteByEvent = new Map<string, InviteRow>();
    for (const inv of (invites ?? []) as unknown as InviteRow[]) {
      const existing = inviteByEvent.get(inv.event_id);
      if (
        !existing ||
        (existing.status !== "accepted" && inv.status === "accepted")
      ) {
        inviteByEvent.set(inv.event_id, inv);
      }
    }

    const built: PendingRow[] = mine.map((r) => {
      const inv = inviteByEvent.get(r.event_id);
      const iAmInviter = inv?.inviter_player_id === me.id;
      // Partner = the side of the invite that isn't me.
      const partnerPlayer = inv ? (iAmInviter ? inv.invitee : inv.inviter) : null;
      const partnerLabel = partnerPlayer
        ? `${partnerPlayer.first_name} ${partnerPlayer.last_name}`
        : // outbound invite addressed to an email with no player record yet
          iAmInviter
          ? inv?.invitee_email ?? null
          : null;
      const partnerEmail =
        (iAmInviter ? inv?.invitee?.email ?? inv?.invitee_email : null) ?? null;
      return {
        regId: r.id,
        eventId: r.event_id,
        eventName: r.event?.name ?? "Event",
        format: r.event?.format ?? "singles",
        partner_status: r.partner_status,
        eventFeeCentsOverride: r.event?.event_fee_cents ?? 0,
        // Keep the invite id only for an OUTBOUND PENDING invite (the deferred
        // pay-time email path); once accepted there's nothing left to send.
        inviteId: inv && iAmInviter && inv.status === "pending" ? inv.id : null,
        partnerLabel,
        partnerEmail,
      };
    });
    // Determine whether the player already paid for at least one
    // event in this tournament in a prior session. If so, every
    // pick in this basket is a returning-registrant addition and
    // should be priced at the additional-event rate.
    const { data: paidRegData } = await supabase
      .from("event_registrations")
      .select(`event:events!event_id (tournament_id)`)
      .eq("player_id", me.id)
      .eq("status", "paid")
      .is("deleted_at", null);
    type PaidRegRow = { event: { tournament_id: string } | null };
    const hasPriorPaid = (paidRegData ?? []).some(
      (r) => (r as unknown as PaidRegRow).event?.tournament_id === t.id,
    );
    setAlreadyHasPaidEvent(hasPriorPaid);

    setRows(built);
    setLoading(false);
  }, [orgSlug, tournamentSlug, user]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Compute the line items + total using D's pricing helper, fed
  // by the currently-active pricing tier. The same math runs in
  // PendingPaymentsBar across all open tournaments — here it's
  // localized to this tournament's rows.
  //
  // The tier picked at *render* is the tier whose price gets
  // snapshotted at pay-time. If the user sits on this page across
  // a tier boundary, they'll see the active tier update on next
  // reload — we deliberately don't lock the displayed total until
  // they actually click Pay, which is also when the snapshot lands.
  const activeTier = pickActivePricingTier(tiers);
  const { items: lineItems, totalCents } = tournament && activeTier
    ? computeLineItems(
        rows.map((r) => ({
          id: r.eventId,
          event_fee_cents: r.eventFeeCentsOverride,
        })),
        {
          firstEventFeeCents: activeTier.first_event_fee_cents,
          additionalEventFeeCents: activeTier.additional_event_fee_cents,
        },
        alreadyHasPaidEvent,
      )
    : { items: [] as LineItem[], totalCents: 0 };

  // Coupon discount applied to the post-tier subtotal. Capped at the
  // subtotal so the payable amount never goes below zero.
  const discountCents = appliedCoupon
    ? Math.min(appliedCoupon.discountCents, totalCents)
    : 0;
  const payableCents = Math.max(0, totalCents - discountCents);

  // Block Pay if any doubles row is missing a partner AND is not a
  // seeker — seekers intentionally have no partner yet; they can pay
  // and get matched later.
  const blockingError = rows.find(
    (r) =>
      r.format === "doubles" &&
      r.partner_status !== "seeking" &&
      // a confirmed pairing always has a partner — never block it, even if
      // we couldn't resolve the partner's display name
      r.partner_status !== "confirmed" &&
      !r.partnerLabel,
  );

  // Step 1 — create the PaymentIntent server-side. The edge function
  // computes the authoritative amount (compute_checkout_total), applies
  // the Connect destination charge + platform fee, records a pending
  // payment, and returns a clientSecret. We never send the amount.
  // Apply a coupon: validate (read-only) against the current subtotal and
  // show the discount. The server re-validates at pay-time, so a stale or
  // tampered client value can't change what's actually charged.
  const applyCoupon = async () => {
    const code = couponInput.trim();
    if (!code || !tournament) return;
    setCouponChecking(true);
    setCouponError(null);
    const { data, error: rpcErr } = await supabase.rpc("validate_coupon", {
      p_tournament_id: tournament.id,
      p_code: code,
      p_subtotal_cents: totalCents,
    });
    setCouponChecking(false);
    const res = data as
      | { valid?: boolean; error?: string; discount_cents?: number }
      | null;
    if (rpcErr || !res?.valid) {
      setAppliedCoupon(null);
      setCouponError(couponErrorMessage(res?.error ?? rpcErr?.message));
      return;
    }
    setAppliedCoupon({ code, discountCents: res.discount_cents ?? 0 });
    setCouponError(null);
  };

  const removeCoupon = () => {
    setAppliedCoupon(null);
    setCouponInput("");
    setCouponError(null);
  };

  const startPayment = async () => {
    if (!tournament || rows.length === 0) return;
    setPaymentError(null);
    setPaymentErrorCode(null);
    setCreatingIntent(true);
    trackEvent("checkout_started", {
      tournament_slug: tournamentSlug,
      event_count: rows.length,
    });
    const { data, error: fnErr } = await supabase.functions.invoke(
      "create-payment-intent",
      // baseUrl is stashed in the PaymentIntent metadata so the webhook
      // can build partner-invite accept links from this same origin (#191).
      {
        body: {
          orgSlug,
          tournamentSlug,
          baseUrl: window.location.origin,
          couponCode: appliedCoupon?.code,
        },
      },
    );
    setCreatingIntent(false);
    const res = data as {
      clientSecret?: string;
      paymentId?: string;
      error?: string;
    } | null;
    const cs = res?.clientSecret;
    if (fnErr || !cs) {
      // On a non-2xx the SDK puts its generic "Edge Function returned a
      // non-2xx status code" in fnErr.message and leaves `data` null — the
      // function's real { error: code } is in fnErr.context. Read it and map
      // to user-safe copy; never surface the raw SDK/Stripe string.
      const code = await readEdgeErrorCode(fnErr, data);
      setPaymentError(paymentErrorMessage(code));
      setPaymentErrorCode(code);
      return;
    }
    setClientSecret(cs);
    setPaymentId(res?.paymentId ?? null);
  };

  // Step 2 — called by the Payment Element form once Stripe confirms the
  // charge. The webhook is the source of truth: it flips the regs to
  // 'paid' AND fires the partner-invite emails (#191 — invites now send
  // only on confirmed payment, never for abandoned checkouts). Here we
  // just poll our regs until they read 'paid', then show the success view.
  const onConfirmed = async () => {
    setFinalizing(true);
    trackEvent("payment_succeeded", { tournament_slug: tournamentSlug });
    const paidRows = rows; // capture before clearing
    const regIds = paidRows.map((r) => r.regId);

    let allPaid = false;
    for (let i = 0; i < 20; i++) {
      const { data } = await supabase
        .from("event_registrations")
        .select("id, status")
        .in("id", regIds);
      if (
        data &&
        data.length === regIds.length &&
        data.every((r) => r.status === "paid")
      ) {
        allPaid = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 1500));
    }

    if (allPaid) {
      // Load the server-side receipt line items from payment_line_items.
      // These were written by create-payment-intent and are readable
      // by the player via SELECT RLS. If the query fails we show the
      // success view without the breakdown rather than blocking it.
      if (paymentId) {
        const { data: liData } = await supabase
          .from("payment_line_items")
          .select("description, amount_cents")
          .eq("payment_id", paymentId)
          .order("amount_cents", { ascending: false });
        setReceiptItems(
          (liData ?? []) as { description: string; amount_cents: number }[],
        );
      }
      setDoneEventNames(paidRows.map((r) => r.eventName));
    } else {
      // Webhook was slow or not yet delivered — don't claim success.
      // The pending bar reconciles when the flip eventually arrives.
      console.warn(
        "Payment confirmed but the reg flip wasn't observed within the poll window; the pending bar will reconcile.",
      );
      setProcessingEventNames(paidRows.map((r) => r.eventName));
    }

    setRows([]);
    setClientSecret(null);
    setPaymentId(null);
    await refreshPending();
    setFinalizing(false);
  };

  if (loading) {
    return (
      <Shell>
        <p style={{ color: inkSoft, fontSize: 14, margin: 0 }}>Loading…</p>
      </Shell>
    );
  }
  if (error) {
    return (
      <Shell>
        <h1 style={pageH1Style}>Can't load checkout</h1>
        <p style={{ color: inkSoft, fontSize: 14 }}>{error}</p>
        <Link to={`/t/${orgSlug}/${tournamentSlug}`} style={backLinkStyle}>
          ← Back to tournament
        </Link>
      </Shell>
    );
  }

  // Success state — shown right after Pay succeeds.
  // Processing state — payment taken but reg flip not yet observed in
  // the poll window. Don't say "you're registered"; say "finalizing".
  if (processingEventNames && tournament) {
    return (
      <Shell>
        <div
          style={{
            ...statusPanelStyle("warn"),
            padding: "20px 22px",
            marginBottom: 24,
          }}
        >
          <h1
            style={{
              ...pageH1Style,
              margin: "0 0 8px",
              fontSize: "clamp(24px, 3.6vw, 30px)",
              color: "inherit",
            }}
          >
            Payment received
          </h1>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>
            We're finalizing your registration for{" "}
            {fmtList(processingEventNames)} in{" "}
            <strong>{tournament.name}</strong>. This can take a moment —
            check{" "}
            <Link
              to="/my-tournaments"
              style={{ color: "inherit", textDecoration: "underline" }}
            >
              My Tournaments
            </Link>{" "}
            shortly or refresh this page.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <Link to={`/t/${orgSlug}/${tournamentSlug}`} style={secondaryLinkBtn}>
            ← Back to tournament
          </Link>
          <Link to="/my-tournaments" style={primaryLinkBtn}>
            My Tournaments
          </Link>
        </div>
      </Shell>
    );
  }

  if (doneEventNames && tournament) {
    const receiptTotal = receiptItems.reduce(
      (sum, it) => sum + it.amount_cents,
      0,
    );
    return (
      <Shell>
        <div
          style={{
            ...statusPanelStyle("success"),
            padding: "20px 22px",
            marginBottom: 24,
          }}
        >
          <h1
            style={{
              ...pageH1Style,
              margin: "0 0 8px",
              fontSize: "clamp(24px, 3.6vw, 30px)",
              color: "inherit",
            }}
          >
            You're registered!
          </h1>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>
            Confirmed for {fmtList(doneEventNames)} in{" "}
            <strong>{tournament.name}</strong>.
          </p>
        </div>

        {receiptItems.length > 0 && (
          <div style={receiptCard}>
            <div
              style={{
                fontFamily: headingFontStack,
                fontSize: 11,
                color: inkSoft,
                textTransform: "uppercase",
                letterSpacing: "0.14em",
                marginBottom: 12,
              }}
            >
              Receipt
            </div>
            {receiptItems.map((it, i) => (
              <div key={i} style={summaryRow}>
                <span style={{ flex: 1, minWidth: 0 }}>{it.description}</span>
                <span>{formatUsd(it.amount_cents)}</span>
              </div>
            ))}
            <div style={summaryTotal}>
              <span>Total charged</span>
              <span>{formatUsd(receiptTotal)}</span>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <Link to={`/t/${orgSlug}/${tournamentSlug}`} style={secondaryLinkBtn}>
            ← Back to tournament
          </Link>
          <Link to="/" style={primaryLinkBtn}>
            Find more tournaments
          </Link>
        </div>
      </Shell>
    );
  }

  // Empty state — landed here with nothing pending.
  if (rows.length === 0) {
    return (
      <Shell>
        <h1 style={pageH1Style}>Nothing to pay for here</h1>
        <p style={{ color: inkSoft, fontSize: 14, marginBottom: 20 }}>
          You don't have any pending registrations for{" "}
          <strong>{tournament?.name}</strong>. Register for an event from
          the tournament page first.
        </p>
        <Link to={`/t/${orgSlug}/${tournamentSlug}`} style={primaryLinkBtn}>
          ← Back to tournament
        </Link>
      </Shell>
    );
  }

  return (
    <Shell wide>
      <Link to={`/t/${orgSlug}/${tournamentSlug}`} style={backLinkStyle}>
        ← Back to {tournament?.name}
      </Link>
      <h1 style={{ ...pageH1Style, margin: "12px 0 8px" }}>Checkout</h1>
      <p style={{ color: inkSoft, margin: "0 0 24px", fontSize: 14, lineHeight: 1.55 }}>
        Pay to finalize your registrations. Partners will be notified
        and your spots will be confirmed once payment goes through.
      </p>

      <div style={checkoutGrid}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.map((r) => (
            <div key={r.regId} style={checkoutCard}>
              <div
                style={{
                  fontFamily: displayFontStack,
                  fontSize: 18,
                  lineHeight: 1.15,
                  letterSpacing: "-0.2px",
                }}
              >
                {r.eventName}
              </div>
              <div
                style={{
                  fontFamily: headingFontStack,
                  fontSize: 11,
                  color: courtRed,
                  marginTop: 6,
                  textTransform: "uppercase",
                  letterSpacing: "0.14em",
                }}
              >
                {r.format === "doubles" ? "Doubles" : "Singles"}
              </div>
              {r.format === "doubles" && r.partnerLabel && (
                <div
                  style={{
                    fontSize: 12,
                    color: courtGreen,
                    marginTop: 10,
                  }}
                >
                  ✓ Partner: <strong>{r.partnerLabel}</strong>
                  {r.partner_status === "confirmed"
                    ? " — accepted"
                    : " — will be invited when you pay"}
                </div>
              )}
              {r.format === "doubles" && !r.partnerLabel && r.partner_status === "seeking" && (
                <div
                  style={{
                    fontSize: 12,
                    color: courtBlue,
                    marginTop: 10,
                  }}
                >
                  Looking for a partner — we'll help you match. You can add one anytime before the event.
                </div>
              )}
              {r.format === "doubles" &&
                r.partner_status === "confirmed" &&
                !r.partnerLabel && (
                  <div
                    style={{ fontSize: 12, color: courtGreen, marginTop: 10 }}
                  >
                    ✓ Partner confirmed
                  </div>
                )}
              {r.format === "doubles" &&
                !r.partnerLabel &&
                r.partner_status !== "seeking" &&
                r.partner_status !== "confirmed" && (
                  <div
                    style={{
                      fontSize: 12,
                      color: courtRed,
                      marginTop: 10,
                    }}
                  >
                    ⚠ No partner picked. Go back to the tournament page
                    and cancel + re-register this event with a partner.
                  </div>
                )}
            </div>
          ))}
          <div
            style={{
              fontSize: 12,
              color: inkSoft,
              textAlign: "center",
              padding: 8,
            }}
          >
            By paying you agree to the tournament's refund policy.
          </div>
        </div>

        <div style={summaryCard}>
          <div
            style={{
              fontFamily: headingFontStack,
              fontSize: 12,
              color: ink,
              marginBottom: 12,
              textTransform: "uppercase",
              letterSpacing: "0.14em",
            }}
          >
            Order summary
          </div>
          {lineItems.map((it) => {
            const row = rows.find((r) => r.eventId === it.event.id);
            return (
              <div key={it.event.id} style={summaryRow}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  {row?.eventName ?? "Event"}{" "}
                  <span style={{ color: inkSoft }}>
                    (
                    {it.tier === "first"
                      ? "registration · incl. 1 event"
                      : it.tier === "additional"
                        ? "additional event"
                        : "event fee"}
                    )
                  </span>
                </span>
                <span>{formatUsd(it.cents)}</span>
              </div>
            );
          })}
          {discountCents > 0 && appliedCoupon && (
            <div style={{ ...summaryRow, color: courtGreen, marginTop: 8 }}>
              <span>Discount ({appliedCoupon.code})</span>
              <span>−{formatUsd(discountCents)}</span>
            </div>
          )}
          <div style={summaryTotal}>
            <span>Total</span>
            <span>{formatUsd(payableCents)}</span>
          </div>

          {/* "Have a code?" — coupon entry (#30). Hidden once a code is on. */}
          {!clientSecret && (
            <div style={{ marginTop: 14 }}>
              {appliedCoupon ? (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: 13,
                  }}
                >
                  <span style={{ color: courtGreen }}>
                    Code <strong>{appliedCoupon.code}</strong> applied
                  </span>
                  <button type="button" onClick={removeCoupon} style={couponLinkBtn}>
                    Remove
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="text"
                    value={couponInput}
                    onChange={(e) => {
                      setCouponInput(e.target.value);
                      setCouponError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void applyCoupon();
                      }
                    }}
                    placeholder="Have a code?"
                    style={couponInputStyle}
                    disabled={couponChecking}
                  />
                  <button
                    type="button"
                    onClick={() => void applyCoupon()}
                    disabled={couponChecking || !couponInput.trim()}
                    style={couponApplyBtn(couponChecking || !couponInput.trim())}
                  >
                    {couponChecking ? "Checking…" : "Apply"}
                  </button>
                </div>
              )}
              {couponError && (
                <div style={{ fontSize: 12, color: courtRed, marginTop: 6 }}>
                  {couponError}
                </div>
              )}
            </div>
          )}

          {paymentError && (
            <div
              style={{
                ...statusPanelStyle("danger"),
                fontSize: 13,
                padding: "10px 12px",
                margin: "12px 0 0",
              }}
            >
              {paymentError}
              {/* org_stripe_not_active is the organizer's to fix — give the
                  player a one-click way to flag it, prefilled with the
                  tournament + the problem so they don't have to explain. */}
              {paymentErrorCode === "org_stripe_not_active" && (
                <div style={{ marginTop: 8 }}>
                  <Link
                    to={`/t/${orgSlug}/${tournamentSlug}/contact?message=${encodeURIComponent(
                      `Hi — I tried to pay for my registration in "${tournament?.name ?? "your tournament"}" but online payments aren't set up yet, so checkout wouldn't go through. Could you help me get registered?`,
                    )}`}
                    style={{
                      fontWeight: 600,
                      color: ink,
                      textDecoration: "underline",
                    }}
                  >
                    Message the organizer about this →
                  </Link>
                </div>
              )}
            </div>
          )}

          {/* Dedicated decline view — replaces the Payment Element on
              card error so the explanation is prominent, not buried. */}
          {clientSecret && paymentDeclined ? (
            <div style={{ marginTop: 14 }}>
              <div
                style={{
                  ...statusPanelStyle("danger"),
                  padding: "14px 16px",
                  marginBottom: 14,
                }}
              >
                <div
                  style={{
                    fontFamily: headingFontStack,
                    fontWeight: 600,
                    fontSize: 14,
                    marginBottom: 4,
                  }}
                >
                  Payment declined
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                  {paymentDeclined}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setPaymentDeclined(null);
                  setPaymentError(null);
                }}
                style={{
                  ...ctaPrimaryStyle,
                  padding: "14px 22px",
                  width: "100%",
                  textAlign: "center",
                }}
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => navigate(`/t/${orgSlug}/${tournamentSlug}`)}
                style={{
                  background: "none",
                  border: "none",
                  color: inkSoft,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 13,
                  textDecoration: "underline",
                  width: "100%",
                  padding: "10px 0 0",
                  textAlign: "center",
                }}
              >
                Cancel checkout (keep registrations)
              </button>
            </div>
          ) : !clientSecret ? (
            <>
              <button
                type="button"
                onClick={() => void startPayment()}
                disabled={creatingIntent || !!blockingError || !stripeConfigured}
                style={{
                  ...(creatingIntent || blockingError || !stripeConfigured
                    ? ctaPrimaryDisabledStyle
                    : ctaPrimaryStyle),
                  padding: "14px 22px",
                  width: "100%",
                  marginTop: 14,
                  textAlign: "center",
                }}
              >
                {creatingIntent
                  ? "Starting…"
                  : blockingError
                    ? "Fix the partner issue above"
                    : `Continue to payment · ${formatUsd(payableCents)} →`}
              </button>
              {!stripeConfigured && (
                <div
                  style={{
                    fontSize: 11,
                    color: courtRed,
                    textAlign: "center",
                    marginTop: 10,
                  }}
                >
                  Payments aren't configured yet (missing
                  VITE_STRIPE_PUBLISHABLE_KEY).
                </div>
              )}
              <button
                type="button"
                onClick={() => navigate(`/t/${orgSlug}/${tournamentSlug}`)}
                disabled={creatingIntent}
                style={{
                  background: "none",
                  border: "none",
                  color: inkSoft,
                  cursor: creatingIntent ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                  fontSize: 13,
                  textDecoration: "underline",
                  width: "100%",
                  padding: "10px 0 0",
                  textAlign: "center",
                }}
              >
                Cancel checkout (keep registrations)
              </button>
            </>
          ) : (
            <div style={{ marginTop: 14 }}>
              <Elements
                stripe={stripePromise}
                options={{ clientSecret, appearance: { theme: "stripe" } }}
              >
                <PaymentSection
                  totalCents={payableCents}
                  finalizing={finalizing}
                  partnerNames={rows
                    .filter((r) => r.partnerLabel)
                    .map((r) => r.partnerLabel as string)}
                  onConfirmed={() => void onConfirmed()}
                  onPaymentError={(m) => {
                    setPaymentError(m);
                    setPaymentErrorCode(null);
                    trackEvent("payment_failed", {
                      tournament_slug: tournamentSlug,
                      reason: "error",
                    });
                  }}
                  onPaymentDeclined={(m) => {
                    setPaymentDeclined(m);
                    trackEvent("payment_failed", {
                      tournament_slug: tournamentSlug,
                      reason: "declined",
                    });
                  }}
                  onCancel={() => {
                    setClientSecret(null);
                    setPaymentError(null);
                    setPaymentErrorCode(null);
                    setPaymentDeclined(null);
                  }}
                />
              </Elements>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Stripe Payment Element form. Lives inside <Elements> so it can use
// the Stripe hooks. Confirms the PaymentIntent in-page (redirect only
// if a method requires it); the parent then polls for the webhook flip.
// ─────────────────────────────────────────────────────────────────────

function PaymentSection({
  totalCents,
  finalizing,
  partnerNames,
  onConfirmed,
  onPaymentError,
  onPaymentDeclined,
  onCancel,
}: {
  totalCents: number;
  finalizing: boolean;
  partnerNames: string[];
  onConfirmed: () => void;
  onPaymentError: (msg: string) => void;
  onPaymentDeclined: (msg: string) => void;
  onCancel: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  // The Payment Element mounts asynchronously (it's an iframe). Calling
  // confirmPayment before it's ready throws an IntegrationError, so we
  // gate the Pay button on its onReady callback.
  const [elementReady, setElementReady] = useState(false);
  const busy = submitting || finalizing;
  const canPay = elementReady && !!stripe && !!elements && !busy;

  const handlePay = async () => {
    if (!stripe || !elements || !elementReady) return;
    setSubmitting(true);
    onPaymentError("");
    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
      confirmParams: { return_url: window.location.href },
    });
    if (error) {
      // Card errors and declines get the dedicated declined view;
      // other error types (network, integration) stay as inline banners.
      if (error.type === "card_error" || error.type === "validation_error") {
        onPaymentDeclined(error.message ?? "Your card was declined. Please try a different card.");
      } else {
        onPaymentError(error.message ?? "Payment failed. Please try again.");
      }
      setSubmitting(false);
      return;
    }
    if (
      paymentIntent &&
      (paymentIntent.status === "succeeded" ||
        paymentIntent.status === "processing")
    ) {
      onConfirmed(); // parent polls for the webhook flip; keep busy
      return;
    }
    onPaymentError("Payment didn't complete. Please try again.");
    setSubmitting(false);
  };

  return (
    <div>
      <PaymentElement
        onReady={() => setElementReady(true)}
        onLoadError={(e) =>
          onPaymentError(
            e.error?.message ??
              "Couldn't load the payment form. Please refresh and try again.",
          )
        }
      />
      <button
        type="button"
        onClick={() => void handlePay()}
        disabled={!canPay}
        style={{
          ...(canPay ? ctaPrimaryStyle : ctaPrimaryDisabledStyle),
          padding: "14px 22px",
          width: "100%",
          marginTop: 16,
          textAlign: "center",
        }}
      >
        {finalizing
          ? "Finalizing…"
          : submitting
            ? "Processing…"
            : !elementReady
              ? "Loading payment form…"
              : `Pay ${formatUsd(totalCents)} →`}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        style={{
          background: "none",
          border: "none",
          color: inkSoft,
          cursor: busy ? "not-allowed" : "pointer",
          fontFamily: "inherit",
          fontSize: 13,
          textDecoration: "underline",
          width: "100%",
          padding: "10px 0 0",
          textAlign: "center",
        }}
      >
        Back
      </button>
      {/* Full-page blocking overlay. Mounts the instant the player submits
          (confirmPayment in flight) and stays up through the parent's
          webhook poll, so the page can't be clicked, refreshed via the
          back button's stale state, or double-submitted while the charge
          settles. authorizing → confirming mirrors submitting → finalizing. */}
      {busy && (
        <PaymentProcessingOverlay
          phase={finalizing ? "confirming" : "authorizing"}
          partnerNames={partnerNames}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Payment-processing overlay. A fixed, full-viewport scrim shown while a
// charge is in flight (see PaymentSection). It deliberately offers no
// dismiss affordance — the whole point is to block interaction until the
// webhook confirms (or an error tears it down). The step checklist mirrors
// the real flow: authorize the card → confirm the spot → notify partners
// (the webhook fires invites alongside the reg flip).
// ─────────────────────────────────────────────────────────────────────

function PaymentProcessingOverlay({
  phase,
  partnerNames,
}: {
  phase: "authorizing" | "confirming";
  partnerNames: string[];
}) {
  // Lock background scroll while the overlay is up so the page behind the
  // scrim can't move. Restored on unmount.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const authorized = phase === "confirming";
  return (
    <div role="status" aria-live="polite" aria-busy="true" style={overlayScrim}>
      <div style={overlayCard}>
        <div className="checkout-spin" style={overlaySpinner} aria-hidden />
        <div
          style={{
            fontFamily: displayFontStack,
            fontSize: 22,
            letterSpacing: "-0.3px",
          }}
        >
          {authorized ? "Confirming your spot" : "Processing your payment"}
        </div>
        <div
          style={{
            fontSize: 14,
            color: inkSoft,
            lineHeight: 1.55,
            marginTop: 8,
          }}
        >
          This takes a few seconds. Please don't close or refresh this window.
        </div>
        <div
          style={{
            textAlign: "left",
            marginTop: 22,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <OverlayStep
            state={authorized ? "done" : "active"}
            label={authorized ? "Payment authorized" : "Authorizing payment"}
          />
          <OverlayStep
            state={authorized ? "active" : "pending"}
            label="Confirming your spot"
          />
          {partnerNames.length > 0 && (
            <OverlayStep
              state="pending"
              label={`Notifying ${fmtList(partnerNames)}`}
            />
          )}
        </div>
        <div
          style={{
            marginTop: 22,
            fontSize: 12,
            color: inkMuted,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          Secured by Stripe
        </div>
      </div>
    </div>
  );
}

function OverlayStep({
  state,
  label,
}: {
  state: "done" | "active" | "pending";
  label: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 14,
        color: state === "pending" ? inkMuted : ink,
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {state === "done" ? (
          <span style={{ color: courtGreen, fontSize: 16, lineHeight: 1 }}>✓</span>
        ) : state === "active" ? (
          <span className="checkout-spin" style={overlayMiniSpinner} />
        ) : (
          <span style={overlayPendingDot} />
        )}
      </span>
      <span>{label}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bits
// ─────────────────────────────────────────────────────────────────────

// Pulls the structured { error: code } out of a supabase functions.invoke
// result. On a non-2xx the SDK leaves `data` null and stashes the raw Response
// in error.context — read it there. Returns the short code, or null.
async function readEdgeErrorCode(
  error: unknown,
  data: unknown,
): Promise<string | null> {
  const fromData = (data as { error?: string } | null)?.error;
  if (fromData) return fromData;
  if (error && typeof error === "object" && "context" in error) {
    const ctx = (error as { context?: unknown }).context;
    if (ctx instanceof Response) {
      try {
        const body = await ctx.clone().json();
        return (body as { error?: string })?.error ?? null;
      } catch {
        /* body wasn't JSON — fall through to the generic message */
      }
    }
  }
  return null;
}

// Maps a create-payment-intent error code to a friendly, user-safe message.
// The default covers unknown codes and the function's catch-all 500 so a raw
// Stripe/runtime string never reaches the user.
function paymentErrorMessage(code: string | null): string {
  switch (code) {
    case "org_stripe_not_active":
      return "This organizer hasn't finished setting up online payments yet. Please reach out to them.";
    case "tournament_not_accepting_payment":
      return "This tournament isn't accepting payments right now.";
    case "nothing_to_charge":
      return "There's nothing to pay for — your cart looks empty.";
    case "regs_not_payable":
      return "Some of your registrations are no longer payable. Refresh the page and try again.";
    case "player_not_found":
      return "We couldn't find your player profile. Finish your profile, then try again.";
    case "unauthorized":
      return "Your session expired. Please sign in again and retry.";
    default:
      return "We couldn't start payment. Please try again — if it keeps happening, contact the organizer.";
  }
}

// Maps a validate_coupon error code to a friendly message.
function couponErrorMessage(code?: string): string {
  switch (code) {
    case "not_found":
      return "That code isn't valid for this tournament.";
    case "inactive":
      return "That code is no longer active.";
    case "expired":
      return "That code has expired.";
    case "not_started":
      return "That code isn't active yet.";
    case "exhausted":
      return "That code has reached its usage limit.";
    default:
      return "Couldn't apply that code. Please try again.";
  }
}

const overlayScrim: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  background: "rgba(20, 24, 16, 0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
};

const overlayCard: CSSProperties = {
  background: "#ffffff",
  borderRadius: 16,
  border: `1px solid ${rule}`,
  padding: "32px 36px",
  width: 380,
  maxWidth: "100%",
  textAlign: "center",
};

const overlaySpinner: CSSProperties = {
  width: 46,
  height: 46,
  margin: "0 auto 20px",
  border: `4px solid ${ruleSoft}`,
  borderTopColor: ink,
  borderRadius: "50%",
};

const overlayMiniSpinner: CSSProperties = {
  display: "inline-block",
  width: 16,
  height: 16,
  border: `2px solid ${rule}`,
  borderTopColor: ink,
  borderRadius: "50%",
};

const overlayPendingDot: CSSProperties = {
  width: 16,
  height: 16,
  borderRadius: "50%",
  border: `2px solid ${rule}`,
};

const couponInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "9px 11px",
  border: `1px solid ${rule}`,
  borderRadius: 8,
  fontSize: 13,
  fontFamily: "inherit",
};

function couponApplyBtn(disabled: boolean): CSSProperties {
  return {
    padding: "9px 16px",
    background: disabled ? "#e5e7eb" : ink,
    color: disabled ? "#9ca3af" : "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  };
}

const couponLinkBtn: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: courtRed,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  textDecoration: "underline",
  fontFamily: "inherit",
};

function Shell({
  children,
  wide,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div style={pageWrapStyle}>
      <main style={contentColStyle(wide ? 900 : 600)}>{children}</main>
    </div>
  );
}

function fmtList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

const backLinkStyle: CSSProperties = {
  color: courtBlue,
  textDecoration: "none",
  fontSize: 13,
  fontWeight: 500,
};

const checkoutGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 320px",
  gap: 24,
};

const checkoutCard: CSSProperties = {
  padding: 18,
  background: cream,
  border: `1px solid ${ruleSoft}`,
  borderRadius: 10,
};

const summaryCard: CSSProperties = {
  padding: 20,
  background: "#ffffff",
  border: `1px solid ${rule}`,
  borderRadius: 10,
  alignSelf: "flex-start",
  position: "sticky",
  top: 16,
};

const receiptCard: CSSProperties = {
  padding: 20,
  background: "#ffffff",
  border: `1px solid ${rule}`,
  borderRadius: 10,
  marginBottom: 20,
};

const summaryRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 13,
  color: inkSoft,
  marginBottom: 8,
  gap: 12,
};

const summaryTotal: CSSProperties = {
  ...summaryRow,
  marginTop: 12,
  paddingTop: 12,
  borderTop: `1px solid ${rule}`,
  fontSize: 16,
  fontWeight: 600,
  color: ink,
};

const primaryLinkBtn: CSSProperties = {
  ...ctaPrimaryStyle,
  padding: "12px 20px",
  marginTop: 12,
};

const secondaryLinkBtn: CSSProperties = {
  ...ctaSecondaryStyle,
  padding: "12px 20px",
  marginTop: 12,
};
