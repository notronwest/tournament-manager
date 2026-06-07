import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Handshake, HandHelping } from "lucide-react";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import {
  emptySelection,
  persistPlayerSelection,
  type PlayerSelection,
} from "../../components/PlayerPicker";
import { PartnerSearch } from "../../components/PartnerSearch";
import { ConfirmModal } from "../../components/ConfirmModal";
import { usePendingPayments, type PendingTournamentGroup } from "../../components/PendingPaymentsContext";
import { formatUsd } from "../../lib/pricing";
import { eligibilityChips } from "../../lib/eligibility";
import {
  deriveRegistrationStatus,
  pickActivePricingTier,
  pickNextPricingTier,
  type PricingTier,
} from "../../lib/pricingTiers";
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

// Row returned by the event_roster SECURITY DEFINER RPC.
type RosterRow =
  Database["public"]["Functions"]["event_roster"]["Returns"][number];

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
  const { refresh: refreshPending, groups: pendingGroups } = usePendingPayments();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  // Ordered pricing tiers for this tournament. Backfilled by migration
  // 20260526170000 — every existing tournament has at least one
  // ('Standard') tier holding the legacy entry_fee + additional fees.
  // The active tier (today vs. the tier windows) drives both the
  // price meta shown in the header and the math used at checkout.
  const [tiers, setTiers] = useState<PricingTier[]>([]);
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
  // Roster rows per event for the toggle bar and collapsible panel.
  // Loaded via the event_roster SECURITY DEFINER RPC alongside
  // players_registered_for_events so both round trips happen in
  // parallel.
  const [rosterByEvent, setRosterByEvent] = useState<
    Map<string, RosterRow[]>
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

    // Pricing tiers — anon-readable via the same parent-visibility
    // RLS as events. Pulled alongside events so the meta header can
    // show the active tier's prices + an upcoming-tier countdown if
    // one applies.
    const { data: tierRows, error: tierErr } = await supabase
      .from("tournament_pricing_tiers")
      .select("*")
      .eq("tournament_id", t.id)
      .order("sort_order", { ascending: true });
    if (tierErr) {
      setError(tierErr.message);
      setLoading(false);
      return;
    }
    setTiers(tierRows ?? []);

    // F3 + roster: pull registered player_ids and full roster rows
    // for every event. Both RPCs are SECURITY DEFINER to bypass the
    // event_registrations RLS that blocks anon/non-member SELECTs.
    // Run in parallel since neither depends on the other.
    if (evs && evs.length > 0) {
      const evIds = evs.map((e) => e.id);
      const [regsByEventRes, rosterRes] = await Promise.all([
        supabase.rpc("players_registered_for_events", { p_event_ids: evIds }),
        supabase.rpc("event_roster", { p_event_ids: evIds }),
      ]);

      const grouped = new Map<string, Set<string>>();
      for (const row of regsByEventRes.data ?? []) {
        let set = grouped.get(row.event_id);
        if (!set) {
          set = new Set<string>();
          grouped.set(row.event_id, set);
        }
        set.add(row.player_id);
      }
      setRegisteredByEvent(grouped);

      const rosterGrouped = new Map<string, RosterRow[]>();
      for (const row of (rosterRes.data ?? []) as RosterRow[]) {
        let arr = rosterGrouped.get(row.event_id);
        if (!arr) {
          arr = [];
          rosterGrouped.set(row.event_id, arr);
        }
        arr.push(row);
      }
      setRosterByEvent(rosterGrouped);
    } else {
      setRegisteredByEvent(new Map());
      setRosterByEvent(new Map());
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

  // Active pricing tier drives the prominent "to register" headline
  // in the CTA box below. The model we lead with: the registration
  // fee gets you into your first event; each additional event adds
  // the additional-event fee. (Per-event overrides were retired as
  // the default — see migration 20260529150000.)
  const activeTier = pickActivePricingTier(tiers);
  const nextTier = pickNextPricingTier(tiers);
  const regFeeCents = activeTier?.first_event_fee_cents ?? 0;
  const additionalFeeCents = activeTier?.additional_event_fee_cents ?? 0;
  const isMultiTier = tiers.length > 1;

  // Does the signed-in player already hold an active registration in
  // THIS tournament? If so, any further event they register is an
  // "additional event" — it adds the additional-event fee, not the
  // (already-paid-once) registration fee. We use this to show a
  // context-aware cost line in each event's register form: the
  // registration fee for their first event, "+$X additional" after.
  const activeRegStates = new Set<MyRegStatus["state"]>([
    "paid",
    "pending_payment",
    "awaiting_partner",
  ]);
  const hasActiveRegInTournament = Array.from(myStatus.values()).some((s) =>
    activeRegStates.has(s.state),
  );
  const myPendingGroup =
    pendingGroups?.find((g) => g.tournamentId === tournament.id) ?? null;

  // Public lifecycle status pill — the second surface of the tier
  // dates. "Early Bird Registration Open" / "Registration Open" /
  // "Late Registration Open" / "Registration Closed", derived from
  // the registration window + active tier (no separate status flag).
  const regStatus = deriveRegistrationStatus(tournament, tiers);
  const regStatusPalette: Record<
    typeof regStatus.tone,
    { bg: string; fg: string; border: string }
  > = {
    open: { bg: "#dcfce7", fg: "#166534", border: "#bbf7d0" },
    soon: { bg: "#fef3c7", fg: "#92400e", border: "#fde68a" },
    closed: { bg: "#f3f4f6", fg: "#666", border: "#e5e7eb" },
  };
  const regStatusColors = regStatusPalette[regStatus.tone];

  return (
  <>
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
          {/* Lifecycle status pill — derived from the registration
              window + active pricing tier. */}
          <span
            style={{
              display: "inline-block",
              padding: "3px 10px",
              borderRadius: 999,
              background: regStatusColors.bg,
              color: regStatusColors.fg,
              border: `1px solid ${regStatusColors.border}`,
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {regStatus.label}
          </span>
          {/* Window detail under the pill: when it opens (if not yet)
              or when it closes (if open). */}
          {regStatus.tone === "soon" &&
            tournament.registration_opens_at && (
              <div style={{ fontSize: 12, color: "#92400e", marginTop: 6 }}>
                Opens {fmtDateTime(tournament.registration_opens_at)}
              </div>
            )}
          {tournament.registration_closes_at && registrationOpen && (
            <div style={{ fontSize: 12, color: "#1e40af", marginTop: 6 }}>
              Closes {fmtDateTime(tournament.registration_closes_at)}
            </div>
          )}
        </div>
        {/* Price headline. We lead with the registration fee — that's
            what gets a player into their first event. The additional-
            event fee is a quiet secondary line because most players
            enter a single event. No global Register button here on
            purpose: the per-event Register buttons on each card let
            the player pick what they're registering for first. */}
        {regFeeCents > 0 && (
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div
              style={{
                fontSize: 26,
                fontWeight: 700,
                color: "#111",
                lineHeight: 1.1,
              }}
            >
              ${(regFeeCents / 100).toFixed(0)}
            </div>
            <div style={{ fontSize: 12, color: "#555", marginTop: 2 }}>
              to register · includes 1 event
            </div>
            {additionalFeeCents > 0 && (
              <div style={{ fontSize: 12, color: "#888", marginTop: 1 }}>
                +${(additionalFeeCents / 100).toFixed(0)} each additional event
              </div>
            )}
            {isMultiTier && activeTier && (
              <div style={{ fontSize: 11, color: "#1e40af", marginTop: 4 }}>
                {activeTier.label} pricing
                {nextTier && activeTier.ends_at
                  ? ` · ${nextTier.label} from ${fmtDate(activeTier.ends_at)}`
                  : ""}
              </div>
            )}
          </div>
        )}
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
                registrationOpen={registrationOpen}
                orgSlug={orgSlug ?? ""}
                tournamentSlug={tournamentSlug ?? ""}
                myStatus={myStatus.get(ev.id)}
                me={me}
                user={user}
                regFeeCents={regFeeCents}
                additionalFeeCents={additionalFeeCents}
                isAdditionalEvent={hasActiveRegInTournament}
                alreadyRegisteredPlayerIds={
                  registeredByEvent.get(ev.id) ?? new Set()
                }
                rosterRows={rosterByEvent.get(ev.id) ?? []}
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
    {myPendingGroup && (
      <StickyCheckoutBar
        group={myPendingGroup}
        orgSlug={orgSlug ?? ""}
        tournamentSlug={tournamentSlug ?? ""}
      />
    )}
  </>
  );
}

function StickyCheckoutBar({
  group,
  orgSlug,
  tournamentSlug,
}: {
  group: PendingTournamentGroup;
  orgSlug: string;
  tournamentSlug: string;
}) {
  const count = group.events.length;
  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        background: "#fff",
        borderTop: "1px solid #d1fae5",
        boxShadow: "0 -2px 8px rgba(0,0,0,0.08)",
        zIndex: 40,
      }}
    >
      <div
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          padding: "12px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 13, color: "#374151", fontWeight: 500 }}>
          {count} event{count !== 1 ? "s" : ""} saved &middot;{" "}
          {formatUsd(group.totalCents)} total
        </span>
        <Link
          to={`/t/${orgSlug}/${tournamentSlug}/checkout`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            background: "#16a34a",
            color: "#fff",
            padding: "10px 18px",
            borderRadius: 6,
            textDecoration: "none",
            fontSize: 14,
            fontWeight: 500,
            whiteSpace: "nowrap",
          }}
        >
          Go to checkout →
          <span
            style={{
              background: "rgba(255,255,255,0.25)",
              borderRadius: "50%",
              minWidth: 20,
              height: 20,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 700,
              padding: "0 4px",
            }}
          >
            {count}
          </span>
        </Link>
      </div>
    </div>
  );
}

