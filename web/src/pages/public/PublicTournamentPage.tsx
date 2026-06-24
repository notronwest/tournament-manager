import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import { checkEligibility, eligibilityChips } from "../../lib/eligibility";
import {
  deriveRegistrationStatus,
  pickActivePricingTier,
  type PricingTier,
} from "../../lib/pricingTiers";
import type { Database } from "../../types/supabase";
import {
  bg as v5Bg,
  ink,
  inkSoft,
  inkMuted,
  cream,
  creamDeep,
  rule,
  courtGreen,
  courtYellow,
  courtRed,
  courtBlue,
  displayFontStack,
  headingFontStack,
  monoFontStack,
  pageWrapStyle,
  contentColStyle,
  sectionH2Style,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  ctaSecondaryStyle,
  panelMutedStyle,
  statusPanelStyle,
  warnBg,
  warnFg,
  dangerBg,
  dangerFg,
  successBg,
  successFg,
} from "../../lib/publicTheme";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"] & {
  locations: {
    id: string;
    name: string;
    address: string | null;
    address_line2: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
    court_count: number | null;
    net_type: Database["public"]["Enums"]["net_type"] | null;
    surface_type: Database["public"]["Enums"]["surface_type"] | null;
    surface_notes: string | null;
    ceiling_height_min_ft: number | null;
    ceiling_height_max_ft: number | null;
    pickleball_type: string | null;
  } | null;
};
function composeLocationAddress(loc: {
  address?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
}): string | null {
  const parts: string[] = [];
  if (loc.address) parts.push(loc.address);
  if (loc.address_line2) parts.push(loc.address_line2);
  const stateZip =
    loc.state && loc.postal_code
      ? `${loc.state} ${loc.postal_code}`
      : (loc.state ?? loc.postal_code ?? null);
  const cityStateZip = [loc.city, stateZip].filter(Boolean).join(", ");
  if (cityStateZip) parts.push(cityStateZip);
  return parts.length > 0 ? parts.join(", ") : null;
}

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
    | "invited"
    // On the waitlist (free, not yet promoted)
    | "waitlisted"
    // Promoted off the waitlist — a spot is reserved, pay to claim it
    | "waitlisted_pending_payment";
  // The id of my event_registrations row — null only for 'invited'.
  // Used by Cancel-pending to know which row to soft-delete.
  regId: string | null;
  partnerLabel: string | null;
  partnerEmail: string | null;
  partnerPhone: string | null;
  inviteToken: string | null;
  inviterName: string | null;
  // F1: true when partner_status='seeking' on my reg — I'm
  // registered but explicitly looking for a partner. Rendered as
  // a secondary "Looking for a partner" badge alongside the
  // state pill so the user sees both bits of info.
  isSeekingPartner: boolean;
  // Set when I have a pending outbound invite to a named player
  // (invitee_player_id filled). Used by RosterPanel to suppress
  // that seeker from "Looking for a partner" and show them as my
  // pending partner instead (viewer-specific, #212).
  pendingInviteeName: { first_name: string; last_name: string } | null;
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

// Checked once per page lifetime — does not change during a session.
const prefersReducedMotion =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Phone-width layout. Mobile-first: where a row places actions beside content,
// it stacks on mobile so the content column never collapses (the EventCard
// header otherwise squeezed its meta text to one character per line — #500).
const isMobileViewport =
  typeof window !== "undefined" &&
  window.matchMedia("(max-width: 767px)").matches;

