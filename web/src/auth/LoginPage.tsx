import { useState, type CSSProperties, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";

// Three modes:
//   magic  — email-only "get a link" flow. Default for public-flow
//            users (anyone bounced here from /t/...) because it's the
//            simplest path for non-savvy users: one field, click a
//            link in their inbox, done. The actual password gets set
//            later on the profile page if they want one.
//   signin — returning user with a password.
//   signup — explicit "create an account with a password right now."
//            Kept for users who'd rather pick their own password
//            upfront; not the default.
type Mode = "magic" | "signin" | "signup";

export default function LoginPage() {
  const {
    signInWithPassword,
    signUpWithPassword,
    signInWithMagicLink,
    signInWithGoogle,
  } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from =
    (location.state as { from?: { pathname?: string } } | null)?.from
      ?.pathname || "/admin";

  // Public flow vs. admin flow defaults. Anyone who hit this page
  // from /t/... (the public registration funnel) defaults to magic
  // link because the typical user is signing up for the first time
  // and shouldn't have to invent a password before they understand
  // what they're being asked to do. Anyone who came in via /admin or
  // typed /login directly defaults to the password form because they
  // probably already have one.
  const isPublicFlow = from.startsWith("/t/");
  const [mode, setMode] = useState<Mode>(isPublicFlow ? "magic" : "signin");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two post-submit confirmation states that both render the same
  // "check your email" panel. Tracked separately so the copy can
  // differ slightly per flow if we want.
  const [magicSent, setMagicSent] = useState(false);
  const [signupPending, setSignupPending] = useState(false);

  // Absolute URL Supabase should redirect to from the confirmation /
  // magic-link email. We hand it the URL the user was *trying* to
  // reach so they land back at the same tournament register page
  // after clicking the link, instead of getting dumped at /admin.
  // RequireAuth + RequireProfile handle the rest of the bounce.
  const emailRedirectTo = `${window.location.origin}${from}`;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        const { error } = await signInWithPassword(email, password);
        if (error) throw new Error(error.message);
        navigate(from, { replace: true });
      } else if (mode === "signup") {
        const { error } = await signUpWithPassword(
          email,
          password,
          emailRedirectTo,
        );
        if (error) throw new Error(error.message);
        // Supabase requires email confirmation by default, so the
        // user isn't actually signed in yet — show them the "check
        // your email" panel instead of navigating away.
        setSignupPending(true);
      } else {
        const { error } = await signInWithMagicLink(email, emailRedirectTo);
        if (error) throw new Error(error.message);
        setMagicSent(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  };

  const onGoogle = async () => {
    setError(null);
    const { error } = await signInWithGoogle(emailRedirectTo);
    // OAuth navigates away on success; we only see this branch on error.
    if (error) setError(error.message);
  };

  // Friendlier copy when we know the user is mid-registration — they
  // get to see what they're being asked to do this for.
  const sentToEmailPanel = (heading: string, body: string) => (
    <div
      style={{
        padding: 16,
        background: "#fffbeb",
        border: "1px solid #fde68a",
        borderRadius: 6,
        color: "#7a5d00",
        fontSize: 13,
        lineHeight: 1.55,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{heading}</div>
      <div>{body}</div>
      <div style={{ marginTop: 10, color: "#9a7d00", fontSize: 12 }}>
        Sent to <strong>{email}</strong>. The link will bring you back
        here to finish.
      </div>
    </div>
  );

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "#fafafa",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 400,
          background: "#fff",
          border: "1px solid #e2e2e2",
          borderRadius: 8,
          padding: 32,
        }}
      >
        <h1 style={{ margin: "0 0 4px", fontSize: 22 }}>Tournament Manager</h1>
        <p style={{ margin: "0 0 24px", color: "#666", fontSize: 13 }}>
          {isPublicFlow
            ? "Sign in or get started below — we just need to know who you are before you register."
            : "Sign in to manage tournaments."}
        </p>

        <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
          {(["magic", "signin", "signup"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setError(null);
                setMagicSent(false);
                setSignupPending(false);
              }}
              style={tabStyle(mode === m)}
            >
              {m === "magic"
                ? "Get started"
                : m === "signin"
                  ? "Sign in"
                  : "New password"}
            </button>
          ))}
        </div>

        {magicSent
          ? sentToEmailPanel(
              "Check your email",
              "We just sent you a link. Click it to sign in — you'll finish your profile and register on the next screen.",
            )
          : signupPending
            ? sentToEmailPanel(
                "Confirm your email",
                "We sent a confirmation link to verify your address. Click it to finish creating your account.",
              )
            : (
          <form
            onSubmit={onSubmit}
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            {mode === "magic" && (
              <p
                style={{
                  margin: "0 0 4px",
                  color: "#666",
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                Enter your email and we'll send you a link. New here? No
                password needed — you'll set one (if you want) along with
                your profile after you click the link.
              </p>
            )}
            <Field label="Email">
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={inputStyle}
              />
            </Field>

            {mode !== "magic" && (
              <Field label="Password">
                <input
                  type="password"
                  required
                  minLength={6}
                  autoComplete={
                    mode === "signup" ? "new-password" : "current-password"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={inputStyle}
                />
              </Field>
            )}

            <button type="submit" disabled={busy} style={primaryBtnStyle(busy)}>
              {busy
                ? "Working…"
                : mode === "magic"
                  ? "Email me a link"
                  : mode === "signin"
                    ? "Sign in"
                    : "Create account"}
            </button>
          </form>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            margin: "20px 0",
            color: "#999",
            fontSize: 11,
            letterSpacing: 0.5,
          }}
        >
          <hr
            style={{ flex: 1, border: "none", borderTop: "1px solid #e2e2e2" }}
          />
          OR
          <hr
            style={{ flex: 1, border: "none", borderTop: "1px solid #e2e2e2" }}
          />
        </div>

        <button type="button" onClick={onGoogle} style={secondaryBtnStyle}>
          Continue with Google
        </button>

        {error && (
          <div
            style={{
              marginTop: 16,
              padding: 12,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 6,
              color: "#991b1b",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}
      </div>
    </main>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 13,
        color: "#555",
      }}
    >
      {label}
      {children}
    </label>
  );
}

function tabStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: "8px 12px",
    fontSize: 13,
    background: active ? "#2563eb" : "#fff",
    color: active ? "#fff" : "#555",
    border: `1px solid ${active ? "#2563eb" : "#e2e2e2"}`,
    borderRadius: 6,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

const inputStyle: CSSProperties = {
  padding: "10px 12px",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  width: "100%",
};

function primaryBtnStyle(busy: boolean): CSSProperties {
  return {
    marginTop: 4,
    padding: "10px 12px",
    background: busy ? "#9ca3af" : "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 14,
    cursor: busy ? "not-allowed" : "pointer",
    fontWeight: 500,
    fontFamily: "inherit",
  };
}

const secondaryBtnStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: "#fff",
  color: "#333",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  cursor: "pointer",
  fontWeight: 500,
  fontFamily: "inherit",
};
