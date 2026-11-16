import { getEnvLabel } from "../lib/env";

// A thin strip across the very top of the app that signifies a non-production
// environment (TEST / DEV). Renders nothing on production — see getEnvLabel(),
// which is fail-safe toward prod. Kept in normal document flow (not sticky) so
// it doesn't collide with the sticky SiteHeader / impersonation-banner stack.
// Deliberately NOT role="status": it is a static label, not a live region, and
// a second status region on every TEST page made the app's real save
// confirmations ambiguous to assistive tech and to getByRole("status") specs.
export default function EnvBanner() {
  const label = getEnvLabel();
  if (!label) return null;

  return (
    <div
      style={{
        width: "100%",
        background: "var(--warning, #d97706)",
        color: "#ffffff",
        textAlign: "center",
        padding: "5px 12px",
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        lineHeight: 1.4,
      }}
    >
      {label} environment · not the live site
    </div>
  );
}
