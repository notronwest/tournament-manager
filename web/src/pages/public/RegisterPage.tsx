import {
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import { eligibilityChips } from "../../lib/eligibility";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];
type Player = Database["public"]["Tables"]["players"]["Row"];

// Per-event entry on the form. Tracks whether the user has selected
// this event and, for doubles, the partner details the user typed in
// (we need name+email so we can create a partner player row + an
// invite row referencing it — schema makes those NOT NULL).
type EventSelection = {
  selected: boolean;
  partnerFirst: string;
  partnerLast: string;
  partnerEmail: string;
};

// Auth-gated registration page. Reached via /t/:orgSlug/:tournamentSlug/register
// — RequireAuth bounces unauthenticated visitors to /login and they
// return here on signin.
//
// Single form covers:
//   * "Your info" — pre-filled from the auth user's player row if
//     there is one; otherwise empty. Saves on submit, optionally
//     auto-linking an existing players row that has the matching
//     email and no auth_user_id yet.
//   * Event checklist — one row per event. Doubles events expand
//     to capture partner name + email when checked.
//
// On submit:
//   * The user's player record is created/updated.
//   * For each selected event, an event_registrations row is inserted
//     for the user.
//   * For each doubles event with partner info, a player row is
//     created (or matched by email) and a partner_invites row is
//     created with a token. Emails ship in the next commit; for now
//     we surface the invite URLs so the inviter can copy/share them
//     manually.
export default function RegisterPage() {
  const { user } = useAuth();
  const { orgSlug, tournamentSlug } = useParams<{
    orgSlug: string;
    tournamentSlug: string;
  }>();
  const navigate = useNavigate();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [existingPlayer, setExistingPlayer] = useState<Player | null>(null);
  // Track which events the user is *already* registered for so we
  // don't double-register them. (Stored as a set of event_ids.)
  const [existingRegEventIds, setExistingRegEventIds] = useState<Set<string>>(
    new Set(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Self info
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");

  // Per-event selection state, keyed by event_id.
  const [selections, setSelections] = useState<Map<string, EventSelection>>(
    new Map(),
  );

  // Submission state: 'form' is the editable form, 'submitting' shows
  // a spinner, 'done' is the post-submit summary view with partner
  // invite links to share.
  const [phase, setPhase] = useState<"form" | "submitting" | "done">("form");
  const [doneResult, setDoneResult] = useState<{
    registeredEventNames: string[];
    partnerInvites: { eventName: string; partnerEmail: string; url: string }[];
  } | null>(null);

  useEffect(() => {
    if (!orgSlug || !tournamentSlug || !user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);

      // 1. Resolve org → tournament → events.
      const { data: org, error: orgErr } = await supabase
        .from("organizations")
        .select("id")
        .eq("slug", orgSlug)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (orgErr || !org) {
        setError(orgErr?.message ?? "Organization not found.");
        setLoading(false);
        return;
      }
      const { data: t, error: tErr } = await supabase
        .from("tournaments")
        .select("*")
        .eq("organization_id", org.id)
        .eq("slug", tournamentSlug)
        .in("status", ["published"])
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (tErr || !t) {
        setError(tErr?.message ?? "Tournament not available for registration.");
        setLoading(false);
        return;
      }
      setTournament(t);

      // 2. Events (excluding completed ones — can't register for those).
      const { data: evs, error: evErr } = await supabase
        .from("events")
        .select("*")
        .eq("tournament_id", t.id)
        .is("deleted_at", null)
        .not("status", "eq", "complete")
        .not("status", "eq", "verified")
        .order("created_at", { ascending: true });
      if (cancelled) return;
      if (evErr) {
        setError(evErr.message);
        setLoading(false);
        return;
      }
      setEvents(evs ?? []);
      // Initialize per-event selection state.
      const sel = new Map<string, EventSelection>();
      for (const e of evs ?? []) {
        sel.set(e.id, {
          selected: false,
          partnerFirst: "",
          partnerLast: "",
          partnerEmail: "",
        });
      }
      setSelections(sel);

      // 3. The user's player row, if any. Prefer auth_user_id match;
      //    fall back to a single unlinked player with the same email
      //    so admins can pre-create records that get reclaimed on
      //    first registration.
      let myPlayer: Player | null = null;
      {
        const { data } = await supabase
          .from("players")
          .select("*")
          .eq("auth_user_id", user.id)
          .is("deleted_at", null)
          .maybeSingle();
        if (cancelled) return;
        myPlayer = data ?? null;
      }
      if (!myPlayer && user.email) {
        const { data } = await supabase
          .from("players")
          .select("*")
          .eq("email", user.email)
          .is("auth_user_id", null)
          .is("deleted_at", null);
        if (cancelled) return;
        if (data && data.length === 1) myPlayer = data[0];
      }
      setExistingPlayer(myPlayer);
      if (myPlayer) {
        setFirstName(myPlayer.first_name ?? "");
        setLastName(myPlayer.last_name ?? "");
        setPhone(myPlayer.phone ?? "");
      }

      // 4. Existing registrations for this user in this tournament,
      //    so we can show "Already registered" instead of letting them
      //    double-register.
      if (myPlayer && evs && evs.length > 0) {
        const { data } = await supabase
          .from("event_registrations")
          .select("event_id")
          .eq("player_id", myPlayer.id)
          .in(
            "event_id",
            evs.map((e) => e.id),
          )
          .is("deleted_at", null);
        if (cancelled) return;
        setExistingRegEventIds(
          new Set((data ?? []).map((r) => r.event_id)),
        );
      }

      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug, tournamentSlug, user]);

  const setSel = (eventId: string, patch: Partial<EventSelection>) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const cur = next.get(eventId) ?? {
        selected: false,
        partnerFirst: "",
        partnerLast: "",
        partnerEmail: "",
      };
      next.set(eventId, { ...cur, ...patch });
      return next;
    });
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setError(null);

    if (!firstName.trim() || !lastName.trim()) {
      setError("First and last name are required.");
      return;
    }

    const chosen = events.filter((ev) => selections.get(ev.id)?.selected);
    if (chosen.length === 0) {
      setError("Pick at least one event.");
      return;
    }
    // Validate partner info for doubles events
    for (const ev of chosen) {
      if (ev.format !== "doubles") continue;
      const s = selections.get(ev.id)!;
      if (
        !s.partnerFirst.trim() ||
        !s.partnerLast.trim() ||
        !s.partnerEmail.trim()
      ) {
        setError(
          `Partner first name, last name, and email are required for "${ev.name}".`,
        );
        return;
      }
      if (
        user.email &&
        s.partnerEmail.trim().toLowerCase() === user.email.toLowerCase()
      ) {
        setError(`Partner email can't be your own ("${ev.name}").`);
        return;
      }
    }

    setPhase("submitting");

    // Save self player record (create / update / link existing).
    const me = await ensureSelfPlayer({
      authUserId: user.id,
      authEmail: user.email ?? null,
      existing: existingPlayer,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      phone: phone.trim(),
    });
    if (!me) {
      setError("Failed to save your player record.");
      setPhase("form");
      return;
    }

    const registeredEventNames: string[] = [];
    const partnerInvites: {
      eventName: string;
      partnerEmail: string;
      url: string;
    }[] = [];

    for (const ev of chosen) {
      const sel = selections.get(ev.id)!;

      // Insert the user's event_registration for this event.
      const { data: myReg, error: myRegErr } = await supabase
        .from("event_registrations")
        .insert({
          event_id: ev.id,
          player_id: me.id,
          event_fee_cents: ev.event_fee_cents,
          status: "paid",
          partner_status:
            ev.format === "doubles" ? "pending" : "solo",
        })
        .select()
        .single();
      if (myRegErr || !myReg) {
        setError(
          myRegErr?.message ??
            `Failed to register you for "${ev.name}".`,
        );
        setPhase("form");
        return;
      }
      registeredEventNames.push(ev.name);

      // Partner invite for doubles.
      if (ev.format === "doubles") {
        const partner = await findOrCreatePlayerByEmail({
          email: sel.partnerEmail.trim(),
          firstName: sel.partnerFirst.trim(),
          lastName: sel.partnerLast.trim(),
        });
        if (!partner) {
          setError(
            `Failed to set up partner record for "${ev.name}".`,
          );
          setPhase("form");
          return;
        }
        // Create the invite. The token is generated by the DB
        // default; we read it back to render the share URL.
        const { data: invite, error: invErr } = await supabase
          .from("partner_invites")
          .insert({
            event_id: ev.id,
            inviter_player_id: me.id,
            invitee_player_id: partner.id,
            invitee_email: sel.partnerEmail.trim(),
            status: "pending",
          })
          .select()
          .single();
        if (invErr || !invite) {
          setError(
            invErr?.message ??
              `Failed to send partner invite for "${ev.name}".`,
          );
          setPhase("form");
          return;
        }
        const url = `${window.location.origin}/t/${orgSlug}/${tournamentSlug}/invites/${invite.token}`;
        partnerInvites.push({
          eventName: ev.name,
          partnerEmail: sel.partnerEmail.trim(),
          url,
        });
      }
    }

    setDoneResult({ registeredEventNames, partnerInvites });
    setPhase("done");
  };

  if (loading) {
    return (
      <Shell>
        <p style={{ color: "#666", fontSize: 14 }}>Loading…</p>
      </Shell>
    );
  }
  if (error && phase === "form" && !tournament) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 8px", fontSize: 22 }}>Not available</h1>
        <p style={{ color: "#666", fontSize: 14 }}>{error}</p>
      </Shell>
    );
  }
  if (!tournament) return null;

  if (phase === "done" && doneResult) {
    return (
      <Shell>
        <div
          style={{
            padding: 20,
            background: "#dcfce7",
            border: "1px solid #86efac",
            borderRadius: 8,
            marginBottom: 24,
          }}
        >
          <h1
            style={{ margin: "0 0 8px", fontSize: 20, color: "#166534" }}
          >
            You're registered!
          </h1>
          <p style={{ margin: 0, color: "#166534", fontSize: 14 }}>
            Confirmed for {fmtList(doneResult.registeredEventNames)} in{" "}
            <strong>{tournament.name}</strong>.
          </p>
        </div>

        {doneResult.partnerInvites.length > 0 && (
          <section style={{ marginBottom: 24 }}>
            <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>
              Partner invite{doneResult.partnerInvites.length === 1 ? "" : "s"}
            </h2>
            <p style={{ margin: "0 0 12px", color: "#666", fontSize: 13 }}>
              Email delivery is coming in the next deploy. For now, copy
              each link below and send it to your partner.
            </p>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {doneResult.partnerInvites.map((inv, i) => (
                <PartnerInviteCard key={i} {...inv} />
              ))}
            </div>
          </section>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <Link
            to={`/t/${orgSlug}/${tournamentSlug}`}
            style={{
              padding: "8px 16px",
              background: "#fff",
              color: "#2563eb",
              textDecoration: "none",
              borderRadius: 6,
              border: "1px solid #2563eb",
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            ← Back to tournament
          </Link>
          <button
            onClick={() => {
              // Re-fetch from scratch so existingRegEventIds reflects
              // what we just inserted.
              navigate(0);
            }}
            style={{
              padding: "8px 16px",
              background: "#2563eb",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Register for more events
          </button>
        </div>
      </Shell>
    );
  }

  const submitting = phase === "submitting";

  return (
    <Shell>
      <Link
        to={`/t/${orgSlug}/${tournamentSlug}`}
        style={{ color: "#2563eb", textDecoration: "none", fontSize: 13 }}
      >
        ← {tournament.name}
      </Link>
      <h1 style={{ margin: "12px 0 4px", fontSize: 24 }}>
        Register for {tournament.name}
      </h1>
      <p style={{ color: "#666", margin: "0 0 24px", fontSize: 14 }}>
        Signed in as <strong>{user?.email}</strong>.
      </p>

      <form onSubmit={onSubmit}>
        <Section title="Your info">
          <FieldRow>
            <Field label="First name" required>
              <input
                type="text"
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                style={inputStyle}
                disabled={submitting}
              />
            </Field>
            <Field label="Last name" required>
              <input
                type="text"
                required
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                style={inputStyle}
                disabled={submitting}
              />
            </Field>
            <Field label="Phone">
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                style={inputStyle}
                disabled={submitting}
              />
            </Field>
          </FieldRow>
        </Section>

        <Section title="Pick your events">
          {events.length === 0 ? (
            <Empty>No events available for registration.</Empty>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {events.map((ev) => {
                const sel = selections.get(ev.id)!;
                const already = existingRegEventIds.has(ev.id);
                return (
                  <EventRow
                    key={ev.id}
                    event={ev}
                    selection={sel}
                    alreadyRegistered={already}
                    disabled={submitting}
                    onChange={(patch) => setSel(ev.id, patch)}
                  />
                );
              })}
            </div>
          )}
        </Section>

        {error && (
          <div
            style={{
              padding: 12,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 6,
              color: "#991b1b",
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: "12px 24px",
            background: submitting ? "#9ca3af" : "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontSize: 15,
            fontWeight: 500,
            cursor: submitting ? "not-allowed" : "pointer",
            fontFamily: "inherit",
          }}
        >
          {submitting ? "Registering…" : "Confirm registration"}
        </button>
      </form>
    </Shell>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Per-event form row
// ─────────────────────────────────────────────────────────────────────

function EventRow({
  event,
  selection,
  alreadyRegistered,
  disabled,
  onChange,
}: {
  event: Event;
  selection: EventSelection;
  alreadyRegistered: boolean;
  disabled: boolean;
  onChange: (patch: Partial<EventSelection>) => void;
}) {
  const chips = eligibilityChips(event);
  return (
    <label
      style={{
        display: "block",
        padding: 12,
        background: alreadyRegistered ? "#f3f4f6" : "#fff",
        border: `1px solid ${selection.selected ? "#2563eb" : "#e5e7eb"}`,
        borderRadius: 6,
        cursor: alreadyRegistered || disabled ? "not-allowed" : "pointer",
        opacity: alreadyRegistered ? 0.7 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <input
          type="checkbox"
          checked={alreadyRegistered ? true : selection.selected}
          disabled={alreadyRegistered || disabled}
          onChange={(e) => onChange({ selected: e.target.checked })}
          style={{ marginTop: 3 }}
        />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, fontSize: 14 }}>
            {event.name}
            {alreadyRegistered && (
              <span
                style={{
                  marginLeft: 8,
                  padding: "1px 8px",
                  background: "#dcfce7",
                  color: "#166534",
                  borderRadius: 3,
                  fontSize: 11,
                  fontWeight: 500,
                }}
              >
                Already registered
              </span>
            )}
          </div>
          <div style={{ color: "#666", fontSize: 12, marginTop: 2 }}>
            {capitalize(event.format)} · {capitalize(event.gender)} ·{" "}
            {event.points_to_win} win by {event.win_by}
            {event.event_fee_cents > 0
              ? ` · $${(event.event_fee_cents / 100).toFixed(2)}`
              : ""}
          </div>
          {chips.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 4,
                marginTop: 6,
              }}
            >
              {chips.map((c) => (
                <span
                  key={c}
                  style={{
                    padding: "1px 6px",
                    background: "#eff6ff",
                    color: "#1e40af",
                    borderRadius: 3,
                    fontSize: 10,
                    fontWeight: 500,
                  }}
                >
                  {c}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {event.format === "doubles" &&
        selection.selected &&
        !alreadyRegistered && (
          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px dashed #e5e7eb",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ fontSize: 12, color: "#666" }}>
              Your doubles partner. They'll get an invite link to confirm.
            </div>
            <FieldRow>
              <Field label="Partner first name" required>
                <input
                  type="text"
                  required
                  value={selection.partnerFirst}
                  onChange={(e) =>
                    onChange({ partnerFirst: e.target.value })
                  }
                  style={inputStyle}
                  disabled={disabled}
                />
              </Field>
              <Field label="Partner last name" required>
                <input
                  type="text"
                  required
                  value={selection.partnerLast}
                  onChange={(e) =>
                    onChange({ partnerLast: e.target.value })
                  }
                  style={inputStyle}
                  disabled={disabled}
                />
              </Field>
              <Field label="Partner email" required>
                <input
                  type="email"
                  required
                  value={selection.partnerEmail}
                  onChange={(e) =>
                    onChange({ partnerEmail: e.target.value })
                  }
                  style={inputStyle}
                  disabled={disabled}
                />
              </Field>
            </FieldRow>
          </div>
        )}
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Partner invite card on the done screen
// ─────────────────────────────────────────────────────────────────────

function PartnerInviteCard({
  eventName,
  partnerEmail,
  url,
}: {
  eventName: string;
  partnerEmail: string;
  url: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy this URL:", url);
    }
  };
  return (
    <div
      style={{
        padding: 12,
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 6,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 500 }}>{eventName}</div>
      <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
        Invite for <strong>{partnerEmail}</strong>
      </div>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginTop: 8,
        }}
      >
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            flex: 1,
            padding: "6px 10px",
            border: "1px solid #e2e2e2",
            borderRadius: 4,
            fontSize: 12,
            fontFamily: "ui-monospace, monospace",
            background: "#fafafa",
          }}
        />
        <button
          onClick={onCopy}
          style={{
            padding: "6px 12px",
            background: copied ? "#dcfce7" : "#2563eb",
            color: copied ? "#166534" : "#fff",
            border: "none",
            borderRadius: 4,
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Persistence helpers
// ─────────────────────────────────────────────────────────────────────

async function ensureSelfPlayer(args: {
  authUserId: string;
  authEmail: string | null;
  existing: Player | null;
  firstName: string;
  lastName: string;
  phone: string;
}): Promise<Player | null> {
  const payload = {
    first_name: args.firstName,
    last_name: args.lastName,
    phone: args.phone || null,
  };
  // If the existing record is already linked to this auth user,
  // update it in place.
  if (args.existing && args.existing.auth_user_id === args.authUserId) {
    const { data, error } = await supabase
      .from("players")
      .update(payload)
      .eq("id", args.existing.id)
      .select()
      .single();
    if (error || !data) return null;
    return data;
  }
  // If we found an unlinked player by email, claim it for this user.
  if (args.existing && args.existing.auth_user_id === null) {
    const { data, error } = await supabase
      .from("players")
      .update({ ...payload, auth_user_id: args.authUserId })
      .eq("id", args.existing.id)
      .select()
      .single();
    if (error || !data) return null;
    return data;
  }
  // Otherwise create a fresh player linked to this auth user.
  const { data, error } = await supabase
    .from("players")
    .insert({
      ...payload,
      auth_user_id: args.authUserId,
      email: args.authEmail,
    })
    .select()
    .single();
  if (error || !data) return null;
  return data;
}

async function findOrCreatePlayerByEmail(args: {
  email: string;
  firstName: string;
  lastName: string;
}): Promise<Player | null> {
  // Soft-unique email — fetch ALL matches; if exactly one, reuse it.
  // Multiple matches (rare: parent + child sharing an email) → create
  // a new record rather than guess.
  const { data: matches } = await supabase
    .from("players")
    .select("*")
    .eq("email", args.email)
    .is("deleted_at", null);
  if (matches && matches.length === 1) return matches[0];

  const { data, error } = await supabase
    .from("players")
    .insert({
      first_name: args.firstName,
      last_name: args.lastName,
      email: args.email,
    })
    .select()
    .single();
  if (error || !data) return null;
  return data;
}

// ─────────────────────────────────────────────────────────────────────
// Bits + styles
// ─────────────────────────────────────────────────────────────────────

function Shell({ children }: { children: ReactNode }) {
  return (
    <main
      style={{ padding: "32px 24px", maxWidth: 760, margin: "0 auto" }}
    >
      {children}
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>{title}</h2>
      {children}
    </section>
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

function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: 24,
        textAlign: "center",
        background: "#fafafa",
        border: "1px dashed #d1d5db",
        borderRadius: 6,
        color: "#666",
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  width: "100%",
};