function EventCard({
  event,
  registrationOpen,
  orgSlug,
  tournamentSlug,
  myStatus,
  me,
  user,
  regFeeCents,
  additionalFeeCents,
  isAdditionalEvent,
  alreadyRegisteredPlayerIds,
  rosterRows,
  onChanged,
  onNeedsAuth,
}: {
  event: Event;
  registrationOpen: boolean;
  orgSlug: string;
  tournamentSlug: string;
  myStatus: MyRegStatus | undefined;
  me: Player | null;
  user: ReturnType<typeof useAuth>["user"];
  // Active-tier fees + whether the player already holds a reg in this
  // tournament. Drive the context-aware cost line in the register
  // form: registration fee for the first event, +additional after.
  regFeeCents: number;
  additionalFeeCents: number;
  isAdditionalEvent: boolean;
  // F3: ids of players already registered for THIS event. Folded
  // into the PartnerSearch excludePlayerIds so the search can't
  // surface someone who's already in.
  alreadyRegisteredPlayerIds: Set<string>;
  // Roster rows for the collapsible roster panel.
  rosterRows: RosterRow[];
  onChanged: () => Promise<void> | void;
  onNeedsAuth: () => void;
}) {
  const chips = eligibilityChips(event);
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
  // #9: gate the partner-dropping Cancel behind a confirm step.
  const [confirmCancel, setConfirmCancel] = useState(false);
  // #9: same guard for backing out of the register FORM after a
  // partner is picked (discards the in-progress pick).
  const [confirmDiscardForm, setConfirmDiscardForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Roster panel collapsed by default; toggled by the toggle bar.
  const [rosterOpen, setRosterOpen] = useState(false);

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

  // #9: a pending reg with a *picked* partner gets an "are you sure?"
  // step before Cancel drops the partner. Seeker / no-partner regs
  // cancel directly — the action is less consequential (issue #9).
  const hasPickedPartner =
    !!myStatus?.partnerLabel && !myStatus?.isSeekingPartner;
  const requestCancel = () => {
    if (hasPickedPartner) setConfirmCancel(true);
    else void onCancelPending();
  };

  // Roster: "Partner up →" button opens the register form with the
  // seeker pre-selected as the partner. The event_roster RPC doesn't
  // return player_id, so we do a name-based lookup restricted to
  // players already registered for this event (alreadyRegisteredPlayerIds)
  // to find the right record. In the rare case of a same-name collision,
  // we prefer the registered player; if still ambiguous, we take the first
  // match and note it in the PR.
  const handlePartnerUp = async (seeker: {
    first_name: string;
    last_name: string;
  }) => {
    if (!user || !me) {
      onNeedsAuth();
      return;
    }
    setEditMode("register");
    setSeekingPartner(false);
    setFormError(null);
    // Async lookup: search by exact name, then prefer the player
    // who's already registered for this event (using the
    // alreadyRegisteredPlayerIds set from the partner-picker RPC).
    const { data: candidates } = await supabase
      .from("players")
      .select("*")
      .eq("first_name", seeker.first_name)
      .eq("last_name", seeker.last_name)
      .is("deleted_at", null);
    const p =
      (candidates ?? []).find((c) => alreadyRegisteredPlayerIds.has(c.id)) ??
      (candidates ?? [])[0];
    if (p) {
      setPartner({ mode: "existing", player: p, emailDraft: "", phoneDraft: "" });
    }
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
            onClick={requestCancel}
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
  // #9: name of the picked partner, for the discard-confirm copy.
  const pickedPartnerName =
    partner.mode === "existing"
      ? `${partner.player.first_name} ${partner.player.last_name}`.trim()
      : partner.mode === "new"
        ? `${partner.firstName} ${partner.lastName}`.trim()
        : null;
  // #9: backing out of the form warns first when a partner is picked;
  // otherwise it cancels directly (nothing consequential to drop).
  const requestDiscardForm = () => {
    if (partnerPicked) setConfirmDiscardForm(true);
    else cancelExpand();
  };
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
      {confirmCancel && (
        <ConfirmModal
          title="Cancel registration?"
          body={
            <>
              This cancels your registration and drops{" "}
              <strong>{myStatus?.partnerLabel}</strong> as your partner.
              Your partner pick will be removed.
            </>
          }
          confirmLabel="Cancel registration"
          cancelLabel="Keep registration"
          onCancel={() => setConfirmCancel(false)}
          onConfirm={async () => {
            await onCancelPending();
            setConfirmCancel(false);
          }}
        />
      )}
      {confirmDiscardForm && (
        <ConfirmModal
          title="Discard your partner pick?"
          body={
            <>
              You've selected{" "}
              <strong>{pickedPartnerName ?? "a partner"}</strong>. Cancelling
              the form will clear that pick.
            </>
          }
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          onCancel={() => setConfirmDiscardForm(false)}
          onConfirm={() => {
            setConfirmDiscardForm(false);
            cancelExpand();
          }}
        />
      )}
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
          {isPending && myStatus?.partnerLabel && (
            <div
              style={{
                marginTop: 5,
                padding: "5px 10px",
                background: "#fef3c7",
                border: "1px solid #fde68a",
                borderRadius: 5,
                fontSize: 11,
                color: "#7a5d00",
                display: "inline-block",
              }}
            >
              Your partner won't be notified until you check out.
            </div>
          )}
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
          {/* No per-event price line here. Pricing is tournament-level
              (registration fee includes one event, +additional per
              extra event) and is shown prominently in the header CTA
              box, so repeating a per-event number on every card just
              muddied the model. */}
        </div>
        <div style={{ alignSelf: "center" }}>{renderAction()}</div>
      </div>

      {/* Toggle bar + collapsible roster panel */}
      <RosterToggleBar
        rosterRows={rosterRows}
        isDoubles={isDoubles}
        rosterOpen={rosterOpen}
        onToggle={() => setRosterOpen((o) => !o)}
      />
      {rosterOpen && (
        <RosterPanel
          rosterRows={rosterRows}
          event={event}
          isDoubles={isDoubles}
          myRegId={myStatus?.regId ?? null}
          myIsRegistered={
            myStatus !== undefined &&
            (myStatus.state === "paid" ||
              myStatus.state === "pending_payment" ||
              myStatus.state === "awaiting_partner")
          }
          onPartnerUp={handlePartnerUp}
        />
      )}

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
          {/* Context-aware cost line. Only on the register flow (not
              the change-partner flow, which doesn't change the price).
              We don't re-explain the whole first/additional model —
              just tell the player what THIS event costs them given
              what they've already signed up for. */}
          {editMode === "register" && regFeeCents > 0 && (
            <div
              style={{
                marginBottom: 12,
                fontSize: 13,
                color: "#444",
              }}
            >
              {isAdditionalEvent ? (
                <>
                  Additional event:{" "}
                  <strong>+${(additionalFeeCents / 100).toFixed(0)}</strong>{" "}
                  <span style={{ color: "#888" }}>
                    (added to your registration)
                  </span>
                </>
              ) : (
                <>
                  <strong>${(regFeeCents / 100).toFixed(0)}</strong>{" "}
                  registration{" "}
                  <span style={{ color: "#888" }}>· includes this event</span>
                </>
              )}
            </div>
          )}
          {isDoubles && (
            <>
              {/* F1: two-mode picker — pick a partner OR sign up
                  needing one. Defaults to "I have a partner."
                  Renders as compact choice tiles (icon + label) so
                  the affordance reads as "selection, not action."
                  Handshake = picker mode; HandHelping = the user
                  raising their hand to be matched. */}
              <div
                role="radiogroup"
                aria-label="Partner mode"
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  marginBottom: 10,
                }}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={!seekingPartner}
                  onClick={() => setSeekingPartner(false)}
                  style={partnerModeTileStyle(!seekingPartner)}
                >
                  <Handshake size={18} aria-hidden="true" />
                  <span>I have a partner</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={seekingPartner}
                  onClick={() => {
                    setSeekingPartner(true);
                    setPartner(emptySelection);
                  }}
                  style={partnerModeTileStyle(seekingPartner)}
                >
                  <HandHelping size={18} aria-hidden="true" />
                  <span>I need a partner</span>
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
                    as a new player.
                  </div>
                  <PartnerSearch
                    selection={partner}
                    onChange={setPartner}
                    excludePlayerIds={[
                      ...(me ? [me.id] : []),
                      ...Array.from(alreadyRegisteredPlayerIds),
                    ]}
                  />
                  {partnerPicked && (
                    <div
                      style={{
                        marginTop: 8,
                        padding: "8px 12px",
                        background: "#fef3c7",
                        border: "1px solid #fde68a",
                        borderRadius: 6,
                        fontSize: 12,
                        color: "#7a5d00",
                        lineHeight: 1.5,
                      }}
                    >
                      Your partner won't be notified until you check out.
                    </div>
                  )}
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
                ? "Saving…"
                : editMode === "change-partner"
                  ? "Save partner change"
                  : "Save"}
            </button>
            <button
              type="button"
              onClick={requestDiscardForm}
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

// Tile for the partner-mode choice picker. Icon + label arranged
// horizontally inside a compact bordered card. Active tile gets the
// app's blue-wash background + blue border so the selection reads
// from across the form; inactive stays white with a neutral border.
// The whole tile is the click target — both the icon and the label
// inherit `currentColor` so hover/active states flow through.
function partnerModeTileStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    background: active ? "#eff6ff" : "#fff",
    color: active ? "#1e40af" : "#444",
    border: `1px solid ${active ? "#2563eb" : "#d1d5db"}`,
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: "inherit",
    cursor: "pointer",
    textAlign: "left",
    transition: "border-color 120ms, background 120ms, color 120ms",
  };
}

