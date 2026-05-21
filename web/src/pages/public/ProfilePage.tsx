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
  const { user } = useAuth();
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
    setBusy(true);

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

  if (loading) {
    return (
      <Shell>
        <p style={{ color: "#666", fontSize: 14 }}>Loading…</p>
      </Shell>
    );
  }

  // First-fill heading vs. edit heading — small touch but tells the
  // returning user "you've been here before."
  const isFirstFill = !existingPlayer || !existingPlayer.first_name;
  const heading = isFirstFill
    ? `Welcome${user?.email ? `, ${user.email.split("@")[0]}` : ""} 👋`
    : "Your profile";
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
      <h1 style={{ margin: "0 0 6px", fontSize: 24 }}>{heading}</h1>
      <p
        style={{
          color: "#666",
          margin: "0 0 24px",
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        {subhead}
      </p>

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
          <div style={{ fontSize: 13, color: "#444", marginBottom: 4 }}>
            <strong>Self-reported rating</strong>{" "}
            <span style={{ color: "#888" }}>
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

        {error && (
          <div
            style={{
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

        <button
          type="submit"
          disabled={busy}
          style={{
            padding: "12px 24px",
            background: busy ? "#9ca3af" : "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontSize: 15,
            fontWeight: 500,
            cursor: busy ? "not-allowed" : "pointer",
            fontFamily: "inherit",
            marginTop: 4,
          }}
        >
          {busy
            ? "Saving…"
            : isFirstFill
              ? "Save & continue →"
              : "Save profile"}
        </button>
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
    <main
      style={{ padding: "32px 24px", maxWidth: 560, margin: "0 auto" }}
    >
      {children}
    </main>
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
        color: "#555",
        flex: "1 1 160px",
        minWidth: 0,
      }}
    >
      <span>
        {label}
        {required && (
          <span style={{ color: "#ef4444", marginLeft: 4 }}>*</span>
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

const inputStyle: CSSProperties = {
  padding: "10px 12px",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  width: "100%",
  background: "#fff",
};

const progressBarRow: CSSProperties = {
  display: "flex",
  gap: 4,
  marginBottom: 20,
};

const progressStep: CSSProperties = {
  flex: 1,
  height: 4,
  background: "#e5e7eb",
  borderRadius: 2,
};

const progressStepActive: CSSProperties = {
  ...progressStep,
  background: "#2563eb",
};
