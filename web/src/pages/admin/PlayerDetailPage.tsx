import { useState, useEffect, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { usePlatformAdmin } from "../../hooks/usePlatformAdmin";
import { ConfirmModal } from "../../components/ConfirmModal";
import {
  ink,
  inkSoft,
  inkMuted,
  rule,
  ruleSoft,
  bg,
  cream,
  courtBlue,
  successBg,
  successFg,
  warnBg,
  warnFg,
  bodyFontStack,
  breadcrumbLinkStyle,
  pageH1Style,
  ctaPrimaryStyle,
  ctaSecondaryStyle,
  inputStyle,
  statusPanelStyle,
} from "../../lib/publicTheme";

// ─── Types mirroring the admin-get-player edge function payload ───────────────

type Gender = "M" | "F" | "X";

type PlayerProfile = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  gender: Gender | null;
  city: string | null;
  state: string | null;
  dob: string | null;
  self_rating_doubles: number | null;
  self_rating_mixed: number | null;
  self_rating_singles: number | null;
  avatar_path: string | null;
  avatar_hidden: boolean;
  auth_user_id: string | null;
  created_at: string;
};

type Account = {
  loginEmail: string | null;
  emailConfirmedAt: string | null;
  lastSignInAt: string | null;
};

type HistoryRow = {
  regId: string;
  status: string;
  partnerStatus: string;
  registeredAt: string;
  partnerName: string | null;
  event: { name: string; format: string; gender: string } | null;
  tournament: {
    name: string;
    slug: string;
    startsAt: string;
    status: string;
    orgName: string | null;
    orgSlug: string | null;
  } | null;
};

type GetPlayerResponse = {
  ok: boolean;
  player: PlayerProfile;
  account: Account | null;
  history: HistoryRow[];
  avatarUrl: string | null;
  error?: string;
};

// Pull a server-sent { error } message out of a functions.invoke failure.
async function fnError(fnErr: unknown): Promise<string> {
  let message = (fnErr as { message?: string })?.message ?? "Request failed.";
  try {
    const ctx = (fnErr as { context?: Response }).context;
    if (ctx) {
      const b = (await ctx.json()) as { error?: string };
      if (b.error) message = b.error;
    }
  } catch {
    // keep the generic message
  }
  return message;
}

// Mirror ProfilePage.parseRating: blank → null, clamp to [0, 9.99].
function parseRating(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const n = parseFloat(trimmed);
  if (Number.isNaN(n)) return null;
  if (n < 0) return 0;
  if (n > 9.99) return 9.99;
  return n;
}

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "—";

const STATUS_LABELS: Record<string, string> = {
  paid: "Registered",
  pending_payment: "Pending payment",
  waitlisted: "Waitlisted",
  waitlisted_pending_payment: "Waitlist — pay to claim",
  cancelled: "Cancelled",
  withdrawn: "Withdrawn",
  refunded: "Refunded",
};
const statusLabel = (s: string) => STATUS_LABELS[s] ?? s;

