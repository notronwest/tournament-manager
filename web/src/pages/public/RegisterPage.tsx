import {
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import {
  emptySelection,
  persistPlayerSelection,
  type PlayerSelection,
} from "../../components/PlayerPicker";
import { PartnerSearch } from "../../components/PartnerSearch";
import { eligibilityChips } from "../../lib/eligibility";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];
type Player = Database["public"]["Tables"]["players"]["Row"];

// Per-event entry on the form. Tracks whether the user has selected
// this event and, for doubles, the partner. The partner is a
// PlayerSelection from the shared PlayerPicker component — empty,
// an existing player picked via typeahead, or a brand-new draft.
type EventSelection = {
  selected: boolean;
  partner: PlayerSelection;
};

// Auth-gated registration page. Reached via /t/:orgSlug/:tournamentSlug/register.
// RequireAuth bounces unauthenticated visitors to /login; RequireProfile
// bounces anyone without a complete player profile to /profile?return=…
// Both run before this component renders, so by the time we get here we
// can assume `me` has a name.
//
// The form is just two sections — pick events + pick partner — because
// profile lives elsewhere now. On submit, for each selected event we
// insert an event_registration. For doubles events we additionally
// resolve the partner via PlayerPicker (existing player or "Add new")
// and either:
//   * auto-accept an existing pending invite from that partner to
//     this user (the user picked the inviter; no new outbound invite),
//     OR
//   * create a new partner_invites row + call send-partner-invite to
//     email them an accept link.
export default function RegisterPage() {
  const { user } = useAuth();
  const { orgSlug, tournamentSlug } = useParams<{
    orgSlug: string;
    tournamentSlug: string;
  }>();
  const navigate = useNavigate();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  // Profile is guaranteed to exist (RequireProfile wraps this route).
  // We load it for two reasons: we need the player id to insert
  // registrations and to populate excludePlayerIds on the partner
  // picker so the user can't pick themselves.
  const [me, setMe] = useState<Player | null>(null);
  // Track which events the user is *already* registered for so we
  // don't double-register them. (Stored as a set of event_ids.)
  const [existingRegEventIds, setExistingRegEventIds] = useState<Set<string>>(
    new Set(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    partnerInvites: {
      eventName: string;
      partnerEmail: string;
      url: string;
      emailSent: boolean;
      emailError?: string;
    }[];
    autoPairs: { eventName: string; partnerName: string }[];
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
        sel.set(e.id, { selected: false, partner: emptySelection });
      }
      setSelections(sel);

      // 3. The user's player row. Guaranteed to exist + have a name
      //    by the time we render — RequireProfile redirects to
      //    /profile when it isn't there yet.
      const { data: myPlayer } = await supabase
        .from("players")
        .select("*")
        .eq("auth_user_id", user.id)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (!myPlayer) {
        // Defensive: shouldn't happen given RequireProfile, but bail
        // out cleanly instead of crashing if some race lands us here.
        setError(
          "Profile not found. Try refreshing — you may need to finish your profile first.",
        );
        setLoading(false);
        return;
      }
      setMe(myPlayer);

      // 4. Existing registrations for this user in this tournament,
      //    so we can show "Already registered" instead of letting them
      //    double-register.
      if (evs && evs.length > 0) {
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
        partner: emptySelection,
      };
      next.set(eventId, { ...cur, ...patch });
      return next;
    });
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !me) return;
    setError(null);

    const chosen = events.filter((ev) => selections.get(ev.id)?.selected);
    if (chosen.length === 0) {
      setError("Pick at least one event.");
      return;
    }
    // Validate partner selection for doubles events
    for (const ev of chosen) {
      if (ev.format !== "doubles") continue;
      const s = selections.get(ev.id)!;
      if (s.partner.mode === "empty") {
        setError(
          `Pick a partner for "${ev.name}" — search by name, email, or phone, or add a new player.`,
        );
        return;
      }
      if (s.partner.mode === "new") {
        if (
          !s.partner.firstName.trim() ||
          !s.partner.lastName.trim() ||
          !s.partner.email.trim()
        ) {
          setError(
            `Partner first name, last name, and email are required for "${ev.name}".`,
          );
          return;
        }
        if (
          user.email &&
          s.partner.email.trim().toLowerCase() === user.email.toLowerCase()
        ) {
          setError(`Partner email can't be your own ("${ev.name}").`);
          return;
        }
      }
      if (s.partner.mode === "existing") {
        // Can't partner with yourself.
        if (s.partner.player.id === me.id) {
          setError(`You picked yourself as your partner for "${ev.name}".`);
          return;
        }
        if (!s.partner.player.email) {
          setError(
            `${s.partner.player.first_name} ${s.partner.player.last_name} doesn't have an email on file — we need one to send the partner invite. Pick a different partner or add a new player with their email.`,
          );
          return;
        }
      }
    }

    setPhase("submitting");

    const registeredEventNames: string[] = [];
    const partnerInvites: {
      eventName: string;
      partnerEmail: string;
      url: string;
      emailSent: boolean;
      emailError?: string;
    }[] = [];
    const autoPairs: { eventName: string; partnerName: string }[] = [];

    for (const ev of chosen) {
      const sel = selections.get(ev.id)!;

      // ─── Doubles: resolve partner FIRST so we can check for an
      //     inbound invite before deciding how to insert our own reg.
      let resolvedPartner: Player | null = null;
      let inboundInviteId: string | null = null;
      let partnerEmail: string | null = null;

      if (ev.format === "doubles") {
        const partnerRes = await persistPlayerSelection(sel.partner);
        if (!partnerRes.player) {
          setError(
            partnerRes.error ??
              `Failed to set up partner record for "${ev.name}".`,
          );
          setPhase("form");
          return;
        }
        resolvedPartner = partnerRes.player;
        partnerEmail =
          resolvedPartner.email ??
          (sel.partner.mode === "new" ? sel.partner.email.trim() : null);

        // Look for an inbound invite: the partner already invited
        // me to this same event. If found, registering here counts
        // as accepting that invite — no new outbound invite, no
        // duplicate email.
        if (user.email) {
          const { data: inbound } = await supabase
            .from("partner_invites")
            .select("id")
            .eq("event_id", ev.id)
            .eq("inviter_player_id", resolvedPartner.id)
            .eq("invitee_email", user.email)
            .eq("status", "pending")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (inbound) inboundInviteId = inbound.id;
        }
      }

      // ─── Insert my event_registration.
      const { error: myRegErr } = await supabase
        .from("event_registrations")
        .insert({
          event_id: ev.id,
          player_id: me.id,
          event_fee_cents: ev.event_fee_cents,
          status: "paid",
          // For the inbound-invite case, partner_status starts at
          // 'solo' and the accept_partner_invite RPC bumps it to
          // 'confirmed' along with linking the two regs. For the
          // outbound-invite case, 'pending' until the partner
          // accepts.
          partner_status:
            ev.format !== "doubles"
              ? "solo"
              : inboundInviteId
                ? "solo"
                : "pending",
        })
        .select()
        .single();
      if (myRegErr) {
        setError(
          myRegErr.message ?? `Failed to register you for "${ev.name}".`,
        );
        setPhase("form");
        return;
      }
      registeredEventNames.push(ev.name);

      if (ev.format !== "doubles") continue;

      // ─── Doubles branch: either auto-pair (inbound) or send a
      //     new outbound invite.
      if (inboundInviteId && resolvedPartner) {
        const { error: acceptErr } = await supabase.rpc(
          "accept_partner_invite",
          { p_invite_id: inboundInviteId },
        );
        if (acceptErr) {
          // Don't block the whole submit — the user is registered,
          // just not yet linked. Surface the error and fall back to
          // sending a new outbound invite anyway.
          // eslint-disable-next-line no-console
          console.warn("auto-pair failed, falling back", acceptErr);
        } else {
          autoPairs.push({
            eventName: ev.name,
            partnerName: `${resolvedPartner.first_name} ${resolvedPartner.last_name}`,
          });
          continue;
        }
      }

      // ─── Outbound invite (standard flow).
      if (!partnerEmail || !resolvedPartner) {
        setError(`No email on file for partner in "${ev.name}".`);
        setPhase("form");
        return;
      }
      const { data: invite, error: invErr } = await supabase
        .from("partner_invites")
        .insert({
          event_id: ev.id,
          inviter_player_id: me.id,
          invitee_player_id: resolvedPartner.id,
          invitee_email: partnerEmail,
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

      let emailSent = false;
      let emailError: string | undefined;
      try {
        const { error: sendErr } = await supabase.functions.invoke(
          "send-partner-invite",
          {
            body: {
              inviteId: invite.id,
              baseUrl: window.location.origin,
            },
          },
        );
        if (sendErr) emailError = sendErr.message;
        else emailSent = true;
      } catch (e) {
        emailError = e instanceof Error ? e.message : String(e);
      }

      partnerInvites.push({
        eventName: ev.name,
        partnerEmail,
        url,
        emailSent,
        emailError,
      });
    }

    setDoneResult({ registeredEventNames, partnerInvites, autoPairs });
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

        {doneResult.autoPairs.length > 0 && (
          <section style={{ marginBottom: 24 }}>
            <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>
              Auto-paired
            </h2>
            <p style={{ margin: "0 0 12px", color: "#666", fontSize: 13 }}>
              These partners had already invited you, so picking them
              here counted as accepting their invite. Both registrations
              are now linked — no extra email needed.
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              {doneResult.autoPairs.map((p, i) => (
                <li key={i} style={{ marginBottom: 4 }}>
                  <strong>{p.eventName}</strong> with{" "}
                  <strong>{p.partnerName}</strong>
                </li>
              ))}
            </ul>
          </section>
        )}

        {doneResult.partnerInvites.length > 0 && (
          <section style={{ marginBottom: 24 }}>
            <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>
              Partner invite{doneResult.partnerInvites.length === 1 ? "" : "s"}
            </h2>
            <p style={{ margin: "0 0 12px", color: "#666", fontSize: 13 }}>
              {doneResult.partnerInvites.every((i) => i.emailSent)
                ? "We emailed your partner(s) a confirmation link. You can also share the link directly:"
                : "Heads up — some invite emails didn't go out (details below). The links still work if you copy them yourself."}
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
        {me?.first_name ? (
          <>
            Welcome back, <strong>{me.first_name}</strong>.{" "}
          </>
        ) : (
          <>Welcome back.{" "}</>
        )}
        <Link
          to={`/profile?return=${encodeURIComponent(`/t/${orgSlug}/${tournamentSlug}/register`)}`}
          style={{
            color: "#2563eb",
            textDecoration: "none",
            fontSize: 12,
          }}
        >
          Edit profile
        </Link>
      </p>

      <form onSubmit={onSubmit}>
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
                    // Stop the user from picking themselves as their
                    // own partner. The picker excludes these ids
                    // from its search results.
                    excludePlayerIds={me ? [me.id] : []}
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
  excludePlayerIds,
}: {
  event: Event;
  selection: EventSelection;
  alreadyRegistered: boolean;
  disabled: boolean;
  onChange: (patch: Partial<EventSelection>) => void;
  excludePlayerIds: string[];
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
            // Picker dropdown opens on focus; clicking it shouldn't
            // toggle the wrapping label's checkbox.
            onClick={(e) => e.preventDefault()}
          >
            <div style={{ fontSize: 12, color: "#666" }}>
              Your doubles partner. Search by name, email, or phone —
              if they're not in the list yet, "Add new" to invite them.
              They'll get an invite link to confirm.
            </div>
            <PartnerSearch
              selection={selection.partner}
              onChange={(p) => onChange({ partner: p })}
              excludePlayerIds={excludePlayerIds}
            />
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
  emailSent,
  emailError,
}: {
  eventName: string;
  partnerEmail: string;
  url: string;
  emailSent: boolean;
  emailError?: string;
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
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 500 }}>{eventName}</div>
        {emailSent ? (
          <span
            style={{
              padding: "1px 8px",
              background: "#dcfce7",
              color: "#166534",
              borderRadius: 3,
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.3,
            }}
          >
            Emailed
          </span>
        ) : (
          <span
            title={emailError ?? undefined}
            style={{
              padding: "1px 8px",
              background: "#fffbeb",
              color: "#92400e",
              borderRadius: 3,
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.3,
            }}
          >
            Email failed
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
        Invite for <strong>{partnerEmail}</strong>
      </div>
      {emailError && (
        <div
          style={{
            fontSize: 11,
            color: "#92400e",
            marginTop: 4,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          {emailError}
        </div>
      )}
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