// ─────────────────────────────────────────────────────────────────────
// Roster helpers
// ─────────────────────────────────────────────────────────────────────

// Returns the right self-rating for the event format/gender.
function rosterRating(row: RosterRow, event: Event): number | null {
  if (event.format === "singles") return (row.self_rating_singles as number | null);
  if (event.gender === "mixed") return (row.self_rating_mixed as number | null);
  return (row.self_rating_doubles as number | null);
}

// Team-slot count for the toggle bar label.
// Doubles: confirmed pairs each count as 1 team; every non-confirmed
// registration counts as 1 individual slot.
// Singles: one row = one player.
function countTeamSlots(rows: RosterRow[], isDoubles: boolean): number {
  if (!isDoubles) return rows.length;
  const confirmedCount = rows.filter(
    (r) => r.partner_status === "confirmed",
  ).length;
  const nonConfirmedCount = rows.length - confirmedCount;
  return confirmedCount / 2 + nonConfirmedCount;
}

function RosterToggleBar({
  rosterRows,
  isDoubles,
  rosterOpen,
  onToggle,
}: {
  rosterRows: RosterRow[];
  isDoubles: boolean;
  rosterOpen: boolean;
  onToggle: () => void;
}) {
  const teamSlots = countTeamSlots(rosterRows, isDoubles);
  const seekerCount = rosterRows.filter(
    (r) => r.partner_status === "seeking",
  ).length;
  const label = isDoubles ? "teams" : "players";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginTop: 10,
        paddingTop: 10,
        borderTop: "1px solid #f3f4f6",
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: 12, color: "#555" }}>
        {teamSlots} {label}
      </span>
      {seekerCount > 0 && (
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "#1e40af",
            background: "#dbeafe",
            border: "1px solid #bfdbfe",
            borderRadius: 999,
            padding: "2px 8px",
          }}
        >
          {seekerCount} seeking partner
        </span>
      )}
      <button
        type="button"
        onClick={onToggle}
        style={{
          marginLeft: "auto",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: 12,
          color: "#2563eb",
          fontFamily: "inherit",
          display: "flex",
          alignItems: "center",
          gap: 3,
          padding: 0,
        }}
      >
        {rosterOpen ? "Hide roster" : "Show roster"}
        <span
          style={{
            display: "inline-block",
            transform: rosterOpen ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 150ms",
          }}
        >
          ▾
        </span>
      </button>
    </div>
  );
}

