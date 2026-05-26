import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import {
  emptySelection,
  persistPlayerSelection,
  type PlayerSelection,
} from "../../components/PlayerPicker";
import { PartnerSearch } from "../../components/PartnerSearch";
import { usePendingPayments } from "../../components/PendingPaymentsContext";
import { eligibilityChips } from "../../lib/eligibility";
import { formatUsd, priceTiers } from "../../lib/pricing";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];
type Player = Database["public"]["Tables"]["players"]["Row"];

// Per-event registration status for the currently signed-in user.
// Only computed when the user is logged in; for anon visitors the
// map is empty and event cards render the normal "Register" CTA.
type MyRegStatus = {
  // 'paid'             → my event_registrations row has status='paid'.
  //                     For singles or doubles-with-confirmed-partner,
  //                     this is the "registered and done" state.
  // 'pending_payment'  → my reg has status='pending_payment'. I
  //                     registered but haven't paid yet (new
  //                     register-then-checkout flow). Card shows
  //                     amber tint + a Cancel option.
  // 'awaiting_partner' → my reg is paid but partner hasn't accepted
  //                     yet (partner_status='pending'). Rare under
  //                     the new flow but possible during transition.
  // 'invited'          → no reg on my side; someone else invited me
  //                     to be their partner. inviteToken set.
  state:
    | "paid"
    | "pending_payment"
    | "awaiting_partner"
    | "invited";
  // The id of my event_registrations row — null only for 'invited'.
  // Used by Cancel-pending to know which row to soft-delete.
  regId: string | null;
  partnerLabel: string | null;
  inviteToken: string | null;
  inviterName: string | null;
  // F1: true when partner_status='seeking' on my reg — I'm
  // registered but explicitly looking for a partner. Rendered as
  // a secondary "Looking for a partner" badge alongside the
  // state pill so the user sees both bits of info.
  isSeekingPartner: boolean;
};

// Top-of-page banner content for a pending inbound invite.
type InboundInvite = {
  eventId: string;
  eventName: string;
  inviterName: string;
  token: string;
};

