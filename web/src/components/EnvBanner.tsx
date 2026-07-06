import { getEnvLabel } from "../lib/env";

// A thin strip across the very top of the app that signifies a non-production
// environment (TEST / DEV). Renders nothing on production — see getEnvLabel(),
// which is fail-safe toward prod. Kept in normal document flow (not sticky) so
// it doesn't collide with the sticky SiteHeader / impersonation-banner stack.
export default function EnvBanner() {
  const label = getEnvLabel();
  if (!label) return null;

  return (
    <div
      role="status"
      aria-live="polite"
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