export default function PlayerDetailPage() {
  const isPlatformAdmin = usePlatformAdmin();
  const { playerId } = useParams<{ playerId: string }>();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [player, setPlayer] = useState<PlayerProfile | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!playerId) return;
    setLoading(true);
    setLoadError(null);
    const { data, error } = await supabase.functions.invoke("admin-get-player", {
      body: { playerId },
    });
    setLoading(false);
    if (error) {
      setLoadError(await fnError(error));
      return;
    }
    const res = data as GetPlayerResponse;
    if (!res?.ok) {
      setLoadError(res?.error ?? "Failed to load player.");
      return;
    }
    setPlayer(res.player);
    setAccount(res.account);
    setHistory(res.history ?? []);
    setAvatarUrl(res.avatarUrl ?? null);
  }, [playerId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isPlatformAdmin) void load();
  }, [isPlatformAdmin, load]);

  if (isPlatformAdmin === null) {
    return (
      <div style={{ padding: 24, color: inkMuted, fontSize: 14, fontFamily: bodyFontStack }}>
        Loading…
      </div>
    );
  }
  if (!isPlatformAdmin) {
    return (
      <main style={{ padding: "24px 32px", maxWidth: 600, margin: "0 auto", fontFamily: bodyFontStack }}>
        <h1 style={{ ...pageH1Style, fontSize: 20, marginTop: 0 }}>Access denied</h1>
        <p style={{ color: inkSoft, fontSize: 14 }}>
          This page is restricted to platform administrators.
        </p>
        <Link to="/admin" style={breadcrumbLinkStyle}>
          ← Back to admin
        </Link>
      </main>
    );
  }

  return (
    <main style={{ padding: "24px 32px", maxWidth: 900, margin: "0 auto", fontFamily: bodyFontStack }}>
      <div style={{ marginBottom: 16 }}>
        <Link to="/admin/attendees" style={breadcrumbLinkStyle}>
          ← All players
        </Link>
      </div>

      {loading && (
        <div style={{ color: inkMuted, fontSize: 14 }}>Loading player…</div>
      )}
      {loadError && <div style={statusPanelStyle("danger")}>{loadError}</div>}

      {!loading && player && (
        <>
          <h1 style={{ ...pageH1Style, fontSize: 24, marginBottom: 2 }}>
            {player.first_name} {player.last_name}
          </h1>
          <p style={{ fontSize: 13, color: inkSoft, margin: "0 0 24px" }}>
            Player since {fmtDate(player.created_at)}
            {" · "}
            {player.auth_user_id ? (
              <span style={{ color: successFg }}>linked account</span>
            ) : (
              <span style={{ color: inkMuted }}>no account</span>
            )}
          </p>

          {/* key by player id so a navigation to a different player
              remounts these and their local form state resets cleanly
              (no reset-in-effect needed). */}
          <ProfileSection key={`p-${player.id}`} player={player} onSaved={setPlayer} />
          <ImageSection
            key={`i-${player.id}`}
            player={player}
            avatarUrl={avatarUrl}
            onChanged={load}
          />
          <AccountSection
            key={`a-${player.id}`}
            player={player}
            account={account}
            onChanged={load}
          />
          <HistorySection history={history} />
        </>
      )}
    </main>
  );
}

// ─── Profile (name / contact / phone / gender / location) ─────────────────────

