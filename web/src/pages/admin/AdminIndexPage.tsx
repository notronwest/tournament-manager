import { useEffect, useState, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import { usePlatformAdmin } from "../../hooks/usePlatformAdmin";
import {
  ink,
  inkSoft,
  inkMuted,
  bg,
  rule,
  warnBg,
  warnFg,
  creamDeep,
  bodyFontStack,
  headingFontStack,
  displayFontStack,
  ctaPrimaryStyle,
  ctaSecondaryStyle,
} from "../../lib/publicTheme";

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
      <main style={pageStyle}>
        <div style={colStyle}>
          <h1 style={h1Style}>Couldn't load organizations</h1>
          <p style={{ color: inkSoft, fontSize: 14 }}>{error}</p>
        </div>
      </main>
    );
  }

  if (orgs === null) {
    return (
      <main style={pageStyle}>
        <div style={colStyle}>
          <div style={{ color: inkMuted, fontSize: 14, fontFamily: bodyFontStack }}>
            Loading…
          </div>
        </div>
      </main>
    );
  }

  if (orgs.length === 0) {
    return (
      <main style={pageStyle}>
        <div style={colStyle}>
          <h1 style={h1Style}>No organizations</h1>
          <p style={{ color: inkSoft, fontSize: 14, lineHeight: 1.55 }}>
            You're not a member of any organization yet. Ask an organization
            owner to add you, or create your own.
          </p>
          {isPlatformAdmin && (
            <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
              <Link to="/admin/new-org" style={ctaPrimaryStyle}>
                + Create organization
              </Link>
              <Link to="/admin/platform" style={ctaSecondaryStyle}>
                Platform settings
              </Link>
            </div>
          )}
        </div>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <div style={colStyle}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 24,
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <h1 style={h1Style}>Choose an organization</h1>
          {isPlatformAdmin && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Link to="/admin/new-org" style={ctaPrimaryStyle}>
                + Create organization
              </Link>
              <Link to="/admin/platform" style={ctaSecondaryStyle}>
                Platform settings
              </Link>
            </div>
          )}
        </div>

        {orgs.length > 0 && (
          <>
            {isPlatformAdmin && (
              <div style={sectionLabelStyle}>Your organizations</div>
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
            <div style={{ ...sectionLabelStyle, marginTop: 28 }}>
              Other organizations (platform-admin access)
            </div>
            <ul style={listStyle}>
              {overrideOrgs.map((o) => (
                <li key={o.slug}>
                  <Link
                    to={`/admin/${o.slug}`}
                    style={{
                      ...orgLinkStyle,
                      background: warnBg,
                      borderColor: creamDeep,
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
                        color: warnFg,
                        fontWeight: 600,
                        background: "#fff8e7",
                        padding: "2px 8px",
                        borderRadius: 3,
                        fontFamily: bodyFontStack,
                        letterSpacing: "0.03em",
                      }}
                    >
                      admin override
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}

const pageStyle: CSSProperties = {
  background: bg,
  color: ink,
  fontFamily: bodyFontStack,
  minHeight: "100vh",
};

const colStyle: CSSProperties = {
  maxWidth: 560,
  margin: "0 auto",
  padding: "clamp(28px, 5vw, 48px) clamp(20px, 4vw, 32px) clamp(48px, 7vw, 72px)",
};

const h1Style: CSSProperties = {
  fontFamily: displayFontStack,
  fontSize: "clamp(26px, 4vw, 36px)",
  lineHeight: 1.05,
  letterSpacing: "-0.3px",
  margin: "0 0 8px",
  color: ink,
};

const sectionLabelStyle: CSSProperties = {
  fontSize: 11,
  color: inkMuted,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontWeight: 600,
  fontFamily: headingFontStack,
  marginBottom: 8,
};

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
  padding: "13px 16px",
  background: "#ffffff",
  border: `1px solid ${rule}`,
  borderRadius: 8,
  textDecoration: "none",
  color: ink,
  fontSize: 14,
  fontWeight: 500,
  fontFamily: bodyFontStack,
};
