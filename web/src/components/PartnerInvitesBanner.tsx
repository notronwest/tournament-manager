import { Link, useLocation } from "react-router-dom";
import { usePartnerInvites } from "./PartnerInvitesContext";

// Site-wide banner that surfaces pending partner-selection invites for
// the signed-in player. Appears below the site header on every page
// when there is at least one pending invite — so the player never has
// to visit a specific tournament page to discover they've been picked.
//
// Hides itself:
//   * when there are no pending invites (most of the time)
//   * while the provider is still loading (invites === null)
//   * on /login (no auth context yet)
//   * on partner-accept pages (already handling the invite)
export default function PartnerInvitesBanner() {
  const { invites } = usePartnerInvites();
  const location = useLocation();

  if (invites === null || invites.length === 0) return null;
  if (location.pathname === "/login") return null;
  // Hide on the dedicated invites page and on the per-token accept pages —
  // those already surface the invite in full.
  if (location.pathname === "/invites") return null;
  if (location.pathname.includes("/invites/")) return null;

  return (
    <div
      style={{
        background: "#eff6ff",
        borderBottom: "2px solid #93c5fd",
      }}
    >
      <div
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          padding: "12px 24px",
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "#1e40af",
            marginBottom: 6,
          }}
        >
          {invites.length === 1
            ? "You have a pending partner invite"
            : `You have ${invites.length} pending partner invites`}
        </div>
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {invites.map((inv) => (
            <li
              key={inv.token}
              style={{ fontSize: 13, color: "#1e3a8a" }}
            >
              <strong>{inv.inviterName}</strong> picked you for{" "}
              <strong>{inv.eventName}</strong>{" "}
              &mdash;{" "}
              <Link
                to={`/t/${inv.orgSlug}/${inv.tournamentSlug}/invites/${inv.token}`}
                style={{
                  color: "#2563eb",
                  textDecoration: "underline",
                  fontWeight: 500,
                }}
              >
                Review invite
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
