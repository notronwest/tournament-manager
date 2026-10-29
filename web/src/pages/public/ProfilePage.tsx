import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { Eye, EyeOff, Trash2 } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import { recordSignupEvent, grantAccountCreditIfEligible } from "../../lib/campaignCapture";
import type { Database } from "../../types/supabase";
import { RatingFields } from "../../components/RatingFields";
import { GenderSelect } from "../../components/GenderSelect";
import { AddChildForm } from "../../components/AddChildForm";
import { Field, FieldRow } from "../../components/Field";
import { ConfirmModal } from "../../components/ConfirmModal";
import { ageAt } from "../../lib/eligibility";
import {
  dependentDobError,
  fetchDependents,
  playerName,
  removeDependent,
  setDependentEmail,
  setDependentProfile,
  type Dependent,
} from "../../lib/guardians";
import { ratingValuesOf, selfRatingSummary } from "../../lib/selfRatings";
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
  inlineActionStyle,
  inputStyle,
  pageH1Style,
  pageSubStyle,
  pageWrapStyle,
  panelMutedStyle,
  panelStyle,
  rule,
  statusPanelStyle,
} from "../../lib/publicTheme";

type Player = Database["public"]["Tables"]["players"]["Row"];
type PlayerGender = Database["public"]["Enums"]["player_gender"];

// What the per-child editor holds while it is open (#1183). "" is the
// unset gender, the same sentinel the select uses on the profile form above,
// and null is an unset rating — a rating can be cleared by tapping its
// selected chip, so "nothing chosen" has to be representable.
type DependentProfileDraft = {
  dob: string;
  gender: PlayerGender | "";
  doubles: number | null;
  mixed: number | null;
  singles: number | null;
};

const emptyProfileDraft: DependentProfileDraft = {
  dob: "",
  gender: "",
  doubles: null,
  mixed: null,
  singles: null,
};