function ProfileSection({
  player,
  onSaved,
}: {
  player: PlayerProfile;
  onSaved: (p: PlayerProfile) => void;
}) {
  const [firstName, setFirstName] = useState(player.first_name);
  const [lastName, setLastName] = useState(player.last_name);
  const [contactEmail, setContactEmail] = useState(player.email ?? "");
  const [phone, setPhone] = useState(player.phone ?? "");
  const [gender, setGender] = useState<Gender | "">(player.gender ?? "");
  const [city, setCity] = useState(player.city ?? "");
  const [state, setState] = useState(player.state ?? "");
  const ratingStr = (n: number | null) => (n != null ? String(n) : "");
  const [ratingDoubles, setRatingDoubles] = useState(ratingStr(player.self_rating_doubles));
  const [ratingMixed, setRatingMixed] = useState(ratingStr(player.self_rating_mixed));
  const [ratingSingles, setRatingSingles] = useState(ratingStr(player.self_rating_singles));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty =
    firstName !== player.first_name ||
    lastName !== player.last_name ||
    contactEmail !== (player.email ?? "") ||
    phone !== (player.phone ?? "") ||
    gender !== (player.gender ?? "") ||
    city !== (player.city ?? "") ||
    state !== (player.state ?? "") ||
    ratingDoubles !== ratingStr(player.self_rating_doubles) ||
    ratingMixed !== ratingStr(player.self_rating_mixed) ||
    ratingSingles !== ratingStr(player.self_rating_singles);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    const { data, error: fnErr } = await supabase.functions.invoke(
      "admin-update-player",
      {
        body: {
          playerId: player.id,
          profile: {
            firstName,
            lastName,
            contactEmail,
            phone,
            gender: gender === "" ? null : gender,
            city,
            state,
            ratingDoubles: parseRating(ratingDoubles),
            ratingMixed: parseRating(ratingMixed),
            ratingSingles: parseRating(ratingSingles),
          },
        },
      },
    );
    setSaving(false);
    if (fnErr) {
      setError(await fnError(fnErr));
      return;
    }
    if (data && !(data as { ok?: boolean }).ok) {
      setError((data as { error?: string }).error ?? "Failed.");
      return;
    }
    setSaved(true);
    onSaved({
      ...player,
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      email: contactEmail.trim() || null,
      phone: phone.trim() || null,
      gender: gender === "" ? null : gender,
      city: city.trim() || null,
      state: state.trim() || null,
      self_rating_doubles: parseRating(ratingDoubles),
      self_rating_mixed: parseRating(ratingMixed),
      self_rating_singles: parseRating(ratingSingles),
    });
  };

  return (
    <Section title="Profile">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <Field label="First name">
          <input value={firstName} onChange={(e) => { setFirstName(e.target.value); setSaved(false); }} style={fieldInput} />
        </Field>
        <Field label="Last name">
          <input value={lastName} onChange={(e) => { setLastName(e.target.value); setSaved(false); }} style={fieldInput} />
        </Field>
        <Field label="Contact email">
          <input type="email" value={contactEmail} onChange={(e) => { setContactEmail(e.target.value); setSaved(false); }} style={fieldInput} />
        </Field>
        <Field label="Phone">
          <input value={phone} onChange={(e) => { setPhone(e.target.value); setSaved(false); }} style={fieldInput} />
        </Field>
        <Field label="Gender">
          <select
            value={gender}
            onChange={(e) => { setGender(e.target.value as Gender | ""); setSaved(false); }}
            style={{ ...fieldInput, height: 38 }}
          >
            <option value="">— (unset)</option>
            <option value="M">M — Men's-eligible</option>
            <option value="F">F — Women's-eligible</option>
            <option value="X">X — Other / prefer not to say</option>
          </select>
        </Field>
        <Field label="City">
          <input value={city} onChange={(e) => { setCity(e.target.value); setSaved(false); }} style={fieldInput} />
        </Field>
        <Field label="State">
          <input value={state} onChange={(e) => { setState(e.target.value); setSaved(false); }} style={fieldInput} />
        </Field>
      </div>

      <div style={{ fontSize: 12, fontWeight: 600, color: ink, margin: "20px 0 8px" }}>
        Self-reported ratings{" "}
        <span style={{ fontWeight: 400, color: inkMuted }}>
          (0–9.99 · used for bracket eligibility)
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <Field label="Doubles (same-gender)">
          <input type="number" step="0.01" min="0" max="9.99" placeholder="e.g. 3.5"
            value={ratingDoubles} onChange={(e) => { setRatingDoubles(e.target.value); setSaved(false); }} style={fieldInput} />
        </Field>
        <Field label="Mixed doubles">
          <input type="number" step="0.01" min="0" max="9.99" placeholder="e.g. 3.5"
            value={ratingMixed} onChange={(e) => { setRatingMixed(e.target.value); setSaved(false); }} style={fieldInput} />
        </Field>
        <Field label="Singles">
          <input type="number" step="0.01" min="0" max="9.99" placeholder="e.g. 3.0"
            value={ratingSingles} onChange={(e) => { setRatingSingles(e.target.value); setSaved(false); }} style={fieldInput} />
        </Field>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
        <button
          onClick={save}
          disabled={!dirty || saving}
          style={!dirty || saving ? { ...ctaPrimaryStyle, opacity: 0.5, cursor: "not-allowed" } : ctaPrimaryStyle}
        >
          {saving ? "Saving…" : "Save profile"}
        </button>
        {saved && <span style={{ fontSize: 13, color: successFg }}>Saved ✓</span>}
      </div>
      {error && <div style={{ ...statusPanelStyle("danger"), marginTop: 12 }}>{error}</div>}
    </Section>
  );
}

// ─── Account (login email + password) ─────────────────────────────────────────

