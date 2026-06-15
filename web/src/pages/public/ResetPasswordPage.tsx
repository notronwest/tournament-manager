import { useState, useEffect, type FormEvent, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import {
  bg,
  ink,
  inkSoft,
  inkMuted,
  rule,
  dangerBg,
  dangerFg,
  successBg,
  successFg,
  courtGreen,
  courtYellow,
  courtRed,
  displayFontStack,
  bodyFontStack,
} from "../../lib/publicTheme";
import brushMark from "../../assets/bert-and-erne-brush-mark.svg";

export default function ResetPasswordPage() {
  const { updatePassword } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Initialised from the URL hash — Supabase appends ?type=recovery#...
  // or embeds the type in the fragment when the recovery link is clicked.
  // We also subscribe to PASSWORD_RECOVERY to catch the event if the SDK
  // processes the hash after this component mounts.
  const [recoveryReady, setRecoveryReady] = useState(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    return hash.get("type") === "recovery";
  });
  // True once the password has been set successfully.
  const [done, setDone] = useState(false);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setRecoveryReady(true);
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const { error: err } = await updatePassword(password);
      if (err) throw new Error(err.message);
      setDone(true);
      // Redirect after a brief moment so the user sees the success message.
      const returnTo = searchParams.get("return") ?? "/admin";
      setTimeout(() => navigate(returnTo, { replace: true }), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-layout" style={{ fontFamily: bodyFontStack }}>

      {/* Mobile header */}
      <header
        className="login-mobile-header"
        style={{ background: ink, padding: "12px 20px", alignItems: "center" }}
      >
        <img src={brushMark} alt="bert & erne" height="32" style={{ display: "block" }} />
      </header>

      {/* Desktop brand panel */}
      <aside
        className="login-brand-panel"
        style={{
          background: ink,
          color: "#ffffff",
          position: "relative",
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
            fontFamily: bodyFontStack,
            fontSize: 15,
            color: "rgba(255,255,255,0.70)",
            lineHeight: 1.5,
          }}
        >
          Choose a new password to secure your account.
        </p>
        <div
          aria-hidden="true"
          style={{ position: "absolute", bottom: 0, left: 0, right: 0, display: "flex" }}
        >
          <div style={{ flex: 1, height: 6, background: courtGreen }} />
          <div style={{ flex: 1, height: 6, background: courtYellow }} />
          <div style={{ flex: 1, height: 6, background: courtRed }} />
        </div>
      </aside>

      {/* Form area */}
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
            boxShadow: "0 6px 22px rgba(20,24,31,.06)",
          }}
        >
          <h1
            style={{
              fontFamily: displayFontStack,
              fontSize: 22,
              margin: "0 0 6px",
              color: ink,
              lineHeight: 1.15,
            }}
          >
            Set new password
          </h1>

          {!recoveryReady ? (
            <p style={{ margin: "16px 0 0", color: inkSoft, fontSize: 13, lineHeight: 1.5 }}>
              This link is invalid or has already been used.{" "}
              <button
                type="button"
                onClick={() => navigate("/login")}
                style={linkBtnStyle}
              >
                Request a new one.
              </button>
            </p>
          ) : done ? (
            <div
              style={{
                marginTop: 16,
                padding: 16,
                background: successBg,
                border: `1px solid #a7d7b0`,
                borderRadius: 10,
                color: successFg,
                fontSize: 13,
                lineHeight: 1.55,
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 24, marginBottom: 8 }}>✓</div>
              <div style={{ fontWeight: 600 }}>Password updated</div>
              <div style={{ marginTop: 4 }}>Taking you to the dashboard…</div>
            </div>
          ) : (
            <>
              <p style={{ margin: "0 0 20px", color: inkSoft, fontSize: 13, lineHeight: 1.5 }}>
                Choose a new password for your account.
              </p>
              <form
                onSubmit={onSubmit}
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <Field label="New password">
                  <input
                    type="password"
                    required
                    minLength={6}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={inputFieldStyle}
                  />
                </Field>
                <Field label="Confirm password">
                  <input
                    type="password"
                    required
                    minLength={6}
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    style={inputFieldStyle}
                  />
                </Field>
                {error && (
                  <div
                    style={{
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
                <button type="submit" disabled={busy} style={primaryBtnStyle(busy)}>
                  {busy ? "Saving…" : "Set password"}
                </button>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
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

const linkBtnStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: inkMuted,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: bodyFontStack,
  padding: 0,
  textDecoration: "underline",
};

