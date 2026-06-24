import {
  useEffect,
  useState,
  type CSSProperties,
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
import { checkEligibility, eligibilityChips } from "../../lib/eligibility";
import {
  computeLineItems,
  formatUsd,
  type LineItem,
} from "../../lib/pricing";
import {
  pickActivePricingTier,
  type PricingTier,
} from "../../lib/pricingTiers";
import {
  contentColStyle,
  courtBlue,
  cream,
  creamDeep,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  ctaSecondaryStyle,
  headingFontStack,
  ink,
  inkSoft,
  pageH1Style,
  pageWrapStyle,
  ruleSoft,
  sectionH2Style,
  statusPanelStyle,
} from "../../lib/publicTheme";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];
type Player = Database["public"]["Tables"]["players"]["Row"];
type ChangeRequestKind = Database["public"]["Enums"]["change_request_kind"];

// Per-event snapshot of what the user is *currently* registered for —
// loaded once on mount, then compared against the live selections
// state on every render to compute the diff (added / withdrawn /
// partner_changed / unchanged). regId is the user's own
// event_registrations.id so we can soft-delete it on withdraw. The
// partner block holds enough info to pre-fill the PartnerSearch
// widget, detect a swap by id, and email the dropped partner on
// change (which is what commit C is about).
type ExistingReg = {
  regId: string;
  partnerStatus: Database["public"]["Enums"]["partner_status"];
  partnerLabel: string | null;
  // Full enough partner shape to construct a PlayerSelection in
  // existing mode AND to email them if they get dropped. Null when
  // singles, or when doubles and the user hasn't picked / been
  // matched with a partner.
  partner: {
    id: string;
    first_name: string;
    last_name: string;
    email: string | null;
    phone: string | null;
    // The other partner's event_registrations.id, if they accepted
    // and got linked. Null while the invite is still pending.
    regId: string | null;
  } | null;
  // Most recent pending OR accepted partner_invites row for this
  // event where I'm the inviter. We need its id to cancel it on a
  // partner change (status='cancelled'). Null when there's no
  // outbound invite (singles, or partner accepted way back and the
  // row aged out somehow — defensive).
  inviteId: string | null;
};