function AccountSection({
  player,
  account,
  onChanged,
}: {
  player: PlayerProfile;
  account: Account | null;
  onChanged: () => Promise<void> | void;
}) {
  const [loginEmail, setLoginEmail] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwNotice, setPwNotice] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "email" | "temp">(null);

  if (!player.auth_user_id) {
    return (
      <Section title="Account & password">
        <p style={{ fontSize: 13, color: inkSoft, margin: 0 }}>
          This player has <strong>no linked login account</strong> — they were
          pre-created by an organizer and haven't claimed an account yet.
          There's no login email or password to manage until they sign up with
          a matching email.
        </p>
      </Section>
    );
  }

  const saveLoginEmail = async () => {
    setSavingEmail(true);
    setEmailError(null);
    const { data, error: fnErr } = await supabase.functions.invoke(
      "admin-update-player",
      { body: { playerId: player.id, loginEmail: loginEmail.trim() } },
    );
    setSavingEmail(false);
    if (fnErr) {
      setEmailError(await fnError(fnErr));
      return;
    }
    if (data && !(data as { ok?: boolean }).ok) {
      setEmailError((data as { error?: string }).error ?? "Failed.");
      return;
    }
    setLoginEmail("");
    await onChanged();
  };

  const runPasswordAction = async (type: "send_reset_email" | "set_temp_password") => {
    setPwBusy(true);
    setPwError(null);
    setPwNotice(null);
    setTempPassword(null);
    const body: Record<string, unknown> = {
      playerId: player.id,
      passwordAction:
        type === "send_reset_email"
          ? { type, redirectTo: `${window.location.origin}/reset-password` }
          : { type },
    };
    const { data, error: fnErr } = await supabase.functions.invoke(
      "admin-update-player",
      { body },
    );
    setPwBusy(false);
    if (fnErr) {
      setPwError(await fnError(fnErr));
      return;
    }
    const res = data as { ok?: boolean; error?: string; tempPassword?: string };
    if (!res?.ok) {
      setPwError(res?.error ?? "Failed.");
      return;
    }
    if (type === "send_reset_email") {
      setPwNotice(
        `Password-reset email sent to ${account?.loginEmail ?? "the player's login email"}.`,
      );
    } else if (res.tempPassword) {
      setTempPassword(res.tempPassword);
    }
  };

  return (
    <Section title="Account & password">
      <dl style={{ margin: "0 0 16px", display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 16px", fontSize: 13 }}>
        <dt style={{ color: inkMuted }}>Login email</dt>
        <dd style={{ margin: 0, color: ink }}>{account?.loginEmail ?? "—"}</dd>
        <dt style={{ color: inkMuted }}>Email confirmed</dt>
        <dd style={{ margin: 0, color: ink }}>
          {account?.emailConfirmedAt ? (
            fmtDate(account.emailConfirmedAt)
          ) : (
            <span style={{ color: warnFg }}>not confirmed</span>
          )}
        </dd>
        <dt style={{ color: inkMuted }}>Last sign-in</dt>
        <dd style={{ margin: 0, color: ink }}>{fmtDate(account?.lastSignInAt ?? null)}</dd>
      </dl>

      {/* Change login email */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 8 }}>
        <Field label="Change login email">
          <input
            type="email"
            value={loginEmail}
            placeholder="new-login@example.com"
            onChange={(e) => { setLoginEmail(e.target.value); setEmailError(null); }}
            style={fieldInput}
          />
        </Field>
        <button
          onClick={() => setConfirm("email")}
          disabled={savingEmail || !loginEmail.trim()}
          style={savingEmail || !loginEmail.trim() ? { ...ctaSecondaryStyle, opacity: 0.5, cursor: "not-allowed" } : ctaSecondaryStyle}
        >
          {savingEmail ? "Updating…" : "Update login email"}
        </button>
      </div>
      {emailError && <div style={{ ...statusPanelStyle("danger"), marginTop: 8 }}>{emailError}</div>}

      {/* Password reset */}
      <div style={{ borderTop: `1px solid ${ruleSoft}`, marginTop: 16, paddingTop: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: ink, marginBottom: 6 }}>
          Reset password
        </div>
        <p style={{ fontSize: 12.5, color: inkSoft, margin: "0 0 10px", maxWidth: 560 }}>
          <strong>Send reset email</strong> lets the player set their own new
          password via a branded link (needs email delivery working).{" "}
          <strong>Set temporary password</strong> generates one shown here once —
          relay it to the player, and they can change it after signing in.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => void runPasswordAction("send_reset_email")}
            disabled={pwBusy}
            style={pwBusy ? { ...ctaSecondaryStyle, opacity: 0.5, cursor: "not-allowed" } : ctaSecondaryStyle}
          >
            {pwBusy ? "Working…" : "Send reset email"}
          </button>
          <button
            onClick={() => setConfirm("temp")}
            disabled={pwBusy}
            style={pwBusy ? { ...ctaSecondaryStyle, opacity: 0.5, cursor: "not-allowed" } : ctaSecondaryStyle}
          >
            Set temporary password
          </button>
        </div>

        {pwNotice && <div style={{ ...statusPanelStyle("success"), marginTop: 12 }}>{pwNotice}</div>}
        {pwError && <div style={{ ...statusPanelStyle("danger"), marginTop: 12 }}>{pwError}</div>}
        {tempPassword && (
          <div
            style={{
              marginTop: 12,
              padding: "12px 14px",
              background: warnBg,
              border: `1px solid ${rule}`,
              borderRadius: 8,
              fontSize: 13,
              color: ink,
            }}
          >
            <div style={{ marginBottom: 6 }}>
              Temporary password (shown once — copy it now):
            </div>
            <code
              style={{
                display: "inline-block",
                padding: "6px 10px",
                background: "#fff",
                border: `1px solid ${rule}`,
                borderRadius: 6,
                fontSize: 15,
                letterSpacing: 0.5,
                userSelect: "all",
              }}
            >
              {tempPassword}
            </code>
            <div style={{ marginTop: 6, fontSize: 12, color: inkSoft }}>
              Give this to the player over a trusted channel; have them change
              it after signing in.
            </div>
          </div>
        )}
      </div>

      {confirm === "email" && (
        <ConfirmModal
          title="Change login email?"
          destructive={false}
          body={
            <>
              This changes the email <strong>{player.first_name}</strong> signs
              in with to <strong>{loginEmail.trim()}</strong>. Depending on your
              Supabase settings they may need to confirm the new address.
            </>
          }
          confirmLabel="Change login email"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            setConfirm(null);
            await saveLoginEmail();
          }}
        />
      )}
      {confirm === "temp" && (
        <ConfirmModal
          title="Set a temporary password?"
          body={
            <>
              This immediately replaces <strong>{player.first_name}</strong>'s
              password with a new temporary one shown to you once. Their current
              password stops working right away.
            </>
          }
          confirmLabel="Set temporary password"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            setConfirm(null);
            await runPasswordAction("set_temp_password");
          }}
        />
      )}
    </Section>
  );
}