// Whether this player has any self-rating at all, which is what decides
// whether the row's control offers to add one or to change it.
function hasAnySelfRating(p: Player): boolean {
  const v = ratingValuesOf(p);
  return v.doubles != null || v.mixed != null || v.singles != null;
}

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
  const [dob, setDob] = useState("");
  const [gender, setGender] = useState<PlayerGender | "">("");
  const [ratingDoubles, setRatingDoubles] = useState<number | null>(null);
  const [ratingMixed, setRatingMixed] = useState<number | null>(null);
  const [ratingSingles, setRatingSingles] = useState<number | null>(null);
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
  // ── My family (#1169) ────────────────────────────────────────────
  // Its own form, its own busy/error/success state: the profile form above
  // navigates away on save, which would throw a parent out of the page
  // mid-way through adding a second child.
  const [dependents, setDependents] = useState<Dependent[]>([]);
  const [familyLoading, setFamilyLoading] = useState(false);
  const [addChildOpen, setAddChildOpen] = useState(false);
  // Inline per-row address editing (#1186). A dependent's address was
  // write-once-or-never until this: the add form is the only thing that ever
  // set one, so a parent who skipped it, mistyped it, or hit the half-saved
  // state had nowhere to go. editingEmailFor holds the link id of the row
  // being edited, which is also what keeps only one row open at a time.
  const [editingEmailFor, setEditingEmailFor] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailRowError, setEmailRowError] = useState<string | null>(null);
  // Inline per-row rating, gender and date of birth (#1183). The same shape
  // as the address editor above, for the same reason: a child added through
  // the add form has a name and a date of birth and nothing else, and every
  // skill-bounded or single-gender bracket refused them with no control the
  // parent could reach. The date of birth is in here too because the one
  // place that ever set it was the add form, and the register form already
  // tells a parent to fix it here.
  const [editingProfileFor, setEditingProfileFor] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState<DependentProfileDraft>(emptyProfileDraft);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileRowError, setProfileRowError] = useState<string | null>(null);
  const [familyError, setFamilyError] = useState<string | null>(null);
  const [familyAdded, setFamilyAdded] = useState<string | null>(null);
  const [familyRemoved, setFamilyRemoved] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Dependent | null>(null);

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
        setDob(me.dob ?? "");
        setGender(me.gender ?? "");
        setRatingDoubles(me.self_rating_doubles ?? null);
        setRatingMixed(me.self_rating_mixed ?? null);
        setRatingSingles(me.self_rating_singles ?? null);
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

  // Keyed on the player id rather than the user, so saving the profile above
  // doesn't re-fetch the family, and a player who has no row yet never asks.
  const myPlayerId = existingPlayer?.id ?? null;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // No player row yet means no family to hold; clearing inside the async
      // body rather than in the effect body keeps this off the synchronous
      // setState path (react-hooks/set-state-in-effect).
      if (!myPlayerId) {
        setDependents([]);
        return;
      }
      setFamilyLoading(true);
      const { dependents: found, error: depErr } = await fetchDependents(myPlayerId);
      if (cancelled) return;
      setDependents(found);
      if (depErr) setFamilyError(depErr);
      setFamilyLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [myPlayerId]);

  // What this page does once the shared form has made the child: fold them
  // into the family list and say so. The validation and the write itself live
  // in AddChildForm, which the register form mounts too.
  const onChildAdded = (dependent: Dependent) => {
    setFamilyError(null);
    setFamilyRemoved(null);
    setDependents((prev) =>
      [...prev, dependent].sort((a, b) => playerName(a.player).localeCompare(playerName(b.player))),
    );
    setFamilyAdded(playerName(dependent.player));
    setAddChildOpen(false);
  };

  // The guardian's own address, for the one-press fill in both the add form
  // and the row editor.
  const myEmail = (existingPlayer?.email ?? "").trim();

  // Saves one row's address in place. The row is where the person is looking
  // and where the fact lives, so there is no panel for this: the line under
  // the name changes from "No email address" to the address itself.
  const onSaveRowEmail = async (d: Dependent) => {
    setEmailRowError(null);
    setEmailBusy(true);
    const { error: setErr } = await setDependentEmail(d.player.id, emailDraft);
    setEmailBusy(false);
    if (setErr) {
      console.error("set dependent email failed", setErr);
      setEmailRowError("That didn\u2019t save. Try again in a moment.");
      return;
    }
    // Mirrors what setDependentEmail just wrote: blank is an absent address,
    // never an empty string, so the row reads "No email address" rather than a
    // dangling separator.
    const stored = emailDraft.trim() || null;
    setDependents((prev) =>
      prev.map((x) =>
        x.linkId === d.linkId ? { ...x, player: { ...x.player, email: stored } } : x,
      ),
    );
    setEditingEmailFor(null);
    setEmailDraft("");
  };

  // One editor open in this card at a time: two forms would mean two submit
  // buttons, and the card is supposed to have one obvious action.
  const closeRowEditors = () => {
    setEditingEmailFor(null);
    setEmailRowError(null);
    setEditingProfileFor(null);
    setProfileRowError(null);
  };

  // Saves one child's rating, gender and date of birth in place, in a single
  // write, so a parent who sets a rating and a gender together cannot end up
  // with half of it stored.
  const onSaveRowProfile = async (d: Dependent) => {
    // The same rule the add form applies, from the same function: a row
    // editor that accepted a blank would quietly undo what the add form
    // insisted on.
    const dobErr = dependentDobError(profileDraft.dob);
    if (dobErr) {
      setProfileRowError(dobErr);
      return;
    }
    setProfileRowError(null);
    setProfileBusy(true);
    const values = {
      dob: profileDraft.dob || null,
      gender: profileDraft.gender || null,
      doubles: profileDraft.doubles,
      mixed: profileDraft.mixed,
      singles: profileDraft.singles,
    };
    const { error: setErr } = await setDependentProfile(d.player.id, values);
    setProfileBusy(false);
    if (setErr) {
      console.error("set dependent profile failed", setErr);
      setProfileRowError("That didn’t save. Try again in a moment.");
      return;
    }
    // Mirrors exactly what was written, so the row's summary line and the
    // eligibility the register form computes both agree with the database
    // without a re-fetch.
    setDependents((prev) =>
      prev.map((x) =>
        x.linkId === d.linkId
          ? {
              ...x,
              player: {
                ...x.player,
                dob: values.dob,
                gender: values.gender,
                self_rating_doubles: values.doubles,
                self_rating_mixed: values.mixed,
                self_rating_singles: values.singles,
              },
            }
          : x,
      ),
    );
    setEditingProfileFor(null);
  };

  const onRemoveChild = async () => {
    if (!removeTarget) return;
    setFamilyError(null);
    setFamilyAdded(null);
    setFamilyRemoved(null);
    const { error: rmErr } = await removeDependent(removeTarget.linkId);
    if (rmErr) {
      setFamilyError(rmErr);
      setRemoveTarget(null);
      return;
    }
    setDependents((prev) => prev.filter((d) => d.linkId !== removeTarget.linkId));
    setFamilyRemoved(playerName(removeTarget.player));
    setRemoveTarget(null);
  };

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
      // A plain `date` column, so the YYYY-MM-DD the input emits goes
      // straight in — no timezone conversion, which is also what keeps the
      // age gate reading the same calendar day the player typed.
      dob: dob || null,
      gender: (gender || null) as PlayerGender | null,
      self_rating_doubles: ratingDoubles,
      self_rating_mixed: ratingMixed,
      self_rating_singles: ratingSingles,
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
      // Brand-new player row — the one signal that an account was just
      // created, not just signed into. Fires at most once per signup;
      // best-effort and a no-op when no campaign was captured (D-0077).
      void recordSignupEvent();
      // Grants the $20 account credit (#1102) for a live campaign, same
      // call site, same best-effort/no-op-without-a-campaign shape.
      void grantAccountCreditIfEligible();
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

      {/* What this page lets you do, named at the top and linked. "My family"
          is the only entry point to registering a child, and on a phone it
          sits well below the fold — a section heading further down is not a
          way to find out it exists. */}
      {!isFirstFill && (
        <p style={{ fontSize: 13, color: inkSoft, margin: "-6px 0 20px" }}>
          On this page: your details,{" "}
          <a href="#my-family" style={jumpLinkStyle}>
            my family
          </a>{" "}
          (register a child from your account), and your{" "}
          <a href="#account" style={jumpLinkStyle}>
            account
          </a>
          .
        </p>
      )}

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
            <GenderSelect value={gender} onChange={setGender} disabled={busy} />
          </Field>
        </FieldRow>

        <FieldRow>
          <Field label="Date of birth">
            <input
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              style={inputStyle}
              disabled={busy}
            />
            <span style={{ fontSize: 12, color: inkMuted }}>
              Optional, and only used for age-restricted brackets — a juniors
              or 50+ division can&rsquo;t check whether you qualify without it.
            </span>
          </Field>
        </FieldRow>

        <RatingFields
          values={{ doubles: ratingDoubles, mixed: ratingMixed, singles: ratingSingles }}
          onChange={(f, v) => {
            if (f === "doubles") setRatingDoubles(v);
            else if (f === "mixed") setRatingMixed(v);
            else setRatingSingles(v);
          }}
          disabled={busy}
        />

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
          <h2 id="my-family" style={sectionHeadingStyle}>
            My family
          </h2>
          <p style={{ fontSize: 13, color: inkSoft, margin: "-8px 0 16px" }}>
            Add a child here and you can register and pay for them from your own
            account. They need no account of their own. An email address is
            optional &mdash; yours will do, and it&rsquo;s where notices about
            their registration go.
          </p>

          <div style={{ ...panelMutedStyle, display: "flex", flexDirection: "column", gap: 12 }}>
            {familyError && (
              <div style={statusPanelStyle("danger")}>{familyError}</div>
            )}
            {familyAdded && (
              <div style={statusPanelStyle("success")}>
                {familyAdded} is on your family list. You can register them from
                any tournament page.
              </div>
            )}
            {familyRemoved && (
              <div style={statusPanelStyle("info")}>
                {familyRemoved} was removed from your family. Anything they were
                already registered for is unchanged.
              </div>
            )}

            {familyLoading ? (
              <div style={{ fontSize: 13, color: inkMuted }}>Loading your family…</div>
            ) : dependents.length === 0 ? (
              // The empty state's job is to explain the blank card and point
              // at the button. Once that button has been pressed the form
              // says the same thing better, so it steps aside.
              addChildOpen ? null : (
                <div style={{ fontSize: 13, color: inkSoft }}>
                  Nobody here yet. Add a child and they&rsquo;ll show up as
                  someone you can register.
                </div>
              )
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {dependents.map((d) => {
                  const age = ageAt(d.player.dob);
                  const editingEmail = editingEmailFor === d.linkId;
                  const editingProfile = editingProfileFor === d.linkId;
                  const childName = d.player.first_name?.trim() || playerName(d.player);
                  return (
                    <div key={d.linkId} style={familyRowStyle}>
                      <div style={{ flex: "1 1 160px", minWidth: 0 }}>
                        <div style={{ fontSize: 14, color: ink, fontWeight: 500 }}>
                          {playerName(d.player)}
                        </div>
                        {/* Age, then the address — and "No email address"
                            when there is none (#1186). The absence is the
                            thing worth seeing: it means every notice about
                            this child's registrations is skipped, and nothing
                            else on the page says so. overflowWrap so a long
                            address wraps instead of widening the row past a
                            390px screen. */}
                        <div
                          style={{
                            fontSize: 12,
                            color: inkMuted,
                            marginTop: 2,
                            overflowWrap: "anywhere",
                          }}
                        >
                          {age == null
                            ? "No date of birth yet"
                            : `${age} year${age === 1 ? "" : "s"} old`}
                          {` · ${dependentEmail(d) ?? "No email address"}`}
                        </div>
                        {/* What a bracket checks, on its own line: the rating
                            decides whether this child can enter a skill-
                            bounded division at all, which is most of them,
                            and a missing one is why the register form refuses
                            them. Gender appears only once set — it is
                            optional by design and only a boys' or girls'
                            bracket reads it. */}
                        <div
                          style={{
                            fontSize: 12,
                            color: inkMuted,
                            marginTop: 2,
                            overflowWrap: "anywhere",
                          }}
                        >
                          {selfRatingSummary(d.player)}
                        </div>
                        {!editingEmail && !editingProfile && (
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              alignItems: "center",
                              gap: 16,
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                setEditingProfileFor(d.linkId);
                                setProfileDraft({
                                  dob: d.player.dob ?? "",
                                  gender: d.player.gender ?? "",
                                  ...ratingValuesOf(d.player),
                                });
                                setProfileRowError(null);
                                setEditingEmailFor(null);
                                setEmailRowError(null);
                                setAddChildOpen(false);
                              }}
                              style={inlineActionStyle}
                            >
                              {hasAnySelfRating(d.player) || d.player.gender
                                ? "Change rating and gender"
                                : "Add a rating and gender"}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingEmailFor(d.linkId);
                                setEmailDraft(dependentEmail(d) ?? "");
                                setEmailRowError(null);
                                setEditingProfileFor(null);
                                setProfileRowError(null);
                                // One thing open in this card at a time: two
                                // forms would mean two submit buttons, and the
                                // card is supposed to have one obvious action.
                                setAddChildOpen(false);
                              }}
                              style={inlineActionStyle}
                            >
                              {dependentEmail(d)
                                ? `Change email address`
                                : `Add an email address`}
                            </button>
                          </div>
                        )}
                      </div>
                      {/* Fixed-width slot so the remove control lines up down
                          the list whether or not a row ever gains a second
                          indicator. */}
                      <div style={familyActionSlotStyle}>
                        <button
                          type="button"
                          onClick={() => setRemoveTarget(d)}
                          aria-label={`Remove ${playerName(d.player)} from your family`}
                          title={`Remove ${playerName(d.player)}`}
                          style={familyRemoveButtonStyle}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      </div>
                      {/* The open editor spans the row, under the name
                          and the remove control, so a form carrying three
                          rating scales gets the card's full width instead of
                          the narrow name column. At 390px that is the
                          difference between six chips on one line and an
                          orphan level on a second. */}
                      {(editingEmail || editingProfile) && (
                        <div style={{ flexBasis: "100%", minWidth: 0 }}>
                          {editingEmail ? (
                          // A real <form>, not a div with a button: this is
                          // the same field as the one in AddChildForm and it
                          // has to refuse the same values. type="email" alone
                          // does nothing outside a form, so a loose input here
                          // would write "notanemail" through — on the mount
                          // that exists to REPAIR a missing address, which is
                          // the one that can least afford to be the lax one.
                          // It also makes the phone keyboard's Go key work.
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              void onSaveRowEmail(d);
                            }}
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              alignItems: "center",
                              gap: 8,
                              marginTop: 6,
                            }}
                          >
                            <input
                              type="email"
                              value={emailDraft}
                              onChange={(e) => setEmailDraft(e.target.value)}
                              placeholder="you@example.com"
                              aria-label={`Email address for ${playerName(d.player)}`}
                              disabled={emailBusy}
                              style={{ ...inputStyle, flex: "1 1 180px", minWidth: 0 }}
                            />
                            {/* The same one-press fill as the add form, in
                                the same place relative to the actions: field,
                                then the shortcut that fills it, then what you
                                do with it. This is the repair path, so it is
                                where a parent is most likely to be reaching
                                for their own address. */}
                            {myEmail &&
                              emailDraft.trim().toLowerCase() !== myEmail.toLowerCase() && (
                                <button
                                  type="button"
                                  onClick={() => setEmailDraft(myEmail)}
                                  disabled={emailBusy}
                                  style={
                                    emailBusy
                                      ? { ...inlineActionStyle, opacity: 0.6, cursor: "not-allowed" }
                                      : inlineActionStyle
                                  }
                                >
                                  Use my address
                                </button>
                              )}
                            <button
                              type="submit"
                              disabled={emailBusy}
                              style={emailBusy ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
                            >
                              {emailBusy ? "Saving…" : "Save"}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingEmailFor(null);
                                setEmailRowError(null);
                              }}
                              disabled={emailBusy}
                              style={
                                emailBusy
                                  ? { ...ctaSecondaryStyle, opacity: 0.6, cursor: "not-allowed" }
                                  : ctaSecondaryStyle
                              }
                            >
                              Cancel
                            </button>
                            {emailRowError && (
                              <div style={{ ...statusPanelStyle("danger"), fontSize: 12 }}>
                                {emailRowError}
                              </div>
                            )}
                          </form>
                          ) : (
                          // A real <form> for the same reason the address one
                          // is: the date input's own constraints only bite
                          // inside a form, and the phone keyboard's Go key
                          // then submits.
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              void onSaveRowProfile(d);
                            }}
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: 12,
                              marginTop: 8,
                            }}
                          >
                            <FieldRow>
                              <Field label="Date of birth">
                                <input
                                  type="date"
                                  value={profileDraft.dob}
                                  onChange={(e) =>
                                    setProfileDraft((p) => ({ ...p, dob: e.target.value }))
                                  }
                                  aria-label={`Date of birth for ${childName}`}
                                  disabled={profileBusy}
                                  style={inputStyle}
                                />
                              </Field>
                              <Field label="Gender">
                                <GenderSelect
                                  value={profileDraft.gender}
                                  onChange={(v) =>
                                    setProfileDraft((p) => ({ ...p, gender: v }))
                                  }
                                  disabled={profileBusy}
                                  ariaLabel={`Gender for ${childName}`}
                                />
                                <span style={{ fontSize: 12, color: inkMuted }}>
                                  Only needed for a boys&rsquo; or girls&rsquo;
                                  bracket. Everything else is open to any
                                  answer, including none.
                                </span>
                              </Field>
                            </FieldRow>
                            <RatingFields
                              variant="inline"
                              ownerName={childName}
                              values={{
                                doubles: profileDraft.doubles,
                                mixed: profileDraft.mixed,
                                singles: profileDraft.singles,
                              }}
                              onChange={(f, v) =>
                                setProfileDraft((p) => ({ ...p, [f]: v }))
                              }
                              disabled={profileBusy}
                            />
                            <span style={{ fontSize: 12, color: inkMuted }}>
                              Most divisions have a skill range, so a rating is
                              what lets {childName} be entered for one. Tap a
                              level, tap it again to clear.
                            </span>
                            <div
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                alignItems: "center",
                                gap: 8,
                              }}
                            >
                              <button
                                type="submit"
                                disabled={profileBusy}
                                style={profileBusy ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
                              >
                                {profileBusy ? "Saving…" : "Save"}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingProfileFor(null);
                                  setProfileRowError(null);
                                }}
                                disabled={profileBusy}
                                style={
                                  profileBusy
                                    ? { ...ctaSecondaryStyle, opacity: 0.6, cursor: "not-allowed" }
                                    : ctaSecondaryStyle
                                }
                              >
                                Cancel
                              </button>
                            </div>
                            {profileRowError && (
                              <div style={{ ...statusPanelStyle("danger"), fontSize: 12 }}>
                                {profileRowError}
                              </div>
                            )}
                          </form>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {addChildOpen && myPlayerId ? (
              <AddChildForm
                variant="page"
                guardianPlayerId={myPlayerId}
                guardianEmail={myEmail || null}
                onAdded={onChildAdded}
                onCancel={() => {
                  setAddChildOpen(false);
                  setFamilyError(null);
                }}
              />
            ) : (
              <div>
                <button
                  type="button"
                  onClick={() => {
                    setAddChildOpen(true);
                    setFamilyAdded(null);
                    setFamilyRemoved(null);
                    setFamilyError(null);
                    closeRowEditors();
                  }}
                  // Steps down while a row is being edited: that row's Save is
                  // the card's one filled action, and on a long family list
                  // the two are a screenful apart rather than a page apart.
                  style={
                    editingEmailFor || editingProfileFor
                      ? ctaSecondaryStyle
                      : ctaPrimaryStyle
                  }
                >
                  Add a child
                </button>
              </div>
            )}
          </div>

          <div style={sectionDivider} />
          <h2 id="account" style={sectionHeadingStyle}>
            Account
          </h2>
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

      {removeTarget && (
        <ConfirmModal
          title={`Remove ${playerName(removeTarget.player)}`}
          body={
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <p style={{ margin: 0 }}>
                They&rsquo;ll no longer appear as someone you can register, and
                you won&rsquo;t be able to manage their registrations.
              </p>
              <p style={{ margin: 0 }}>
                Anything they&rsquo;re already registered for stays as it is —
                ask the organizer if you need it changed. You can add them back
                at any time.
              </p>
            </div>
          }
          confirmLabel="Remove from my family"
          onCancel={() => setRemoveTarget(null)}
          onConfirm={onRemoveChild}
        />
      )}
    </Shell>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers + small UI bits
