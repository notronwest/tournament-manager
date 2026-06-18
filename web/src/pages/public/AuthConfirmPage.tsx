import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { EmailOtpType } from "@supabase/supabase-js";
import { supabase } from "../../supabase";
import {
  bodyFontStack,
  ctaPrimaryStyle,
  displayFontStack,
  ink,
  inkSoft,
  pageWrapStyle,
} from "../../lib/publicTheme";

// Branded landing for auth email links. Instead of pointing the
// confirmation button at the raw <project-ref>.supabase.co/auth/v1/verify
// URL (which reads as a stranger's domain and trips spam filters), the
// email templates link here — {{ .SiteURL }}/auth/confirm?... — and we
// exchange the token_hash for a session client-side via verifyOtp. The
// visible link stays on our own domain.
//
// Templates pass: token_hash, type (signup | magiclink | recovery), and
// next ({{ .RedirectTo }} — the URL the user was originally headed to).

const VALID_TYPES: EmailOtpType[] = [
  "signup",
  "magiclink",
  "recovery",
  "email",
  "invite",
  "email_change",
];

// Resolve "next" to a safe SAME-ORIGIN internal path. Guards against an
// open redirect if the param were ever tampered with.
function safeNext(raw: string | null): string {
  if (!raw) return "/admin";
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return "/admin";
    return url.pathname + url.search + url.hash;
  } catch {
    return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/admin";
  }
}

export default function AuthConfirmPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // verifyOtp consumes the single-use token_hash — guard against the
  // effect running twice (React 18 StrictMode double-invoke) so we don't
  // burn the token and then report it "already used".
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const tokenHash = params.get("token_hash");
    const type = params.get("type") as EmailOtpType | null;
    if (!tokenHash || !type || !VALID_TYPES.includes(type)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("This link is missing or has invalid confirmation details.");
      return;
    }

    void (async () => {
      const { error: verr } = await supabase.auth.verifyOtp({
        type,
        token_hash: tokenHash,
      });
      if (verr) {
        setError(verr.message || "This link is invalid or has expired.");
        return;
      }
      // Recovery always lands on the set-a-new-password screen; the
      // ?recovery=1 flag tells ResetPasswordPage we arrived with a valid
      // recovery session (it otherwise looks for the implicit-flow hash).
      if (type === "recovery") {
        navigate("/reset-password?recovery=1", { replace: true });
        return;
      }
      navigate(safeNext(params.get("next")), { replace: true });
    })();
  }, [params, navigate]);

  return (
    <div
      style={{
        ...pageWrapStyle,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 20px",
        fontFamily: bodyFontStack,
      }}
    >
      <div style={{ maxWidth: 420, textAlign: "center" }}>
        {error ? (
          <>
            <h1
              style={{
                fontFamily: displayFontStack,
                fontSize: 24,
                color: ink,
                margin: "0 0 10px",
              }}
            >
              Couldn’t confirm this link
            </h1>
            <p style={{ color: ink, fontSize: 14, lineHeight: 1.6, margin: "0 0 6px" }}>
              {error}
            </p>
            <p style={{ color: inkSoft, fontSize: 13, lineHeight: 1.6, margin: "0 0 20px" }}>
              Links expire and can only be used once — request a fresh one and
              try again.
            </p>
            <Link to="/login" style={{ ...ctaPrimaryStyle, textDecoration: "none" }}>
              Back to sign in
            </Link>
          </>
        ) : (
          <p style={{ color: inkSoft, fontSize: 15 }}>Confirming your link…</p>
        )}
      </div>
    </div>
  );
}