// Public tournament page at /t/:orgSlug/:tournamentSlug. Anonymous-
// readable thanks to existing RLS: tournaments + events with status
// in ('published', 'closed', 'completed') are readable by anyone.
// Draft tournaments are invisible here; the only way to reach a
// draft is through the admin UI.
//
// This page is intentionally read-only — the Register CTA links to
// /t/:orgSlug/:tournamentSlug/register which is auth-gated (built
// in the next commit on this branch).
export default function PublicTournamentPage() {
  const { orgSlug, tournamentSlug } = useParams<{
    orgSlug: string;
    tournamentSlug: string;
  }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  // Used to refresh the global PendingPaymentsBar after we mutate
  // event_registrations from this page (inline register / cancel).
  const { refresh: refreshPending } = usePendingPayments();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The signed-in user's player record. Needed for the inline
  // register/cancel actions (we insert event_registrations.player_id
  // from this). Null when nobody's signed in OR when the user
  // hasn't set up a profile yet — RequireProfile handles that case
  // when they navigate to anything write-capable.
  const [me, setMe] = useState<Player | null>(null);
  // Per-event registration status for the signed-in user, keyed by
  // event_id. Empty when nobody's signed in.
  const [myStatus, setMyStatus] = useState<Map<string, MyRegStatus>>(
    new Map(),
  );
  // Pending invites where the signed-in user is the invitee. We
  // render these as a banner at the top so a player who got picked
  // sees the invite the moment they hit the tournament page.
  const [inboundInvites, setInboundInvites] = useState<InboundInvite[]>([]);
  // F3: set of player_ids already registered (paid or pending) per
  // event, keyed by event_id. We pass these into PartnerSearch's
  // excludePlayerIds so a search never returns someone who's
  // already in the event — they can't accept the invite anyway,
  // and the invitee would see a confusing "you've been invited"
  // banner for an event they're already in.
  const [registeredByEvent, setRegisteredByEvent] = useState<
    Map<string, Set<string>>
  >(new Map());

  // Single source of truth for the page's data. Wrapped in a
  // useCallback + invoked by the useEffect on mount and by the
  // inline register/cancel handlers after a write, so the UI stays
  // in sync without a full page reload.
  const reload = useCallback(async () => {
    if (!orgSlug || !tournamentSlug) return;
    setError(null);

    // Fetch org → tournament → events. Anon-keyed Supabase client
    // hits the same RLS as a logged-in non-member: published-only.
    const { data: org, error: orgErr } = await supabase
      .from("organizations")
      .select("id, name, slug")
      .eq("slug", orgSlug)
      .is("deleted_at", null)
      .maybeSingle();
    if (orgErr) {
      setError(orgErr.message);
      setLoading(false);
      return;
    }
    if (!org) {
      setError("Organization not found.");
      setLoading(false);
      return;
    }

    const { data: t, error: tErr } = await supabase
      .from("tournaments")
      .select("*")
      .eq("organization_id", org.id)
      .eq("slug", tournamentSlug)
      .in("status", ["published", "closed", "completed"])
      .is("deleted_at", null)
      .maybeSingle();
    if (tErr) {
      setError(tErr.message);
      setLoading(false);
      return;
    }
    if (!t) {
      setError("Tournament not found or not yet published.");
      setLoading(false);
      return;
    }
    setTournament(t);

    const { data: evs, error: evErr } = await supabase
      .from("events")
      .select("*")
      .eq("tournament_id", t.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: true });
    if (evErr) {
      setError(evErr.message);
      setLoading(false);
      return;
    }
    setEvents(evs ?? []);

    // F3: pull the set of already-registered player_ids for every
    // event in this tournament. Goes through a SECURITY DEFINER RPC
    // because event_registrations RLS blocks anon / non-org-member
    // SELECTs of other players' rows. The RPC returns only ids —
    // no PII — and lets the partner picker exclude them from
    // results. Done in parallel with the auth + me load below.
    if (evs && evs.length > 0) {
      const { data: regsByEvent } = await supabase.rpc(
        "players_registered_for_events",
        { p_event_ids: evs.map((e) => e.id) },
      );
      const grouped = new Map<string, Set<string>>();
      for (const row of regsByEvent ?? []) {
        let set = grouped.get(row.event_id);
        if (!set) {
          set = new Set<string>();
          grouped.set(row.event_id, set);
        }
        set.add(row.player_id);
      }
      setRegisteredByEvent(grouped);
    } else {
      setRegisteredByEvent(new Map());
    }

    if (!user || !evs || evs.length === 0) {
      // Anon visitor — clear any stale state from a previous session.
      setMe(null);
      setMyStatus(new Map());
      setInboundInvites([]);
      setLoading(false);
      return;
    }

    // Pull the user's player row (full record — needed by the
    // inline-register handlers). May not exist yet for fresh
    // signups; the inline Register button will route them through
    // RequireProfile if so.
    const { data: myPlayer } = await supabase
      .from("players")
      .select("*")
      .eq("auth_user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();
    setMe(myPlayer ?? null);

    if (!myPlayer) {
      setMyStatus(new Map());
      setInboundInvites([]);
      setLoading(false);
      return;
    }

    const eventIds = evs.map((e) => e.id);
    // Three reads in parallel:
    //  * my non-deleted registrations (any status) with partner-reg
    //    join — drives "paid" / "pending_payment" / "awaiting_partner"
    //  * my OUTBOUND pending invites (I picked someone, awaiting them)
    //    — fills in partner labels when no partner_registration link yet
    //  * my INBOUND pending invites — surfaces as banner + per-card pill
    const [regsRes, outboundRes, inboundRes] = await Promise.all([
      supabase
        .from("event_registrations")
        .select(
          `id, event_id, status, partner_status,
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
      supabase
        .from("partner_invites")
        .select(
          `event_id, token,
           inviter:players!inviter_player_id (first_name, last_name)`,
        )
        .eq("invitee_player_id", myPlayer.id)
        .eq("status", "pending")
        .in("event_id", eventIds),
    ]);

    const map = new Map<string, MyRegStatus>();
    type RegRow = {
      id: string;
      event_id: string;
      status: Database["public"]["Enums"]["registration_status"];
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
    type InboundRow = {
      event_id: string;
      token: string;
      inviter: { first_name: string; last_name: string } | null;
    };

    for (const r of (regsRes.data ?? []) as unknown as RegRow[]) {
      const partner = r.partner_registration?.player;
      const partnerLabel = partner
        ? `${partner.first_name} ${partner.last_name}`
        : null;
      // Derive the per-card state from the reg's payment + partner
      // status. pending_payment wins over partner_status (haven't
      // committed yet); for paid regs the partner_status splits
      // "paid" vs "awaiting_partner".
      let state: MyRegStatus["state"];
      if (r.status === "pending_payment") {
        state = "pending_payment";
      } else if (r.partner_status === "pending") {
        state = "awaiting_partner";
      } else {
        state = "paid";
      }
      map.set(r.event_id, {
        state,
        regId: r.id,
        partnerLabel,
        inviteToken: null,
        inviterName: null,
        isSeekingPartner: r.partner_status === "seeking",
      });
    }
    // Outbound invites: fill in invitee names for pending state
    // where we didn't already have a partnerLabel from the reg join.
    for (const inv of (outboundRes.data ?? []) as unknown as OutboundRow[]) {
      const cur = map.get(inv.event_id);
      const label = inv.invitee
        ? `${inv.invitee.first_name} ${inv.invitee.last_name}`
        : inv.invitee_email ?? null;
      if (cur && !cur.partnerLabel) {
        map.set(inv.event_id, { ...cur, partnerLabel: label });
      }
    }
    // Inbound invites: any event I was picked for and haven't
    // accepted/declined yet. Overrides the per-card status so the
    // invite pill is the obvious thing to act on.
    const inbound: InboundInvite[] = [];
    for (const inv of (inboundRes.data ?? []) as unknown as InboundRow[]) {
      const inviterName = inv.inviter
        ? `${inv.inviter.first_name} ${inv.inviter.last_name}`
        : "Someone";
      const ev = evs.find((e) => e.id === inv.event_id);
      if (ev) {
        inbound.push({
          eventId: inv.event_id,
          eventName: ev.name,
          inviterName,
          token: inv.token,
        });
      }
      const cur = map.get(inv.event_id);
      map.set(inv.event_id, {
        state: "invited",
        regId: cur?.regId ?? null,
        partnerLabel: cur?.partnerLabel ?? null,
        inviteToken: inv.token,
        inviterName,
        isSeekingPartner: cur?.isSeekingPartner ?? false,
      });
    }
    setMyStatus(map);
    setInboundInvites(inbound);
    setLoading(false);
  }, [orgSlug, tournamentSlug, user]);

  useEffect(() => {
    setLoading(true);
    void reload();
    // eslint-disable-next-line react-hooks/set-state-in-effect
  }, [reload]);

  if (loading) {
    return (
      <Shell>
        <p style={{ color: "#666", fontSize: 14 }}>Loading…</p>
      </Shell>
    );
  }
  if (error || !tournament) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 8px", fontSize: 22 }}>Not available</h1>
        <p style={{ color: "#666", fontSize: 14, margin: 0 }}>
          {error ?? "Tournament not found."}
        </p>
      </Shell>
    );
  }

  const registrationOpen =
    tournament.status === "published" &&
    (!tournament.registration_closes_at ||
      new Date(tournament.registration_closes_at) > new Date()) &&
    (!tournament.registration_opens_at ||
      new Date(tournament.registration_opens_at) <= new Date());

  return (
    <Shell>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 26 }}>{tournament.name}</h1>
        {tournament.description && (
          <p
            style={{
              color: "#444",
              margin: "8px 0 0",
              fontSize: 15,
              lineHeight: 1.5,
            }}
          >
            {tournament.description}
          </p>
        )}
        <div
          style={{
            display: "flex",
            gap: 16,
            marginTop: 16,
            flexWrap: "wrap",
            fontSize: 14,
            color: "#444",
          }}
        >
          <Meta
            label="When"
            value={`${fmtDate(tournament.starts_at)} – ${fmtDate(tournament.ends_at)}`}
          />
          {tournament.location_name && (
            <Meta
              label="Where"
              value={
                tournament.location_address
                  ? `${tournament.location_name} · ${tournament.location_address}`
                  : tournament.location_name
              }
            />
          )}
          {tournament.entry_fee_cents > 0 && (
            <Meta
              label="Entry fee"
              value={
                // Two-tier label when the additional-event fee
                // differs from the first-event fee. Otherwise a
                // single price is clearer than spelling out the
                // tiers redundantly.
                tournament.additional_event_fee_cents !==
                tournament.entry_fee_cents
                  ? `$${(tournament.entry_fee_cents / 100).toFixed(2)} first event · $${(tournament.additional_event_fee_cents / 100).toFixed(2)} additional`
                  : `$${(tournament.entry_fee_cents / 100).toFixed(2)} per event`
              }
            />
          )}
          <Meta
            label="Status"
            value={capitalize(tournament.status)}
          />
        </div>
      </header>

      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          padding: 16,
          background: registrationOpen ? "#eff6ff" : "#fafafa",
          border: `1px solid ${registrationOpen ? "#bfdbfe" : "#e5e7eb"}`,
          borderRadius: 8,
          marginBottom: 24,
        }}
      >
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: registrationOpen ? "#1e40af" : "#666",
            }}
          >
            {registrationOpen
              ? "Registration is open"
              : tournament.status === "published" &&
                  tournament.registration_opens_at &&
                  new Date(tournament.registration_opens_at) > new Date()
                ? `Registration opens ${fmtDateTime(tournament.registration_opens_at)}`
                : "Registration is closed"}
          </div>
          {tournament.registration_closes_at && registrationOpen && (
            <div style={{ fontSize: 12, color: "#1e40af", marginTop: 2 }}>
              Closes {fmtDateTime(tournament.registration_closes_at)}
            </div>
          )}
        </div>
        {/* No global Register button here on purpose — the per-event
            Register buttons on each card below let the user pick what
            they're registering for first, instead of registering and
            then picking. */}
      </div>

      {/* Pending-invite banner — the most actionable thing on the
          page for a player who just got picked, so it lives above
          the events list. One row per inbound invite; each row has
          its own Accept button that drops the user on the existing
          partner-accept page. */}
      {inboundInvites.length > 0 && (
        <section
          style={{
            padding: 16,
            background: "#fef3c7",
            border: "1px solid #fde68a",
            borderRadius: 8,
            marginBottom: 24,
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
            You've been invited to be someone's partner
            {inboundInvites.length > 1 ? ` (${inboundInvites.length})` : ""}
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {inboundInvites.map((inv) => (
              <div
                key={inv.token}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: 10,
                  background: "#fff",
                  borderRadius: 6,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ fontSize: 13, color: "#444" }}>
                  <strong>{inv.inviterName}</strong> invited you for{" "}
                  <strong>{inv.eventName}</strong>
                </div>
                <Link
                  to={`/t/${orgSlug}/${tournamentSlug}/invites/${inv.token}`}
                  style={{
                    padding: "6px 14px",
                    background: "#2563eb",
                    color: "#fff",
                    textDecoration: "none",
                    borderRadius: 6,
                    fontSize: 13,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  Review invite →
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>
          Events ({events.length})
        </h2>
        {events.length === 0 ? (
          <Empty>No events have been added yet.</Empty>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {events.map((ev) => (
              <EventCard
                key={ev.id}
                event={ev}
                tournament={tournament}
                registrationOpen={registrationOpen}
                orgSlug={orgSlug ?? ""}
                tournamentSlug={tournamentSlug ?? ""}
                myStatus={myStatus.get(ev.id)}
                me={me}
                user={user}
                alreadyRegisteredPlayerIds={
                  registeredByEvent.get(ev.id) ?? new Set()
                }
                onChanged={async () => {
                  // Refetch both the page's local state AND the
                  // site-wide pending bar — they read different
                  // slices of the same rows.
                  await Promise.all([reload(), refreshPending()]);
                }}
                onNeedsAuth={() => {
                  // Anon visitor or no profile yet → bounce through
                  // login + profile, then come back here.
                  navigate("/login", {
                    state: { from: { pathname: `/t/${orgSlug}/${tournamentSlug}` } },
                  });
                }}
              />
            ))}
          </div>
        )}
      </section>
    </Shell>
  );
}

function EventCard({
  event,
  tournament,
  registrationOpen,
  orgSlug,
  tournamentSlug,
  myStatus,
  me,
  user,
  alreadyRegisteredPlayerIds,
  onChanged,
  onNeedsAuth,
}: {
  event: Event;
  tournament: Tournament;
  registrationOpen: boolean;
  orgSlug: string;
  tournamentSlug: string;
  myStatus: MyRegStatus | undefined;
  me: Player | null;
  user: ReturnType<typeof useAuth>["user"];
  // F3: ids of players already registered for THIS event. Folded
  // into the PartnerSearch excludePlayerIds so the search can't
  // surface someone who's already in.
  alreadyRegisteredPlayerIds: Set<string>;
  onChanged: () => Promise<void> | void;
  onNeedsAuth: () => void;
}) {
  const chips = eligibilityChips(event);
  const tiers = priceTiers(event, tournament);
  const isOverride = event.event_fee_cents > 0;
  const showsFee = tiers.fullPrice > 0 || isOverride;
  const isDoubles = event.format === "doubles";

  // ─── Local state for the inline-expand register form ─────────────
  // Each card carries its own form state. We don't enforce
  // "one card open at a time" — keep it permissive; users can
  // open multiple cards if they want to compare. They still pay
  // through the per-tournament checkout at the end.
  // "register"        → expanded form is for creating a new reg.
  // "change-partner"  → expanded form is for swapping the partner
  //                     on an EXISTING pending reg (no new INSERT).
  // null              → form is collapsed.
  const [editMode, setEditMode] = useState<
    "register" | "change-partner" | null
  >(null);
  const expanded = editMode !== null;
  const [partner, setPartner] = useState<PlayerSelection>(emptySelection);
  // F1: doubles users can opt into "I need a partner" instead of
  // picking one. When true, the partner picker hides + the submit
  // path skips the partner-invite insert and stamps
  // partner_status='seeking' on the reg.
  const [seekingPartner, setSeekingPartner] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // ─── Derived state for visual treatment ──────────────────────────
  const isPaid =
    myStatus?.state === "paid" || myStatus?.state === "awaiting_partner";
  const isPending = myStatus?.state === "pending_payment";
  const borderColor = isPending
    ? "#fde68a"
    : isPaid
      ? "#bbf7d0"
      : "#e5e7eb";
  const bg = isPending ? "#fffbeb" : "#fff";

  // ─── Handlers ────────────────────────────────────────────────────
  const startRegister = () => {
    if (!user || !me) {
      // Anon visitor or no profile yet — bounce through auth, then
      // they come back here and click Register again.
      onNeedsAuth();
      return;
    }
    setEditMode("register");
    setPartner(emptySelection);
    setSeekingPartner(false);
    setFormError(null);
  };

  // F-#9: open the expanded form on a PENDING reg to swap partner
  // without losing the reg itself. Pre-fills "seekingPartner" with
  // the current state so toggling between picking-a-partner and
  // seeking is a one-click affordance.
  const startChangePartner = () => {
    setEditMode("change-partner");
    setPartner(emptySelection);
    setSeekingPartner(myStatus?.isSeekingPartner ?? false);
    setFormError(null);
  };

  const cancelExpand = () => {
    setEditMode(null);
    setPartner(emptySelection);
    setSeekingPartner(false);
    setFormError(null);
  };

  const onSubmitRegister = async () => {
    if (!me) {
      onNeedsAuth();
      return;
    }
    setFormError(null);

    // Validate doubles partner pick. Singles events bypass
    // entirely. So does "I need a partner" — they're registering
    // without a partner intentionally.
    if (isDoubles && !seekingPartner) {
      if (partner.mode === "empty") {
        setFormError("Pick a partner to continue.");
        return;
      }
      if (partner.mode === "existing" && partner.player.id === me.id) {
        setFormError("You picked yourself as your partner.");
        return;
      }
      if (partner.mode === "new") {
        if (
          !partner.firstName.trim() ||
          !partner.lastName.trim() ||
          !partner.email.trim()
        ) {
          setFormError(
            "Partner first name, last name, and email are required.",
          );
          return;
        }
        if (
          user?.email &&
          partner.email.trim().toLowerCase() === user.email.toLowerCase()
        ) {
          setFormError("Partner email can't be your own.");
          return;
        }
      }
    }

    setSubmitting(true);

    // Resolve partner: existing-mode returns the picked player as-is;
    // new-mode inserts a fresh players row. Singles events skip this.
    // F1 "I need a partner" also skips — the seeker reg goes in
    // with partner_status='seeking' and no partner_invite row.
    let resolvedPartnerId: string | null = null;
    let resolvedPartnerEmail: string | null = null;
    if (isDoubles && !seekingPartner && partner.mode !== "empty") {
      const resolved = await persistPlayerSelection(partner);
      if (!resolved.player) {
        setFormError(resolved.error ?? "Failed to set up partner.");
        setSubmitting(false);
        return;
      }
      resolvedPartnerId = resolved.player.id;
      resolvedPartnerEmail =
        resolved.player.email ??
        (partner.mode === "new" ? partner.email.trim() : null);
    }

    // Auto-pair check: did the chosen partner already invite ME to
    // this event? If so, registering with them picked counts as
    // accepting their invite — no new outbound invite, no
    // duplicate. Mirrors the logic in the legacy /register page.
    let inboundInviteId: string | null = null;
    if (isDoubles && resolvedPartnerId && user?.email) {
      const { data: inbound } = await supabase
        .from("partner_invites")
        .select("id")
        .eq("event_id", event.id)
        .eq("inviter_player_id", resolvedPartnerId)
        .eq("invitee_email", user.email)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (inbound) inboundInviteId = inbound.id;
    }

    // Insert MY event_registration with status='pending_payment'.
    // The fee cents stay 0 here — the actual amount is computed at
    // checkout based on the full basket (D's first-vs-additional
    // tier math). Checkout's "Pay" handler snapshots the cents
    // onto the row before flipping status to 'paid'.
    //
    // partner_status:
    //   * singles               → 'solo'
    //   * doubles + seeking     → 'seeking' (F1)
    //   * doubles + auto-pair   → 'solo' (the RPC bumps it to
    //                             'confirmed' along with the link)
    //   * doubles + outbound    → 'pending' (until partner accepts)
    const partnerStatusOnInsert: Database["public"]["Enums"]["partner_status"] =
      !isDoubles
        ? "solo"
        : seekingPartner
          ? "seeking"
          : inboundInviteId
            ? "solo"
            : "pending";
    const { error: regErr } = await supabase
      .from("event_registrations")
      .insert({
        event_id: event.id,
        player_id: me.id,
        event_fee_cents: 0,
        status: "pending_payment",
        partner_status: partnerStatusOnInsert,
      })
      .select()
      .single();
    if (regErr) {
      setFormError(regErr.message ?? "Failed to register.");
      setSubmitting(false);
      return;
    }

    if (isDoubles && !seekingPartner && resolvedPartnerId) {
      // Capture into a local that's narrowed non-null so the
      // closure-captured value in insertOutboundInvite doesn't
      // re-widen to nullable.
      const partnerIdNN = resolvedPartnerId;
      const meIdNN = me.id;
      const insertOutboundInvite = async () => {
        // Queue the partner_invite as 'pending'. The invite EMAIL
        // doesn't fire yet — it fires from the checkout page after
        // payment so an unpaid registrant doesn't ghost their
        // partner.
        const { error: invErr } = await supabase
          .from("partner_invites")
          .insert({
            event_id: event.id,
            inviter_player_id: meIdNN,
            invitee_player_id: partnerIdNN,
            invitee_email: resolvedPartnerEmail,
            status: "pending",
          });
        if (invErr) {
          setFormError(
            `Registered, but partner invite setup failed: ${invErr.message}`,
          );
        }
      };

      if (inboundInviteId) {
        // Auto-pair: accept the existing inbound invite. RPC links
        // both regs + flips partner_status='confirmed' on each.
        const { error: acceptErr } = await supabase.rpc(
          "accept_partner_invite",
          { p_invite_id: inboundInviteId },
        );
        if (acceptErr) {
          // Auto-pair failed — fall back to the standard
          // outbound-invite path. User is still registered.
          // eslint-disable-next-line no-console
          console.warn(
            "auto-pair failed, falling back to outbound invite",
            acceptErr,
          );
          await insertOutboundInvite();
        }
      } else {
        await insertOutboundInvite();
      }
    }

    setEditMode(null);
    setPartner(emptySelection);
    setSeekingPartner(false);
    setSubmitting(false);
    await onChanged();
  };

  // F-#9: change-partner submit. Doesn't insert a new reg — updates
  // the existing pending reg's partner_status and swaps the
  // outbound invite. Auto-pair still applies (if the new pick
  // already invited me, accept theirs instead). Email doesn't
  // fire from here either; it'll fire from checkout like always.
  const onSubmitChangePartner = async () => {
    if (!me || !myStatus?.regId) return;
    setFormError(null);

    // Same validation as the register form for doubles, minus the
    // singles path (you don't get here from a singles event).
    if (!seekingPartner) {
      if (partner.mode === "empty") {
        setFormError("Pick a partner to continue.");
        return;
      }
      if (partner.mode === "existing" && partner.player.id === me.id) {
        setFormError("You picked yourself as your partner.");
        return;
      }
      if (partner.mode === "new") {
        if (
          !partner.firstName.trim() ||
          !partner.lastName.trim() ||
          !partner.email.trim()
        ) {
          setFormError(
            "Partner first name, last name, and email are required.",
          );
          return;
        }
        if (
          user?.email &&
          partner.email.trim().toLowerCase() === user.email.toLowerCase()
        ) {
          setFormError("Partner email can't be your own.");
          return;
        }
      }
    }

    setSubmitting(true);

    // 1. Cancel any pending outbound invite for this event — the
    //    new partner pick supersedes it. Safe to call even when
    //    there isn't one (no rows updated).
    await supabase
      .from("partner_invites")
      .update({ status: "cancelled" })
      .eq("event_id", event.id)
      .eq("inviter_player_id", me.id)
      .eq("status", "pending");

    // 2. Resolve the new partner (skip when seeking).
    let resolvedPartnerId: string | null = null;
    let resolvedPartnerEmail: string | null = null;
    if (!seekingPartner && partner.mode !== "empty") {
      const resolved = await persistPlayerSelection(partner);
      if (!resolved.player) {
        setFormError(resolved.error ?? "Failed to set up partner.");
        setSubmitting(false);
        return;
      }
      resolvedPartnerId = resolved.player.id;
      resolvedPartnerEmail =
        resolved.player.email ??
        (partner.mode === "new" ? partner.email.trim() : null);
    }

    // 3. Auto-pair lookup (same as register flow).
    let inboundInviteId: string | null = null;
    if (!seekingPartner && resolvedPartnerId && user?.email) {
      const { data: inbound } = await supabase
        .from("partner_invites")
        .select("id")
        .eq("event_id", event.id)
        .eq("inviter_player_id", resolvedPartnerId)
        .eq("invitee_email", user.email)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (inbound) inboundInviteId = inbound.id;
    }

    // 4. Update my reg's partner_status. The accept_partner_invite
    //    RPC will overwrite to 'confirmed' if we auto-pair below,
    //    so for that case we set 'solo' as a placeholder.
    const newPartnerStatus = seekingPartner
      ? "seeking"
      : inboundInviteId
        ? "solo"
        : "pending";
    await supabase
      .from("event_registrations")
      .update({
        partner_status: newPartnerStatus,
        // If switching TO seeking or about to re-pair, drop any
        // stale link to the previous partner's reg.
        partner_registration_id: null,
      })
      .eq("id", myStatus.regId);

    // 5. Either accept the inbound invite or insert a fresh one.
    if (!seekingPartner && resolvedPartnerId) {
      if (inboundInviteId) {
        const { error: acceptErr } = await supabase.rpc(
          "accept_partner_invite",
          { p_invite_id: inboundInviteId },
        );
        if (acceptErr) {
          // eslint-disable-next-line no-console
          console.warn(
            "auto-pair failed during partner change, falling back",
            acceptErr,
          );
          await insertNewInvite();
        }
      } else {
        await insertNewInvite();
      }
    }

    async function insertNewInvite() {
      const { error: invErr } = await supabase
        .from("partner_invites")
        .insert({
          event_id: event.id,
          inviter_player_id: me!.id,
          invitee_player_id: resolvedPartnerId!,
          invitee_email: resolvedPartnerEmail,
          status: "pending",
        });
      if (invErr) {
        setFormError(
          `Partner updated but invite setup failed: ${invErr.message}`,
        );
      }
    }

    setEditMode(null);
    setPartner(emptySelection);
    setSeekingPartner(false);
    setSubmitting(false);
    await onChanged();
  };

  const onCancelPending = async () => {
    if (!myStatus?.regId || !me) return;
    setCancelling(true);
    // Soft-delete the pending reg + cancel any outbound invite for
    // this event. (If the user paid already and then changes their
    // mind, that's the manage-page withdraw flow — different path.)
    await supabase
      .from("event_registrations")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", myStatus.regId);
    await supabase
      .from("partner_invites")
      .update({ status: "cancelled" })
      .eq("event_id", event.id)
      .eq("inviter_player_id", me.id)
      .eq("status", "pending");
    setCancelling(false);
    await onChanged();
  };

  // ─── Right-side action button — depends on current state ─────────
  const renderAction = () => {
    if (!registrationOpen) return null;
    if (myStatus?.state === "invited" && myStatus.inviteToken) {
      // Invited state takes priority — the inbound invite is the
      // most actionable thing on this row.
      return (
        <Link
          to={`/t/${orgSlug}/${tournamentSlug}/invites/${myStatus.inviteToken}`}
          style={{
            padding: "8px 16px",
            background: "#2563eb",
            color: "#fff",
            textDecoration: "none",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 500,
            whiteSpace: "nowrap",
            border: "1px solid #2563eb",
          }}
        >
          Review invite →
        </Link>
      );
    }
    if (myStatus?.state === "pending_payment") {
      // F-#9: doubles pending regs get a "Change partner" button
      // next to Cancel so the user can swap their partner without
      // canceling + re-registering (which would risk losing the
      // pending slot to capacity sweep).
      return (
        <div style={{ display: "flex", gap: 6 }}>
          {isDoubles && !expanded && (
            <button
              type="button"
              onClick={startChangePartner}
              disabled={cancelling}
              style={{
                padding: "8px 14px",
                background: "#fff",
                color: "#2563eb",
                border: "1px solid #2563eb",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
                cursor: cancelling ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                whiteSpace: "nowrap",
              }}
            >
              Change partner
            </button>
          )}
          <button
            type="button"
            onClick={() => void onCancelPending()}
            disabled={cancelling}
            style={{
              padding: "8px 14px",
              background: "#fff",
              color: "#991b1b",
              border: "1px solid #fca5a5",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              cursor: cancelling ? "not-allowed" : "pointer",
              fontFamily: "inherit",
              whiteSpace: "nowrap",
            }}
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      );
    }
    if (isPaid) {
      // Already-paid registration — Manage page handles withdraw +
      // partner change. (That's the existing /register page.)
      return (
        <Link
          to={`/t/${orgSlug}/${tournamentSlug}/register?event=${event.id}`}
          style={{
            padding: "8px 16px",
            background: "#fff",
            color: "#2563eb",
            border: "1px solid #2563eb",
            textDecoration: "none",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 500,
            whiteSpace: "nowrap",
          }}
        >
          Manage
        </Link>
      );
    }
    if (expanded) return null; // expanded form has its own buttons
    return (
      <button
        type="button"
        onClick={startRegister}
        style={{
          padding: "8px 16px",
          background: "#2563eb",
          color: "#fff",
          border: "1px solid #2563eb",
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 500,
          cursor: "pointer",
          fontFamily: "inherit",
          whiteSpace: "nowrap",
        }}
      >
        Register
      </button>
    );
  };

  const partnerPicked = partner.mode !== "empty";
  // Submit gate: singles always submit-able. Doubles need EITHER a
  // partner picked OR the "I need a partner" toggle on.
  const canSubmit = !isDoubles || partnerPicked || seekingPartner;

  return (
    <div
      style={{
        padding: 16,
        background: bg,
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
      }}
    >
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Title + status pill */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              {event.name}
            </h3>
            {myStatus?.state === "paid" && (
              <Pill bg="#dcfce7" fg="#166534">Registered</Pill>
            )}
            {myStatus?.state === "pending_payment" && (
              <Pill bg="#fef3c7" fg="#7a5d00">Pending payment</Pill>
            )}
            {myStatus?.state === "awaiting_partner" && (
              <Pill bg="#fffbeb" fg="#92400e">Awaiting partner</Pill>
            )}
            {myStatus?.state === "invited" && (
              <Pill bg="#fef3c7" fg="#7a5d00">You're invited</Pill>
            )}
            {myStatus?.isSeekingPartner && (
              <Pill bg="#dbeafe" fg="#1e40af">Looking for partner</Pill>
            )}
          </div>
          {/* Partner label */}
          {myStatus?.state === "invited" && myStatus.inviterName ? (
            <div style={{ color: "#7a5d00", fontSize: 12, marginTop: 4 }}>
              <strong>{myStatus.inviterName}</strong> picked you as their
              partner
            </div>
          ) : myStatus?.partnerLabel ? (
            <div
              style={{
                color: isPending ? "#7a5d00" : "#166534",
                fontSize: 12,
                marginTop: 4,
              }}
            >
              {isPaid && myStatus.state === "paid"
                ? "Partnered with "
                : "Invited "}
              <strong>{myStatus.partnerLabel}</strong>
            </div>
          ) : null}
          {/* Meta line */}
          <div style={{ color: "#666", fontSize: 13, marginTop: 4 }}>
            {capitalize(event.format)} · {capitalize(event.gender)} ·{" "}
            {event.points_to_win} win by {event.win_by}
            {event.teams_advancing_to_playoff > 0
              ? ` · top ${event.teams_advancing_to_playoff} to playoffs`
              : ""}
            {event.max_teams ? ` · max ${event.max_teams} teams` : ""}
          </div>
          {chips.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 4,
                marginTop: 8,
              }}
            >
              {chips.map((c) => (
                <span
                  key={c}
                  style={{
                    padding: "2px 8px",
                    background: "#eff6ff",
                    color: "#1e40af",
                    borderRadius: 4,
                    fontSize: 11,
                    fontWeight: 500,
                  }}
                >
                  {c}
                </span>
              ))}
            </div>
          )}
          {showsFee && (
            <div style={{ color: "#444", fontSize: 13, marginTop: 8 }}>
              {isOverride ? (
                <>
                  Event fee:{" "}
                  <strong>{formatUsd(event.event_fee_cents)}</strong>
                </>
              ) : tiers.fullPrice === tiers.additionalPrice ? (
                <>
                  Event fee: <strong>{formatUsd(tiers.fullPrice)}</strong>
                </>
              ) : (
                <>
                  <strong>{formatUsd(tiers.fullPrice)}</strong> as your
                  first event,{" "}
                  <strong>{formatUsd(tiers.additionalPrice)}</strong> as
                  an additional event
                </>
              )}
            </div>
          )}
        </div>
        <div style={{ alignSelf: "center" }}>{renderAction()}</div>
      </div>

      {/* Inline-expand register form. Slides in below the metadata
          row when the user clicks Register on an unregistered event.
          For singles, no partner picker — just the buttons. */}
      {expanded && (
        <div
          style={{
            marginTop: 14,
            paddingTop: 14,
            borderTop: "1px dashed #e5e7eb",
          }}
        >
          {isDoubles && (
            <>
              {/* F1: two-mode picker — pick a partner OR sign up
                  needing one. Defaults to "Pick a partner." */}
              <div
                role="radiogroup"
                aria-label="Partner mode"
                style={{
                  display: "flex",
                  gap: 8,
                  marginBottom: 10,
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={!seekingPartner}
                  onClick={() => setSeekingPartner(false)}
                  style={partnerModeBtnStyle(!seekingPartner)}
                >
                  Pick a partner
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={seekingPartner}
                  onClick={() => {
                    setSeekingPartner(true);
                    setPartner(emptySelection);
                  }}
                  style={partnerModeBtnStyle(seekingPartner)}
                >
                  I need a partner
                </button>
              </div>
              {seekingPartner ? (
                <div
                  style={{
                    padding: 10,
                    background: "#eff6ff",
                    border: "1px solid #bfdbfe",
                    borderRadius: 6,
                    fontSize: 12,
                    color: "#1e40af",
                    lineHeight: 1.55,
                  }}
                >
                  We'll register you for this event without a partner.
                  Other registrants will be able to find you in the
                  partner search, and the organizer will see you in
                  their "looking for a partner" list to help match you
                  up.
                </div>
              ) : (
                <>
                  <div
                    style={{
                      fontSize: 12,
                      color: "#666",
                      marginBottom: 8,
                      lineHeight: 1.5,
                    }}
                  >
                    Your doubles partner. Search by name, email, or
                    phone — if they're not in the list yet, add them
                    as a new player. We won't email them until you
                    check out.
                  </div>
                  <PartnerSearch
                    selection={partner}
                    onChange={setPartner}
                    excludePlayerIds={[
                      ...(me ? [me.id] : []),
                      ...Array.from(alreadyRegisteredPlayerIds),
                    ]}
                  />
                </>
              )}
            </>
          )}
          {formError && (
            <div
              style={{
                marginTop: 10,
                padding: 8,
                background: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: 6,
                color: "#991b1b",
                fontSize: 12,
              }}
            >
              {formError}
            </div>
          )}
          <div
            style={{
              marginTop: 12,
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              onClick={() =>
                void (editMode === "change-partner"
                  ? onSubmitChangePartner()
                  : onSubmitRegister())
              }
              disabled={submitting || !canSubmit}
              style={{
                padding: "10px 18px",
                background:
                  submitting || !canSubmit ? "#9ca3af" : "#2563eb",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                fontSize: 14,
                fontWeight: 500,
                cursor:
                  submitting || !canSubmit ? "not-allowed" : "pointer",
                fontFamily: "inherit",
              }}
            >
              {submitting
                ? editMode === "change-partner"
                  ? "Saving…"
                  : "Registering…"
                : editMode === "change-partner"
                  ? "Save partner change"
                  : "Register"}
            </button>
            <button
              type="button"
              onClick={cancelExpand}
              disabled={submitting}
              style={{
                padding: "10px 18px",
                background: "#fff",
                color: "#555",
                border: "1px solid #e2e2e2",
                borderRadius: 6,
                fontSize: 13,
                cursor: submitting ? "not-allowed" : "pointer",
                fontFamily: "inherit",
              }}
            >
              Cancel
            </button>
            {isDoubles && !partnerPicked && !seekingPartner && !submitting && (
              <span style={{ fontSize: 12, color: "#888" }}>
                Pick a partner to continue (or choose "I need a
                partner" above).
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Small status pill used inside the EventCard header.
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
        padding: "2px 8px",
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

// Two-mode toggle button used in EventCard's F1 partner-mode picker.
// Same visual treatment as a segmented control — active mode gets a
// filled blue background, inactive stays white with a thin border.
function partnerModeBtnStyle(active: boolean) {
  return {
    padding: "8px 14px",
    background: active ? "#2563eb" : "#fff",
    color: active ? "#fff" : "#444",
    border: `1px solid ${active ? "#2563eb" : "#e2e2e2"}`,
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500 as const,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

// ─────────────────────────────────────────────────────────────────────
// Bits
// ─────────────────────────────────────────────────────────────────────

function Shell({ children }: { children: ReactNode }) {
  return (
    <main
      style={{
        padding: "32px 24px",
        maxWidth: 760,
        margin: "0 auto",
      }}
    >
      {children}
    </main>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          color: "#888",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div style={{ marginTop: 2 }}>{value}</div>
    </div>
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

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

