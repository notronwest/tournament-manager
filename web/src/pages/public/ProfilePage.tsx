import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { Eye, EyeOff } from "lucide-react";
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
  courtBlue,
  dangerFg,
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

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

function extFor(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

// One-time (mostly) profile screen. Reached either:
//   * Automatically via RequireProfile after a fresh signup when
//     the user hasn't filled out a name or email yet, OR
//   * Manually via an "Edit profile" link.
//
// Required: first_name + last_name. Email is also required when the
// player record has no email on file (e.g. Google OAuth where the
// provider didn't share it, or an admin-pre-created row). Everything
// else is encouraged but optional. The save handler also reclaims an
// unlinked players row whose email matches the auth user — covers the
// case where an admin pre-created the player record before the user
// signed up.
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

  const [email, setEmail] = useState("");
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

  // Account section — change-password form (non-first-fill only).
  // Has its own state so it doesn't interfere with the profile form.
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pwNewVisible, setPwNewVisible] = useState(false);
  const [pwConfirmVisible, setPwConfirmVisible] = useState(false);
  // Collapsible "why don't I need a password?" explainer — passwordless can
  // be confusing if you've never seen it, so it's hidden until asked for.
  const [pwExplainerOpen, setPwExplainerOpen] = useState(false);

  // Avatar upload state
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Clean up blob URL when it changes (avoids leaking object URLs)
  useEffect(() => {
    return () => {
      if (avatarPreviewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(avatarPreviewUrl);
      }
    };
  }, [avatarPreviewUrl]);

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
      // Pre-fill email: player row email → auth session email → blank.
      // The auth-session fallback handles both the "player row has no
      // email" case (Google OAuth where the email wasn't written to the
      // row yet) AND the "no player row at all" case (fresh signup
      // visiting /profile directly before any gated route fires).
      setEmail(me?.email ?? user.email ?? "");
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
        if (me.avatar_path) {
          const { data: urlData } = supabase.storage
            .from("avatars")
            .getPublicUrl(me.avatar_path);
          if (!cancelled) setAvatarPreviewUrl(urlData.publicUrl);
        }
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleAvatarClick = () => {
    if (!busy) fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarError(null);
    if (!ALLOWED_TYPES.includes(file.type)) {
      setAvatarError("Only JPG, PNG, or WebP images are allowed.");
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setAvatarError("Image must be 5 MB or smaller.");
      return;
    }
    setAvatarFile(file);
    setPendingRemove(false);
    setAvatarPreviewUrl(URL.createObjectURL(file));
  };

  const handleRemoveAvatar = () => {
    setAvatarFile(null);
    setAvatarPreviewUrl(null);
    setAvatarError(null);
    setPendingRemove(true);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setError(null);
    if (!firstName.trim() || !lastName.trim()) {
      setError("First and last name are required.");
      return;
    }
    if (needsEmail && !email.trim()) {
      setError("Email address is required to receive receipts and partner invites.");
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

    // Handle avatar storage operations before updating the player row
    let resolvedAvatarPath: string | null = existingPlayer?.avatar_path ?? null;

    if (avatarFile) {
      const ext = extFor(avatarFile.type);
      const newPath = `${user.id}/avatar.${ext}`;
      const oldPath = existingPlayer?.avatar_path ?? null;

      // Delete old object if the path changed (e.g. jpg → png) to avoid orphans
      if (oldPath && oldPath !== newPath) {
        await supabase.storage.from("avatars").remove([oldPath]);
      }

      const { error: uploadErr } = await supabase.storage
        .from("avatars")
        .upload(newPath, avatarFile, { upsert: true, contentType: avatarFile.type });

      if (uploadErr) {
        setError(`Photo upload failed: ${uploadErr.message}`);
        setBusy(false);
        return;
      }
      resolvedAvatarPath = newPath;
    } else if (pendingRemove && existingPlayer?.avatar_path) {
      // Best-effort delete — don't block the profile save if storage delete fails
      await supabase.storage.from("avatars").remove([existingPlayer.avatar_path]);
      resolvedAvatarPath = null;
    }

    const payload = {
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      phone: phone.trim() || null,
      gender: (gender || null) as PlayerGender | null,
      self_rating_doubles: parseRating(ratingDoubles),
      self_rating_mixed: parseRating(ratingMixed),
      self_rating_singles: parseRating(ratingSingles),
      avatar_path: resolvedAvatarPath,
      // Include email in the payload only when the player record
      // currently has none — captures the missing email without
      // overwriting an email the player may have set via a separate
      // change-request flow.
      ...(needsEmail ? { email: email.trim() || null } : {}),
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
          // For new inserts, use the email state (which was pre-filled
          // from user.email if available). payload may already include
          // it via the needsEmail spread, but the insert always needs
          // an email column value so we set it explicitly here.
          email: email.trim() || user.email || null,
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

  const onPasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setPwError(null);
    setPwSuccess(false);
    if (pwNew.length < 6) {
      setPwError("Password must be at least 6 characters.");
      return;
    }
    if (pwNew !== pwConfirm) {
      setPwError("Passwords don't match.");
      return;
    }
    setPwBusy(true);
    const { error: pwErr } = await updatePassword(pwNew);
    setPwBusy(false);
    if (pwErr) {
      setPwError(pwErr.message);
      return;
    }
    setPwNew("");
    setPwConfirm("");
    setPwSuccess(true);
  };

  if (loading) {
    return (
      <Shell>
        <p style={{ color: inkMuted, fontSize: 14 }}>Loading…</p>
      </Shell>
    );
  }

  // Show the email capture field when the player record has no email.
  // Hidden for users who already have one (AC#3).
  const needsEmail = !existingPlayer?.email;

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

  const initials = [firstName.trim()[0], lastName.trim()[0]]
    .filter(Boolean)
    .join("")
    .toUpperCase() || "?";

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
        {needsEmail && (
          <div>
            <div style={{ fontSize: 13, color: inkMuted, marginBottom: 8 }}>
              We need your email address to send registration receipts, partner
              invitations, and account notifications.
            </div>
            <Field label="Email address" required>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={inputStyle}
                disabled={busy}
                placeholder="you@example.com"
              />
            </Field>
          </div>
        )}
        {/* Avatar upload */}
        <div style={avatarSectionStyle}>
          <button
            type="button"
            onClick={handleAvatarClick}
            disabled={busy}
            style={avatarCircleStyle(!!avatarPreviewUrl)}
            title="Click to change photo"
            aria-label="Change profile photo"
          >
            {avatarPreviewUrl ? (
              <img
                src={avatarPreviewUrl}
                alt="Your profile photo"
                style={avatarImgStyle}
              />
            ) : (
              <span style={avatarInitialsStyle}>{initials}</span>
            )}
          </button>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button
              type="button"
              style={changePhotoStyle}
              onClick={handleAvatarClick}
              disabled={busy}
            >
              {avatarPreviewUrl ? "Change photo" : "Upload photo"}
            </button>
            {avatarPreviewUrl && (
              <button
                type="button"
                style={removePhotoStyle}
                onClick={handleRemoveAvatar}
                disabled={busy}
              >
                Remove photo
              </button>
            )}
            <span style={{ fontSize: 11, color: inkMuted }}>
              JPG, PNG or WebP · max 5 MB
            </span>
            {avatarError && (
              <span style={{ fontSize: 12, color: courtRed }}>{avatarError}</span>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
        </div>

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
            {isFirstFill ? "I'll do this later" : "Cancel"}
          </button>
        </div>
      </form>

      {!isFirstFill && (
        <>
          <div style={sectionDivider} />
          <h2 style={sectionHeadingStyle}>Account</h2>
          <form
            onSubmit={onPasswordSubmit}
            style={{ display: "flex", flexDirection: "column", gap: 16 }}
          >
            <div>
              <div style={{ fontSize: 13, color: ink, marginBottom: 4 }}>
                <strong>Change password</strong>{" "}
                <span style={{ color: inkMuted }}>
                  (leave blank to keep your current sign-in method)
                </span>
              </div>

              {/* Collapsible explainer — reassures users who've never signed
                  in without a password. Hidden until they ask. */}
              <button
                type="button"
                onClick={() => setPwExplainerOpen((o) => !o)}
                aria-expanded={pwExplainerOpen}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  marginBottom: 10,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 12,
                  color: courtBlue,
                  textDecoration: "underline",
                  textUnderlineOffset: 2,
                  alignSelf: "flex-start",
                }}
              >
                {pwExplainerOpen ? "▾" : "▸"} Do I even need a password?
              </button>
              {pwExplainerOpen && (
                <div
                  style={{
                    border: `1px solid ${rule}`,
                    borderRadius: 8,
                    padding: "12px 14px",
                    marginBottom: 12,
                    fontSize: 13,
                    lineHeight: 1.55,
                    color: inkSoft,
                    background: "#fff",
                  }}
                >
                  <p style={{ margin: "0 0 8px" }}>
                    <strong style={{ color: ink }}>No — a password is optional.</strong>{" "}
                    You can sign in without one, and it&rsquo;s just as secure.
                  </p>
                  <p style={{ margin: "0 0 8px" }}>
                    <strong style={{ color: ink }}>How it works:</strong> on the
                    sign-in screen, choose <em>&ldquo;Email me a link&rdquo;</em>{" "}
                    (or <em>Continue with Google</em>). We email you a one-time
                    link &mdash; tap it and you&rsquo;re in. Nothing to remember.
                  </p>
                  <p style={{ margin: "0 0 8px" }}>
                    <strong style={{ color: ink }}>Why it&rsquo;s nice:</strong>{" "}
                    no password to forget or reuse, and nothing for anyone to
                    steal &mdash; each link works once and then expires.
                  </p>
                  <p style={{ margin: 0 }}>
                    <strong style={{ color: ink }}>Prefer a password?</strong>{" "}
                    Set one below and you can sign in with just your email and
                    password &mdash; no need to check your inbox each time.
                  </p>
                </div>
              )}

              <FieldRow>
                <Field label="New password">
                  <div style={{ position: "relative" }}>
                    <input
                      type={pwNewVisible ? "text" : "password"}
                      autoComplete="new-password"
                      value={pwNew}
                      onChange={(e) => { setPwNew(e.target.value); setPwSuccess(false); setPwError(null); }}
                      style={{ ...inputStyle, paddingRight: 36 }}
                      disabled={pwBusy}
                      placeholder="At least 6 characters"
                    />
                    <button
                      type="button"
                      onClick={() => setPwNewVisible((v) => !v)}
                      disabled={pwBusy}
                      style={eyeButtonStyle}
                      aria-label={pwNewVisible ? "Hide password" : "Show password"}
                    >
                      {pwNewVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  {pwNew.length > 0 && pwNew.length < 6 && (
                    <span style={{ fontSize: 11, color: dangerFg, marginTop: 2 }}>
                      At least 6 characters
                    </span>
                  )}
                </Field>
                <Field label="Confirm new password">
                  <div style={{ position: "relative" }}>
                    <input
                      type={pwConfirmVisible ? "text" : "password"}
                      autoComplete="new-password"
                      value={pwConfirm}
                      onChange={(e) => { setPwConfirm(e.target.value); setPwSuccess(false); setPwError(null); }}
                      style={{ ...inputStyle, paddingRight: 36 }}
                      disabled={pwBusy}
                    />
                    <button
                      type="button"
                      onClick={() => setPwConfirmVisible((v) => !v)}
                      disabled={pwBusy}
                      style={eyeButtonStyle}
                      aria-label={pwConfirmVisible ? "Hide password" : "Show password"}
                    >
                      {pwConfirmVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  {pwConfirm.length > 0 && pwNew !== pwConfirm && (
                    <span style={{ fontSize: 11, color: dangerFg, marginTop: 2 }}>
                      Passwords don't match
                    </span>
                  )}
                </Field>
              </FieldRow>
            </div>

            {pwError && (
              <div style={statusPanelStyle("danger")}>{pwError}</div>
            )}
            {pwSuccess && (
              <div style={statusPanelStyle("success")}>Password updated.</div>
            )}

            <div>
              <button
                type="submit"
                disabled={pwBusy}
                style={pwBusy ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
              >
                {pwBusy ? "Updating…" : "Update password"}
              </button>
            </div>
          </form>
        </>
      )}
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

const sectionDivider: CSSProperties = {
  borderTop: `1px solid ${rule}`,
  margin: "28px 0 24px",
};

const sectionHeadingStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: ink,
  margin: "0 0 16px",
};

const eyeButtonStyle: CSSProperties = {
  position: "absolute",
  right: 8,
  top: "50%",
  transform: "translateY(-50%)",
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  color: inkMuted,
  display: "flex",
  alignItems: "center",
};

const avatarSectionStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  paddingBottom: 4,
};

function avatarCircleStyle(hasImage: boolean): CSSProperties {
  return {
    width: 72,
    height: 72,
    borderRadius: "50%",
    background: hasImage ? "transparent" : ink,
    border: `2px solid ${rule}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    padding: 0,
    overflow: "hidden",
    flexShrink: 0,
    transition: "border-color 0.15s",
  };
}

const avatarImgStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  borderRadius: "50%",
  display: "block",
};

const avatarInitialsStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  color: "#fff",
  letterSpacing: 1,
  userSelect: "none",
};

const changePhotoStyle: CSSProperties = {
  background: "none",
  border: `1px solid ${rule}`,
  borderRadius: 6,
  padding: "4px 12px",
  fontSize: 13,
  color: ink,
  cursor: "pointer",
  alignSelf: "flex-start",
};

const removePhotoStyle: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  fontSize: 12,
  color: courtRed,
  cursor: "pointer",
  textDecoration: "underline",
  textAlign: "left",
};
