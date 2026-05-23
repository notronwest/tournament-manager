import {
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
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

// Per-event snapshot of what the user is *currently* registered for —
// loaded once on mount, then compared against the live selections
// state on every render to compute the diff (added / withdrawn /
// unchanged). regId is the user's own event_registrations.id so we
// can soft-delete it on withdraw. partnerLabel renders as
// "Partnered with X" or "Waiting for X" — pure display, not used
// for partner editing (that lives in commit C).
type ExistingReg = {
  regId: string;
  partnerStatus: Database["public"]["Enums"]["partner_status"];
  partnerLabel: string | null;
};

// Change classification for an event, computed from existingRegs +
// selections. "unchanged" means the user's pick matches what's in
// the DB; the other two are the only things we actually write.
type ChangeType = "unchanged" | "added" | "withdrawn";

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
  // Optional ?event=<id> query param. Set when the user arrived here
  // by clicking the per-event "Register" button on the public
  // tournament page — we pre-check that event so they don't have to
  // pick it a second time after picking it on the previous screen.
  const [searchParams] = useSearchParams();
  const preselectEventId = searchParams.get("event");

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  // Profile is guaranteed to exist (RequireProfile wraps this route).
  // We load it for two reasons: we need the player id to insert
  // registrations and to populate excludePlayerIds on the partner
  // picker so the user can't pick themselves.
  const [me, setMe] = useState<Player | null>(null);
  // Track which events the user is already registered for, keyed by
  // event_id. Used to (a) pre-check those events in the selections
  // map, (b) avoid double-registering them, (c) compute the diff
  // against the live form state, and (d) soft-delete the right
  // event_registration row on withdraw.
  const [existingRegs, setExistingRegs] = useState<Map<string, ExistingReg>>(
    new Map(),
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
    withdrawnEventNames: string[];
    partnerInvites: {
      eventName: string;
      partnerEmail: string;
      url: string;
      // Three mutually-exclusive states. emailSent=true means
      // Resend accepted the send. emailSkipped=true means we never
      // tried because the address is obviously fake (test accounts
      // etc.). Both false + emailError set means we tried and the
      // edge function rejected. Only one of sent/skipped is true at
      // a time.
      emailSent: boolean;
      emailSkipped: boolean;
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

      // 4. The user's existing registrations for events in this
      //    tournament, plus their outbound pending invites (for the
      //    "Waiting for X" partner label when no partner reg exists
      //    yet). Two reads in parallel.
      const existingMap = new Map<string, ExistingReg>();
      if (evs && evs.length > 0) {
        const eventIds = evs.map((e) => e.id);
        const [regsRes, outboundRes] = await Promise.all([
          supabase
            .from("event_registrations")
            .select(
              `id, event_id, partner_status,
               partner_registration:event_registrations!partner_registration_id (
                 player:players!player_id (first_name, last_name)
               )`,
            )
            .eq("player_id", myPlayer.id)
            .in("event_id", eventIds)
            .is("deleted_at", null),
          supabase
            .from("partner_invites")
            .select(
              `event_id, invitee_email,
               invitee:players!invitee_player_id (first_name, last_name)`,
            )
            .eq("inviter_player_id", myPlayer.id)
            .eq("status", "pending")
            .in("event_id", eventIds),
        ]);
        if (cancelled) return;

        type RegRow = {
          id: string;
          event_id: string;
          partner_status: Database["public"]["Enums"]["partner_status"];
          partner_registration:
            | { player: { first_name: string; last_name: string } | null }
            | null;
        };
        type OutboundRow = {
          event_id: string;
          invitee_email: string | null;
          invitee: { first_name: string; last_name: string } | null;
        };

        for (const r of (regsRes.data ?? []) as unknown as RegRow[]) {
          const partner = r.partner_registration?.player;
          existingMap.set(r.event_id, {
            regId: r.id,
            partnerStatus: r.partner_status,
            partnerLabel: partner
              ? `${partner.first_name} ${partner.last_name}`
              : null,
          });
        }
        // Fill in partner labels for pending outbound invites where
        // no partner_registration is linked yet (the invitee hasn't
        // accepted, so they don't have their own reg).
        for (const inv of (outboundRes.data ?? []) as unknown as OutboundRow[]) {
          const cur = existingMap.get(inv.event_id);
          const label = inv.invitee
            ? `${inv.invitee.first_name} ${inv.invitee.last_name}`
            : inv.invitee_email ?? null;
          if (cur && !cur.partnerLabel) {
            existingMap.set(inv.event_id, { ...cur, partnerLabel: label });
          }
        }
        setExistingRegs(existingMap);
      } else {
        setExistingRegs(new Map());
      }

      // 5. Initialize selections. Pre-check any event the user is
      //    already registered for so the diff against the form's
      //    live state stays accurate. If the user arrived via the
      //    per-event Register button on the public page, the
      //    ?event=<id> query param also pre-checks that one (or
      //    leaves it on if they were already registered).
      const sel = new Map<string, EventSelection>();
      for (const e of evs ?? []) {
        sel.set(e.id, {
          selected:
            existingMap.has(e.id) || preselectEventId === e.id,
          partner: emptySelection,
        });
      }
      setSelections(sel);

      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // preselectEventId is in deps so a direct-link to a different
    // ?event= value re-initializes the checkbox. The full refetch is
    // wasteful but keeps the init logic in one place.
  }, [orgSlug, tournamentSlug, user, preselectEventId]);

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

  // Per-event change classification. Computed each render from
  // existingRegs vs selections. Drives the diff summary, the Confirm
  // button's enabled state + count, and the submit handler's
  // add/withdraw branches. We deliberately don't track partner
  // changes here — that's commit C (with its email side effects);
  // for now, the partner editor is hidden on existing regs.
  const changeFor = (eventId: string): ChangeType => {
    const wasRegistered = existingRegs.has(eventId);
    const isSelected = selections.get(eventId)?.selected ?? false;
    if (wasRegistered && !isSelected) return "withdrawn";
    if (!wasRegistered && isSelected) return "added";
    return "unchanged";
  };
  const addedEvents = events.filter((ev) => changeFor(ev.id) === "added");
  const withdrawnEvents = events.filter(
    (ev) => changeFor(ev.id) === "withdrawn",
  );
  const changeCount = addedEvents.length + withdrawnEvents.length;
  const hasChanges = changeCount > 0;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !me) return;
    setError(null);

    if (!hasChanges) {
      // Button is disabled in this state but the user could still
      // hit Enter on a focused checkbox — bail out cleanly.
      return;
    }
    // Validate partner selection for NEWLY-added doubles events.
    // Existing doubles regs aren't validated here because their
    // partner editor is hidden in B; partner changes are commit C.
    for (const ev of addedEvents) {
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
    const withdrawnEventNames: string[] = [];
    const partnerInvites: {
      eventName: string;
      partnerEmail: string;
      url: string;
      emailSent: boolean;
      emailSkipped: boolean;
      emailError?: string;
    }[] = [];
    const autoPairs: { eventName: string; partnerName: string }[] = [];

    // ─── Process withdrawals first. Soft-delete the user's reg and
    //     cancel any pending outbound partner_invites for that event
    //     so the would-be partner doesn't keep seeing an invite from
    //     someone who's no longer registered. (Confirmed partners
    //     get notified in commit C; for now they silently become
    //     solo and can pick a new partner from the tournament page.)
    for (const ev of withdrawnEvents) {
      const existing = existingRegs.get(ev.id);
      if (!existing) continue; // defensive
      const { error: delErr } = await supabase
        .from("event_registrations")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", existing.regId);
      if (delErr) {
        setError(
          `Failed to withdraw from "${ev.name}": ${delErr.message}`,
        );
        setPhase("form");
        return;
      }
      await supabase
        .from("partner_invites")
        .update({ status: "cancelled" })
        .eq("event_id", ev.id)
        .eq("inviter_player_id", me.id)
        .eq("status", "pending");
      withdrawnEventNames.push(ev.name);
    }

    for (const ev of addedEvents) {
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
      let emailSkipped = false;
      let emailError: string | undefined;
      if (isObviouslyFakeEmail(partnerEmail)) {
        // Test accounts (test.player.N@example.test, foo@example.com,
        // etc.) — sending real email is doomed. Skip the invoke and
        // surface the link prominently so the tester can copy it.
        emailSkipped = true;
      } else {
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
      }

      partnerInvites.push({
        eventName: ev.name,
        partnerEmail,
        url,
        emailSent,
        emailSkipped,
        emailError,
      });
    }

    setDoneResult({
      registeredEventNames,
      withdrawnEventNames,
      partnerInvites,
      autoPairs,
    });
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
    const addedCount = doneResult.registeredEventNames.length;
    const withdrewCount = doneResult.withdrawnEventNames.length;
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
            {addedCount > 0 && withdrewCount > 0
              ? "Your registration is updated"
              : withdrewCount > 0
                ? "Withdrawn"
                : "You're registered!"}
          </h1>
          {addedCount > 0 && (
            <p style={{ margin: 0, color: "#166534", fontSize: 14 }}>
              Confirmed for {fmtList(doneResult.registeredEventNames)} in{" "}
              <strong>{tournament.name}</strong>.
            </p>
          )}
          {withdrewCount > 0 && (
            <p
              style={{
                margin: addedCount > 0 ? "8px 0 0" : "0",
                color: "#166534",
                fontSize: 14,
              }}
            >
              Withdrawn from {fmtList(doneResult.withdrawnEventNames)}.
            </p>
          )}
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
              {(() => {
                const all = doneResult.partnerInvites;
                const allSent = all.every((i) => i.emailSent);
                const allSkipped = all.every((i) => i.emailSkipped);
                const someFailed = all.some(
                  (i) => !i.emailSent && !i.emailSkipped,
                );
                if (allSent) {
                  return "We emailed your partner(s) a confirmation link. You can also share the link directly:";
                }
                if (allSkipped) {
                  return "These invites went to test addresses — we didn't actually send the emails. Copy the links below to accept the invites yourself.";
                }
                if (someFailed) {
                  return "Heads up — some invite emails didn't go out (details below). The links still work if you copy them yourself.";
                }
                // Mix of sent + skipped, no failures.
                return "Some invites were emailed and some went to test addresses (links below).";
              })()}
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
              // Re-fetch from scratch so existingRegs reflects what
              // we just inserted / withdrew.
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
        {/* Change summary — only renders when there's an actual diff
            against what's stored. Gives the user a clear "you're
            about to do this" preview before they hit Confirm. */}
        {hasChanges && (
          <ChangeSummary
            added={addedEvents}
            withdrawn={withdrawnEvents}
          />
        )}

        <Section title="Pick your events">
          {events.length === 0 ? (
            <Empty>No events available for registration.</Empty>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {events.map((ev) => {
                const sel = selections.get(ev.id)!;
                const existing = existingRegs.get(ev.id);
                return (
                  <EventRow
                    key={ev.id}
                    event={ev}
                    selection={sel}
                    existing={existing}
                    change={changeFor(ev.id)}
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
          disabled={submitting || !hasChanges}
          style={{
            padding: "12px 24px",
            background: submitting || !hasChanges ? "#9ca3af" : "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontSize: 15,
            fontWeight: 500,
            cursor:
              submitting || !hasChanges ? "not-allowed" : "pointer",
            fontFamily: "inherit",
          }}
        >
          {submitting
            ? "Saving…"
            : !hasChanges
              ? existingRegs.size > 0
                ? "No changes to save"
                : "Pick at least one event"
              : changeCount === 1
                ? "Confirm 1 change"
                : `Confirm ${changeCount} changes`}
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
  existing,
  change,
  disabled,
  onChange,
  excludePlayerIds,
}: {
  event: Event;
  selection: EventSelection;
  existing: ExistingReg | undefined;
  change: ChangeType;
  disabled: boolean;
  onChange: (patch: Partial<EventSelection>) => void;
  excludePlayerIds: string[];
}) {
  const chips = eligibilityChips(event);

  // Visual treatment derived from existing-reg + diff state.
  // "added"    → blue border, "Will register" pill
  // "withdrawn"→ red border + tint, "Will withdraw" pill + warning
  // "unchanged" + existing → green tint, "Registered" pill
  // "unchanged" + new      → plain (default)
  const isExistingChecked = !!existing && change === "unchanged";
  const isWillWithdraw = change === "withdrawn";
  const isWillAdd = change === "added";

  const borderColor = isWillWithdraw
    ? "#fca5a5"
    : isWillAdd
      ? "#2563eb"
      : isExistingChecked
        ? "#bbf7d0"
        : selection.selected
          ? "#2563eb"
          : "#e5e7eb";
  const bg = isWillWithdraw
    ? "#fef2f2"
    : isExistingChecked
      ? "#f0fdf4"
      : "#fff";

  // Doubles partner editor only renders for NEWLY-added events.
  // Existing doubles regs show a read-only "Partnered with X" line
  // instead — changing partners is commit C (with its email
  // side-effects).
  const showPartnerEditor =
    event.format === "doubles" && selection.selected && !existing;

  return (
    <label
      style={{
        display: "block",
        padding: 12,
        background: bg,
        border: `1px solid ${borderColor}`,
        borderRadius: 6,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <input
          type="checkbox"
          checked={selection.selected}
          disabled={disabled}
          onChange={(e) => onChange({ selected: e.target.checked })}
          style={{ marginTop: 3 }}
        />
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontWeight: 500,
              fontSize: 14,
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            {event.name}
            {isExistingChecked && <Pill bg="#dcfce7" fg="#166534">Registered</Pill>}
            {isWillAdd && <Pill bg="#dbeafe" fg="#1e40af">Will register</Pill>}
            {isWillWithdraw && (
              <Pill bg="#fee2e2" fg="#991b1b">Will withdraw</Pill>
            )}
          </div>
          {/* Partner display for existing doubles regs — read-only in
              B. Goes editable in C. */}
          {existing &&
            event.format === "doubles" &&
            existing.partnerLabel && (
              <div
                style={{
                  fontSize: 12,
                  color: isWillWithdraw ? "#991b1b" : "#166534",
                  marginTop: 4,
                }}
              >
                {existing.partnerStatus === "pending"
                  ? "Waiting for "
                  : "Partnered with "}
                <strong>{existing.partnerLabel}</strong>
              </div>
            )}
          {isWillWithdraw && (
            <div
              style={{
                fontSize: 12,
                color: "#991b1b",
                marginTop: 4,
                lineHeight: 1.5,
              }}
            >
              You'll be removed from this event.{" "}
              {existing?.partnerLabel
                ? `${existing.partnerLabel} won't be your partner anymore. `
                : ""}
              Re-check the box to keep your registration.
            </div>
          )}
          <div style={{ color: "#666", fontSize: 12, marginTop: 4 }}>
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
      {showPartnerEditor && (
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

// Small pill used in event rows. Same shape as the Badge helper used
// on the done-screen partner invite cards but with a different
// signature (no title, fewer text overrides) so we don't accidentally
// couple the two visual elements.
function Pill({
  bg,
  fg,
  children,
}: {
  bg: string;
  fg: string;
  children: ReactNode;
}) {
  return (
    <span
      style={{
        padding: "1px 8px",
        background: bg,
        color: fg,
        borderRadius: 3,
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.3,
      }}
    >
      {children}
    </span>
  );
}

// Top-of-form summary that surfaces exactly what the Confirm button
// will do. Only rendered when there's actually a diff against the
// stored state — keeps the form clean for first-time registrants.
function ChangeSummary({
  added,
  withdrawn,
}: {
  added: Event[];
  withdrawn: Event[];
}) {
  return (
    <div
      style={{
        padding: 14,
        background: "#fef3c7",
        border: "1px solid #fde68a",
        borderRadius: 8,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "#7a5d00",
          marginBottom: 8,
        }}
      >
        Pending changes
      </div>
      <ul
        style={{
          margin: 0,
          paddingLeft: 18,
          fontSize: 13,
          color: "#7a5d00",
          lineHeight: 1.7,
        }}
      >
        {added.map((ev) => (
          <li key={`a-${ev.id}`}>
            <strong>Register</strong> for {ev.name}
          </li>
        ))}
        {withdrawn.map((ev) => (
          <li key={`w-${ev.id}`}>
            <strong>Withdraw</strong> from {ev.name}
          </li>
        ))}
      </ul>
    </div>
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
  emailSkipped,
  emailError,
}: {
  eventName: string;
  partnerEmail: string;
  url: string;
  emailSent: boolean;
  emailSkipped: boolean;
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
          <Badge bg="#dcfce7" fg="#166534">
            Emailed
          </Badge>
        ) : emailSkipped ? (
          <Badge
            bg="#eff6ff"
            fg="#1e40af"
            title="Address looks like a test account — we didn't try to send."
          >
            Test account
          </Badge>
        ) : (
          <Badge bg="#fffbeb" fg="#92400e" title={emailError ?? undefined}>
            Email failed
          </Badge>
        )}
      </div>
      <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
        Invite for <strong>{partnerEmail}</strong>
      </div>
      {emailSkipped && (
        <div
          style={{
            fontSize: 11,
            color: "#1e40af",
            marginTop: 4,
          }}
        >
          This looks like a test address — copy the link below to
          accept it manually.
        </div>
      )}
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

// Detect addresses that can't possibly receive real email. We skip
// the send for these — Resend just rejects them with a 422 anyway,
// which surfaces in the UI as a scary "Email failed" badge.
// Covers:
//   * the seeded test players (test.player.N@example.test)
//   * any .test TLD (RFC 2606 — reserved for testing, no real DNS)
//   * the example.{com,net,org} domains (RFC 2606 — reserved for
//     documentation/examples)
function isObviouslyFakeEmail(email: string | null): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (e.endsWith(".test")) return true;
  if (
    e.endsWith("@example.com") ||
    e.endsWith("@example.net") ||
    e.endsWith("@example.org")
  ) {
    return true;
  }
  return false;
}

// Small status pill, shared across the three invite states
// (Emailed / Test account / Email failed).
function Badge({
  bg,
  fg,
  title,
  children,
}: {
  bg: string;
  fg: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      style={{
        padding: "1px 8px",
        background: bg,
        color: fg,
        borderRadius: 3,
        fontSize: 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.3,
      }}
    >
      {children}
    </span>
  );
}