// ─────────────────────────────────────────────────────────────────────

function Shell({ children }: { children: ReactNode }) {
  return (
    <div style={pageWrapStyle}>
      <main style={contentColStyle(560)}>
        {children}
      </main>
    </div>
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

const jumpLinkStyle: CSSProperties = {
  color: courtBlue,
  textDecoration: "underline",
};

// The one reading of "this child has an address". A row written before blank
// meant NULL can hold "", and an empty string is not an address: it would
// render as a dangling separator, hide the "No email address" line, and look
// present to anything that only checks for null.
function dependentEmail(d: Dependent): string | null {
  return (d.player.email ?? "").trim() || null;
}

// A family row: the name/age column wraps above the action on a narrow
// screen rather than being squeezed to nothing (DESIGN_PREFERENCES).
const familyRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  padding: "8px 0",
  borderBottom: `1px solid ${rule}`,
};

// Fixed-width slot so the action lines up down the list.
const familyActionSlotStyle: CSSProperties = {
  width: 44,
  display: "flex",
  justifyContent: "flex-end",
  flexShrink: 0,
};

const familyRemoveButtonStyle: CSSProperties = {
  // 44px of tappable area on a phone, with the glyph itself kept small.
  width: 44,
  height: 44,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "none",
  border: "none",
  padding: 0,
  color: courtRed,
  cursor: "pointer",
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