// ─── Profile image moderation (hide / show) ───────────────────────────────────

function ImageSection({
  player,
  avatarUrl,
  onChanged,
}: {
  player: PlayerProfile;
  avatarUrl: string | null;
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hidden = player.avatar_hidden;

  const toggle = async () => {
    setBusy(true);
    setError(null);
    const { data, error: fnErr } = await supabase.functions.invoke(
      "admin-update-player",
      { body: { playerId: player.id, avatarHidden: !hidden } },
    );
    setBusy(false);
    if (fnErr) {
      setError(await fnError(fnErr));
      return;
    }
    if (data && !(data as { ok?: boolean }).ok) {
      setError((data as { error?: string }).error ?? "Failed.");
      return;
    }
    await onChanged();
  };

  return (
    <Section title="Profile image">
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div
          style={{
            position: "relative",
            width: 96,
            height: 96,
            borderRadius: "50%",
            overflow: "hidden",
            background: bg,
            border: `1px solid ${rule}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={`${player.first_name} ${player.last_name}`}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                // Dim a hidden image so the admin sees it's suppressed,
                // while still being able to review it.
                filter: hidden ? "grayscale(1) opacity(0.5)" : undefined,
              }}
            />
          ) : (
            <span style={{ fontSize: 22, fontWeight: 600, color: inkMuted }}>
              {(player.first_name[0] ?? "") + (player.last_name[0] ?? "")}
            </span>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 220 }}>
          {!avatarUrl ? (
            <p style={{ fontSize: 13, color: inkSoft, margin: 0 }}>
              No profile image uploaded — other viewers see the initials
              placeholder.
            </p>
          ) : (
            <>
              <div style={{ marginBottom: 8 }}>
                {hidden ? (
                  <span style={{ ...pillBase, background: warnBg, color: warnFg }}>
                    Hidden from other viewers
                  </span>
                ) : (
                  <span style={{ ...pillBase, background: successBg, color: successFg }}>
                    Visible
                  </span>
                )}
              </div>
              <p style={{ fontSize: 12.5, color: inkSoft, margin: "0 0 10px", maxWidth: 520 }}>
                Hiding keeps the image on file (so you can review it here) but
                makes avatar surfaces fall back to the initials placeholder for
                everyone else. Reversible.
              </p>
              <button
                onClick={toggle}
                disabled={busy}
                style={busy ? { ...ctaSecondaryStyle, opacity: 0.5, cursor: "not-allowed" } : ctaSecondaryStyle}
              >
                {busy ? "Working…" : hidden ? "Show image" : "Hide image"}
              </button>
            </>
          )}
          {error && <div style={{ ...statusPanelStyle("danger"), marginTop: 10 }}>{error}</div>}
        </div>
      </div>
    </Section>
  );
}

// ─── Tournament history ───────────────────────────────────────────────────────

function HistorySection({ history }: { history: HistoryRow[] }) {
  return (
    <Section title={`Tournament history (${history.length})`}>
      {history.length === 0 ? (
        <p style={{ fontSize: 13, color: inkMuted, margin: 0 }}>
          No registrations yet.
        </p>
      ) : (
        <div style={{ border: `1px solid ${rule}`, borderRadius: 8, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: bg, borderBottom: `1px solid ${rule}` }}>
                <th style={thStyle}>Tournament</th>
                <th style={thStyle}>Event</th>
                <th style={thStyle}>Partner</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Date</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.regId} style={{ borderBottom: `1px solid ${ruleSoft}` }}>
                  <td style={tdStyle}>
                    {h.tournament ? (
                      h.tournament.orgSlug ? (
                        <Link
                          to={`/admin/${h.tournament.orgSlug}/tournaments/${h.tournament.slug}`}
                          style={{ color: courtBlue, textDecoration: "none" }}
                        >
                          {h.tournament.name}
                        </Link>
                      ) : (
                        h.tournament.name
                      )
                    ) : (
                      "—"
                    )}
                    {h.tournament?.orgName && (
                      <div style={{ fontSize: 11, color: inkMuted }}>
                        {h.tournament.orgName}
                      </div>
                    )}
                  </td>
                  <td style={tdStyle}>{h.event?.name ?? "—"}</td>
                  <td style={tdStyle}>
                    {h.partnerName ?? (
                      <span style={{ color: inkMuted }}>—</span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <span style={statusPillStyle(h.status)}>
                      {statusLabel(h.status)}
                    </span>
                  </td>
                  <td style={tdStyle}>{fmtDate(h.registeredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ─── Small shared bits ────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        border: `1px solid ${rule}`,
        borderRadius: 10,
        padding: 20,
        marginBottom: 20,
        background: "#fff",
      }}
    >
      <h2
        style={{
          margin: "0 0 16px",
          fontSize: 15,
          fontWeight: 700,
          color: ink,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: inkSoft }}>
      {label}
      {children}
    </label>
  );
}

const fieldInput = { ...inputStyle, width: 220 };

const pillBase = {
  display: "inline-block",
  padding: "2px 10px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
};

const thStyle = {
  padding: "10px 14px",
  textAlign: "left" as const,
  fontSize: 12,
  fontWeight: 600,
  color: inkSoft,
  whiteSpace: "nowrap" as const,
};

const tdStyle = {
  padding: "10px 14px",
  verticalAlign: "top" as const,
  color: ink,
};

function statusPillStyle(status: string) {
  const active = status === "paid";
  const muted = ["cancelled", "withdrawn", "refunded"].includes(status);
  return {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 500,
    background: active ? successBg : muted ? bg : cream,
    color: active ? successFg : muted ? inkMuted : warnFg,
    border: `1px solid ${rule}`,
    whiteSpace: "nowrap" as const,
  };
}