// Change classification for an event, computed from existingRegs +
// selections. "unchanged" means the user's pick matches what's in
// the DB; the others drive the corresponding write paths.
type ChangeType =
  | "unchanged"
  | "added"
  | "withdrawn"
  | "partner_changed";

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
  // Pricing tiers for the tournament. The active tier (today vs. its
  // windows) feeds the running-total math below.
  const [tiers, setTiers] = useState<PricingTier[]>([]);
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
  // F3: registered player_ids per event (paid + pending), used to
  // filter the PartnerSearch results so we can't pick someone
  // who's already in. Populated by the players_registered_for_events
  // RPC because event_registrations RLS would otherwise hide them
  // from a non-org-member SELECT.
  const [registeredByEvent, setRegisteredByEvent] = useState<
    Map<string, Set<string>>
  >(new Map());
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
    // Partner swaps on existing regs. The new-partner invite/auto-
    // pair side lives in partnerInvites/autoPairs above so the UI
    // can render them uniformly with fresh registrations. This
    // array only carries the dropped-partner side: who got dropped
    // and whether they were emailed.
    partnerChanges: {
      eventName: string;
      oldPartnerName: string;
      newPartnerName: string;
      cancelEmailSent: boolean;
      cancelEmailSkipped: boolean;
      cancelEmailError?: string;
    }[];
  } | null>(null);

  // Change-request form: player asks organizer for help with edge
  // cases that can't be self-served (division swap, post-accept partner
  // change, special-circumstance withdrawal).
  const [showChangeRequest, setShowChangeRequest] = useState(false);
  const [crKind, setCrKind] = useState<ChangeRequestKind>("other");
  const [crNote, setCrNote] = useState("");
  const [crSubmitting, setCrSubmitting] = useState(false);
  const [crSuccess, setCrSuccess] = useState(false);
  const [crError, setCrError] = useState<string | null>(null);

  const submitChangeRequest = async () => {
    if (!me || !tournament) return;
    setCrSubmitting(true);
    setCrError(null);
    const { error } = await supabase
      .from("tournament_change_requests")
      .insert({
        tournament_id: tournament.id,
        player_id: me.id,
        kind: crKind,
        payload: crNote.trim() ? { note: crNote.trim() } : {},
      });
    setCrSubmitting(false);
    if (error) { setCrError(error.message); return; }
    setCrSuccess(true);
    setShowChangeRequest(false);
    setCrNote("");
    setCrKind("other");
  };

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

      // Pricing tiers — the active one supplies the rates for the
      // running-total math.
      const { data: tierRows } = await supabase
        .from("tournament_pricing_tiers")
        .select("*")
        .eq("tournament_id", t.id)
        .order("sort_order", { ascending: true });
      if (cancelled) return;
      setTiers(tierRows ?? []);

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

      // 3a. F3: pull registered player ids per event so PartnerSearch
      //     can filter them out of the picker. Goes through the
      //     SECURITY DEFINER RPC because event_registrations RLS
      //     limits non-org-member SELECTs to my own rows.
      if (evs && evs.length > 0) {
        const { data: regsByEvent } = await supabase.rpc(
          "players_registered_for_events",
          { p_event_ids: evs.map((e) => e.id) },
        );
        if (cancelled) return;
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
      //    tournament, plus their outbound invites (pending OR
      //    accepted — we need either to be able to cancel a partner
      //    swap). Joins reach far enough to construct a full
      //    PlayerSelection for the current partner so the user can
      //    edit it inline on this page.
      const existingMap = new Map<string, ExistingReg>();
      if (evs && evs.length > 0) {
        const eventIds = evs.map((e) => e.id);
        const [regsRes, outboundRes, inboundRes] = await Promise.all([
          supabase
            .from("event_registrations")
            .select(
              `id, event_id, partner_status,
               partner_registration:event_registrations!partner_registration_id (
                 id,
                 player:players!player_id (id, first_name, last_name, email, phone)
               )`,
            )
            .eq("player_id", myPlayer.id)
            .in("event_id", eventIds)
            // Only ACTIVE regs count as "existing" here. withdraw_self leaves
            // the row in place (status withdrawn/cancelled, deleted_at null),
            // so without this a withdrawn event would reload as "Registered".
            .in("status", ["paid", "pending_payment"])
            .is("deleted_at", null),
          supabase
            .from("partner_invites")
            .select(
              `id, event_id, status, invitee_email,
               invitee:players!invitee_player_id (id, first_name, last_name, email, phone)`,
            )
            .eq("inviter_player_id", myPlayer.id)
            .in("status", ["pending", "accepted"])
            .in("event_id", eventIds)
            .order("created_at", { ascending: false }),
          // INBOUND invites — ones I received and accepted. The linked
          // partner_registration embed above is RLS-blocked (it's the
          // inviter's own-rows-only reg), and I have no OUTBOUND invite as
          // the invitee, so without this my partner shows blank. partner_invites
          // is readable by the recipient, so this fills the invitee's side.
          supabase
            .from("partner_invites")
            .select(
              `id, event_id, status,
               inviter:players!inviter_player_id (id, first_name, last_name, email, phone)`,
            )
            .eq("invitee_player_id", myPlayer.id)
            .in("status", ["pending", "accepted"])
            .in("event_id", eventIds)
            .order("created_at", { ascending: false }),
        ]);
        if (cancelled) return;

        type RegRow = {
          id: string;
          event_id: string;
          partner_status: Database["public"]["Enums"]["partner_status"];
          partner_registration: {
            id: string;
            player: {
              id: string;
              first_name: string;
              last_name: string;
              email: string | null;
              phone: string | null;
            } | null;
          } | null;
        };
        type OutboundRow = {
          id: string;
          event_id: string;
          status: Database["public"]["Enums"]["partner_invite_status"];
          invitee_email: string | null;
          invitee: {
            id: string;
            first_name: string;
            last_name: string;
            email: string | null;
            phone: string | null;
          } | null;
        };

        for (const r of (regsRes.data ?? []) as unknown as RegRow[]) {
          const linked = r.partner_registration;
          const partner = linked?.player ?? null;
          existingMap.set(r.event_id, {
            regId: r.id,
            partnerStatus: r.partner_status,
            partnerLabel: partner
              ? `${partner.first_name} ${partner.last_name}`
              : null,
            partner: partner
              ? {
                  id: partner.id,
                  first_name: partner.first_name,
                  last_name: partner.last_name,
                  email: partner.email,
                  phone: partner.phone,
                  regId: linked!.id,
                }
              : null,
            inviteId: null,
          });
        }
        // Walk outbound invites — newest first thanks to the order
        // clause — to fill in two things on the existingMap rows we
        // already created:
        //   * inviteId so we can cancel the right row on a partner
        //     swap or withdraw
        //   * partner (with regId=null) when the invitee hasn't
        //     accepted yet, so the row shows "Waiting for X" and the
        //     PartnerSearch widget can pre-fill with them
        for (const inv of (outboundRes.data ?? []) as unknown as OutboundRow[]) {
          const cur = existingMap.get(inv.event_id);
          if (!cur) continue;
          if (!cur.inviteId) {
            cur.inviteId = inv.id;
          }
          if (!cur.partner && inv.invitee) {
            cur.partner = {
              id: inv.invitee.id,
              first_name: inv.invitee.first_name,
              last_name: inv.invitee.last_name,
              email: inv.invitee.email,
              phone: inv.invitee.phone,
              regId: null,
            };
            cur.partnerLabel = `${inv.invitee.first_name} ${inv.invitee.last_name}`;
          } else if (!cur.partnerLabel) {
            cur.partnerLabel = inv.invitee_email ?? null;
          }
        }
        // Fill the INVITEE side from inbound invites (the inviter is my
        // partner). Only fills rows the linked-reg/outbound paths left blank.
        type InboundRow = {
          id: string;
          event_id: string;
          status: Database["public"]["Enums"]["partner_invite_status"];
          inviter: {
            id: string;
            first_name: string;
            last_name: string;
            email: string | null;
            phone: string | null;
          } | null;
        };
        for (const inv of (inboundRes.data ?? []) as unknown as InboundRow[]) {
          const cur = existingMap.get(inv.event_id);
          if (!cur || cur.partner || !inv.inviter) continue;
          cur.partner = {
            id: inv.inviter.id,
            first_name: inv.inviter.first_name,
            last_name: inv.inviter.last_name,
            email: inv.inviter.email,
            phone: inv.inviter.phone,
            regId: null,
          };
          cur.partnerLabel = `${inv.inviter.first_name} ${inv.inviter.last_name}`;
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
      //
      //    For existing doubles regs with a known partner, pre-fill
      //    selection.partner with that partner in "existing" mode
      //    so the PartnerSearch widget renders them as the picked
      //    partner. The diff fires only when the user actually
      //    changes them.
      const sel = new Map<string, EventSelection>();
      for (const e of evs ?? []) {
        const existing = existingMap.get(e.id);
        let partner: PlayerSelection = emptySelection;
        if (existing?.partner && e.format === "doubles") {
          // Cast through the partial → Player; the consumers we care
          // about (PartnerSearch display, persistPlayerSelection
          // diff, validation) only touch id/first_name/last_name/
          // email/phone, which we have.
          partner = {
            mode: "existing",
            player: existing.partner as unknown as Player,
            emailDraft: existing.partner.email ?? "",
            phoneDraft: existing.partner.phone ?? "",
          };
        }
        sel.set(e.id, {
          selected:
            existingMap.has(e.id) || preselectEventId === e.id,
          partner,
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
  // add / withdraw / partner_changed branches.
  const changeFor = (eventId: string): ChangeType => {
    const existing = existingRegs.get(eventId);
    const isSelected = selections.get(eventId)?.selected ?? false;
    if (existing && !isSelected) return "withdrawn";
    if (!existing && isSelected) return "added";
    // Still registered. Check for partner swap on doubles events.
    if (existing && isSelected) {
      const ev = events.find((e) => e.id === eventId);
      if (ev && ev.format === "doubles") {
        const newPartner = selections.get(eventId)?.partner;
        // mode "new" always counts as a change (they typed a new
        // person). mode "empty" counts as a change too (they
        // cleared the partner) — submit will flag this with a
        // validation error rather than silently doing nothing.
        if (newPartner?.mode === "new") return "partner_changed";
        if (newPartner?.mode === "empty" && existing.partner) {
          return "partner_changed";
        }
        if (
          newPartner?.mode === "existing" &&
          existing.partner &&
          newPartner.player.id !== existing.partner.id
        ) {
          return "partner_changed";
        }
        // Existing reg had no partner, user is now picking one →
        // treat the same as a partner_changed for write purposes
        // (we'll insert a fresh invite).
        if (
          newPartner?.mode === "existing" &&
          !existing.partner
        ) {
          return "partner_changed";
        }
      }
    }
    return "unchanged";
  };
  const addedEvents = events.filter((ev) => changeFor(ev.id) === "added");
  const withdrawnEvents = events.filter(
    (ev) => changeFor(ev.id) === "withdrawn",
  );
  const partnerChangedEvents = events.filter(
    (ev) => changeFor(ev.id) === "partner_changed",
  );
  const changeCount =
    addedEvents.length +
    withdrawnEvents.length +
    partnerChangedEvents.length;
  const hasChanges = changeCount > 0;

  // Live-computed pricing across the FULL post-submit basket (every
  // event the player will end up registered for, including ones
  // they're keeping unchanged). Used to:
  //   * label per-row prices on EventRow with the right tier
  //   * compute the running total banner above Confirm
  //   * compute the cents-to-charge on each ADDED registration's
  //     INSERT in onSubmit (existing regs keep their stored
  //     event_fee_cents — withdraw/refund is a separate concern)
  const basketEvents = tournament
    ? events.filter((ev) => selections.get(ev.id)?.selected)
    : [];
  const activeTier = pickActivePricingTier(tiers);
  const { items: lineItems, totalCents } = tournament && activeTier
    ? computeLineItems(basketEvents, {
        firstEventFeeCents: activeTier.first_event_fee_cents,
        additionalEventFeeCents: activeTier.additional_event_fee_cents,
      })
    : { items: [] as LineItem[], totalCents: 0 };
  const lineItemByEventId = new Map(
    lineItems.map((item) => [item.event.id, item]),
  );

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !me) return;
    setError(null);

    if (!hasChanges) {
      // Button is disabled in this state but the user could still
      // hit Enter on a focused checkbox — bail out cleanly.
      return;
    }
    // Validate partner selection for any doubles event that's going
    // to write (new registration OR a partner swap on an existing
    // one). Same rules either way: must pick a partner, partner
    // can't be self, partner email must be present.
    for (const ev of [...addedEvents, ...partnerChangedEvents]) {
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

    for (const ev of addedEvents) {
      const { eligible, reasons } = checkEligibility(me, ev);
      if (!eligible) {
        setError(`"${ev.name}": not eligible — ${reasons.join("; ")}.`);
        return;
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

    // ─── Process withdrawals first via withdraw_self — the SAME path as
    //     My Tournaments' Withdraw, so a PAID reg becomes 'withdrawn' with
    //     its policy refund snapshotted (the player can then "Request refund"
    //     on My Tournaments) and a pending reg becomes 'cancelled'. We used
    //     to soft-delete here, which silently dropped the reg with no refund
    //     path. withdraw_self also unpairs the doubles partner; we still
    //     cancel any pending OUTBOUND invite below (the RPC doesn't).
    for (const ev of withdrawnEvents) {
      const existing = existingRegs.get(ev.id);
      if (!existing) continue; // defensive
      const { error: wErr } = await supabase.rpc("withdraw_self", {
        p_reg_id: existing.regId,
      });
      if (wErr) {
        setError(
          `Failed to withdraw from "${ev.name}": ${wErr.message}`,
        );
        setPhase("form");
        return;
      }
      if (existing.partnerStatus === "confirmed" && existing.partner) {
        supabase.functions
          .invoke("send-partner-withdrawal", {
            body: { regId: existing.regId },
          })
          .catch(console.error);
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
      // Use the price the player saw on the form — the line-item
      // tier (first / additional / override) snapshots into the
      // event_registrations row so the historical record reflects
      // what was actually quoted, even if tournament pricing
      // changes later.
      const lineItem = lineItemByEventId.get(ev.id);
      const chargedCents = lineItem ? lineItem.cents : ev.event_fee_cents;

      const { error: myRegErr } = await supabase
        .from("event_registrations")
        .insert({
          event_id: ev.id,
          player_id: me.id,
          event_fee_cents: chargedCents,
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

    // ─── Process partner changes. For each event where the user
    //     swapped their doubles partner:
    //       1. Cancel the outbound invite (if we own one).
    //       2. Soft-delete the dropped partner's event_registration
    //          if they had accepted (regId is set).
    //       3. Email the dropped partner a polite cancellation note
    //          (best-effort; skipped for fake addresses).
    //       4. Reset my own reg back to partner_status='pending'
    //          with the link cleared, so the new-partner flow below
    //          starts from a clean state.
    //       5. Resolve the new partner. Auto-pair if they happened
    //          to have invited me already; otherwise create a new
    //          outbound invite + send email — same shape as the
    //          new-registration path above, so the done screen can
    //          render the new-partner invite cards uniformly.
    const partnerChanges: {
      eventName: string;
      oldPartnerName: string;
      newPartnerName: string;
      cancelEmailSent: boolean;
      cancelEmailSkipped: boolean;
      cancelEmailError?: string;
    }[] = [];

    for (const ev of partnerChangedEvents) {
      const existing = existingRegs.get(ev.id);
      if (!existing) continue; // defensive — partner_changed implies existing
      const sel = selections.get(ev.id)!;
      const oldPartner = existing.partner;

      let cancelEmailSent = false;
      let cancelEmailSkipped = false;
      let cancelEmailError: string | undefined;

      // 1. Cancel our outbound invite if we have one. We may not —
      //    if the original pairing happened because the OLD partner
      //    invited US (we auto-paired by registering and picking
      //    them), the invite's inviter_player_id is them, not us,
      //    and existing.inviteId would be null. In that case the
      //    old invite stays alive but inert; the old partner's
      //    reg gets soft-deleted in step 2 either way.
      if (existing.inviteId) {
        await supabase
          .from("partner_invites")
          .update({ status: "cancelled" })
          .eq("id", existing.inviteId);
      }

      // 2. Soft-delete the dropped partner's reg if they actually
      //    accepted (regId set). They're now off the event; if
      //    they want back in, they re-register.
      if (oldPartner?.regId) {
        await supabase
          .from("event_registrations")
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", oldPartner.regId);
      }

      // 3. Cancellation email — only attempt when we have both a
      //    cancellable invite (so the edge function has joins to
      //    work with) AND a real email address.
      if (existing.inviteId && oldPartner?.email) {
        if (isObviouslyFakeEmail(oldPartner.email)) {
          cancelEmailSkipped = true;
        } else {
          try {
            const { error: sendErr } = await supabase.functions.invoke(
              "send-partner-cancellation",
              { body: { inviteId: existing.inviteId } },
            );
            if (sendErr) cancelEmailError = sendErr.message;
            else cancelEmailSent = true;
          } catch (e) {
            cancelEmailError =
              e instanceof Error ? e.message : String(e);
          }
        }
      }

      // 4. Reset my reg: clear partner link, mark pending.
      const { error: resetErr } = await supabase
        .from("event_registrations")
        .update({
          partner_status: "pending",
          partner_registration_id: null,
        })
        .eq("id", existing.regId);
      if (resetErr) {
        setError(
          `Failed to reset registration for "${ev.name}": ${resetErr.message}`,
        );
        setPhase("form");
        return;
      }

      // 5. Resolve new partner + auto-pair OR new invite.
      const partnerRes = await persistPlayerSelection(sel.partner);
      if (!partnerRes.player) {
        setError(
          partnerRes.error ??
            `Failed to set up new partner for "${ev.name}".`,
        );
        setPhase("form");
        return;
      }
      const newPartner = partnerRes.player;
      const newPartnerEmail =
        newPartner.email ??
        (sel.partner.mode === "new" ? sel.partner.email.trim() : null);

      const oldPartnerName = oldPartner
        ? `${oldPartner.first_name} ${oldPartner.last_name}`
        : "your previous partner";
      const newPartnerName = `${newPartner.first_name} ${newPartner.last_name}`;
      partnerChanges.push({
        eventName: ev.name,
        oldPartnerName,
        newPartnerName,
        cancelEmailSent,
        cancelEmailSkipped,
        cancelEmailError,
      });

      // Check for an inbound invite from the new partner. If they
      // had already invited me, registering here counts as
      // accepting that invite — no new outbound invite needed.
      let inboundInviteId: string | null = null;
      if (user.email) {
        const { data: inbound } = await supabase
          .from("partner_invites")
          .select("id")
          .eq("event_id", ev.id)
          .eq("inviter_player_id", newPartner.id)
          .eq("invitee_email", user.email)
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (inbound) inboundInviteId = inbound.id;
      }

      if (inboundInviteId) {
        const { error: acceptErr } = await supabase.rpc(
          "accept_partner_invite",
          { p_invite_id: inboundInviteId },
        );
        if (!acceptErr) {
          autoPairs.push({
            eventName: ev.name,
            partnerName: newPartnerName,
          });
          continue;
        }
        // Fall through to outbound invite on accept failure.
      }

      if (!newPartnerEmail) {
        setError(
          `No email on file for new partner in "${ev.name}".`,
        );
        setPhase("form");
        return;
      }
      const { data: invite, error: invErr } = await supabase
        .from("partner_invites")
        .insert({
          event_id: ev.id,
          inviter_player_id: me.id,
          invitee_player_id: newPartner.id,
          invitee_email: newPartnerEmail,
          status: "pending",
        })
        .select()
        .single();
      if (invErr || !invite) {
        setError(
          invErr?.message ??
            `Failed to send invite to new partner for "${ev.name}".`,
        );
        setPhase("form");
        return;
      }
      const url = `${window.location.origin}/t/${orgSlug}/${tournamentSlug}/invites/${invite.token}`;

      let emailSent = false;
      let emailSkipped = false;
      let emailError: string | undefined;
      if (isObviouslyFakeEmail(newPartnerEmail)) {
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
        partnerEmail: newPartnerEmail,
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
      partnerChanges,
    });
    setPhase("done");
  };

  if (loading) {
    return (
      <Shell>
        <p style={{ color: inkSoft, fontSize: 14, margin: 0 }}>Loading…</p>
      </Shell>
    );
  }
  if (error && phase === "form" && !tournament) {
    return (
      <Shell>
        <h1 style={pageH1Style}>Not available</h1>
        <p style={{ color: inkSoft, fontSize: 14 }}>{error}</p>
      </Shell>
    );
  }
  if (!tournament) return null;

  if (phase === "done" && doneResult) {
    const addedCount = doneResult.registeredEventNames.length;
    const withdrewCount = doneResult.withdrawnEventNames.length;
    const partnerChangedCount = doneResult.partnerChanges.length;
    // Heading hierarchy: if anything was added we lead with the
    // "registered" framing; if it's pure withdrawals we say so; if
    // it's only partner swaps we say so. Multi-flavor submits get
    // the generic "updated" headline.
    const heading =
      addedCount > 0 && (withdrewCount > 0 || partnerChangedCount > 0)
        ? "Your registration is updated"
        : addedCount > 0
          ? "You're registered!"
          : withdrewCount > 0 && partnerChangedCount === 0
            ? "Withdrawn"
            : partnerChangedCount > 0 && withdrewCount === 0
              ? "Partner updated"
              : "Your registration is updated";
    return (
      <Shell>
        <div
          style={{
            ...statusPanelStyle("success"),
            padding: "20px 22px",
            marginBottom: 24,
          }}
        >
          <h1
            style={{
              ...pageH1Style,
              margin: "0 0 8px",
              fontSize: "clamp(22px, 3.4vw, 28px)",
              color: "inherit",
            }}
          >
            {heading}
          </h1>
          {addedCount > 0 && (
            <p style={{ margin: 0, fontSize: 14 }}>
              Confirmed for {fmtList(doneResult.registeredEventNames)} in{" "}
              <strong>{tournament.name}</strong>.
            </p>
          )}
          {withdrewCount > 0 && (
            <p
              style={{
                margin: addedCount > 0 ? "8px 0 0" : "0",
                fontSize: 14,
              }}
            >
              Withdrawn from {fmtList(doneResult.withdrawnEventNames)}.
            </p>
          )}
        </div>

        {doneResult.partnerChanges.length > 0 && (
          <section style={{ marginBottom: 28 }}>
            <h2 style={sectionH2Style}>
              Partner change{doneResult.partnerChanges.length === 1 ? "" : "s"}
            </h2>
            <p style={{ margin: "0 0 12px", color: inkSoft, fontSize: 13 }}>
              {doneResult.partnerChanges.every(
                (c) => c.cancelEmailSent || c.cancelEmailSkipped,
              )
                ? "Your previous partner has been notified (or, for test addresses, would have been). The new partner's invite is below."
                : "Some cancellation notices to your previous partners didn't go out — details below. The new partner's invite is below."}
            </p>
            <ul
              style={{
                margin: 0,
                paddingLeft: 18,
                fontSize: 13,
                lineHeight: 1.7,
              }}
            >
              {doneResult.partnerChanges.map((c, i) => (
                <li key={i}>
                  <strong>{c.eventName}</strong>:{" "}
                  <span style={{ color: "#666" }}>{c.oldPartnerName}</span>
                  {" → "}
                  <strong>{c.newPartnerName}</strong>
                  {c.cancelEmailError && (
                    <span
                      style={{
                        color: "#92400e",
                        fontSize: 11,
                        marginLeft: 6,
                      }}
                    >
                      (couldn't email previous partner: {c.cancelEmailError})
                    </span>
                  )}
                  {c.cancelEmailSkipped && (
                    <span
                      style={{
                        color: "#888",
                        fontSize: 11,
                        marginLeft: 6,
                      }}
                    >
                      (test address — no email sent)
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {doneResult.autoPairs.length > 0 && (
          <section style={{ marginBottom: 28 }}>
            <h2 style={sectionH2Style}>Auto-paired</h2>
            <p style={{ margin: "0 0 12px", color: inkSoft, fontSize: 13 }}>
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
          <section style={{ marginBottom: 28 }}>
            <h2 style={sectionH2Style}>
              Partner invite{doneResult.partnerInvites.length === 1 ? "" : "s"}
            </h2>
            <p style={{ margin: "0 0 12px", color: inkSoft, fontSize: 13 }}>
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

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link
            to={`/t/${orgSlug}/${tournamentSlug}`}
            style={{ ...ctaSecondaryStyle, padding: "10px 18px", fontSize: 12 }}
          >
            ← Back to tournament
          </Link>
          <button
            onClick={() => {
              // Re-fetch from scratch so existingRegs reflects what
              // we just inserted / withdrew.
              navigate(0);
            }}
            style={{ ...ctaPrimaryStyle, padding: "10px 18px", fontSize: 12 }}
          >
            Register for more events
          </button>
        </div>
      </Shell>
    );
  }

  const submitting = phase === "submitting";

  // "Manage" entry: the tournament page links to ?event=<id> for an event you're
  // already registered for. In that case show a FOCUSED single-registration view
  // — just that event's card (status, partner, Change partner, Unregister) — and
  // hide the event picker + "register for others". Registering for more events
  // lives on the tournament page. The scope is display-only: the diff/submit below
  // still operate on the full event set, so hidden events are never touched.
  const manageEventId =
    preselectEventId && existingRegs.has(preselectEventId)
      ? preselectEventId
      : null;
  const isManageMode = manageEventId !== null;
  const visibleEvents = isManageMode
    ? events.filter((e) => e.id === manageEventId)
    : events;

  return (
    <Shell>
      <Link
        to={`/t/${orgSlug}/${tournamentSlug}`}
        style={{ color: courtBlue, textDecoration: "none", fontSize: 13, fontWeight: 500 }}
      >
        ← {tournament.name}
      </Link>
      <h1 style={{ ...pageH1Style, margin: "12px 0 8px" }}>
        {isManageMode
          ? "Manage your registration"
          : `Register for ${tournament.name}`}
      </h1>
      <p style={{ color: inkSoft, margin: "0 0 24px", fontSize: 14, lineHeight: 1.55 }}>
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
            partnerChanged={partnerChangedEvents}
            existingRegs={existingRegs}
            selections={selections}
            onUndo={(ev, kind) => {
              // Reset whatever piece of state was changed back to
              // its initial value at load time. Doesn't write to
              // the DB — just clears the diff for that row.
              if (kind === "added") {
                setSel(ev.id, {
                  selected: false,
                  partner: emptySelection,
                });
                return;
              }
              if (kind === "withdrawn") {
                // Re-check the existing reg; partner state in
                // selections is already the original from init.
                setSel(ev.id, { selected: true });
                return;
              }
              if (kind === "partner_changed") {
                // Restore partner from existingRegs (same data the
                // init logic seeds from).
                const existing = existingRegs.get(ev.id);
                if (existing?.partner && ev.format === "doubles") {
                  setSel(ev.id, {
                    partner: {
                      mode: "existing",
                      player: existing.partner as unknown as Player,
                      emailDraft: existing.partner.email ?? "",
                      phoneDraft: existing.partner.phone ?? "",
                    },
                  });
                } else {
                  setSel(ev.id, { partner: emptySelection });
                }
              }
            }}
          />
        )}

        <Section title={isManageMode ? "Your registration" : "Pick your events"}>
          {events.length === 0 ? (
            <Empty>No events available for registration.</Empty>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {visibleEvents.map((ev) => {
                const sel = selections.get(ev.id)!;
                const existing = existingRegs.get(ev.id);
                const eligResult = me
                  ? checkEligibility(me, ev)
                  : { eligible: true, reasons: [] as string[] };
                return (
                  <EventRow
                    key={ev.id}
                    event={ev}
                    selection={sel}
                    existing={existing}
                    change={changeFor(ev.id)}
                    lineItem={lineItemByEventId.get(ev.id)}
                    disabled={submitting}
                    onChange={(patch) => setSel(ev.id, patch)}
                    // Stop the user from picking themselves as their
                    // own partner, AND filter out anyone already
                    // registered (paid OR pending) for this event —
                    // they can't accept the invite anyway. The set
                    // for this event was loaded via the F3 RPC.
                    excludePlayerIds={[
                      ...(me ? [me.id] : []),
                      ...Array.from(
                        registeredByEvent.get(ev.id) ?? new Set<string>(),
                      ),
                    ]}
                    ineligibleReasons={
                      eligResult.eligible ? undefined : eligResult.reasons
                    }
                  />
                );
              })}
            </div>
          )}
        </Section>

        {error && (
          <div style={{ ...statusPanelStyle("danger"), marginBottom: 16, fontSize: 13 }}>
            {error}
          </div>
        )}

        {/* Running total — reflects the FULL post-submit basket
            (kept existing regs + the player's current picks). Only
            renders when something is selected so a fresh form
            doesn't show "$0.00 across 0 events". */}
        {lineItems.length > 0 && (
          <div
            style={{
              padding: 16,
              background: cream,
              border: `1px solid ${ruleSoft}`,
              borderRadius: 10,
              marginBottom: 16,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ fontSize: 13, color: ink }}>
              {lineItems.length} event{lineItems.length === 1 ? "" : "s"}
              {(() => {
                // Tier breakdown — e.g. "Entry + 2 extra events + 1 flat-fee".
                const first = lineItems.filter((i) => i.tier === "first").length;
                const additional = lineItems.filter(
                  (i) => i.tier === "additional",
                ).length;
                const override = lineItems.filter(
                  (i) => i.tier === "override",
                ).length;
                const parts: string[] = [];
                if (first > 0) parts.push("Entry");
                if (additional > 0)
                  parts.push(
                    additional === 1 ? "1 extra event" : `${additional} extra events`,
                  );
                if (override > 0)
                  parts.push(`${override} flat-fee`);
                return parts.length > 0 ? (
                  <span style={{ color: inkSoft }}>
                    {" "}
                    ({parts.join(" + ")})
                  </span>
                ) : null;
              })()}
            </div>
            <div
              style={{
                fontFamily: headingFontStack,
                fontSize: 20,
                letterSpacing: "0.02em",
                color: ink,
              }}
            >
              {formatUsd(totalCents)}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            type="submit"
            disabled={submitting || !hasChanges}
            style={
              submitting || !hasChanges
                ? { ...ctaPrimaryDisabledStyle, padding: "14px 22px" }
                : { ...ctaPrimaryStyle, padding: "14px 22px" }
            }
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
          {/* Cancel discards in-progress changes and drops the user
              back at the tournament public page. The form is
              re-derivable from the DB so leaving here doesn't lose
              anything saved. */}
          <button
            type="button"
            onClick={() => navigate(`/t/${orgSlug}/${tournamentSlug}`)}
            disabled={submitting}
            style={{
              ...ctaSecondaryStyle,
              padding: "14px 22px",
              cursor: submitting ? "not-allowed" : "pointer",
              opacity: submitting ? 0.6 : 1,
            }}
          >
            Cancel
          </button>
        </div>
      </form>

      {/* Change-request section — shown when the player already has at
          least one registration (paid or pending) for this tournament.
          Cases the normal save-flow can't handle: division swap after
          paying, partner change post-accept, special withdrawal. */}
      {existingRegs.size > 0 && (
        <div
          style={{
            marginTop: 32,
            paddingTop: 24,
            borderTop: "1px solid #e5e7eb",
          }}
        >
          <div
            style={{ fontSize: 14, fontWeight: 600, color: "#374151", marginBottom: 4 }}
          >
            Need organizer help?
          </div>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 12px", lineHeight: 1.5 }}>
            For changes that can't be done here — switching divisions, swapping
            a partner who already accepted, or a special-circumstance withdrawal
            — send a request to the organizer.
          </p>

          {crSuccess && (
            <div
              style={{
                padding: "10px 14px",
                background: "#dcfce7",
                border: "1px solid #86efac",
                borderRadius: 6,
                fontSize: 13,
                color: "#166534",
                marginBottom: 12,
              }}
            >
              Your request was sent. The organizer will follow up.
            </div>
          )}

          {!crSuccess && !showChangeRequest && (
            <button
              type="button"
              onClick={() => setShowChangeRequest(true)}
              style={{
                padding: "8px 18px",
                border: "1px solid #d1d5db",
                background: "#fff",
                color: "#374151",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Request a change
            </button>
          )}

          {showChangeRequest && (
            <div
              style={{
                padding: 16,
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                background: "#f9fafb",
              }}
            >
              <div style={{ marginBottom: 14 }}>
                <label
                  htmlFor="cr-kind"
                  style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 4 }}
                >
                  Type of request
                </label>
                <select
                  id="cr-kind"
                  value={crKind}
                  onChange={(e) => setCrKind(e.target.value as ChangeRequestKind)}
                  style={{
                    padding: "8px 10px",
                    border: "1px solid #d1d5db",
                    borderRadius: 6,
                    fontSize: 13,
                    fontFamily: "inherit",
                    background: "#fff",
                    color: "#111827",
                    width: "100%",
                    maxWidth: 280,
                  }}
                >
                  <option value="division_change">Division change</option>
                  <option value="partner_change">Partner change</option>
                  <option value="withdrawal">Withdrawal</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label
                  htmlFor="cr-note"
                  style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 4 }}
                >
                  Details
                </label>
                <textarea
                  id="cr-note"
                  value={crNote}
                  onChange={(e) => setCrNote(e.target.value)}
                  rows={3}
                  placeholder="Describe what you need…"
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "8px 10px",
                    border: "1px solid #d1d5db",
                    borderRadius: 6,
                    fontSize: 13,
                    fontFamily: "inherit",
                    resize: "vertical",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              {crError && (
                <div style={{ fontSize: 13, color: "#991b1b", marginBottom: 10 }}>
                  {crError}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  disabled={crSubmitting}
                  onClick={() => void submitChangeRequest()}
                  style={{
                    padding: "8px 20px",
                    border: "1px solid #2563eb",
                    background: crSubmitting ? "#eff6ff" : "#2563eb",
                    color: crSubmitting ? "#1d4ed8" : "#fff",
                    borderRadius: 6,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: crSubmitting ? "not-allowed" : "pointer",
                    fontFamily: "inherit",
                    opacity: crSubmitting ? 0.7 : 1,
                  }}
                >
                  {crSubmitting ? "Sending…" : "Send request"}
                </button>
                <button
                  type="button"
                  disabled={crSubmitting}
                  onClick={() => {
                    setShowChangeRequest(false);
                    setCrNote("");
                    setCrKind("other");
                    setCrError(null);
                  }}
                  style={{
                    padding: "8px 18px",
                    border: "1px solid #d1d5db",
                    background: "#fff",
                    color: "#374151",
                    borderRadius: 6,
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: crSubmitting ? "not-allowed" : "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
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
  lineItem,
  disabled,
  onChange,
  excludePlayerIds,
  ineligibleReasons,
}: {
  event: Event;
  selection: EventSelection;
  existing: ExistingReg | undefined;
  change: ChangeType;
  // Live-computed line item for this row (when selected). Carries
  // the cents to charge AND the tier classification (first /
  // additional / override) so the per-row price label can tell the
  // user which rate they're getting.
  lineItem: LineItem | undefined;
  disabled: boolean;
  onChange: (patch: Partial<EventSelection>) => void;
  excludePlayerIds: string[];
  // Non-empty when the logged-in player doesn't meet this event's
  // eligibility requirements and has no existing registration.
  // The checkbox is disabled and the reasons are shown inline.
  ineligibleReasons?: string[];
}) {
  const chips = eligibilityChips(event);
  // Gate: hide the checkbox for ineligible events the player isn't yet in.
  const isIneligible = !!ineligibleReasons?.length && !existing;

  // Visual treatment derived from existing-reg + diff state.
  // "added"           → blue border, "Will register" pill
  // "withdrawn"       → amber border + tint, "Will withdraw" pill (caution, not
  //                     an error — red is reserved for actual error messages)
  // "partner_changed" → amber border + tint, "Partner change" pill
  // "unchanged" + existing → green tint, "Registered" pill
  // "unchanged" + new      → plain (default)
  const isExistingChecked = !!existing && change === "unchanged";
  const isWillWithdraw = change === "withdrawn";
  const isWillAdd = change === "added";
  const isPartnerChanged = change === "partner_changed";

  const borderColor = isWillWithdraw
    ? "#fbbf24"
    : isWillAdd
      ? "#2563eb"
      : isPartnerChanged
        ? "#fbbf24"
        : isExistingChecked
          ? "#bbf7d0"
          : selection.selected
            ? "#2563eb"
            : "#e5e7eb";
  const bg = isWillWithdraw
    ? "#fffbeb"
    : isPartnerChanged
      ? "#fffbeb"
      : isExistingChecked
        ? "#f0fdf4"
        : "#fff";

  // Affordances (issues #2–#4): registered events read as managed cards
  // with explicit Change-partner / Unregister buttons, and unregistered
  // events get an explicit Register button instead of a checkbox. The
  // staged-diff model underneath is unchanged — the buttons just call
  // onChange({ selected }) and toggle the partner editor; the bottom bar
  // still confirms everything at once.
  const [editingPartner, setEditingPartner] = useState(false);
  const hasPartner = !!existing?.partnerLabel;

  // The current partner as a PlayerSelection, so "Cancel" on a change can
  // revert to it (mirrors the page-level init).
  const originalPartnerSelection: PlayerSelection =
    existing?.partner && event.format === "doubles"
      ? {
          mode: "existing",
          player: existing.partner as unknown as Player,
          emailDraft: existing.partner.email ?? "",
          phoneDraft: existing.partner.phone ?? "",
        }
      : emptySelection;

  // Show the partner search for: a new doubles add (must pick), an existing
  // reg with no partner yet, a staged partner change, or after the user
  // taps "Change partner". An existing reg WITH a partner stays collapsed
  // until then (issue #2).
  const showPartnerEditor =
    event.format === "doubles" &&
    selection.selected &&
    !isWillWithdraw &&
    (isWillAdd ||
      isPartnerChanged ||
      editingPartner ||
      (isExistingChecked && !hasPartner));

  const cancelPartnerEdit = () => {
    onChange({ partner: originalPartnerSelection });
    setEditingPartner(false);
  };

  const btnBase: CSSProperties = {
    border: "1px solid #d6d3d1",
    background: "#fff",
    color: "#1f2937",
    borderRadius: 8,
    padding: "8px 14px",
    fontSize: 13,
    fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  };
  // Caution (not error). Red is reserved for actual error messages; a staged
  // withdraw/remove is amber, matching the "Pending changes" / partner-change
  // styling.
  const cautionBtn: CSSProperties = {
    ...btnBase,
    color: "#92400e",
    borderColor: "#e7c9a3",
    background: "#fffbeb",
  };
  const filledBtn: CSSProperties = {
    ...btnBase,
    background: "#1f2937",
    color: "#fff",
    border: "none",
  };

  return (
    <div
      style={{
        padding: 14,
        background: bg,
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: 15,
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
              <Pill bg="#fef3c7" fg="#7a5d00">Will withdraw</Pill>
            )}
            {isPartnerChanged && (
              <Pill bg="#fef3c7" fg="#7a5d00">Partner change</Pill>
            )}
          </div>

          <div style={{ color: "#666", fontSize: 12, marginTop: 4 }}>
            {capitalize(event.format)} · {capitalize(event.gender)} ·{" "}
            {event.points_to_win} win by {event.win_by}
          </div>

          {/* Per-row price + tier label. Withdrawals hide it — nothing
              to charge. */}
          {lineItem && !isWillWithdraw && lineItem.cents > 0 && (
            <div style={{ marginTop: 6, fontSize: 12, color: "#444" }}>
              <strong>{formatUsd(lineItem.cents)}</strong>{" "}
              <span style={{ color: "#888" }}>
                (
                {lineItem.tier === "first"
                  ? "entry"
                  : lineItem.tier === "additional"
                    ? "extra event"
                    : "flat fee"}
                )
              </span>
            </div>
          )}

          {/* Partner line for an unchanged existing reg (issue #1: now
              resolves the invitee's partner too). */}
          {existing &&
            event.format === "doubles" &&
            existing.partnerLabel &&
            !isPartnerChanged &&
            !isWillWithdraw && (
              <div
                style={{
                  fontSize: 13,
                  color: "#166534",
                  marginTop: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span aria-hidden>✓</span>
                {existing.partnerStatus === "pending" ? (
                  <span>
                    Waiting for <strong>{existing.partnerLabel}</strong>
                  </span>
                ) : (
                  <span>
                    Partner: <strong>{existing.partnerLabel}</strong> — accepted
                  </span>
                )}
              </div>
            )}
          {/* Existing doubles reg with no partner yet. */}
          {isExistingChecked &&
            event.format === "doubles" &&
            !existing?.partnerLabel &&
            !showPartnerEditor && (
              <div style={{ fontSize: 13, color: "#1e40af", marginTop: 8 }}>
                No partner yet — add one below.
              </div>
            )}
          {isPartnerChanged && existing?.partnerLabel && (
            <div style={{ fontSize: 12, color: "#7a5d00", marginTop: 8 }}>
              Was: <strong>{existing.partnerLabel}</strong>. They'll be
              notified by email when you confirm.
            </div>
          )}
          {isWillWithdraw && (
            <div
              style={{
                fontSize: 12,
                color: "#7a5d00",
                marginTop: 8,
                lineHeight: 1.5,
              }}
            >
              You'll be removed from this event.{" "}
              {existing?.partnerLabel
                ? `${existing.partnerLabel} won't be your partner anymore. `
                : ""}
            </div>
          )}

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
          {isIneligible && (
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>
              Not eligible: {ineligibleReasons!.join("; ")}
            </div>
          )}
        </div>

        {/* Right-side primary action for the un-staged states (issue #4:
            an explicit Register button, not a checkbox). */}
        <div style={{ flexShrink: 0 }}>
          {!isIneligible && !existing && !selection.selected && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange({ selected: true })}
              style={filledBtn}
            >
              + Register
            </button>
          )}
          {isWillAdd && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange({ selected: false })}
              style={cautionBtn}
            >
              Remove
            </button>
          )}
          {/* No per-card "Keep" — undoing a staged withdrawal is the top
              "Pending changes → Undo" link or the Cancel button, so the card
              doesn't offer a competing action on top of Unregister. */}
        </div>
      </div>

      {/* Manage actions for a registered (unchanged) event (issues #2/#3). */}
      {isExistingChecked && (
        <div
          style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}
        >
          {event.format === "doubles" && hasPartner && !showPartnerEditor && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => setEditingPartner(true)}
              style={btnBase}
            >
              Change partner
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ selected: false })}
            style={cautionBtn}
          >
            Unregister
          </button>
        </div>
      )}

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
        >
          <div style={{ fontSize: 12, color: "#666" }}>
            Your doubles partner. Search by name, email, or phone — if
            they're not in the list yet, "Add new" to invite them. They'll
            get an invite link to confirm.
          </div>
          <PartnerSearch
            selection={selection.partner}
            onChange={(p) => onChange({ partner: p })}
            excludePlayerIds={excludePlayerIds}
          />
          {/* Cancel a partner change on an existing reg — revert + collapse. */}
          {isExistingChecked && (editingPartner || isPartnerChanged) && (
            <button
              type="button"
              onClick={cancelPartnerEdit}
              style={{
                alignSelf: "flex-start",
                background: "none",
                border: "none",
                color: "#6b7280",
                fontSize: 12,
                textDecoration: "underline",
                cursor: "pointer",
                fontFamily: "inherit",
                padding: 0,
              }}
            >
              Cancel{hasPartner ? ` — keep ${existing!.partnerLabel}` : ""}
            </button>
          )}
        </div>
      )}
    </div>
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
  partnerChanged,
  existingRegs,
  selections,
  onUndo,
}: {
  added: Event[];
  withdrawn: Event[];
  partnerChanged: Event[];
  existingRegs: Map<string, ExistingReg>;
  selections: Map<string, EventSelection>;
  // Per-row undo: clears that specific change without affecting
  // the others. Misclick recovery — the user shouldn't have to
  // hunt through the events list to find the row they changed.
  onUndo: (ev: Event, kind: ChangeType) => void;
}) {
  // Render a partner swap as "old → new" so the user can verify
  // the diff before hitting Confirm. Falls back to "previous
  // partner" when we don't have the old partner's name (e.g.
  // they never accepted the original invite).
  const describePartnerSwap = (ev: Event): string => {
    const existing = existingRegs.get(ev.id);
    const sel = selections.get(ev.id);
    const oldLabel = existing?.partner
      ? `${existing.partner.first_name} ${existing.partner.last_name}`
      : "your previous partner";
    let newLabel = "(no partner picked)";
    if (sel?.partner.mode === "existing") {
      newLabel = `${sel.partner.player.first_name} ${sel.partner.player.last_name}`;
    } else if (sel?.partner.mode === "new") {
      const first = sel.partner.firstName.trim();
      const last = sel.partner.lastName.trim();
      newLabel =
        first || last ? `${first} ${last}`.trim() : "a new partner";
    }
    return `${oldLabel} → ${newLabel}`;
  };
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
            <strong>Register</strong> for {ev.name}{" "}
            <UndoLink onClick={() => onUndo(ev, "added")} />
          </li>
        ))}
        {withdrawn.map((ev) => (
          <li key={`w-${ev.id}`}>
            <strong>Withdraw</strong> from {ev.name}{" "}
            <UndoLink onClick={() => onUndo(ev, "withdrawn")} />
          </li>
        ))}
        {partnerChanged.map((ev) => (
          <li key={`p-${ev.id}`}>
            <strong>Change partner</strong> for {ev.name} (
            {describePartnerSwap(ev)}){" "}
            <UndoLink onClick={() => onUndo(ev, "partner_changed")} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// Small inline "↶ Undo" button rendered next to each entry in the
// ChangeSummary list. Underlined link styling so it reads as a
// natural recovery action rather than competing with the primary
// Confirm button below.
function UndoLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "none",
        border: "none",
        color: "#7a5d00",
        textDecoration: "underline",
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 12,
        padding: 0,
        marginLeft: 4,
      }}
    >
      ↶ Undo
    </button>
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
    <div style={pageWrapStyle}>
      <main style={contentColStyle(760)}>{children}</main>
    </div>
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
    <section style={{ marginBottom: 28 }}>
      <h2 style={sectionH2Style}>{title}</h2>
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
        background: cream,
        border: `1px dashed ${creamDeep}`,
        borderRadius: 8,
        color: inkSoft,
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

