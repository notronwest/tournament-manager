import { Link } from "react-router-dom";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";

// Placeholder dashboard for the org. As we add features (reports,
// payouts, etc.) this is where the at-a-glance numbers will live.
export default function OrgOverviewPage() {
  const { org } = useCurrentOrg();
  if (!org) return null;

  return (
    <div>
      <h1 style={{ margin: "0 0 4px", fontSize: 22 }}>{org.name}</h1>
      <p style={{ color: "#666", margin: 0, fontSize: 14 }}>
        Welcome to your tournament dashboard.
      </p>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 14, color: "#888", margin: "0 0 8px" }}>
          Quick actions
        </h2>
        <Link
          to={`/admin/${org.slug}/tournaments`}
          style={{
            display: "inline-block",
            padding: "10px 16px",
            background: "#fff",
            border: "1px solid #e2e2e2",
            borderRadius: 6,
            color: "#2563eb",
            textDecoration: "none",
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          Manage tournaments →
        </Link>
      </section>
    </div>
  );
}
