import { useState, type CSSProperties, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";

type Mode = "signin" | "signup" | "magic";

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

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [magicSent, setMagicSent] = useState(false);

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
        const { error } = await signUpWithPassword(email, password);
        if (error) throw new Error(error.message);
        // If the project requires email confirmation, the user won't be
        // signed in yet — they get a confirmation email. Surface that.
        navigate(from, { replace: true });
      } else {
        const { error } = await signInWithMagicLink(email);
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
    const { error } = await signInWithGoogle();
    // OAuth navigates away on success; we only see this branch on error.
    if (error) setError(error.message);
  };

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
          Sign in to manage tournaments.
        </p>

        <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
          {(["signin", "signup", "magic"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setError(null);
                setMagicSent(false);
              }}
              style={tabStyle(mode === m)}
            >
              {m === "signin"
                ? "Sign in"
                : m === "signup"
                  ? "Sign up"
                  : "Magic link"}
            </button>
          ))}
        </div>

        {magicSent ? (
          <div
            style={{
              padding: 14,
              background: "#fffbeb",
              border: "1px solid #fde68a",
              borderRadius: 6,
              color: "#7a5d00",
              fontSize: 13,
            }}
          >
            Magic link sent to <strong>{email}</strong>. Check your inbox.
          </div>
        ) : (
          <form
            onSubmit={onSubmit}
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
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
                : mode === "signin"
                  ? "Sign in"
                  : mode === "signup"
                    ? "Create account"
                    : "Send magic link"}
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
