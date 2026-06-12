import {
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../supabase";
import { usePlatformAdmin } from "../../hooks/usePlatformAdmin";
import {
  ink,
  inkSoft,
  breadcrumbLinkStyle,
  pageH1Style,
  pageSubStyle,
  panelStyle,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  ctaSecondaryStyle,
  inputStyle,
  statusPanelStyle,
  sectionH2Style,
  bodyFontStack,
} from "../../lib/publicTheme";

// Super-admin form to spin up a new organization + provision its
// initial owner in one go. Gated by usePlatformAdmin() — non-admins
// see a 403 message instead of the form (the underlying edge
// function double-checks anyway).
//
// Owner email handling:
//   * already a user → linked directly as 'owner'
//   * not a user yet → Supabase sends an invite email; once they
//     confirm + set a password they land straight into the new org.
export default function CreateOrganizationPage() {
  const isPlatformAdmin = usePlatformAdmin();

  const [orgName, setOrgName] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [ownerFirstName, setOwnerFirstName] = useState("");
  const [ownerLastName, setOwnerLastName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{
    slug: string;
    name: string;
    ownerWasInvited: boolean;
  } | null>(null);

  if (isPlatformAdmin === null) {
    return <div style={{ padding: 24, color: inkSoft, fontFamily: bodyFontStack }}>Loading…</div>;
  }
  if (!isPlatformAdmin) {
    return (
      <main style={{ padding: 24, maxWidth: 600, margin: "0 auto", fontFamily: bodyFontStack }}>
        <h1 style={{ ...pageH1Style, fontSize: 20 }}>Not authorized</h1>
        <p style={{ color: inkSoft, fontSize: 14 }}>
          Creating organizations is restricted to platform admins.
        </p>
        <Link to="/admin" style={breadcrumbLinkStyle}>
          ← Back to organizations
        </Link>
      </main>
    );
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const finalSlug = (orgSlug || slugify(orgName)).trim();
    if (!orgName.trim() || !finalSlug) {
      setError("Organization name and slug are required.");
      return;
    }
    if (!ownerFirstName.trim()) {
      setError("Owner first name is required.");
      return;
    }
    if (!ownerEmail.trim()) {
      setError("Owner email is required.");
      return;
    }

    setBusy(true);
    const { data, error: fnErr } = await supabase.functions.invoke(
      "create-organization",
      {
        body: {
          orgName: orgName.trim(),
          orgSlug: finalSlug,
          ownerFirstName: ownerFirstName.trim(),
          ownerLastName: ownerLastName.trim() || undefined,
          ownerEmail: ownerEmail.trim(),
          baseUrl: window.location.origin,
        },
      },
    );
    setBusy(false);

    if (fnErr) {
      // Supabase functions.invoke surfaces non-2xx as a FunctionsError;
      // the JSON body sits on fnErr.context (a Response).
      let message = fnErr.message;
      try {
        const ctx = (fnErr as unknown as { context?: Response }).context;
        if (ctx) {
          const body = (await ctx.json()) as { error?: string };
          if (body.error) message = body.error;
        }
      } catch {
        /* fall through */
      }
      setError(message);
      return;
    }
    if (!data?.ok) {
      setError((data as { error?: string })?.error ?? "Failed.");
      return;
    }
    setSuccess({
      slug: data.slug,
      name: orgName.trim(),
      ownerWasInvited: !!data.ownerWasInvited,
    });
  };

  if (success) {
    return (
      <main style={{ padding: 24, maxWidth: 640, margin: "0 auto", fontFamily: bodyFontStack }}>
        <h1 style={{ ...pageH1Style, marginTop: 0 }}>
          {success.name} created
        </h1>
        <div style={{ ...statusPanelStyle("success"), marginTop: 14 }}>
          {success.ownerWasInvited ? (
            <>
              An invitation email was sent to{" "}
              <strong>{ownerEmail}</strong>. They'll set a password and land
              straight into the new organization as owner.
            </>
          ) : (
            <>
              <strong>{ownerEmail}</strong> already had an account and was
              linked directly as owner.
            </>
          )}
        </div>
        <div style={{ marginTop: 18, display: "flex", gap: 10 }}>
          <Link
            to={`/admin/${success.slug}`}
            style={{ ...ctaPrimaryStyle, textDecoration: "none" }}
          >
            Open {success.name} →
          </Link>
          <Link
            to="/admin"
            style={{ ...ctaSecondaryStyle, textDecoration: "none" }}
          >
            Back to organizations
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main style={{ padding: 24, maxWidth: 640, margin: "0 auto", fontFamily: bodyFontStack }}>
      <Link to="/admin" style={breadcrumbLinkStyle}>
        ← Organizations
      </Link>
      <h1 style={{ ...pageH1Style, margin: "12px 0 4px" }}>
        Create an organization
      </h1>
      <p style={{ ...pageSubStyle, margin: 0 }}>
        Sets up the organization and provisions its initial owner. If the
        owner email doesn't already have an account, an invitation is sent.
      </p>

      <form
        onSubmit={onSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          marginTop: 22,
        }}
      >
        <FieldRow>
          <Field label="Organization name" required>
            <input
              type="text"
              required
              value={orgName}
              onChange={(e) => {
                setOrgName(e.target.value);
                if (!slugTouched) setOrgSlug(slugify(e.target.value));
              }}
              style={inputStyle}
            />
          </Field>
          <Field
            label="URL slug"
            required
            hint="Used in admin + public URLs."
          >
            <input
              type="text"
              required
              value={orgSlug}
              onChange={(e) => {
                setOrgSlug(slugify(e.target.value));
                setSlugTouched(true);
              }}
              style={inputStyle}
            />
          </Field>
        </FieldRow>

        <div style={{ ...panelStyle, marginTop: 6 }}>
          <div style={{ ...sectionH2Style, fontSize: 13, marginBottom: 4 }}>
            Initial owner
          </div>
          <div
            style={{
              fontSize: 12,
              color: inkSoft,
              marginBottom: 12,
              lineHeight: 1.5,
            }}
          >
            The first admin for this organization. If they don't have an
            account yet, we'll email an invitation; once they confirm and set
            a password they're an owner of {orgName || "this org"}.
          </div>
          <FieldRow>
            <Field label="First name" required>
              <input
                type="text"
                required
                value={ownerFirstName}
                onChange={(e) => setOwnerFirstName(e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field label="Last name">
              <input
                type="text"
                value={ownerLastName}
                onChange={(e) => setOwnerLastName(e.target.value)}
                style={inputStyle}
              />
            </Field>
          </FieldRow>
          <Field label="Email" required hint="The address the invitation goes to.">
            <input
              type="email"
              required
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              style={inputStyle}
            />
          </Field>
        </div>

        {error && (
          <div style={statusPanelStyle("danger")}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <button
            type="submit"
            disabled={busy}
            style={busy ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
          >
            {busy ? "Creating…" : "Create organization"}
          </button>
          <Link
            to="/admin"
            style={{ ...ctaSecondaryStyle, textDecoration: "none" }}
          >
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 13,
        color: inkSoft,
      }}
    >
      <span>
        {label}
        {required && (
          <span style={{ color: "#ef4444", marginLeft: 4 }}>*</span>
        )}
      </span>
      {children}
      {hint && (
        <span style={{ fontSize: 12, color: ink, opacity: 0.5, marginTop: 2 }}>
          {hint}
        </span>
      )}
    </label>
  );
}

function FieldRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 16,
      }}
    >
      {children}
    </div>
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
