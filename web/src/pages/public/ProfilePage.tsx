import {
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import type { Database } from "../../types/supabase";
import {
  contentColStyle,
  courtRed,
  courtYellow,
  ctaPrimaryDisabledStyle,
  ctaPrimaryStyle,
  ctaSecondaryStyle,
  ghostButtonStyle,
  ink,
  inkMuted,
  inkSoft,
  inputStyle,
  pageH1Style,
  pageSubStyle,
  pageWrapStyle,
  panelStyle,
  rule,
  statusPanelStyle,
} from "../../lib/publicTheme";

type Player = Database["public"]["Tables"]["players"]["Row"];
type PlayerGender = Database["public"]["Enums"]["player_gender"];

// One-time (mostly) profile screen. Reached either:
//   * Automatically via RequireProfile after a fresh signup when
//     the user hasn't filled out a name yet, OR
//   * Manually via an "Edit profile" link.
//
// Required: first_name + last_name. Everything else is encouraged
// but optional. The save handler also reclaims an unlinked players
// row whose email matches the auth user — covers the case where an
// admin pre-created the player record before the user signed up.
//
// `?return=<path>` query param: where to navigate after saving.
// Defaults to /admin so an "Edit profile" link from anywhere lands
// safely if no return is provided.
export default function ProfilePage() {
  const { user, updatePassword } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("return") || "/admin";

  const [existingPlayer, setExistingPlayer] = useState<Player | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState<PlayerGender | "">("");
  const [ratingDoubles, setRatingDoubles] = useState("");
  const [ratingMixed, setRatingMixed] = useState("");
  const [ratingSingles, setRatingSingles] = useState("");
  // Optional password setup shown only on first-fill — lets a
  // magic-link signup opt into a password while they're already
  // filling in their profile, so they don't have to come back later
  // to do it. Both fields stay optional; leaving them blank just
  // means "I'll keep using magic links."
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // Email-change request state — separate from the profile save flow.
  const [requestState, setRequestState] = useState<
    "idle" | "open" | "sending" | "sent"
  >("idle");
  const [requestedEmail, setRequestedEmail] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);

      // First-pass: player linked to this auth user.
      let me: Player | null = null;
      {
        const { data } = await supabase
          .from("players")
          .select("*")
          .eq("auth_user_id", user.id)
          .is("deleted_at", null)
          .maybeSingle();
        if (cancelled) return;
        me = data ?? null;
      }
      // Fallback: a single unlinked player record with the same
      // email — the admin-pre-created case. We display it so the
      // user sees what's on file and can confirm before saving
      // (which links it to their auth_user_id).
      if (!me && user.email) {
        const { data } = await supabase
          .from("players")
          .select("*")
          .eq("email", user.email)
          .is("auth_user_id", null)
          .is("deleted_at", null);
        if (cancelled) return;
        if (data && data.length === 1) me = data[0];
      }

      setExistingPlayer(me);
      if (me) {
        setFirstName(me.first_name ?? "");
        setLastName(me.last_name ?? "");
        setPhone(me.phone ?? "");
        setGender(me.gender ?? "");
        setRatingDoubles(
          me.self_rating_doubles != null
            ? String(me.self_rating_doubles)
            : "",
        );
        setRatingMixed(
          me.self_rating_mixed != null ? String(me.self_rating_mixed) : "",
        );
        setRatingSingles(
          me.self_rating_singles != null
            ? String(me.self_rating_singles)
            : "",
        );
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setError(null);
    if (!firstName.trim() || !lastName.trim()) {
      setError("First and last name are required.");
      return;
    }
    // Password fields are entirely optional but, if one is filled,
    // both must be filled and they must match. Validate before
    // touching the database so we don't half-save.
    const wantsPassword = !!(newPassword || confirmPassword);
    if (wantsPassword) {
      if (newPassword.length < 6) {
        setError("Password must be at least 6 characters.");
        return;
      }
      if (newPassword !== confirmPassword) {
        setError("Passwords don't match.");
        return;
      }
    }
    setBusy(true);

    // Update password first — if it fails we want to bail out before
    // we've started touching player rows. Supabase's updateUser is
    // idempotent so a retry after a profile error is safe.
    if (wantsPassword) {
      const { error: pwErr } = await updatePassword(newPassword);
      if (pwErr) {
        setError(pwErr.message);
        setBusy(false);
        return;
      }
    }

    const payload = {
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      phone: phone.trim() || null,
      gender: (gender || null) as PlayerGender | null,
      self_rating_doubles: parseRating(ratingDoubles),
      self_rating_mixed: parseRating(ratingMixed),
      self_rating_singles: parseRating(ratingSingles),
    };

    // Three save paths: update auth-linked row, claim an email-
    // matched orphan, or insert a new row. Identical to the logic
    // RegisterPage used to have inline; lifted here so the profile
    // is owned by one place.
    let saved: Player | null = null;
    if (existingPlayer && existingPlayer.auth_user_id === user.id) {
      const { data, error: updErr } = await supabase
        .from("players")
        .update(payload)
        .eq("id", existingPlayer.id)
        .select()
        .single();
      if (updErr) {
        setError(updErr.message);
        setBusy(false);
        return;
      }
      saved = data;
    } else if (existingPlayer && existingPlayer.auth_user_id === null) {
      const { data, error: updErr } = await supabase
        .from("players")
        .update({ ...payload, auth_user_id: user.id })
        .eq("id", existingPlayer.id)
        .select()
        .single();
      if (updErr) {
        setError(updErr.message);
        setBusy(false);
        return;
      }
      saved = data;
    } else {
      const { data, error: insErr } = await supabase
        .from("players")
        .insert({
          ...payload,
          auth_user_id: user.id,
          email: user.email ?? null,
        })
        .select()
        .single();
      if (insErr) {
        setError(insErr.message);
        setBusy(false);
        return;
      }
      saved = data;
    }

    setBusy(false);
    if (saved) {
      navigate(returnTo, { replace: true });
    }
  };

  const onRequestSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setRequestError(null);
    setRequestState("sending");
    const { error: fnErr } = await supabase.functions.invoke(
      "request-email-change",
      { body: { requestedEmail } },
    );
    if (fnErr) {
      let msg = "Something went wrong. Please try again.";
      try {
        const ctx = (fnErr as unknown as { context?: Response }).context;
        if (ctx) {
          const body = (await ctx.json()) as { error?: string };
          if (body.error) msg = body.error;
        }
      } catch { /* use default */ }
      setRequestError(msg);
      setRequestState("open");
      return;
    }
    setRequestState("sent");
  };

  if (loading) {
    return (
      <Shell>
        <p style={{ color: inkMuted, fontSize: 14 }}>Loading…</p>
      </Shell>
    );
  }

  // First-fill heading vs. edit heading — small touch but tells the
  // returning user "you've been here before." We deliberately don't
  // try to greet by name here: on first fill we don't have one yet,
  // and falling back to the email local-part (e.g. "Welcome,
  // ronaldwest123 👋") reads worse than just "Welcome 👋".
  const requestSending = requestState === "sending";
  const requestFormVisible =
    requestState === "open" || requestState === "sending";
  const isFirstFill = !existingPlayer || !existingPlayer.first_name;
  const heading = isFirstFill ? "Welcome 👋" : "Your profile";
  const subhead = isFirstFill
    ? "Before you register, we need a few things about you. You only have to do this once — every future tournament uses the same profile."
    : "Anything you update here flows into every event you've registered for.";

  return (
    <Shell>
      {isFirstFill && (
        <div style={progressBarRow}>
          <div style={progressStepActive} />
          <div style={progressStep} />
        </div>
      )}
      <h1 style={pageH1Style}>{heading}</h1>
      <p style={pageSubStyle}>{subhead}</p>

      {/* ── Account email + change request ──────────────────────── */}
      <div style={{ ...panelStyle, marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontSize: 12, color: inkSoft, marginBottom: 2 }}>Account email</div>
            <div style={{ fontSize: 14, color: ink }}>{user?.email ?? "—"}</div>
          </div>
          {requestState === "idle" && (
            <button
              type="button"
              onClick={() => setRequestState("open")}
              style={ghostButtonStyle}
            >
              Request a change
            </button>
          )}
        </div>
        {requestFormVisible && (
          <form
            onSubmit={onRequestSubmit}
            style={{ borderTop: `1px solid ${rule}`, paddingTop: 12, marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}
          >
            <label
              style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: inkSoft }}
            >
              New email address
              <input
                type="email"
                required
                value={requestedEmail}
                onChange={(e) => setRequestedEmail(e.target.value)}
                style={inputStyle}
                disabled={requestSending}
                placeholder="new@example.com"
              />
            </label>
            <p style={{ fontSize: 12, color: inkMuted, margin: 0 }}>
              Your request will be forwarded to the site administrator, who will
              update your account and follow up by email.
            </p>
            {requestError && (
              <div style={statusPanelStyle("danger")}>{requestError}</div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="submit"
                disabled={requestSending}
                style={requestSending ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
              >
                {requestSending ? "Sending…" : "Send request"}
              </button>
              <button
                type="button"
                onClick={() => { setRequestState("idle"); setRequestedEmail(""); setRequestError(null); }}
                style={ctaSecondaryStyle}
                disabled={requestSending}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {requestState === "sent" && (
          <div style={{ ...statusPanelStyle("success"), marginTop: 12 }}>
            Your request has been sent to the site administrator. They&rsquo;ll
            be in touch once your email has been updated.
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <FieldRow>
          <Field label="First name" required>
            <input
              type="text"
              required
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              style={inputStyle}
              disabled={busy}
            />
          </Field>
          <Field label="Last name" required>
            <input
              type="text"
              required
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              style={inputStyle}
              disabled={busy}
            />
          </Field>
        </FieldRow>

        <FieldRow>
          <Field label="Phone">
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              style={inputStyle}
              disabled={busy}
            />
          </Field>
          <Field label="Gender">
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value as PlayerGender | "")}
              style={inputStyle}
              disabled={busy}
            >
              <option value="">—</option>
              <option value="M">Male</option>
              <option value="F">Female</option>
              <option value="X">Other / prefer not to say</option>
            </select>
          </Field>
        </FieldRow>

        <div>
          <div style={{ fontSize: 13, color: ink, marginBottom: 4 }}>
            <strong>Self-reported rating</strong>{" "}
            <span style={{ color: inkMuted }}>
              (optional — helps organizers seed brackets)
            </span>
          </div>
          <FieldRow>
            <Field label="Doubles (same-gender)">
              <input
                type="number"
                step="0.01"
                min="0"
                max="9.99"
                value={ratingDoubles}
                onChange={(e) => setRatingDoubles(e.target.value)}
                style={inputStyle}
                disabled={busy}
                placeholder="e.g. 3.5"
              />
            </Field>
            <Field label="Mixed doubles">
              <input
                type="number"
                step="0.01"
                min="0"
                max="9.99"
                value={ratingMixed}
                onChange={(e) => setRatingMixed(e.target.value)}
                style={inputStyle}
                disabled={busy}
                placeholder="e.g. 3.5"
              />
            </Field>
            <Field label="Singles">
              <input
                type="number"
                step="0.01"
                min="0"
                max="9.99"
                value={ratingSingles}
                onChange={(e) => setRatingSingles(e.target.value)}
                style={inputStyle}
                disabled={busy}
                placeholder="e.g. 3.0"
              />
            </Field>
          </FieldRow>
        </div>

        {isFirstFill && (
          <div>
            <div style={{ fontSize: 13, color: ink, marginBottom: 4 }}>
              <strong>Set a password</strong>{" "}
              <span style={{ color: inkMuted }}>
                (optional — you can keep signing in with email links if
                you prefer)
              </span>
            </div>
            <FieldRow>
              <Field label="Password">
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={6}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  style={inputStyle}
                  disabled={busy}
                  placeholder="At least 6 characters"
                />
              </Field>
              <Field label="Confirm password">
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={6}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  style={inputStyle}
                  disabled={busy}
                />
              </Field>
            </FieldRow>
          </div>
        )}

        {error && (
          <div style={statusPanelStyle("danger")}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
          <button
            type="submit"
            disabled={busy}
            style={busy ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
          >
            {busy
              ? "Saving…"
              : isFirstFill
                ? "Save & continue →"
                : "Save profile"}
          </button>
          {/* Cancel sends the user back where they came from on the
              edit path (returnTo defaults to /admin). On first-fill
              they can still cancel, but they'll have to come back to
              the profile screen before they can register for
              anything — RequireProfile bounces them right here. */}
          <button
            type="button"
            onClick={() => navigate(isFirstFill ? "/" : returnTo)}
            disabled={busy}
            style={
              busy
                ? { ...ctaSecondaryStyle, opacity: 0.6, cursor: "not-allowed" }
                : ctaSecondaryStyle
            }
          >
            Cancel
          </button>
        </div>
      </form>
    </Shell>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers + small UI bits
// ─────────────────────────────────────────────────────────────────────

function parseRating(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const n = parseFloat(trimmed);
  if (Number.isNaN(n)) return null;
  if (n < 0) return 0;
  if (n > 9.99) return 9.99;
  return n;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div style={pageWrapStyle}>
      <main style={contentColStyle(560)}>
        {children}
      </main>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 12,
        color: inkSoft,
        flex: "1 1 160px",
        minWidth: 0,
      }}
    >
      <span>
        {label}
        {required && (
          <span style={{ color: courtRed, marginLeft: 4 }}>*</span>
        )}
      </span>
      {children}
    </label>
  );
}

function FieldRow({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>{children}</div>
  );
}

const progressBarRow: CSSProperties = {
  display: "flex",
  gap: 4,
  marginBottom: 20,
};

const progressStep: CSSProperties = {
  flex: 1,
  height: 4,
  background: rule,
  borderRadius: 2,
};

const progressStepActive: CSSProperties = {
  ...progressStep,
  background: courtYellow,
};