// Public tournament page at /t/:orgSlug/:tournamentSlug. Anonymous-
// readable thanks to existing RLS: tournaments + events with status
// in ('published', 'closed', 'completed') are readable by anyone.
// Draft tournaments are invisible here; the only way to reach a
// draft is through the admin UI.
//
// This page is intentionally read-only — the Register CTA links to
// /t/:orgSlug/:tournamentSlug/register which is auth-gated (built
// in the next commit on this branch).
export default function PublicTournamentPage({
  orgSlugOverride,
  tournamentSlugOverride,
}: {
  // Set when rendered at the root of a custom domain (#408) instead of the
  // /t/:orgSlug/:tournamentSlug route — the slugs come from the host
  // mapping rather than the URL path.
  orgSlugOverride?: string;
  tournamentSlugOverride?: string;
} = {}) {
  const params = useParams<{
    orgSlug: string;
    tournamentSlug: string;
  }>();
  const orgSlug = orgSlugOverride ?? params.orgSlug;
  const tournamentSlug = tournamentSlugOverride ?? params.tournamentSlug;
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

  // #98: which event's register form is currently in focus mode.
  // null = no card focused; a string event_id = that card is lifted
  // above the scrim and all siblings are dimmed + inert.
  const [focusedEventId, setFocusedEventId] = useState<string | null>(null);

  // #208: pricing schedule expand/collapse — collapsed by default so
  // single-price tournaments see no extra chrome and staged-pricing
  // users can dig in on demand.
  const [pricingExpanded, setPricingExpanded] = useState(false);

  // Public page is split into tabs (Details first, then Register). Built to
  // grow — Schedule / Results land here later. Details = pricing + the info
  // sections; Register = the events list (+ inbound-invite banner).
  const [tab, setTab] = useState<"details" | "register">("details");

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
      .select("*, locations(id, name, address, address_line2, city, state, postal_code, court_count, net_type, surface_type, surface_notes, ceiling_height_min_ft, ceiling_height_max_ft, pickleball_type)")
      .eq("organization_id", org.id)
      .eq("slug", tournamentSlug)
      .in("status", ["published", "closed", "completed", "cancelled"])
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
             player:players!player_id (first_name, last_name, email, phone)
           )`,
        )
        .eq("player_id", myPlayer.id)
        .in("event_id", eventIds)
        .is("deleted_at", null),
      supabase
        .from("partner_invites")
        .select(
          `event_id, invitee_email,
           invitee:players!invitee_player_id (first_name, last_name, email, phone)`,
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
        | { player: { first_name: string; last_name: string; email: string | null; phone: string | null } | null }
        | null;
    };
    type OutboundRow = {
      event_id: string;
      invitee_email: string | null;
      invitee: { first_name: string; last_name: string; email: string | null; phone: string | null } | null;
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
      const partnerEmail = partner?.email ?? null;
      const partnerPhone = partner?.phone ?? null;
      // Derive the per-card state from the reg's payment + partner
      // status. pending_payment wins over partner_status (haven't
      // committed yet); for paid regs the partner_status splits
      // "paid" vs "awaiting_partner".
      let state: MyRegStatus["state"];
      if (r.status === "pending_payment") {
        state = "pending_payment";
      } else if (r.status === "waitlisted") {
        state = "waitlisted";
      } else if (r.status === "waitlisted_pending_payment") {
        state = "waitlisted_pending_payment";
      } else if (r.partner_status === "pending") {
        state = "awaiting_partner";
      } else {
        state = "paid";
      }
      map.set(r.event_id, {
        state,
        regId: r.id,
        partnerLabel,
        partnerEmail,
        partnerPhone,
        inviteToken: null,
        inviterName: null,
        isSeekingPartner: r.partner_status === "seeking",
        pendingInviteeName: null,
      });
    }
    // Outbound invites: fill in invitee names for pending state
    // where we didn't already have a partnerLabel from the reg join.
    // Also capture the invitee's first/last name so RosterPanel can
    // suppress that seeker from "Looking for a partner" (#212).
    for (const inv of (outboundRes.data ?? []) as unknown as OutboundRow[]) {
      const cur = map.get(inv.event_id);
      const label = inv.invitee
        ? `${inv.invitee.first_name} ${inv.invitee.last_name}`
        : inv.invitee_email ?? null;
      if (cur && !cur.partnerLabel) {
        map.set(inv.event_id, {
          ...cur,
          partnerLabel: label,
          pendingInviteeName: inv.invitee ?? null,
          partnerEmail: inv.invitee?.email ?? null,
          partnerPhone: inv.invitee?.phone ?? null,
        });
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
        partnerEmail: cur?.partnerEmail ?? null,
        partnerPhone: cur?.partnerPhone ?? null,
        inviteToken: inv.token,
        inviterName,
        isSeekingPartner: cur?.isSeekingPartner ?? false,
        pendingInviteeName: cur?.pendingInviteeName ?? null,
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

  // Open every tournament on Details first. The component instance persists
  // across /t/:slug navigations, so without this the tab would carry over
  // from the previous tournament.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTab("details");
  }, [orgSlug, tournamentSlug]);

  if (loading) {
    return (
      <Shell>
        <p style={{ color: inkMuted, fontSize: 14 }}>Loading…</p>
      </Shell>
    );
  }
  if (error || !tournament) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 8px", fontSize: 22, fontFamily: displayFontStack }}>Not available</h1>
        <p style={{ color: inkSoft, fontSize: 14, margin: 0 }}>
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
  const sortedTiers = [...tiers].sort((a, b) => a.sort_order - b.sort_order);
  const activeTier = pickActivePricingTier(tiers);
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
  return (
  <>
    {/* #98: translucent scrim — always in the DOM so the CSS opacity
        transition fires on both open and close. pointer-events:none
        when inactive so it never intercepts normal page clicks.
        Clicking the scrim is intentionally inert: while registering,
        the overlay only closes via the form's Cancel button (or a
        successful submit). pointer-events:auto while focused still
        blocks stray clicks from reaching the dimmed cards behind it. */}
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20, 24, 31, 0.55)",
        backdropFilter: "saturate(0.7) blur(1px)",
        zIndex: 50,
        opacity: focusedEventId ? 1 : 0,
        pointerEvents: focusedEventId ? "auto" : "none",
        transition: prefersReducedMotion ? undefined : "opacity 0.2s ease",
        cursor: "default",
      }}
    />
    <Shell>
      <header
        style={{
          background: `linear-gradient(180deg, ${cream} 0%, ${creamDeep} 100%)`,
          borderRadius: 10,
          padding: "40px 32px 32px",
          marginBottom: 24,
          position: "relative",
        }}
      >
        <div
          style={{
            fontFamily: monoFontStack,
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.2em",
            color: courtRed,
            fontWeight: 700,
            marginBottom: 10,
          }}
        >
          Tournament
        </div>
        <h1
          style={{
            fontFamily: displayFontStack,
            fontSize: "clamp(32px, 5vw, 52px)",
            lineHeight: 0.95,
            margin: "0 0 14px",
            color: ink,
          }}
        >
          {tournament.name}
        </h1>
        {/* At-a-glance: event dates, registration window, and cost — kept in
            the header so they're always visible. Venue/format details + the
            full description live under the Details tab. */}
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 4 }}>
          <Meta
            label="When"
            value={`${fmtDate(tournament.starts_at)} – ${fmtDate(tournament.ends_at)}`}
          />
          <Meta
            label="Registration"
            value={
              regStatus.tone === "soon" && tournament.registration_opens_at
                ? `Opens ${fmtDateTime(tournament.registration_opens_at)}`
                : registrationOpen && tournament.registration_closes_at
                  ? `Closes ${fmtDateTime(tournament.registration_closes_at)}`
                  : regStatus.tone === "closed"
                    ? "Closed"
                    : "Open"
            }
          />
          {regFeeCents > 0 && (
            <div style={{ marginLeft: "auto", textAlign: "right" }}>
              <div
                style={{
                  fontFamily: displayFontStack,
                  fontSize: 30,
                  fontWeight: 700,
                  color: ink,
                  lineHeight: 1.0,
                }}
              >
                ${(regFeeCents / 100).toFixed(0)}
              </div>
              <div style={{ fontSize: 13, color: inkSoft, marginTop: 3 }}>
                to register · includes 1 event
              </div>
              {additionalFeeCents > 0 && (
                <div style={{ fontSize: 12, color: inkMuted, marginTop: 1 }}>
                  +${(additionalFeeCents / 100).toFixed(0)} each additional event
                </div>
              )}
              {isMultiTier && activeTier && (
                <div
                  style={{
                    fontFamily: monoFontStack,
                    fontSize: 11,
                    color: courtBlue,
                    marginTop: 3,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                  }}
                >
                  {activeTier.label}
                  {activeTier.ends_at
                    ? ` · ends ${fmtShortDate(activeTier.ends_at)}`
                    : " · ongoing"}
                </div>
              )}
              {isMultiTier && (
                <button
                  onClick={() => setPricingExpanded((e) => !e)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: "3px 0 0",
                    cursor: "pointer",
                    fontSize: 12,
                    color: courtBlue,
                    textDecoration: "underline",
                    textUnderlineOffset: 2,
                    display: "block",
                    width: "100%",
                    textAlign: "right",
                  }}
                >
                  {pricingExpanded
                    ? "Hide pricing schedule"
                    : "See full pricing schedule"}
                </button>
              )}
            </div>
          )}
        </div>
        {/* Full pricing schedule — expanded on demand, inside the header. */}
        {isMultiTier && pricingExpanded && (
          <div
            style={{
              marginTop: 14,
              borderTop: `1px solid ${rule}`,
              paddingTop: 12,
              maxWidth: 520,
            }}
          >
            {sortedTiers.map((tier) => {
              const isActive = tier.id === activeTier?.id;
              return (
                <div
                  key={tier.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    padding: "5px 0",
                    borderBottom: `1px solid ${rule}`,
                    opacity: isActive ? 1 : 0.7,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: isActive ? 600 : 400,
                        color: isActive ? ink : inkSoft,
                      }}
                    >
                      {tier.label}
                      {isActive && (
                        <span
                          style={{
                            marginLeft: 6,
                            fontFamily: monoFontStack,
                            fontSize: 9,
                            textTransform: "uppercase",
                            letterSpacing: "0.1em",
                            color: courtBlue,
                          }}
                        >
                          active
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: inkMuted, marginTop: 1 }}>
                      {tier.starts_at
                        ? fmtShortDate(tier.starts_at)
                        : "start of registration"}
                      {" – "}
                      {tier.ends_at ? fmtShortDate(tier.ends_at) : "no end date"}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: isActive ? 600 : 400,
                        color: isActive ? ink : inkSoft,
                      }}
                    >
                      ${(tier.first_event_fee_cents / 100).toFixed(0)}
                    </div>
                    {tier.additional_event_fee_cents > 0 && (
                      <div style={{ fontSize: 11, color: inkMuted, marginTop: 1 }}>
                        +${(tier.additional_event_fee_cents / 100).toFixed(0)} add'l
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <span
          style={{
            position: "absolute",
            top: 24,
            right: 24,
            background:
              regStatus.tone === "open"
                ? courtGreen
                : regStatus.tone === "soon"
                  ? courtYellow
                  : inkMuted,
            color:
              regStatus.tone === "soon" ? ink : v5Bg,
            padding: "6px 14px",
            borderRadius: 999,
            fontFamily: headingFontStack,
            fontSize: 12,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {regStatus.tone === "open" && (
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: courtYellow,
                display: "inline-block",
              }}
            />
          )}
          {regStatus.label}
        </span>
        <div
          style={{
            marginTop: 20,
            display: "flex",
            gap: 20,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <Link
            to={`/t/${orgSlug}/${tournamentSlug}/contact`}
            style={{
              fontSize: 13,
              color: inkSoft,
              textDecoration: "none",
              fontFamily: headingFontStack,
            }}
          >
            Contact organizers →
          </Link>
          {/* Charity donations (#377): only shown when the organizer has
              opted this tournament in. */}
          {tournament.accepts_donations && (
            <Link
              to={`/t/${orgSlug}/${tournamentSlug}/donate`}
              style={{
                fontSize: 13,
                color: courtRed,
                textDecoration: "none",
                fontFamily: headingFontStack,
                fontWeight: 600,
              }}
            >
              Donate ♥
            </Link>
          )}
        </div>
      </header>

      {tournament.status === "cancelled" && (
        <div
          style={{
            ...statusPanelStyle("danger"),
            marginBottom: 24,
            fontWeight: 600,
          }}
        >
          This tournament has been cancelled.
        </div>
      )}

      {/* Venue / format — kept under the header (not inside a tab) so it's
          always visible. Sourced from the tournament's location. */}
      {(tournament.locations ?? tournament.location_name) && (
        <div
          style={{
            display: "flex",
            gap: 24,
            flexWrap: "wrap",
            marginBottom: 24,
          }}
        >
          <Meta
            label="Where"
            value={(() => {
              if (tournament.locations) {
                const addrStr = composeLocationAddress(tournament.locations);
                return addrStr
                  ? `${tournament.locations.name} · ${addrStr}`
                  : tournament.locations.name;
              }
              return tournament.location_address
                ? `${tournament.location_name} · ${tournament.location_address}`
                : tournament.location_name!;
            })()}
          />
          {tournament.locations?.court_count != null && (
            <Meta label="Courts" value={String(tournament.locations.court_count)} />
          )}
          {tournament.locations?.net_type && (
            <Meta label="Nets" value={tournament.locations.net_type === "permanent" ? "Permanent" : "Moveable"} />
          )}
          {tournament.locations?.surface_type && (
            <Meta
              label="Surface"
              value={
                tournament.locations.surface_type === "concrete" ? "Concrete"
                : tournament.locations.surface_type === "asphalt" ? "Asphalt"
                : tournament.locations.surface_type === "cushion_core" ? "Cushion Core"
                : tournament.locations.surface_type === "hardwood" ? "Hardwood"
                : tournament.locations.surface_type === "polycarbonate" ? "Polycarbonate"
                : tournament.locations.surface_type === "polyurethane" ? "Polyurethane"
                : tournament.locations.surface_notes
                  ? `Other (${tournament.locations.surface_notes})`
                  : "Other"
              }
            />
          )}
          {(tournament.locations?.ceiling_height_min_ft != null || tournament.locations?.ceiling_height_max_ft != null) && (
            <Meta
              label="Ceiling"
              value={
                tournament.locations!.ceiling_height_min_ft != null && tournament.locations!.ceiling_height_max_ft != null
                  ? `${tournament.locations!.ceiling_height_min_ft}–${tournament.locations!.ceiling_height_max_ft} ft`
                  : tournament.locations!.ceiling_height_max_ft != null
                    ? `${tournament.locations!.ceiling_height_max_ft} ft`
                    : `${tournament.locations!.ceiling_height_min_ft} ft min`
              }
            />
          )}
          {(tournament.pickleball_type ?? tournament.locations?.pickleball_type) && (
            <Meta
              label="Ball"
              value={(tournament.pickleball_type ?? tournament.locations?.pickleball_type)!}
            />
          )}
        </div>
      )}

      {/* Section tabs — Details first, Register one click away. Built to
          grow: Schedule / Results can slot in here later. */}
      <div
        role="tablist"
        aria-label="Tournament sections"
        style={{
          display: "flex",
          gap: 4,
          borderBottom: `1px solid ${rule}`,
          marginBottom: 24,
        }}
      >
        {(
          [
            ["details", "Details"],
            ["register", "Register"],
          ] as const
        ).map(([key, label]) => {
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(key)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontFamily: headingFontStack,
                fontSize: 14,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                padding: "10px 14px",
                color: active ? ink : inkMuted,
                borderBottom: active
                  ? `3px solid ${courtRed}`
                  : "3px solid transparent",
                marginBottom: -1,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {tab === "register" && (
      <>
      {/* Pending-invite banner — the most actionable thing on the
          page for a player who just got picked, so it lives above
          the events list. One row per inbound invite; each row has
          its own Accept button that drops the user on the existing
          partner-accept page. */}
      {inboundInvites.length > 0 && (
        <section
          style={{
            ...statusPanelStyle("warn"),
            marginBottom: 24,
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 8,
            }}
          >
            You've been invited to be someone's partner
            {inboundInvites.length > 1 ? ` (${inboundInvites.length})` : ""}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {inboundInvites.map((inv) => (
              <div
                key={inv.token}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: 10,
                  background: v5Bg,
                  borderRadius: 6,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ fontSize: 13, color: ink }}>
                  <strong>{inv.inviterName}</strong> invited you for{" "}
                  <strong>{inv.eventName}</strong>
                </div>
                <Link
                  to={`/t/${orgSlug}/${tournamentSlug}/invites/${inv.token}`}
                  style={{
                    padding: "6px 14px",
                    background: courtBlue,
                    color: v5Bg,
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
        <h2 style={sectionH2Style}>Events ({events.length})</h2>
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
                isFocused={focusedEventId === ev.id}
                isDimmed={focusedEventId !== null && focusedEventId !== ev.id}
                onRequestFocus={() => setFocusedEventId(ev.id)}
                onReleaseFocus={() => setFocusedEventId(null)}
                onChanged={async () => {
                  // Refetch both the page's local state AND the
                  // site-wide pending bar — they read different
                  // slices of the same rows.
                  await Promise.all([reload(), refreshPending()]);
                }}
                onNeedsAuth={() => {
                  const back = `/t/${orgSlug}/${tournamentSlug}`;
                  if (user && !me) {
                    // Already signed in but no player profile yet — send them
                    // to complete it and return, NOT to /login (mirrors
                    // RequireProfile's ?return= convention). Bouncing an
                    // authenticated user to /login is what made Register look
                    // like it "logs you out."
                    navigate(`/profile?return=${encodeURIComponent(back)}`);
                  } else {
                    // Anon visitor → sign in, then come back here.
                    navigate("/login", { state: { from: { pathname: back } } });
                  }
                }}
              />
            ))}
          </div>
        )}
      </section>
      </>
      )}

      {tab === "details" && (
      <>
      {/* Empty state — venue meta now lives in the persistent strip, so the
          Details tab is just the description + info sections; note if none. */}
      {!tournament.description &&
        !tournament.cancellation_policy_preset &&
        !tournament.refund_policy_md &&
        !tournament.weather_md &&
        !tournament.facility_info_md &&
        !tournament.additional_info_md &&
        !tournament.sponsors_md &&
        !tournament.faqs_md && (
          <p style={{ color: inkMuted, fontSize: 14, margin: 0 }}>
            No additional details have been posted yet.
          </p>
        )}
      {/* Description */}
      {tournament.description && (
        <p
          style={{
            color: inkSoft,
            margin: "0 0 24px",
            fontSize: 15,
            lineHeight: 1.6,
            maxWidth: 640,
          }}
        >
          {nl2br(tournament.description)}
        </p>
      )}
      {/* Where/Courts/Nets/Surface/Ceiling moved to the persistent venue
          strip under the header. */}
      {/* Refund policy — combines cancellation preset (mechanism) with
          refund_policy_md (the organizer's copy). Show if either is set. */}
      {(tournament.cancellation_policy_preset || tournament.refund_policy_md) && (
        <TournamentContentSection title="Refund policy">
          {tournament.cancellation_policy_preset && (
            <p style={{ margin: "0 0 10px", lineHeight: 1.6 }}>
              <strong>Cancellation policy: </strong>
              {cancellationPresetSummary(tournament.cancellation_policy_preset)}
            </p>
          )}
          {tournament.refund_policy_md && renderSimpleMd(tournament.refund_policy_md)}
        </TournamentContentSection>
      )}

      {tournament.weather_md && (
        <TournamentContentSection title="Weather plan">
          {renderSimpleMd(tournament.weather_md)}
        </TournamentContentSection>
      )}

      {tournament.facility_info_md && (
        <TournamentContentSection title="Facility info">
          {renderSimpleMd(tournament.facility_info_md)}
        </TournamentContentSection>
      )}

      {tournament.additional_info_md && (
        <TournamentContentSection title="Additional info">
          {renderSimpleMd(tournament.additional_info_md)}
        </TournamentContentSection>
      )}

      {tournament.sponsors_md && (
        <TournamentContentSection title="Sponsors">
          {renderSimpleMd(tournament.sponsors_md)}
        </TournamentContentSection>
      )}

      {tournament.faqs_md && (
        <TournamentContentSection title="FAQs">
          {renderSimpleMd(tournament.faqs_md)}
        </TournamentContentSection>
      )}
      </>
      )}

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

// Maps event format × gender to a left-border accent color so card type
// is readable at a glance. Single source of truth — EventCard calls this;
// don't inline these values elsewhere.
//
// CVD note: courtGreen (men-doubles) and courtRed (mixed-doubles) share the
// red-green axis and may read similarly for deuteranopes/protanopes. The
// format label and gender chip on the card still disambiguate. Add a legend
// with text labels if a dense grid view is introduced later.
function eventTypeColor(
  format: Database["public"]["Enums"]["event_format"],
  gender: Database["public"]["Enums"]["event_gender"],
): string {
  if (format === "singles" && gender === "men")   return courtBlue;    // #1e6cd6
  if (format === "singles" && gender === "women") return "#7eb5f5";    // light blue
  if (format === "doubles" && gender === "men")   return courtGreen;   // #2c8a3d
  if (format === "doubles" && gender === "women") return "#9333ea";    // purple
  if (format === "doubles" && gender === "mixed") return courtRed;     // #d8341c
  if (format === "doubles" && gender === "open")  return "#0891b2";    // teal — paired roles
  return inkMuted; // fallback: singles·mixed or any unexpected combo
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
  isFocused,
  isDimmed,
  onRequestFocus,
  onReleaseFocus,
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
  // #98: focus overlay. isFocused = this card is lifted above the
  // scrim. isDimmed = another card is focused; this card goes
  // behind the scrim, grayscale + inert.
  isFocused: boolean;
  isDimmed: boolean;
  onRequestFocus: () => void;
  onReleaseFocus: () => void;
  onChanged: () => Promise<void> | void;
  onNeedsAuth: () => void;
}) {
  const chips = eligibilityChips(event);
  const isDoubles = event.format === "doubles";

  // Capacity: the event is "full" when active teams reach max_teams. Mirrors
  // the roster count label below so the CTA flips to "Join waitlist" exactly
  // when the card reads "N of N teams". join_waitlist re-checks server-side, so
  // a stale client count can't actually waitlist into a non-full event.
  const activeTeamCount = isDoubles
    ? Math.floor(
        rosterRows.filter((r) => r.partner_status === "confirmed").length / 2,
      ) +
      rosterRows.filter((r) => r.partner_status === "pending").length +
      rosterRows.filter(
        (r) =>
          r.partner_status === "seeking" && r.pending_partner_reg_id === null,
      ).length
    : rosterRows.length;
  const isFull = event.max_teams != null && activeTeamCount >= event.max_teams;

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
  // Paired-roles: which of the two sides the registrant is on ('a'
  // or 'b'). Only relevant when event.is_paired_roles is true; null
  // otherwise. Must be set before submitting a paired-roles reg.
  const [registrationSide, setRegistrationSide] = useState<"a" | "b" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // #9: gate the partner-dropping Cancel behind a confirm step.
  const [confirmCancel, setConfirmCancel] = useState(false);
  // Leaving the waitlist costs the player their place in line, so gate
  // it behind a confirm step too.
  const [confirmLeaveWaitlist, setConfirmLeaveWaitlist] = useState(false);
  // #9: same guard for backing out of the register FORM after a
  // partner is picked (discards the in-progress pick).
  const [confirmDiscardForm, setConfirmDiscardForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Roster panel collapsed by default; toggled by the toggle bar.
  const [rosterOpen, setRosterOpen] = useState(false);

  // ─── Refs for #98 focus management ───────────────────────────────
  // cardRef: root div — for the `inert` attribute and focus-trap query.
  // registerBtnRef: the Register button — keyboard focus returns here
  //   when focus mode exits, restoring the user's position.
  const cardRef = useRef<HTMLDivElement>(null);
  const registerBtnRef = useRef<HTMLButtonElement>(null);
  // Stable ref so the keydown effect always calls the latest
  // requestDiscardForm without re-running on every render.
  const requestDiscardFormRef = useRef<() => void>(() => {});

  // ─── Eligibility: compute once, gate the Register button ─────────
  const { eligible: playerEligible, reasons: eligibilityReasons } = me
    ? checkEligibility(me, event)
    : { eligible: true, reasons: [] as string[] };

  // ─── Derived state for visual treatment ──────────────────────────
  const isPaid =
    myStatus?.state === "paid" || myStatus?.state === "awaiting_partner";
  const isPending = myStatus?.state === "pending_payment";
  // #194 a11y: all three "action needed" states get the amber wash
  // (pending_payment, awaiting_partner, invited) — amber bg + amber border
  // color, with dark-ink text/pills (handled below) for contrast.
  const isAmberCard =
    isPending ||
    myStatus?.state === "awaiting_partner" ||
    myStatus?.state === "invited";
  // Left border encodes the EVENT TYPE (#152), independent of status.
  const cardBorderLeft = `6px solid ${eventTypeColor(event.format, event.gender)}`;
  const cardBorderColor = isAmberCard ? courtYellow : isPaid ? courtGreen : rule;
  const cardBg = isAmberCard ? warnBg : "#fff";

  // ─── Handlers ────────────────────────────────────────────────────
  const startRegister = () => {
    if (!user || !me) {
      // Anon visitor or no profile yet — bounce through auth, then
      // they come back here and click Register again.
      onNeedsAuth();
      return;
    }
    onRequestFocus();
    setEditMode("register");
    setPartner(emptySelection);
    setSeekingPartner(false);
    setRegistrationSide(null);
    setFormError(null);
  };

  // F-#9: open the expanded form on a PENDING reg to swap partner
  // without losing the reg itself. Pre-fills "seekingPartner" with
  // the current state so toggling between picking-a-partner and
  // seeking is a one-click affordance.
  // Note: change-partner does NOT enter focus mode — only the
  // initial Register action focuses the card (#98).
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
    setRegistrationSide(null);
    setFormError(null);
    onReleaseFocus();
  };

  // ─── #98: collapse form when focus is released externally ────────
  // Defensive: if focusedEventId is cleared at the page level while
  // this card still has an open form (editMode set), collapse it.
  // The scrim no longer triggers this (clicking outside is inert) —
  // closing goes through the Cancel button / submit — but keep the
  // guard so any future external focus release stays consistent.
  useEffect(() => {
    if (!isFocused && editMode !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditMode(null);
      setPartner(emptySelection);
      setSeekingPartner(false);
      setRegistrationSide(null);
      setFormError(null);
    }
  // Intentionally omit editMode from deps: only fire when isFocused
  // changes, not on every form interaction.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused]);

  // ─── #98: set/clear `inert` + `aria-hidden` on dimmed siblings ───
  // `inert` is not in React 18 JSX types; set it imperatively.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    if (isDimmed) {
      el.setAttribute("inert", "");
      el.setAttribute("aria-hidden", "true");
    } else {
      el.removeAttribute("inert");
      el.removeAttribute("aria-hidden");
    }
  }, [isDimmed]);

  // ─── #98: focus trap + Esc key while this card is focused ────────
  useEffect(() => {
    if (!isFocused) {
      // Focus released — restore keyboard position to Register button
      // after the re-render that makes it visible again.
      requestAnimationFrame(() => registerBtnRef.current?.focus());
      return;
    }

    const card = cardRef.current;

    const getFocusables = (): HTMLElement[] => {
      if (!card) return [];
      return Array.from(
        card.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), ' +
          'select:not([disabled]), textarea:not([disabled]), ' +
          '[tabindex]:not([tabindex="-1"])',
        ),
      );
    };

    // Bring the top of the now-expanded card into view so the user
    // doesn't have to scroll down to the register form. preventScroll
    // on the focus() below keeps the initial focus from yanking the
    // viewport back down to the first input.
    requestAnimationFrame(() => {
      card?.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "start",
      });
    });

    // Move initial focus to the first interactive element in the card.
    requestAnimationFrame(() => getFocusables()[0]?.focus({ preventScroll: true }));

    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Esc respects the existing discard-confirm flow: if a partner
        // is already picked it shows the confirm modal first, then
        // cancelExpand (which calls onReleaseFocus) on confirmation.
        requestDiscardFormRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = getFocusables();
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    const btnRef = registerBtnRef.current;
    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("keydown", handleKeydown);
      requestAnimationFrame(() => btnRef?.focus());
    };
  }, [isFocused]);

  const onSubmitRegister = async () => {
    if (!me) {
      onNeedsAuth();
      return;
    }
    setFormError(null);

    // Validate paired-roles side selection (required before partner pick).
    if (event.is_paired_roles && isDoubles && !registrationSide) {
      setFormError(
        `Choose which side you're registering as — ${event.side_a_label} or ${event.side_b_label}.`,
      );
      return;
    }

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

    const { eligible, reasons } = checkEligibility(me, event);
    if (!eligible) {
      setFormError(`Not eligible: ${reasons.join("; ")}.`);
      return;
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
    if (isFull) {
      // FULL event → join the WAITLIST (free). join_waitlist creates a
      // 'waitlisted' reg (partner_status seeking for doubles / solo for
      // singles) and re-checks fullness server-side. No checkout — payment
      // only happens after promotion (status → waitlisted_pending_payment).
      // If a partner was picked, the outbound-invite block below still runs.
      const { data: wlData, error: wlErr } = await supabase.rpc(
        "join_waitlist",
        { p_event_id: event.id },
      );
      if (wlErr) {
        setFormError(
          wlErr.message?.includes("event_not_full")
            ? "A spot just opened up — close this and register normally."
            : (wlErr.message ?? "Couldn't join the waitlist. Please try again."),
        );
        setSubmitting(false);
        return;
      }
      // join_waitlist always sets partner_status='seeking'. If the player
      // actually picked a partner, flip the new reg to 'pending' so the card
      // shows "Invited X" (the outbound-invite block below) instead of
      // "Looking for partner".
      const wlRegId = wlData?.[0]?.reg_id;
      if (isDoubles && !seekingPartner && resolvedPartnerId && wlRegId) {
        await supabase
          .from("event_registrations")
          .update({ partner_status: "pending" })
          .eq("id", wlRegId);
      }
    } else {
      const { error: regErr } = await supabase
        .from("event_registrations")
        .insert({
          event_id: event.id,
          player_id: me.id,
          event_fee_cents: 0,
          status: "pending_payment",
          partner_status: partnerStatusOnInsert,
          ...(event.is_paired_roles && registrationSide
            ? { registration_side: registrationSide }
            : {}),
        })
        .select()
        .single();
      if (regErr) {
        setFormError(regErr.message ?? "Failed to register.");
        setSubmitting(false);
        return;
      }
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
    onReleaseFocus();
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
    // Also serves "leave waitlist": a waitlisted reg is free, so there's
    // no refund to compute — soft-deleting it removes it from the queue
    // (promote_from_waitlist filters deleted_at is null; the position gap
    // it leaves is harmless since promotion orders by position ASC).
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
    // On the waitlist (free) — show status + a way to leave, not a
    // register CTA.
    if (myStatus?.state === "waitlisted") {
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              fontSize: 13,
              color: courtBlue,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            ✓ On the waitlist
          </span>
          <button
            type="button"
            onClick={() => setConfirmLeaveWaitlist(true)}
            disabled={cancelling}
            style={{
              ...ctaSecondaryStyle,
              color: dangerFg,
              boxShadow: `inset 0 0 0 2px ${dangerBg}`,
              cursor: cancelling ? "not-allowed" : "pointer",
              whiteSpace: "nowrap",
              opacity: cancelling ? 0.6 : 1,
            }}
          >
            {cancelling ? "Leaving…" : "Leave waitlist"}
          </button>
        </div>
      );
    }
    // Promoted off the waitlist — a spot is reserved; pay to claim it.
    if (myStatus?.state === "waitlisted_pending_payment") {
      return (
        <Link
          to={`/t/${orgSlug}/${tournamentSlug}/checkout`}
          style={{
            ...ctaPrimaryStyle,
            background: courtGreen,
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          A spot opened — pay to claim →
        </Link>
      );
    }
    if (myStatus?.state === "invited" && myStatus.inviteToken) {
      return (
        <Link
          to={`/t/${orgSlug}/${tournamentSlug}/invites/${myStatus.inviteToken}`}
          style={{
            ...ctaPrimaryStyle,
            background: courtBlue,
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          Review invite →
        </Link>
      );
    }
    if (myStatus?.state === "pending_payment") {
      return (
        <div style={{ display: "flex", gap: 6 }}>
          {isDoubles && !expanded && (
            <button
              type="button"
              onClick={startChangePartner}
              disabled={cancelling}
              style={{
                ...ctaSecondaryStyle,
                cursor: cancelling ? "not-allowed" : "pointer",
                whiteSpace: "nowrap",
                opacity: cancelling ? 0.6 : 1,
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
              ...ctaSecondaryStyle,
              color: dangerFg,
              boxShadow: `inset 0 0 0 2px ${dangerBg}`,
              cursor: cancelling ? "not-allowed" : "pointer",
              whiteSpace: "nowrap",
              opacity: cancelling ? 0.6 : 1,
            }}
          >
            {cancelling ? "Cancelling…" : "Cancel Registration"}
          </button>
        </div>
      );
    }
    if (isPaid) {
      return (
        <Link
          to={`/t/${orgSlug}/${tournamentSlug}/register?event=${event.id}`}
          style={{
            ...ctaSecondaryStyle,
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          Manage
        </Link>
      );
    }
    if (expanded) return null;
    if (me && !playerEligible) {
      // An UNSET gender on a single-gender event is fixable — point the
      // player at their profile instead of a dead-end "Not eligible." A
      // *set-but-wrong* gender (e.g. M on a women's event) stays a plain
      // block: they've declared a gender, so this bracket isn't theirs.
      const genderUnset = me.gender == null;
      const isGenderedEvent =
        event.gender === "men" || event.gender === "women";
      if (genderUnset && isGenderedEvent) {
        return (
          <Link
            to={`/profile?return=${encodeURIComponent(
              `/t/${orgSlug}/${tournamentSlug}`,
            )}`}
            style={{
              fontSize: 12,
              color: courtBlue,
              textDecoration: "underline",
              whiteSpace: "nowrap",
            }}
          >
            Set your gender to register →
          </Link>
        );
      }
      return (
        <span style={{ fontSize: 12, color: inkMuted }}>
          Not eligible: {eligibilityReasons.join("; ")}
        </span>
      );
    }
    return (
      <button
        ref={registerBtnRef}
        type="button"
        onClick={startRegister}
        style={{
          ...ctaPrimaryStyle,
          background: isFull ? courtBlue : courtRed,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {isFull ? "Join waitlist" : "Register"}
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
  // Keep the ref current so the Esc keydown handler always calls the
  // latest closure (captures current partnerPicked + cancelExpand).
  // eslint-disable-next-line react-hooks/refs
  requestDiscardFormRef.current = requestDiscardForm;

  // Submit gate: singles always submit-able. Doubles need EITHER a
  // partner picked OR the "I need a partner" toggle on.
  const sideChosen = !event.is_paired_roles || !isDoubles || registrationSide !== null;
  const canSubmit = sideChosen && (!isDoubles || partnerPicked || seekingPartner);

  // ─── #98: card visual state ───────────────────────────────────────
  // Lifted card (isFocused): position:relative + z-index:60 places it
  // above the fixed scrim (z-index:50) in the same stacking context.
  // Dimmed card (isDimmed): filter applied; inert+aria-hidden set via
  // the imperative effect above (React 18 JSX doesn't expose inert).
  const cardStyle: CSSProperties = {
    padding: 16,
    background: cardBg,
    border: `1px solid ${cardBorderColor}`,
    borderLeft: cardBorderLeft,
    borderRadius: 8,
    position: "relative",
    ...(isFocused
      ? {
          zIndex: 60,
          boxShadow: "0 18px 50px rgba(20,24,31,0.28)",
          transform: "translateY(-2px)",
          transition: prefersReducedMotion
            ? undefined
            : "box-shadow 0.2s ease, transform 0.2s ease",
        }
      : isDimmed
        ? {
            filter: "grayscale(0.55) opacity(0.45)",
            transition: prefersReducedMotion ? undefined : "filter 0.2s ease",
          }
        : {}),
  };

  return (
    <div
      ref={cardRef}
      style={cardStyle}
      // #98: treat the lifted card as a dialog so screen readers know
      // focus is contained here while focus mode is active.
      role={isFocused ? "dialog" : undefined}
      aria-modal={isFocused ? true : undefined}
      aria-label={isFocused ? `Registering for ${event.name}` : undefined}
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
      {confirmLeaveWaitlist && (
        <ConfirmModal
          title="Leave the waitlist?"
          body={
            <>
              You'll lose your place in line for <strong>{event.name}</strong>.
              {myStatus?.partnerLabel ? (
                <>
                  {" "}
                  Your partner invite to{" "}
                  <strong>{myStatus.partnerLabel}</strong> will be cancelled.
                </>
              ) : null}{" "}
              You can re-join later, but you'll go to the back of the queue.
            </>
          }
          confirmLabel="Leave waitlist"
          cancelLabel="Stay on waitlist"
          onCancel={() => setConfirmLeaveWaitlist(false)}
          onConfirm={async () => {
            await onCancelPending();
            setConfirmLeaveWaitlist(false);
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
      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "flex-start",
          // Mobile-first: stack so the action buttons drop BELOW the content
          // instead of squeezing the text column to ~0 (which collapsed the
          // meta line to one character per line + overlapped the title — #500).
          flexDirection: isMobileViewport ? "column" : "row",
        }}
      >
        <div style={{ flex: 1, minWidth: 0, width: isMobileViewport ? "100%" : undefined }}>
          {/* Title + status pill */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <h3
              style={{
                margin: 0,
                fontFamily: displayFontStack,
                fontSize: 18,
                lineHeight: 1.1,
                color: ink,
              }}
            >
              {event.name}
            </h3>
            {myStatus?.state === "paid" && (
              <Pill bg={successBg} fg={successFg}>Registered</Pill>
            )}
            {myStatus?.state === "pending_payment" && (
              <Pill bg={ink} fg={courtYellow}>Pending payment</Pill>
            )}
            {myStatus?.state === "awaiting_partner" && (
              <Pill bg={ink} fg={courtYellow}>Awaiting partner</Pill>
            )}
            {myStatus?.state === "invited" && (
              <Pill bg={ink} fg={courtYellow}>You're invited</Pill>
            )}
            {/* "Seeking" is the viewer's OWN status — so word it in the
                first person ("You're …") to avoid reading as if someone
                else is looking. And suppress it once a partner is invited
                or picked (partnerLabel set): a waitlist reg that invited a
                partner BY EMAIL stays partner_status='seeking', which would
                otherwise contradict the "Invited X" label right below. */}
            {myStatus?.isSeekingPartner && !myStatus?.partnerLabel && (
              <Pill bg={cream} fg={courtBlue}>You're looking for a partner</Pill>
            )}
          </div>
          {/* Partner label */}
          {myStatus?.state === "invited" && myStatus.inviterName ? (
            <div style={{ color: ink, fontSize: 12, marginTop: 4 }}>
              <strong>{myStatus.inviterName}</strong> picked you as their
              partner
            </div>
          ) : myStatus?.partnerLabel ? (
            <div style={{ marginTop: 4 }}>
              <div style={{ color: isAmberCard ? ink : successFg, fontSize: 13 }}>
                {isPaid && myStatus.state === "paid"
                  ? "Partnered with "
                  : "Invited "}
              </div>
              <div
                style={{
                  color: isAmberCard ? ink : successFg,
                  fontSize: 16,
                  fontWeight: 600,
                  lineHeight: 1.2,
                }}
              >
                {myStatus.partnerLabel}
              </div>
              {(myStatus.partnerEmail || myStatus.partnerPhone) && (
                <div style={{ marginTop: 2, fontSize: 12, color: inkSoft }}>
                  {myStatus.partnerEmail && (
                    <div>{myStatus.partnerEmail}</div>
                  )}
                  {myStatus.partnerPhone && (
                    <div>{myStatus.partnerPhone}</div>
                  )}
                </div>
              )}
            </div>
          ) : null}
          {/* Meta line */}
          <div style={{ color: inkSoft, fontSize: 13, marginTop: 4 }}>
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
                    background: cream,
                    color: inkSoft,
                    border: `1px solid ${rule}`,
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
        <div style={{ alignSelf: "flex-start", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          {renderAction()}
          {isPending && myStatus?.partnerLabel && (
            <div
              style={{
                padding: "5px 10px",
                background: "#fff",
                border: `2px solid ${warnFg}`,
                borderRadius: 5,
                fontSize: 11,
                lineHeight: 1.4,
                color: ink,
                maxWidth: 180,
                textAlign: "left",
              }}
            >
              Your partner won't be notified until you check out.
            </div>
          )}
        </div>
      </div>

      {/* Toggle bar + collapsible roster panel */}
      <RosterToggleBar
        rosterRows={rosterRows}
        isDoubles={isDoubles}
        maxTeams={event.max_teams}
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
            borderTop: `1px dashed ${rule}`,
          }}
        >
          {/* Context-aware cost line. Only on the register flow (not
              the change-partner flow, which doesn't change the price).
              We don't re-explain the whole first/additional model —
              just tell the player what THIS event costs them given
              what they've already signed up for. */}
          {/* Full event → joining means the WAITLIST. Explain what to expect
              (free now, pay only if promoted) and hide the normal cost line. */}
          {editMode === "register" && isFull && (
            <div
              style={{
                marginBottom: 12,
                padding: "10px 12px",
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
                borderRadius: 8,
                fontSize: 13,
                color: "#1e3a8a",
                lineHeight: 1.5,
              }}
            >
              <strong>This event is full — you'll join the waitlist.</strong>{" "}
              It's free and you won't be charged now.
              {regFeeCents > 0
                ? ` If a spot opens, we'll email you and you can pay the $${(
                    regFeeCents / 100
                  ).toFixed(0)} entry to claim it.`
                : " If a spot opens, we'll email you to claim your place."}
              {isDoubles ? " Your partner pick carries over." : ""}
            </div>
          )}
          {editMode === "register" && regFeeCents > 0 && !isFull && (
            <div
              style={{
                marginBottom: 12,
                fontSize: 13,
                color: inkSoft,
              }}
            >
              {isAdditionalEvent ? (
                <>
                  Extra event:{" "}
                  <strong>+${(additionalFeeCents / 100).toFixed(0)}</strong>{" "}
                  <span style={{ color: inkMuted }}>
                    (added to your registration)
                  </span>
                </>
              ) : (
                <>
                  <strong>${(regFeeCents / 100).toFixed(0)}</strong>{" "}
                  entry{" "}
                  <span style={{ color: inkMuted }}>· includes this event</span>
                </>
              )}
            </div>
          )}
          {isDoubles && (
            <>
              {/* Paired-roles: side selector — appears above the partner
                  picker when event.is_paired_roles is true. Must be
                  chosen before the registrant can submit. The label tiles
                  reuse partnerModeTileStyle (the established choice-tile
                  pattern) so they look consistent. */}
              {event.is_paired_roles && (
                <div style={{ marginBottom: 10 }}>
                  <div
                    style={{
                      fontSize: 12,
                      color: inkMuted,
                      marginBottom: 6,
                      fontWeight: 600,
                    }}
                  >
                    I'm registering as
                  </div>
                  <div
                    role="radiogroup"
                    aria-label="Registration side"
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 8,
                    }}
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={registrationSide === "a"}
                      onClick={() => setRegistrationSide("a")}
                      style={partnerModeTileStyle(registrationSide === "a")}
                    >
                      <span>{event.side_a_label}</span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={registrationSide === "b"}
                      onClick={() => setRegistrationSide("b")}
                      style={partnerModeTileStyle(registrationSide === "b")}
                    >
                      <span>{event.side_b_label}</span>
                    </button>
                  </div>
                </div>
              )}
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
                <div style={{ ...statusPanelStyle("info"), fontSize: 12 }}>
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
                    {event.is_paired_roles && registrationSide
                      ? `Your partner will join as ${registrationSide === "a" ? event.side_b_label : event.side_a_label}.`
                      : "Your doubles partner. Search by name, email, or phone — if they're not in the list yet, add them as a new player."}
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
                        background: "#fff",
                        border: `2px solid ${warnFg}`,
                        borderRadius: 8,
                        padding: "10px 14px",
                        fontSize: 12,
                        lineHeight: 1.5,
                        color: ink,
                        marginTop: 8,
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
            <div style={{ ...statusPanelStyle("danger"), marginTop: 10, fontSize: 12 }}>
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
              style={
                submitting || !canSubmit
                  ? ctaPrimaryDisabledStyle
                  : { ...ctaPrimaryStyle, cursor: "pointer" }
              }
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
                ...ctaSecondaryStyle,
                cursor: submitting ? "not-allowed" : "pointer",
                opacity: submitting ? 0.6 : 1,
              }}
            >
              Not now
            </button>
            {event.is_paired_roles && isDoubles && !registrationSide && !submitting && (
              <span style={{ fontSize: 12, color: inkMuted }}>
                Registration not complete — pick an "I'm registering as"
                option above to complete your registration.
              </span>
            )}
            {sideChosen && isDoubles && !partnerPicked && !seekingPartner && !submitting && (
              <span style={{ fontSize: 12, color: inkMuted }}>
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


function RosterToggleBar({
  rosterRows,
  isDoubles,
  maxTeams,
  rosterOpen,
  onToggle,
}: {
  rosterRows: RosterRow[];
  isDoubles: boolean;
  maxTeams: number | null;
  rosterOpen: boolean;
  onToggle: () => void;
}) {
  let countLabel: string;
  if (isDoubles) {
    const confirmedPairs = rosterRows.filter(
      (r) => r.partner_status === "confirmed",
    ).length / 2;
    const pendingCount = rosterRows.filter(
      (r) => r.partner_status === "pending",
    ).length;
    const openSeekerCount = rosterRows.filter(
      (r) => r.partner_status === "seeking" && r.pending_partner_reg_id === null,
    ).length;
    const totalTeams = Math.floor(confirmedPairs) + pendingCount + openSeekerCount;
    const formingCount = pendingCount + openSeekerCount;
    const cap = maxTeams ? ` of ${maxTeams}` : "";
    countLabel = `${totalTeams}${cap} teams${formingCount > 0 ? ` · ${formingCount} still forming` : ""}`;
  } else {
    countLabel = `${rosterRows.length} player${rosterRows.length !== 1 ? "s" : ""}`;
  }

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
      <span style={{ fontSize: 12, color: "#555" }}>{countLabel}</span>
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
  myIsRegistered: boolean;
  onPartnerUp: (seeker: { first_name: string; last_name: string }) => void;
}) {
  if (!isDoubles) {
    // Singles: flat list unchanged from before.
    return (
      <div
        style={{
          marginTop: 8,
          border: "1px solid #e5e7eb",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        {rosterRows.length === 0 ? (
          <div style={{ padding: "14px 12px", fontSize: 12, color: "#888", textAlign: "center" }}>
            No registrations yet.
          </div>
        ) : (
          <>
            <div
              style={{
                padding: "6px 10px",
                background: "#f9fafb",
                borderBottom: "1px solid #e5e7eb",
                fontSize: 11,
                fontWeight: 700,
                color: "#555",
                textTransform: "uppercase" as const,
                letterSpacing: 0.5,
              }}
            >
              Registered players
            </div>
            {rosterRows.map((row) => {
              const isMe = row.registration_id === myRegId;
              const rating = rosterRating(row, event);
              const loc = [row.city as string | null, row.state as string | null]
                .filter(Boolean).join(", ");
              return (
                <div
                  key={row.registration_id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 56px 48px 1fr",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 12px",
                    borderBottom: "1px solid #f3f4f6",
                    background: isMe ? "#f0fdf4" : undefined,
                  }}
                >
                  <span style={{ fontSize: 13.5, fontWeight: isMe ? 600 : 500, color: ink }}>
                    {row.first_name} {row.last_name}
                    {isMe && (
                      <span style={{ marginLeft: 5, fontSize: 10, color: "#16a34a", fontWeight: 700 }}>
                        ← you
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: 12.5, color: "#555" }}>
                    {rating != null ? rating.toFixed(2) : "--"}
                  </span>
                  <span style={{ fontSize: 12.5, color: "#555" }}>
                    {row.gender ? capitalize(row.gender) : "--"}
                  </span>
                  <span style={{ fontSize: 12, color: "#888", textAlign: "right" }}>
                    {loc || "--"}
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>
    );
  }

  // Doubles: slot-teams layout (mock 5D).
  //
  // Each team block has up to two "slots":
  //   confirmed pair  → slot1 + slot2: both green dots
  //   pending inviter → slot1 (green) + amber slot (invitee name or "not registered yet")
  //   open seeker     → slot1 (green) + dashed-ring open slot with "Partner up →"
  //
  // Seekers with pending_partner_reg_id are "spoken-for": they appear
  // only as the amber slot inside the inviter's block, not as open slots.

  const spokenForRegIds = new Set<string>(
    rosterRows
      .filter((r) => r.partner_status === "pending" && r.pending_partner_reg_id !== null)
      .map((r) => r.pending_partner_reg_id as string),
  );

  type Block =
    | { kind: "confirmed"; a: RosterRow; b: RosterRow }
    | { kind: "pending"; inviter: RosterRow }
    | { kind: "seeker"; row: RosterRow };

  const blocks: Block[] = [];
  const placed = new Set<string>();

  for (const row of rosterRows) {
    if (row.partner_status !== "confirmed") continue;
    if (placed.has(row.registration_id)) continue;
    placed.add(row.registration_id);
    const partner = rosterRows.find(
      (r) => r.registration_id === row.partner_registration_id,
    );
    if (partner && !placed.has(partner.registration_id)) {
      placed.add(partner.registration_id);
      blocks.push({ kind: "confirmed", a: row, b: partner });
    }
  }

  for (const row of rosterRows) {
    if (row.partner_status === "pending") {
      blocks.push({ kind: "pending", inviter: row });
    }
  }

  for (const row of rosterRows) {
    if (row.partner_status === "seeking" && !spokenForRegIds.has(row.registration_id)) {
      blocks.push({ kind: "seeker", row });
    }
  }

  // Sort: bubble my block (or the block where I'm the amber invitee) to front.
  const myBlockIdx = blocks.findIndex((b) => {
    if (b.kind === "confirmed") return b.a.registration_id === myRegId || b.b.registration_id === myRegId;
    if (b.kind === "pending") {
      return (
        b.inviter.registration_id === myRegId ||
        (myRegId !== null && b.inviter.pending_partner_reg_id === myRegId)
      );
    }
    return b.row.registration_id === myRegId;
  });
  if (myBlockIdx > 0) {
    const [mine] = blocks.splice(myBlockIdx, 1);
    blocks.unshift(mine);
  }

  const isMeSeeker = rosterRows.some(
    (r) => r.partner_status === "seeking" && r.registration_id === myRegId,
  );

  const dotStyle = (color: string, dashed = false): CSSProperties => ({
    display: "inline-block",
    width: 10,
    height: 10,
    borderRadius: "50%",
    flexShrink: 0,
    ...(dashed
      ? { background: "transparent", border: "2px dashed #c9b58a" }
      : { background: color }),
  });

  const slotRowBase: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr 56px 48px 1fr",
    alignItems: "center",
    gap: 8,
    padding: "7px 12px",
  };

  const partnerUpBtnStyle: CSSProperties = {
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
  };

  const renderNameCell = (
    firstName: string,
    lastName: string,
    isMe: boolean,
    meColor = "#16a34a",
  ) => (
    <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
      <span
        style={{
          fontSize: 13.5,
          fontWeight: isMe ? 600 : 500,
          color: ink,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {firstName} {lastName}
      </span>
      {isMe && (
        <span style={{ fontSize: 10, color: meColor, fontWeight: 700, flexShrink: 0 }}>
          ← you
        </span>
      )}
    </div>
  );

  const renderRating = (row: RosterRow) => {
    const r = rosterRating(row, event);
    return <span style={{ fontSize: 12.5, color: "#555" }}>{r != null ? r.toFixed(2) : "--"}</span>;
  };

  const renderGender = (row: RosterRow) => (
    <span style={{ fontSize: 12.5, color: "#555" }}>{row.gender ? capitalize(row.gender) : "--"}</span>
  );

  const renderLoc = (row: RosterRow) => {
    const loc = [row.city as string | null, row.state as string | null].filter(Boolean).join(", ");
    return <span style={{ fontSize: 12, color: "#888", textAlign: "right" }}>{loc || "--"}</span>;
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
      {blocks.length === 0 && (
        <div style={{ padding: "14px 12px", fontSize: 12, color: "#888", textAlign: "center" }}>
          No registrations yet.
        </div>
      )}
      {blocks.length > 0 && (
        <>
          <div
            style={{
              padding: "6px 10px",
              background: "#f9fafb",
              borderBottom: "1px solid #e5e7eb",
              fontSize: 11,
              fontWeight: 700,
              color: "#555",
              textTransform: "uppercase" as const,
              letterSpacing: 0.5,
            }}
          >
            Registered
          </div>
          <div style={{ background: "#fafafa", padding: "8px 8px 0" }}>
            {blocks.map((block, bi) => {
              if (block.kind === "confirmed") {
                const isMeA = block.a.registration_id === myRegId;
                const isMeB = block.b.registration_id === myRegId;
                return (
                  <div
                    key={bi}
                    style={{
                      background: "#fff",
                      border: isMeA || isMeB ? "1px solid #bbf7d0" : "1px solid #e5e7eb",
                      borderRadius: 6,
                      overflow: "hidden",
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ ...slotRowBase, background: isMeA ? "#f0fdf4" : undefined }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                        <span style={dotStyle("#16a34a")} />
                        {renderNameCell(block.a.first_name, block.a.last_name, isMeA)}
                      </div>
                      {renderRating(block.a)}
                      {renderGender(block.a)}
                      {renderLoc(block.a)}
                    </div>
                    <div style={{ ...slotRowBase, borderTop: "1px solid #f3f4f6", background: isMeB ? "#f0fdf4" : undefined }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                        <span style={dotStyle("#16a34a")} />
                        {renderNameCell(block.b.first_name, block.b.last_name, isMeB)}
                      </div>
                      {renderRating(block.b)}
                      {renderGender(block.b)}
                      {renderLoc(block.b)}
                    </div>
                  </div>
                );
              }

              if (block.kind === "pending") {
                const isMe1 = block.inviter.registration_id === myRegId;
                const isMeInvitee = myRegId !== null && block.inviter.pending_partner_reg_id === myRegId;
                const inviterRating = rosterRating(block.inviter, event);
                const inviterLoc = [block.inviter.city as string | null, block.inviter.state as string | null]
                  .filter(Boolean).join(", ");
                const hasRegisteredInvitee = block.inviter.pending_partner_reg_id !== null;
                // For a registered invitee, look up their roster row for actual data.
                const inviteeRow = hasRegisteredInvitee
                  ? rosterRows.find((r) => r.registration_id === block.inviter.pending_partner_reg_id) ?? null
                  : null;
                const inviteeName = inviteeRow
                  ? `${inviteeRow.first_name} ${inviteeRow.last_name}`
                  : block.inviter.invited_partner_first_name
                    ? `${block.inviter.invited_partner_first_name} ${block.inviter.invited_partner_last_name ?? ""}`.trim()
                    : null;
                const inviteeRating = inviteeRow ? rosterRating(inviteeRow, event) : null;
                const isMyBlock = isMe1 || isMeInvitee;
                return (
                  <div
                    key={bi}
                    style={{
                      background: "#fff",
                      border: isMyBlock ? `1px solid ${courtYellow}` : "1px solid #e5e7eb",
                      borderRadius: 6,
                      overflow: "hidden",
                      marginBottom: 8,
                    }}
                  >
                    {/* Slot 1: inviter (green dot) */}
                    <div style={{ ...slotRowBase, background: isMe1 ? "#fffbeb" : undefined }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                        <span style={dotStyle("#16a34a")} />
                        {renderNameCell(block.inviter.first_name, block.inviter.last_name, isMe1)}
                      </div>
                      <span style={{ fontSize: 12.5, color: "#555" }}>
                        {inviterRating != null ? inviterRating.toFixed(2) : "--"}
                      </span>
                      <span style={{ fontSize: 12.5, color: "#555" }}>
                        {block.inviter.gender ? capitalize(block.inviter.gender) : "--"}
                      </span>
                      <span style={{ fontSize: 12, color: "#888", textAlign: "right" }}>
                        {inviterLoc || "--"}
                      </span>
                    </div>
                    {/* Slot 2: amber dot — invited player */}
                    <div
                      style={{
                        ...slotRowBase,
                        borderTop: "1px solid #f3f4f6",
                        background: "#fffbeb",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                        <span style={dotStyle("#d97706")} />
                        {inviteeName ? (
                          renderNameCell(
                            inviteeName.split(" ")[0],
                            inviteeName.split(" ").slice(1).join(" "),
                            isMeInvitee,
                            "#d97706",
                          )
                        ) : (
                          <span style={{ fontSize: 13, color: "#9ca3af", fontStyle: "italic" }}>
                            Invited player
                          </span>
                        )}
                      </div>
                      <span style={{ fontSize: 12.5, color: inviteeRow ? "#555" : "#9ca3af" }}>
                        {inviteeRating != null ? inviteeRating.toFixed(2) : "--"}
                      </span>
                      <span style={{ fontSize: 12.5, color: inviteeRow ? "#555" : "#9ca3af" }}>
                        {inviteeRow?.gender ? capitalize(inviteeRow.gender) : "--"}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          color: "#92400e",
                          textAlign: "right",
                          fontStyle: "italic",
                        }}
                      >
                        {hasRegisteredInvitee
                          ? "invited — awaiting reply"
                          : "invited — not registered yet"}
                      </span>
                    </div>
                  </div>
                );
              }

              // kind === "seeker"
              const isMe1 = block.row.registration_id === myRegId;
              const seekerRating = rosterRating(block.row, event);
              const seekerLoc = [block.row.city as string | null, block.row.state as string | null]
                .filter(Boolean).join(", ");
              const showPartnerUp =
                !isMe1 && (!myIsRegistered || isMeSeeker);
              return (
                <div
                  key={bi}
                  style={{
                    background: "#fff",
                    border: isMe1 ? "1px solid #bfdbfe" : "1px solid #e5e7eb",
                    borderRadius: 6,
                    overflow: "hidden",
                    marginBottom: 8,
                  }}
                >
                  {/* Slot 1: seeker (green dot) */}
                  <div style={{ ...slotRowBase, background: isMe1 ? "#eff6ff" : undefined }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                      <span style={dotStyle("#16a34a")} />
                      {renderNameCell(block.row.first_name, block.row.last_name, isMe1, "#2563eb")}
                    </div>
                    <span style={{ fontSize: 12.5, color: "#555" }}>
                      {seekerRating != null ? seekerRating.toFixed(2) : "--"}
                    </span>
                    <span style={{ fontSize: 12.5, color: "#555" }}>
                      {block.row.gender ? capitalize(block.row.gender) : "--"}
                    </span>
                    <span style={{ fontSize: 12, color: "#888", textAlign: "right" }}>
                      {seekerLoc || "--"}
                    </span>
                  </div>
                  {/* Slot 2: open slot (dashed ring) */}
                  <div
                    style={{
                      ...slotRowBase,
                      borderTop: "1px solid #f3f4f6",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <span style={dotStyle("", true)} />
                      <span style={{ fontSize: 13, color: "#9ca3af" }}>
                        Open slot — seeking partner
                      </span>
                    </div>
                    <span />
                    <span />
                    <div style={{ textAlign: "right" }}>
                      {showPartnerUp && (
                        <button
                          type="button"
                          onClick={() =>
                            onPartnerUp({
                              first_name: block.row.first_name,
                              last_name: block.row.last_name,
                            })
                          }
                          style={partnerUpBtnStyle}
                        >
                          Partner up →
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bits
// ─────────────────────────────────────────────────────────────────────

function Shell({ children }: { children: ReactNode }) {
  return (
    <main style={pageWrapStyle}>
      <div style={contentColStyle(1080)}>
        {children}
      </div>
    </main>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontFamily: monoFontStack,
          fontSize: 11,
          color: inkMuted,
          textTransform: "uppercase",
          letterSpacing: "0.18em",
          fontWeight: 700,
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 15, color: ink }}>{value}</div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        ...panelMutedStyle,
        textAlign: "center",
        color: inkMuted,
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

function fmtShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
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

type CancellationPolicyPreset =
  Database["public"]["Enums"]["cancellation_policy_preset"];

function cancellationPresetSummary(p: CancellationPolicyPreset): string {
  switch (p) {
    case "generous":
      return "Full refund > 7 days before, none within 7 days.";
    case "standard":
      return "Full refund <7d after reg, half >30d before, none <7d before.";
    case "strict":
      return "No refunds after registration.";
    case "custom":
      return "Custom refund windows — see organizer for details.";
  }
}

// Minimal markdown renderer: paragraphs, unordered lists, bold, italic,
// links. No external library — the content is organizer-authored and
// limited to these constructs.
// Turn carriage returns / line feeds (CR, LF, or CRLF) in plain organizer text
// into <br/> line breaks, so what they typed across multiple lines renders that
// way. React escapes each line, so this is XSS-safe (no dangerouslySetInnerHTML).
function nl2br(text: string): ReactNode {
  return text.split(/\r\n|\r|\n/).map((line, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {line}
    </Fragment>
  ));
}

function renderSimpleMd(md: string): ReactNode {
  // Normalize line endings so CRLF/CR behave like LF for the block + line splits.
  const normalized = md.replace(/\r\n?/g, "\n");
  const blocks = normalized.split(/\n\n+/);
  return blocks.map((block, bi) => {
    const lines = block.split("\n");
    if (lines.length > 0 && lines.every((l) => l.startsWith("- "))) {
      return (
        <ul key={bi} style={{ paddingLeft: 20, margin: "0 0 10px" }}>
          {lines.map((l, li) => (
            <li key={li}>{renderInline(l.slice(2))}</li>
          ))}
        </ul>
      );
    }
    // A single newline inside a block is an intentional line break → <br/>
    // (was previously collapsed to a space). Blank lines still split paragraphs.
    return (
      <p key={bi} style={{ margin: "0 0 10px", lineHeight: 1.6 }}>
        {lines.map((line, li) => (
          <Fragment key={li}>
            {li > 0 && <br />}
            {renderInline(line)}
          </Fragment>
        ))}
      </p>
    );
  });
}

function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/);
  return parts.map((tok, i) => {
    if (tok.startsWith("**") && tok.endsWith("**")) {
      return <strong key={i}>{tok.slice(2, -2)}</strong>;
    }
    if (tok.startsWith("*") && tok.endsWith("*")) {
      return <em key={i}>{tok.slice(1, -1)}</em>;
    }
    const m = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (m) {
      return (
        <a key={i} href={m[2]} target="_blank" rel="noopener noreferrer">
          {m[1]}
        </a>
      );
    }
    return tok;
  });
}

function TournamentContentSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={sectionH2Style}>{title}</h2>
      <div style={{ fontSize: 15, color: inkSoft, lineHeight: 1.6 }}>
        {children}
      </div>
    </section>
  );
}

