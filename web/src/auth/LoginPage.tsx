import { useState, type CSSProperties, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import {
  bg,
  ink,
  inkSoft,
  inkMuted,
  cream,
  creamDeep,
  rule,
  warnBg,
  warnFg,
  dangerBg,
  dangerFg,
  courtGreen,
  courtYellow,
  courtRed,
  displayFontStack,
  bodyFontStack,
  monoFontStack,
} from "../lib/publicTheme";
import brushMark from "../assets/bert-and-erne-brush-mark.svg";
import outlinedLogo from "../assets/bert-and-erne-v5-outlined.svg";

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

  const sentToEmailPanel = (heading: string, body: string) => (
    <div
      style={{
        padding: 16,
        background: warnBg,
        border: `1px solid ${creamDeep}`,
        borderRadius: 10,
        color: warnFg,
        fontSize: 13,
        lineHeight: 1.55,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 28, lineHeight: 1, marginBottom: 8 }}>✉️</div>
      <div style={{ fontWeight: 600, color: ink, fontSize: 15, marginBottom: 6 }}>
        {heading}
      </div>
      <div>{body}</div>
      <div
        style={{
          marginTop: 10,
          fontFamily: monoFontStack,
          fontSize: 12,
          color: ink,
        }}
      >
        {email}
      </div>
    </div>
  );

  return (
    // login-layout and child classes are defined in index.css:
    // desktop = flex-row (brand panel left, form right)
    // mobile  = flex-col (slim header bar top, form below)
    <div className="login-layout" style={{ fontFamily: bodyFontStack }}>

      {/* ── Mobile only: slim ink header bar ─────────────────── */}
      <header
        className="login-mobile-header"
        style={{
          background: ink,
          padding: "12px 20px",
          display: "flex",
          alignItems: "center",
        }}
      >
        <img
          src={brushMark}
          alt="bert & erne"
          height="32"
          style={{ display: "block" }}
        />
      </header>

      {/* ── Desktop only: ink brand panel ────────────────────── */}
      <aside
        className="login-brand-panel"
        style={{
          background: ink,
          color: "#ffffff",
          position: "relative",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-start",
          padding: "56px 48px",
        }}
      >
        <img
          src={brushMark}
          alt="bert & erne"
          width="220"
          style={{ display: "block", marginBottom: 20 }}
        />
        <p
          style={{
            margin: 0,
            fontFamily: monoFontStack,
            fontSize: 13,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.55)",
          }}
        >
          pickleball tournaments
        </p>

        {/* G / Y / R court stripes at the bottom of the panel */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            display: "flex",
          }}
        >
          <div style={{ flex: 1, height: 6, background: courtGreen }} />
          <div style={{ flex: 1, height: 6, background: courtYellow }} />
          <div style={{ flex: 1, height: 6, background: courtRed }} />
        </div>
      </aside>

      {/* ── Form area (desktop: right side; mobile: below header) */}
      <main
        className="login-form-area"
        style={{
          flex: 1,
          background: bg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "clamp(24px, 5vw, 48px) clamp(16px, 4vw, 32px)",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 400,
            background: "#ffffff",
            border: `1px solid ${rule}`,
            borderRadius: 12,
            padding: "28px 32px",
            boxShadow: `0 6px 22px rgba(20,24,31,.06)`,
          }}
        >
          {/* Wordmark inside card — shown on mobile only via CSS class.
              On desktop the brand panel handles the wordmark. */}
          <div className="login-card-logo" style={{ marginBottom: 14 }}>
            <img
              src={outlinedLogo}
              alt="bert & erne"
              width="130"
              style={{ display: "block" }}
            />
          </div>

          <h1
            style={{
              fontFamily: displayFontStack,
              fontSize: 22,
              margin: "0 0 6px",
              color: ink,
              lineHeight: 1.15,
            }}
          >
            {mode === "magic"
              ? "Get started"
              : mode === "signin"
                ? "Sign in"
                : "Create account"}
          </h1>
          <p style={{ margin: "0 0 20px", color: inkSoft, fontSize: 13, lineHeight: 1.5 }}>
            {isPublicFlow
              ? "Sign in or get started — we just need to know who you are before you register."
              : "Sign in to manage tournaments."}
          </p>

          {/* Segmented control */}
          <div
            role="radiogroup"
            aria-label="Sign-in mode"
            style={{
              display: "flex",
              background: cream,
              border: `1px solid ${creamDeep}`,
              borderRadius: 10,
              padding: 3,
              gap: 3,
              marginBottom: 18,
            }}
          >
            {(["magic", "signin", "signup"] as const).map((m) => {
              const active = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    setMode(m);
                    setError(null);
                    setMagicSent(false);
                    setSignupPending(false);
                  }}
                  style={segTabStyle(active)}
                >
                  {m === "magic"
                    ? "Get started"
                    : m === "signin"
                      ? "Sign in"
                      : "New password"}
                </button>
              );
            })}
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
                    color: inkMuted,
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  Enter your email and we&apos;ll send you a link.{" "}
                  <strong style={{ color: ink }}>No password needed</strong> —
                  you can set one later with your profile.
                </p>
              )}
              <Field label="Email">
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={inputFieldStyle}
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
                    style={inputFieldStyle}
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
              color: inkMuted,
              fontSize: 11,
              letterSpacing: 0.5,
            }}
          >
            <hr style={{ flex: 1, border: "none", borderTop: `1px solid ${rule}` }} />
            OR
            <hr style={{ flex: 1, border: "none", borderTop: `1px solid ${rule}` }} />
          </div>

          <button type="button" onClick={onGoogle} style={googleBtnStyle}>
            Continue with Google
          </button>

          {error && (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                background: dangerBg,
                border: `1px solid #f5a49a`,
                borderRadius: 8,
                color: dangerFg,
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}

          {/* Cancel: a quiet escape hatch so a user who clicked
              "Register" by accident isn't stuck on the sign-in screen
              without a clear way back. Drops them at the homepage where
              they can keep browsing. */}
          <div style={{ marginTop: 16, textAlign: "center" }}>
            <button
              type="button"
              onClick={() => navigate("/")}
              style={{
                background: "none",
                border: "none",
                color: inkMuted,
                fontSize: 13,
                cursor: "pointer",
                fontFamily: "inherit",
                textDecoration: "underline",
                padding: 0,
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </main>
    </div>
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
        color: inkSoft,
      }}
    >
      {label}
      {children}
    </label>
  );
}

function segTabStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: "7px 4px",
    fontSize: 12,
    fontWeight: 600,
    background: active ? "#ffffff" : "transparent",
    color: active ? ink : inkSoft,
    border: "none",
    borderRadius: 7,
    cursor: "pointer",
    fontFamily: bodyFontStack,
    boxShadow: active ? "0 1px 3px rgba(20,24,31,.12)" : "none",
    textAlign: "center",
  };
}

const inputFieldStyle: CSSProperties = {
  padding: "10px 12px",
  border: `1px solid ${rule}`,
  borderRadius: 9,
  fontSize: 14,
  fontFamily: bodyFontStack,
  width: "100%",
  background: "#ffffff",
  color: ink,
  outline: "none",
};

function primaryBtnStyle(busy: boolean): CSSProperties {
  return {
    marginTop: 4,
    padding: "11px 12px",
    background: busy ? "#9ca3af" : ink,
    color: "#ffffff",
    border: "none",
    borderRadius: 10,
    fontSize: 14,
    cursor: busy ? "not-allowed" : "pointer",
    fontWeight: 600,
    fontFamily: bodyFontStack,
    width: "100%",
  };
}

const googleBtnStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: "#ffffff",
  color: ink,
  border: `1px solid ${rule}`,
  borderRadius: 10,
  fontSize: 14,
  cursor: "pointer",
  fontWeight: 500,
  fontFamily: bodyFontStack,
};
