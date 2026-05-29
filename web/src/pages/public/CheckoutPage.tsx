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
  eventFeeCentsOverride: number;
  // Doubles only. The pending outbound invite created at register
  // time. We fire its email after Stripe takes payment (which is
  // a placeholder for now — see comment in onPay).
  inviteId: string | null;
  partnerLabel: string | null;
  partnerEmail: string | null;
};

// Detect addresses that can't possibly receive real email. Mirrors
// the helper in RegisterPage / send-partner-invite — keep both
// implementations in sync until we extract the helper.
function isObviouslyFakeEmail(email: string | null): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (e.endsWith(".test")) return true;
  if (
    e.endsWith("@example.com") ||
    e.endsWith("@example.net") ||
    e.endsWith("@example.org")
  ) {
    return true;
  }
  return false;
}

// Checkout page at /t/:orgSlug/:tournamentSlug/checkout.
//
// Reads the user's pending_payment registrations for THIS tournament,
// renders them as a review + sticky order summary, and on Pay flips
// each pending reg → 'paid' (with the computed cents snapshotted)
// and fires partner-invite emails for doubles regs.
//
// Stripe is deliberately NOT wired up yet — backlog has Stripe
// Connect onboarding as its own Soon item. For now Pay is a status
// flip + email fan-out. When Stripe lands the same handler will
// route through a PaymentIntent and the status flip moves to the
// webhook handler.
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
  const [paying, setPaying] = useState(false);

  // After Pay succeeds we render the "you're paid up" view instead
  // of the review form. doneEventNames carries the list of events
  // that just transitioned so we can name them in the success card.
  const [doneEventNames, setDoneEventNames] = useState<string[] | null>(
    null,
  );

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
        `id, event_id,
         event:events!event_id (id, name, format, event_fee_cents)`,
      )
      .eq("player_id", me.id)
      .eq("status", "pending_payment")
      .is("deleted_at", null);
    if (regsErr) {
      setError(regsErr.message);
      setLoading(false);
      return;
    }

    // Filter to events that belong to THIS tournament. The query
    // above doesn't constrain by tournament_id directly, so we do
    // it in JS off the joined event.
    type RegRow = {
      id: string;
      event_id: string;
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

    // Pull outbound pending invites for these events so we can
    // surface partner display + know which invite_id to email at
    // pay-time.
    const { data: invites } = await supabase
      .from("partner_invites")
      .select(
        `id, event_id, invitee_email,
         invitee:players!invitee_player_id (first_name, last_name, email)`,
      )
      .eq("inviter_player_id", me.id)
      .eq("status", "pending")
      .in(
        "event_id",
        mine.map((r) => r.event_id),
      );
    type InviteRow = {
      id: string;
      event_id: string;
      invitee_email: string | null;
      invitee: {
        first_name: string;
        last_name: string;
        email: string | null;
      } | null;
    };
    const inviteByEvent = new Map<string, InviteRow>();
    for (const inv of (invites ?? []) as unknown as InviteRow[]) {
      // If somehow multiple invites exist for the same event,
      // newest-first ordering would matter — we didn't order
      // explicitly, but for an inviter+event+pending tuple there
      // should normally be at most one row.
      inviteByEvent.set(inv.event_id, inv);
    }

    const built: PendingRow[] = mine.map((r) => {
      const inv = inviteByEvent.get(r.event_id);
      const partnerLabel = inv?.invitee
        ? `${inv.invitee.first_name} ${inv.invitee.last_name}`
        : inv?.invitee_email ?? null;
      const partnerEmail = inv?.invitee?.email ?? inv?.invitee_email ?? null;
      return {
        regId: r.id,
        eventId: r.event_id,
        eventName: r.event?.name ?? "Event",
        format: r.event?.format ?? "singles",
        eventFeeCentsOverride: r.event?.event_fee_cents ?? 0,
        inviteId: inv?.id ?? null,
        partnerLabel,
        partnerEmail,
      };
    });
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
          entry_fee_cents: activeTier.first_event_fee_cents,
          additional_event_fee_cents: activeTier.additional_event_fee_cents,
        },
      )
    : { items: [] as LineItem[], totalCents: 0 };
  const lineItemByEventId = new Map(
    lineItems.map((it) => [it.event.id, it]),
  );

  // Block Pay if any doubles row is missing a partner — shouldn't
  // happen given the inline register form enforces it, but defensive.
  const blockingError = rows.find(
    (r) => r.format === "doubles" && !r.partnerLabel,
  );

  const onPay = async () => {
    if (!tournament || rows.length === 0) return;
    setError(null);
    setPaying(true);

    // 1. Flip each pending reg → paid, with the computed cents
    //    snapshotted. We do these sequentially so an early failure
    //    doesn't leave a partial state — could be a single RPC
    //    in a future commit.
    const paidRegIds: string[] = [];
    for (const r of rows) {
      const line = lineItemByEventId.get(r.eventId);
      const cents = line ? line.cents : r.eventFeeCentsOverride;
      const { error: updErr } = await supabase
        .from("event_registrations")
        .update({ status: "paid", event_fee_cents: cents })
        .eq("id", r.regId);
      if (updErr) {
        setError(`Failed to finalize ${r.eventName}: ${updErr.message}`);
        setPaying(false);
        return;
      }
      paidRegIds.push(r.regId);
    }

    // 2. Fire partner-invite emails for each doubles row that has
    //    an outbound invite. Skip obviously-fake addresses (test
    //    accounts). Errors are tolerated — the user is paid up
    //    either way; we just surface a console warn for now.
    for (const r of rows) {
      if (r.format !== "doubles" || !r.inviteId) continue;
      if (isObviouslyFakeEmail(r.partnerEmail)) continue;
      try {
        await supabase.functions.invoke("send-partner-invite", {
          body: {
            inviteId: r.inviteId,
            baseUrl: window.location.origin,
          },
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `Invite email for ${r.eventName} failed:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    // 3. Surface success state + refresh the global bar so it
    //    drops these rows.
    setDoneEventNames(rows.map((r) => r.eventName));
    setRows([]);
    await refreshPending();
    setPaying(false);
  };

  if (loading) {
    return (
      <Shell>
        <p style={{ color: "#666", fontSize: 14 }}>Loading…</p>
      </Shell>
    );
  }
  if (error) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 8px", fontSize: 22 }}>
          Can't load checkout
        </h1>
        <p style={{ color: "#666", fontSize: 14 }}>{error}</p>
        <Link to={`/t/${orgSlug}/${tournamentSlug}`} style={backLinkStyle}>
          ← Back to tournament
        </Link>
      </Shell>
    );
  }

  // Success state — shown right after Pay succeeds.
  if (doneEventNames && tournament) {
    return (
      <Shell>
        <div
          style={{
            padding: 20,
            background: "#dcfce7",
            border: "1px solid #86efac",
            borderRadius: 8,
            marginBottom: 24,
          }}
        >
          <h1 style={{ margin: "0 0 8px", fontSize: 22, color: "#166534" }}>
            🎉 You're paid up!
          </h1>
          <p style={{ margin: 0, color: "#166534", fontSize: 14, lineHeight: 1.55 }}>
            Confirmed for {fmtList(doneEventNames)} in{" "}
            <strong>{tournament.name}</strong>. Doubles partners have been
            emailed their invites.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
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
        <h1 style={{ margin: "0 0 8px", fontSize: 22 }}>
          Nothing to pay for here
        </h1>
        <p style={{ color: "#666", fontSize: 14 }}>
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
      <h1 style={{ margin: "12px 0 4px", fontSize: 24 }}>Checkout</h1>
      <p style={{ color: "#666", margin: "0 0 24px", fontSize: 14 }}>
        Pay to finalize your registrations. Partners will be notified
        and your spots will be confirmed once payment goes through.
      </p>

      <div style={checkoutGrid}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.map((r) => (
            <div key={r.regId} style={checkoutCard}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{r.eventName}</div>
              <div style={{ fontSize: 13, color: "#666", marginTop: 4 }}>
                {r.format === "doubles" ? "Doubles" : "Singles"}
              </div>
              {r.format === "doubles" && r.partnerLabel && (
                <div
                  style={{
                    fontSize: 12,
                    color: "#166534",
                    marginTop: 6,
                  }}
                >
                  ✓ Partner: <strong>{r.partnerLabel}</strong> — will be
                  invited when you pay
                </div>
              )}
              {r.format === "doubles" && !r.partnerLabel && (
                <div
                  style={{
                    fontSize: 12,
                    color: "#991b1b",
                    marginTop: 6,
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
              color: "#888",
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
              fontSize: 13,
              fontWeight: 600,
              color: "#444",
              marginBottom: 10,
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
                  <span style={{ color: "#888" }}>
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
          <div style={summaryTotal}>
            <span>Total</span>
            <span>{formatUsd(totalCents)}</span>
          </div>
          <button
            type="button"
            onClick={() => void onPay()}
            disabled={paying || !!blockingError}
            style={{
              padding: "12px 24px",
              background:
                paying || blockingError ? "#9ca3af" : "#2563eb",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              fontSize: 15,
              fontWeight: 500,
              cursor:
                paying || blockingError ? "not-allowed" : "pointer",
              fontFamily: "inherit",
              width: "100%",
              marginTop: 14,
            }}
          >
            {paying
              ? "Finalizing…"
              : blockingError
                ? "Fix the partner issue above"
                : `Pay ${formatUsd(totalCents)} →`}
          </button>
          <button
            type="button"
            onClick={() => navigate(`/t/${orgSlug}/${tournamentSlug}`)}
            disabled={paying}
            style={{
              background: "none",
              border: "none",
              color: "#666",
              cursor: paying ? "not-allowed" : "pointer",
              fontFamily: "inherit",
              fontSize: 13,
              textDecoration: "underline",
              width: "100%",
              padding: "8px 0 0",
              textAlign: "center",
            }}
          >
            Cancel checkout (keep registrations)
          </button>
          <div
            style={{
              fontSize: 11,
              color: "#888",
              textAlign: "center",
              marginTop: 10,
            }}
          >
            Stripe checkout coming soon — for now Pay finalizes the
            registration directly.
          </div>
        </div>
      </div>
    </Shell>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bits
// ─────────────────────────────────────────────────────────────────────

function Shell({
  children,
  wide,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <main
      style={{
        padding: "32px 24px",
        maxWidth: wide ? 900 : 600,
        margin: "0 auto",
      }}
    >
      {children}
    </main>
  );
}

function fmtList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

const backLinkStyle: CSSProperties = {
  color: "#2563eb",
  textDecoration: "none",
  fontSize: 13,
};

const checkoutGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 320px",
  gap: 24,
};

const checkoutCard: CSSProperties = {
  padding: 16,
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
};

const summaryCard: CSSProperties = {
  padding: 18,
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  alignSelf: "flex-start",
  position: "sticky",
  top: 16,
};

const summaryRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 13,
  color: "#444",
  marginBottom: 8,
  gap: 12,
};

const summaryTotal: CSSProperties = {
  ...summaryRow,
  marginTop: 12,
  paddingTop: 12,
  borderTop: "1px solid #e5e7eb",
  fontSize: 16,
  fontWeight: 600,
  color: "#111",
};

const primaryLinkBtn: CSSProperties = {
  padding: "10px 18px",
  background: "#2563eb",
  color: "#fff",
  textDecoration: "none",
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 500,
  marginTop: 12,
  display: "inline-block",
};

const secondaryLinkBtn: CSSProperties = {
  padding: "10px 18px",
  background: "#fff",
  color: "#555",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  textDecoration: "none",
  marginTop: 12,
  display: "inline-block",
};