function RosterPanel({
  rosterRows,
  event,
  isDoubles,
  myRegId,
  myIsRegistered,
  onPartnerUp,
}: {
  rosterRows: RosterRow[];
  event: Event;
  isDoubles: boolean;
  myRegId: string | null;
  // True when the current user already has any active reg for this event
  // (paid/pending_payment/awaiting_partner). Hides "Partner up →" on seekers.
  myIsRegistered: boolean;
  onPartnerUp: (seeker: { first_name: string; last_name: string }) => void;
}) {
  const seekers = rosterRows.filter((r) => r.partner_status === "seeking");
  const nonSeekers = rosterRows.filter((r) => r.partner_status !== "seeking");

  // Group doubles non-seekers into pairs. Each confirmed pair has two
  // rows pointing at each other via registration_id ↔
  // partner_registration_id. Unconfirmed rows render as singles.
  const teams: RosterRow[][] = [];
  if (isDoubles) {
    const placed = new Set<string>();
    for (const row of nonSeekers) {
      if (placed.has(row.registration_id)) continue;
      placed.add(row.registration_id);
      if (row.partner_registration_id) {
        const partner = nonSeekers.find(
          (r) => r.registration_id === row.partner_registration_id,
        );
        if (partner && !placed.has(partner.registration_id)) {
          placed.add(partner.registration_id);
          teams.push([row, partner]);
          continue;
        }
      }
      teams.push([row]);
    }
  } else {
    for (const row of nonSeekers) teams.push([row]);
  }

  // Sort: current user's team/row first.
  const myTeamIdx = teams.findIndex((t) =>
    t.some((r) => r.registration_id === myRegId),
  );
  if (myTeamIdx > 0) {
    const [myTeam] = teams.splice(myTeamIdx, 1);
    teams.unshift(myTeam);
  }

  // Sort seekers: current user first.
  const seekersSorted = [...seekers].sort((a) =>
    a.registration_id === myRegId ? -1 : 0,
  );

  const isMeSeeker = seekers.some((r) => r.registration_id === myRegId);
  const colStyle: CSSProperties = {
    fontSize: 12,
    color: "#555",
    padding: "4px 6px",
    verticalAlign: "middle",
  };

  return (
    <div
      style={{
        marginTop: 8,
        border: "1px solid #e5e7eb",
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      {/* Section 1: seeking partner */}
      {seekersSorted.length > 0 && (
        <div>
          <div
            style={{
              padding: "6px 10px",
              background: "#eff6ff",
              borderBottom: "1px solid #bfdbfe",
              fontSize: 11,
              fontWeight: 700,
              color: "#1e40af",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            Looking for a partner
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {seekersSorted.map((row) => {
                const isMe = row.registration_id === myRegId;
                const rating = rosterRating(row, event);
                return (
                  <tr
                    key={row.registration_id}
                    style={{
                      background: isMe ? "#eff6ff" : undefined,
                      borderBottom: "1px solid #f3f4f6",
                    }}
                  >
                    <td style={{ ...colStyle, fontWeight: isMe ? 600 : undefined }}>
                      {row.first_name} {row.last_name}
                      {isMe && (
                        <span
                          style={{
                            marginLeft: 5,
                            fontSize: 10,
                            color: "#2563eb",
                            fontWeight: 700,
                          }}
                        >
                          ← you
                        </span>
                      )}
                    </td>
                    <td style={colStyle}>
                      {rating != null ? rating.toFixed(2) : "--"}
                    </td>
                    <td style={colStyle}>
                      {(row.age as number | null) != null ? String(row.age) : "--"}
                    </td>
                    <td style={colStyle}>
                      {row.gender ? capitalize(row.gender) : "--"}
                    </td>
                    <td style={{ ...colStyle, textAlign: "right" }}>
                      {!isMe && !myIsRegistered && !isMeSeeker && (
                        <button
                          type="button"
                          onClick={() => onPartnerUp(row)}
                          style={{
                            padding: "4px 10px",
                            background: "#2563eb",
                            color: "#fff",
                            border: "none",
                            borderRadius: 4,
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: "pointer",
                            fontFamily: "inherit",
                            whiteSpace: "nowrap",
                          }}
                        >
                          Partner up →
                        </button>
                      )}
                      {isMeSeeker && !isMe && (
                        <button
                          type="button"
                          onClick={() => onPartnerUp(row)}
                          style={{
                            padding: "4px 10px",
                            background: "#2563eb",
                            color: "#fff",
                            border: "none",
                            borderRadius: 4,
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: "pointer",
                            fontFamily: "inherit",
                            whiteSpace: "nowrap",
                          }}
                        >
                          Partner up →
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Section 2: registered teams / players */}
      {teams.length > 0 && (
        <div>
          <div
            style={{
              padding: "6px 10px",
              background: "#f9fafb",
              borderTop: seekersSorted.length > 0 ? "1px solid #e5e7eb" : undefined,
              borderBottom: "1px solid #e5e7eb",
              fontSize: 11,
              fontWeight: 700,
              color: "#555",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            {isDoubles ? "Registered teams" : "Registered players"}
          </div>
          <div style={{ background: "#fafafa" }}>
            {teams.map((team, i) => {
              const isMyTeam = team.some((r) => r.registration_id === myRegId);
              const isPair = team.length === 2;
              return (
                <div
                  key={i}
                  style={{
                    borderLeft: isPair ? "3px solid #93c5fd" : undefined,
                    paddingLeft: isPair ? 0 : undefined,
                    background: isMyTeam ? "#f0fdf4" : undefined,
                    borderBottom:
                      i < teams.length - 1 ? "1px solid #e5e7eb" : undefined,
                  }}
                >
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <tbody>
                      {team.map((row, ri) => {
                        const isMe = row.registration_id === myRegId;
                        const rating = rosterRating(row, event);
                        const loc = [row.city as string | null, row.state as string | null]
                          .filter(Boolean)
                          .join(", ");
                        return (
                          <tr
                            key={row.registration_id}
                            style={{
                              borderBottom:
                                isPair && ri === 0
                                  ? "1px solid #e5e7eb"
                                  : undefined,
                            }}
                          >
                            <td style={{ ...colStyle, fontWeight: isMe ? 600 : undefined }}>
                              {row.first_name} {row.last_name}
                              {isMe && (
                                <span
                                  style={{
                                    marginLeft: 5,
                                    fontSize: 10,
                                    color: "#16a34a",
                                    fontWeight: 700,
                                  }}
                                >
                                  ← you
                                </span>
                              )}
                            </td>
                            <td style={colStyle}>
                              {rating != null ? rating.toFixed(2) : "--"}
                            </td>
                            <td style={colStyle}>
                              {(row.age as number | null) != null ? String(row.age) : "--"}
                            </td>
                            <td style={colStyle}>
                              {row.gender ? capitalize(row.gender) : "--"}
                            </td>
                            <td style={{ ...colStyle, color: "#888" }}>
                              {loc || "--"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {rosterRows.length === 0 && (
        <div
          style={{
            padding: "14px 12px",
            fontSize: 12,
            color: "#888",
            textAlign: "center",
          }}
        >
          No registrations yet.
        </div>
      )}
    </div>
  );
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

