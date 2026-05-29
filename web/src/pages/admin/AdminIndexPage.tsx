import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import { usePlatformAdmin } from "../../hooks/usePlatformAdmin";

type OrgSummary = { slug: string; name: string };

// Landing page after sign-in. Lists the orgs the current user belongs to.
// If they belong to exactly one, we redirect straight into it so the picker
// doesn't get in the way.
export default function AdminIndexPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const isPlatformAdmin = usePlatformAdmin();
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) return;
    // Platform admins always see the picker so the "+ Create
    // organization" button is reachable, even when they only belong
    // to one org. Non-admins still get the auto-redirect for
    // ergonomics. Wait until the admin check resolves so we don't
    // redirect-then-bounce-back.
    if (isPlatformAdmin === null) return;

    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("organization_members")
        .select("organizations(slug, name)")
        .eq("user_id", user.id);

      if (cancelled) return;
      if (error) {
        setError(error.message);
        return;
      }

      const list: OrgSummary[] = (data ?? [])
        .map((row) => row.organizations)
        .filter((o): o is OrgSummary => !!o);

      setOrgs(list);
      if (list.length === 1 && !isPlatformAdmin) {
        navigate(`/admin/${list[0].slug}`, { replace: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, authLoading, navigate, isPlatformAdmin]);

  if (error) {
    return (
      <main style={{ padding: 24, maxWidth: 600, margin: "0 auto" }}>
        <h1 style={{ fontSize: 20 }}>Couldn't load organizations</h1>
        <p style={{ color: "#666", fontSize: 14 }}>{error}</p>
      </main>
    );
  }

  if (orgs === null) {
    return (
      <div style={{ padding: 24, color: "#666", fontSize: 14 }}>Loading…</div>
    );
  }

  if (orgs.length === 0) {
    return (
      <main style={{ padding: 24, maxWidth: 600, margin: "0 auto" }}>
        <h1 style={{ fontSize: 20, marginTop: 0 }}>No organizations</h1>
        <p style={{ color: "#666", fontSize: 14 }}>
          You're not a member of any organization yet. Ask an organization
          owner to add you, or create your own.
        </p>
        {isPlatformAdmin && (
          <Link
            to="/admin/new-org"
            style={{
              display: "inline-block",
              marginTop: 12,
              padding: "8px 14px",
              background: "#2563eb",
              color: "#fff",
              textDecoration: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            + Create organization
          </Link>
        )}
      </main>
    );
  }

  return (
    <main style={{ padding: 24, maxWidth: 600, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ fontSize: 20, margin: 0 }}>Choose an organization</h1>
        {isPlatformAdmin && (
          <Link
            to="/admin/new-org"
            style={{
              padding: "8px 14px",
              background: "#2563eb",
              color: "#fff",
              textDecoration: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            + Create organization
          </Link>
        )}
      </div>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {orgs.map((o) => (
          <li key={o.slug}>
            <Link
              to={`/admin/${o.slug}`}
              style={{
                display: "block",
                padding: "12px 16px",
                background: "#fff",
                border: "1px solid #e2e2e2",
                borderRadius: 6,
                textDecoration: "none",
                color: "#222",
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              {o.name}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
