import { Link, useLocation } from "react-router-dom";
import { usePendingPayments } from "./PendingPaymentsContext";
import { formatUsd } from "../lib/pricing";

// Site-wide sticky bottom bar that surfaces the signed-in user's
// pending_payment registrations. Visible whenever they have at
// least one pending reg, regardless of which page they're on —
// homepage, tournament page, admin, profile, anywhere — so they
// can always one-click into checkout.
//
// Hides itself:
//   * when the user has zero pending regs (most of the time)
//   * on the checkout page itself (the bar's primary CTA would be
//     redundant once you're already there)
//   * while the provider is still loading (groups === null) to
//     avoid a flash of empty-state
//
// No countdown timer — capacity holds expire silently on the
// server. The bar is a calm reminder, not a stress-inducing one.
export default function PendingPaymentsBar() {
  const { groups } = usePendingPayments();
  const location = useLocation();

  if (groups === null || groups.length === 0) return null;

  // Hide on any tournament's /checkout page — once they're there,
  // the bar's CTA points back at the same place.
  if (location.pathname.endsWith("/checkout")) return null;

  // Hide on a tournament page that has a pending here — that page renders its
  // OWN sticky "Go to checkout" bar (also fixed bottom:0), so showing this
  // global amber bar too just collides (it sits hidden behind the page bar).
  if (
    groups.some(
      (g) => location.pathname === `/t/${g.orgSlug}/${g.tournamentSlug}`,
    )
  )
    return null;

  // Single-tournament case: one row in the bar with a direct
  // Check out CTA pointing at that tournament's checkout.
  // Multi-tournament case: still one bar, but the CTA + label
  // call out that they have pendings across multiple tournaments
  // and link to the first one (others remain accessible from each
  // tournament's own page; for v1 we don't build a unified
  // checkout dashboard).
  const total = groups.reduce((sum, g) => sum + g.totalCents, 0);
  const eventCount = groups.reduce((n, g) => n + g.events.length, 0);

  const isSingle = groups.length === 1;
  const primary = groups[0];
  const checkoutHref = `/t/${primary.orgSlug}/${primary.tournamentSlug}/checkout`;

  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        background: "#fef3c7",
        borderTop: "2px solid #fbbf24",
        boxShadow: "0 -2px 8px rgba(0,0,0,0.06)",
        zIndex: 30,
      }}
    >
      <div
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          padding: "12px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 13, color: "#5b4604", minWidth: 0 }}>
          {isSingle ? (
            <>
              <strong>
                {eventCount} event{eventCount === 1 ? "" : "s"}
              </strong>{" "}
              waiting for payment at{" "}
              <strong>{primary.tournamentName}</strong> ·{" "}
              <strong>{formatUsd(total)}</strong>
            </>
          ) : (
            <>
              <strong>
                {eventCount} event{eventCount === 1 ? "" : "s"}
              </strong>{" "}
              waiting for payment across{" "}
              <strong>
                {groups.length} tournament{groups.length === 1 ? "" : "s"}
              </strong>{" "}
              · <strong>{formatUsd(total)}</strong>
            </>
          )}
        </div>
        <Link
          to={checkoutHref}
          style={{
            padding: "10px 20px",
            background: "#2563eb",
            color: "#fff",
            textDecoration: "none",
            borderRadius: 6,
            fontSize: 14,
            fontWeight: 500,
            whiteSpace: "nowrap",
          }}
        >
          {isSingle
            ? "Check out →"
            : `Check out ${primary.tournamentName} →`}
        </Link>
      </div>
    </div>
  );
}
