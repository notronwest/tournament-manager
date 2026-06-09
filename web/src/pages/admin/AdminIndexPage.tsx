import { useEffect, useState, type CSSProperties } from "react";
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
  // Orgs the platform admin can access via override (excludes the
  // ones they're an explicit member of, which are in `orgs`). Empty
  // for non-platform-admins.
  const [overrideOrgs, setOverrideOrgs] = useState<OrgSummary[]>([]);
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

      // Platform admins also see every other org as an
      // override-access section (so they can walk into any org from
      // the picker without typing the slug).
      if (isPlatformAdmin) {
        const memberSlugs = new Set(list.map((o) => o.slug));
        const { data: allOrgs } = await supabase
          .from("organizations")
          .select("slug, name")
          .is("deleted_at", null)
          .order("name", { ascending: true });
        if (cancelled) return;
        const others = (allOrgs ?? []).filter(
          (o): o is OrgSummary => !!o && !memberSlugs.has(o.slug),
        );
        setOverrideOrgs(others);
      }

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
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <Link
              to="/admin/new-org"
              style={{
                display: "inline-block",
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
            <Link
              to="/admin/platform"
              style={{
                display: "inline-block",
                padding: "8px 14px",
                background: "#fff",
                color: "#2563eb",
                border: "1px solid #2563eb",
                textDecoration: "none",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              Platform settings
            </Link>
          </div>
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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
            <Link
              to="/admin/platform"
              style={{
                padding: "8px 14px",
                background: "#fff",
                color: "#2563eb",
                border: "1px solid #2563eb",
                textDecoration: "none",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              Platform settings
            </Link>
          </div>
        )}
      </div>
      {orgs.length > 0 && (
        <>
          {isPlatformAdmin && (
            <div
              style={{
                fontSize: 11,
                color: "#888",
                textTransform: "uppercase",
                letterSpacing: 0.5,
                fontWeight: 600,
                marginBottom: 6,
              }}
            >
              Your organizations
            </div>
          )}
          <ul style={listStyle}>
            {orgs.map((o) => (
              <li key={o.slug}>
                <Link to={`/admin/${o.slug}`} style={orgLinkStyle}>
                  {o.name}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {overrideOrgs.length > 0 && (
        <>
          <div
            style={{
              fontSize: 11,
              color: "#888",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              fontWeight: 600,
              marginTop: 24,
              marginBottom: 6,
            }}
          >
            Other organizations (platform-admin access)
          </div>
          <ul style={listStyle}>
            {overrideOrgs.map((o) => (
              <li key={o.slug}>
                <Link
                  to={`/admin/${o.slug}`}
                  style={{
                    ...orgLinkStyle,
                    background: "#fffbeb",
                    borderColor: "#fde68a",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span>{o.name}</span>
                  <span
                    style={{
                      fontSize: 11,
                      color: "#7a5d00",
                      fontWeight: 500,
                      background: "#fef3c7",
                      padding: "2px 8px",
                      borderRadius: 3,
                    }}
                  >
                    🛡 admin override
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

const listStyle: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const orgLinkStyle: CSSProperties = {
  display: "block",
  padding: "12px 16px",
  background: "#fff",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  textDecoration: "none",
  color: "#222",
  fontSize: 14,
  fontWeight: 500,
};
