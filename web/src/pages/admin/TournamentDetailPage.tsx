import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { ConfirmModal } from "../../components/ConfirmModal";
import { eligibilityChips } from "../../lib/eligibility";
import { estimateMedalRound, estimatePoolPlay } from "../../lib/estimator";
import {
  compactTierPriceLabel,
  type PricingTier,
} from "../../lib/pricingTiers";
import type { Database } from "../../types/supabase";
import {
  ink,
  inkSoft,
  inkMuted,
  bg,
  cream,
  rule,
  ruleSoft,
  creamDeep,
  courtBlue,
  bodyFontStack,
  headingFontStack,
  displayFontStack,
  monoFontStack,
  dangerBg,
  dangerFg,
  successBg,
  successFg,
  warnBg,
  warnFg,
  infoBg,
  infoFg,
  breadcrumbLinkStyle,
} from "../../lib/publicTheme";

// Court count + venue details now live on the selected venue
// (locations), joined in on the tournament fetch below.
type Tournament = Database["public"]["Tables"]["tournaments"]["Row"] & {
  locations: { name: string; address: string | null; court_count: number | null } | null;
};
type Event = Database["public"]["Tables"]["events"]["Row"];
type EventStatus = Database["public"]["Enums"]["event_status"];
type TournamentStatus = Database["public"]["Enums"]["tournament_status"];
type EventCourt = Database["public"]["Tables"]["event_courts"]["Row"];

type EventSummary = {
  event: Event;
  teamCount: number;
  courtNumbers: number[];
};

type CancelResult = {
  players_refunded: number;
  registrations_refunded: number;
  total_refunded_cents: number;
  emailed: number;
  failures: Array<{ event_registration_id: string; error: string }>;
};

type PendingWithdrawal = {
  id: string;
  playerFirstName: string | null;
  playerLastName: string | null;
  eventName: string;
  eventFeeCents: number;
  entitledRefundCents: number | null;
  withdrawalRequestedAt: string;
  withdrawalReason: string | null;
  daysToStart: number | null;
  requestedDaysAgo: number;
};

// Tournament homepage: stats + events list with per-event status,
// court allocation, and start/complete actions. The court manager
// link sits at the top because it's tournament-wide — a single
// dispatcher across all active events.
export default function TournamentDetailPage() {
  const { org, role } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();
  const [t, setT] = useState<Tournament | null>(null);
  const [tiers, setTiers] = useState<PricingTier[]>([]);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [eventCourts, setEventCourts] = useState<EventCourt[]>([]);
  const [totalPlayers, setTotalPlayers] = useState<number | null>(null);
  const [openChangeRequestCount, setOpenChangeRequestCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pendingDeleteEvent, setPendingDeleteEvent] = useState<EventSummary | null>(null);
  const [deletingEvent, setDeletingEvent] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelResult, setCancelResult] = useState<CancelResult | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [pendingWithdrawals, setPendingWithdrawals] = useState<PendingWithdrawal[]>([]);
  const [approvingWithdrawal, setApprovingWithdrawal] = useState<PendingWithdrawal | null>(null);
  const [approveAmountStr, setApproveAmountStr] = useState("");
  const [approveBusy, setApproveBusy] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [denyingWithdrawal, setDenyingWithdrawal] = useState<PendingWithdrawal | null>(null);
  const [denyBusy, setDenyBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!org || !tournamentSlug) return;
    // Don't flip loading=true on subsequent reloads — that flashes the
    // "Loading…" skeleton on every mutation. The initial useState(true)
    // covers the first paint; after that we update in place.
    setError(null);

    const { data: tData, error: tErr } = await supabase
      .from("tournaments")
      .select("*, locations(name, address, court_count)")
      .eq("organization_id", org.id)
      .eq("slug", tournamentSlug)
      .is("deleted_at", null)
      .maybeSingle();
    if (tErr) {
      setError(tErr.message);
      setLoading(false);
      return;
    }
    if (!tData) {
      setError("Tournament not found.");
      setLoading(false);
      return;
    }

    // Events + their registrations + court allocations + pricing
    // tiers + open change request count + pending refund requests, in parallel.
    const [evRes, regsRes, courtsRes, tiersRes, openCrRes, withdrawRes] = await Promise.all([
      supabase
        .from("events")
        .select("*")
        .eq("tournament_id", tData.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: true }),
      supabase
        .from("event_registrations")
        .select("event_id, player_id, events!inner(tournament_id)")
        .eq("events.tournament_id", tData.id)
        .is("deleted_at", null),
      supabase
        .from("event_courts")
        .select("*, events!inner(tournament_id)")
        .eq("events.tournament_id", tData.id),
      supabase
        .from("tournament_pricing_tiers")
        .select("*")
        .eq("tournament_id", tData.id)
        .order("sort_order", { ascending: true }),
      supabase
        .from("tournament_change_requests")
        .select("id", { count: "exact", head: true })
        .eq("tournament_id", tData.id)
        .eq("status", "open"),
      supabase
        .from("event_registrations")
        .select(
          "id, withdrawal_requested_at, withdrawal_reason, entitled_refund_cents, players(first_name, last_name), events!inner(name, event_fee_cents, tournament_id)",
        )
        .eq("events.tournament_id", tData.id)
        .not("withdrawal_requested_at", "is", null)
        .is("withdrawal_decided_at", null)
        .is("deleted_at", null)
        .in("status", ["paid", "withdrawn"])
        .order("withdrawal_requested_at", { ascending: true }),
    ]);

    setTiers(tiersRes.data ?? []);
    setOpenChangeRequestCount(openCrRes.count ?? 0);

    type WithdrawRow = {
      id: string;
      withdrawal_requested_at: string;
      withdrawal_reason: string | null;
      entitled_refund_cents: number | null;
      players: { first_name: string | null; last_name: string | null } | null;
      events: { name: string; event_fee_cents: number };
    };
    const wdRows = (withdrawRes.data ?? []) as unknown as WithdrawRow[];
    const fetchTime = new Date();
    const tournamentStart = tData.starts_at ? new Date(tData.starts_at) : null;
    setPendingWithdrawals(
      wdRows.map((row) => {
        const requestedAt = new Date(row.withdrawal_requested_at);
        return {
          id: row.id,
          playerFirstName: row.players?.first_name ?? null,
          playerLastName: row.players?.last_name ?? null,
          eventName: row.events.name,
          eventFeeCents: row.events.event_fee_cents,
          entitledRefundCents: row.entitled_refund_cents,
          withdrawalRequestedAt: row.withdrawal_requested_at,
          withdrawalReason: row.withdrawal_reason,
          daysToStart: tournamentStart
            ? Math.max(
                0,
                Math.ceil(
                  (tournamentStart.getTime() - fetchTime.getTime()) / 86_400_000,
                ),
              )
            : null,
          requestedDaysAgo: Math.floor(
            (fetchTime.getTime() - requestedAt.getTime()) / 86_400_000,
          ),
        };
      }),
    );

    if (evRes.error) {
      setError(evRes.error.message);
      setLoading(false);
      return;
    }
    if (regsRes.error) {
      setError(regsRes.error.message);
      setLoading(false);
      return;
    }
    if (courtsRes.error) {
      setError(courtsRes.error.message);
      setLoading(false);
      return;
    }

    const evs = evRes.data ?? [];
    const regs = regsRes.data ?? [];
    const courts = (courtsRes.data ?? []) as unknown as EventCourt[];
    setEventCourts(courts);

    // Auto-transition tournament status. Two rules, both
    // page-load-evaluated (no cron required):
    //   * `published` → `closed` once registration_closes_at is in
    //     the past. Stops new sign-ups without an organizer click.
    //   * `published`/`closed` → `completed` once every non-cancelled
    //     event has reached `complete` or `verified`. The whole
    //     tournament has wrapped at that point.
    // If we transition we keep the local copy in sync so the rest
    // of this reload renders the new state without a second fetch.
    let liveTournament = tData;
    {
      const next = inferTournamentStatus(tData, evs);
      if (next && next !== tData.status) {
        const { error: trErr } = await supabase
          .from("tournaments")
          .update({ status: next })
          .eq("id", tData.id);
        if (!trErr) liveTournament = { ...tData, status: next };
      }
    }
    setT(liveTournament);

    // Player count: distinct player_id across all event_registrations
    // for this tournament.
    setTotalPlayers(new Set(regs.map((r) => r.player_id)).size);

    const regsByEvent = new Map<string, number>();
    for (const r of regs) {
      regsByEvent.set(r.event_id, (regsByEvent.get(r.event_id) ?? 0) + 1);
    }
    const courtsByEvent = new Map<string, number[]>();
    for (const c of courts) {
      const arr = courtsByEvent.get(c.event_id) ?? [];
      arr.push(c.court_number);
      courtsByEvent.set(c.event_id, arr);
    }

    const summaries: EventSummary[] = evs.map((event) => {
      const regCount = regsByEvent.get(event.id) ?? 0;
      const teamCount =
        event.format === "doubles" ? Math.floor(regCount / 2) : regCount;
      const courtNumbers = (courtsByEvent.get(event.id) ?? []).sort(
        (a, b) => a - b,
      );
      return { event, teamCount, courtNumbers };
    });
    setEvents(summaries);
    setLoading(false);
  }, [org, tournamentSlug]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Map court number → event_id of any ACTIVE event holding it. Used to
  // disable claiming a court that's already claimed by a different
  // active event.
  const activeOwnerByCourt = useMemo(() => {
    const m = new Map<number, string>();
    const eventById = new Map(events.map((s) => [s.event.id, s.event]));
    // An event holds its court while running OR paused — don't let a
    // sibling event claim a paused event's court.
    const ownsCourt = (s: EventStatus) =>
      s === "active" || s === "medal_round" || s === "on_hold";
    for (const ec of eventCourts) {
      const ev = eventById.get(ec.event_id);
      if (ev && ownsCourt(ev.status)) m.set(ec.court_number, ec.event_id);
    }
    return m;
  }, [eventCourts, events]);

  const setEventStatus = async (eventId: string, status: EventStatus) => {
    setBusyAction(`status:${eventId}`);
    const { error: updErr } = await supabase
      .from("events")
      .update({ status })
      .eq("id", eventId);
    setBusyAction(null);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    await reload();
  };

  // Duplicate an event: clone the full row into a fresh DRAFT under the same
  // tournament. Only the event's settings are copied — registrations, matches,
  // and court allocations are NOT. The organizer renames/tweaks the copy from
  // there. Cloning the whole row (minus id/timestamps) keeps this robust to new
  // columns without enumerating each field.
  const copyEvent = async (eventId: string) => {
    setBusyAction(`copy:${eventId}`);
    setError(null);
    const { data: src, error: fErr } = await supabase
      .from("events")
      .select("*")
      .eq("id", eventId)
      .single();
    if (fErr || !src) {
      setBusyAction(null);
      setError(fErr?.message ?? "Couldn't load the event to copy.");
      return;
    }
    // Drop identity/timestamps; keep every other column as-is.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _id, created_at: _created, deleted_at: _deleted, ...rest } = src;
    const { error: insErr } = await supabase.from("events").insert({
      ...rest,
      name: `Copy of ${src.name}`,
      status: "draft",
    });
    setBusyAction(null);
    if (insErr) {
      setError(insErr.message);
      return;
    }
    await reload();
  };

  // Soft-delete an event by setting deleted_at. Same pattern the rest
  // of the app uses (events are filtered by `is("deleted_at", null)`
  // everywhere). Match history, registrations, and event_courts stay
  // in the DB so the event can be recovered by clearing deleted_at —
  // only the dashboard hides it.
  const confirmDeleteEvent = async () => {
    if (!pendingDeleteEvent) return;
    setDeletingEvent(true);
    setError(null);
    const { error: updErr } = await supabase
      .from("events")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", pendingDeleteEvent.event.id);
    setDeletingEvent(false);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    setPendingDeleteEvent(null);
    await reload();
  };

  // Manual tournament-status transition. Auto-transitions to closed/
  // completed already happen inside reload(); this is for the buttons
  // in the header (Publish, Close registration, Cancel, Reopen, etc.).
  const setTournamentStatus = async (status: TournamentStatus) => {
    if (!t) return;
    setBusyAction("tstatus");
    const { error: updErr } = await supabase
      .from("tournaments")
      .update({ status })
      .eq("id", t.id);
    setBusyAction(null);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    await reload();
  };

  const cancelTournament = async () => {
    if (!t || !cancelReason.trim()) {
      setCancelError("Please enter a reason for the cancellation.");
      return;
    }
    setCancelBusy(true);
    setCancelError(null);
    const { data, error: fnErr } = await supabase.functions.invoke(
      "cancel-tournament",
      { body: { tournament_id: t.id, reason: cancelReason.trim() } },
    );
    setCancelBusy(false);
    if (fnErr) {
      setCancelError(await extractFnError(fnErr));
      return;
    }
    setCancelResult(data as CancelResult);
    setShowCancelModal(false);
    await reload();
  };

  const retryFailedRefunds = async () => {
    if (!t) return;
    setRetryBusy(true);
    const { data, error: fnErr } = await supabase.functions.invoke(
      "cancel-tournament",
      { body: { tournament_id: t.id, reason: cancelReason.trim() || "Retry" } },
    );
    setRetryBusy(false);
    if (fnErr) {
      setError(await extractFnError(fnErr));
      return;
    }
    setCancelResult(data as CancelResult);
  };

  const openApproveModal = (wd: PendingWithdrawal) => {
    const defaultStr =
      wd.entitledRefundCents !== null
        ? (wd.entitledRefundCents / 100).toFixed(2)
        : "0.00";
    setApproveAmountStr(defaultStr);
    setApproveError(null);
    setApprovingWithdrawal(wd);
  };

  const submitApprove = async () => {
    if (!approvingWithdrawal) return;
    const parsed = parseFloat(approveAmountStr);
    if (isNaN(parsed) || parsed < 0) {
      setApproveError("Enter a valid amount ($0.00 or more).");
      return;
    }
    const amountCents = Math.round(parsed * 100);
    if (amountCents > approvingWithdrawal.eventFeeCents) {
      setApproveError(
        `Amount cannot exceed $${(approvingWithdrawal.eventFeeCents / 100).toFixed(2)}.`,
      );
      return;
    }
    setApproveBusy(true);
    setApproveError(null);
    const { error: fnErr } = await supabase.functions.invoke("stripe-refund", {
      body: {
        eventRegistrationId: approvingWithdrawal.id,
        mode: "resolve",
        decision: "approve",
        amountCents,
        dryRun: false,
      },
    });
    setApproveBusy(false);
    if (fnErr) {
      setApproveError(await extractFnError(fnErr));
      return;
    }
    setApprovingWithdrawal(null);
    await reload();
  };

  const submitDeny = async () => {
    if (!denyingWithdrawal) return;
    setDenyBusy(true);
    const { error: fnErr } = await supabase.functions.invoke("stripe-refund", {
      body: {
        eventRegistrationId: denyingWithdrawal.id,
        mode: "resolve",
        decision: "deny",
        dryRun: false,
      },
    });
    setDenyBusy(false);
    if (fnErr) {
      setError(await extractFnError(fnErr));
    }
    setDenyingWithdrawal(null);
    await reload();
  };

  const toggleCourt = async (eventId: string, courtNumber: number) => {
    setBusyAction(`court:${eventId}:${courtNumber}`);
    const existing = eventCourts.find(
      (c) => c.event_id === eventId && c.court_number === courtNumber,
    );
    if (existing) {
      const { error: delErr } = await supabase
        .from("event_courts")
        .delete()
        .eq("event_id", eventId)
        .eq("court_number", courtNumber);
      setBusyAction(null);
      if (delErr) {
        setError(delErr.message);
        return;
      }
    } else {
      const { error: insErr } = await supabase
        .from("event_courts")
        .insert({ event_id: eventId, court_number: courtNumber });
      setBusyAction(null);
      if (insErr) {
        setError(insErr.message);
        return;
      }
    }
    await reload();
  };

  if (!org) return null;
  if (loading)
    return <div style={{ color: inkMuted, fontSize: 14, fontFamily: bodyFontStack }}>Loading…</div>;
  if (error) return <ErrorBox message={error} />;
  if (!t) return null;

  const venueCourtCount = t.locations?.court_count ?? null;
  const courts = Array.from(
    { length: venueCourtCount ?? 0 },
    (_, i) => i + 1,
  );

  return (
    <div style={{ fontFamily: bodyFontStack, color: ink }}>
      <Link
        to={`/admin/${org.slug}/tournaments`}
        style={breadcrumbLinkStyle}
      >
        ← Tournaments
      </Link>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "end",
          gap: 16,
          flexWrap: "wrap",
          marginTop: 12,
        }}
      >
        <div>
          <div
            style={{ display: "flex", alignItems: "center", gap: 10 }}
          >
            <h1 style={pageH1Style}>{t.name}</h1>
            <TournamentStatusBadge status={t.status} />
          </div>
          <p style={{ color: inkSoft, margin: "4px 0 0", fontSize: 14, lineHeight: 1.5 }}>
            {t.description || "No description."}
          </p>
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <TournamentStatusActions
            status={t.status}
            busy={busyAction === "tstatus"}
            onSetStatus={setTournamentStatus}
            onRequestCancel={() => {
              setCancelReason("");
              setCancelError(null);
              setShowCancelModal(true);
            }}
          />
          {/* Edit tournament details — name, dates, description,
              location, registration window, entry fee, court count.
              Status transitions stay on this page (the buttons just
              to the left of this) because they have public-visibility
              side effects worth surfacing in context. */}
          <Link
            to={`/admin/${org.slug}/tournaments/${t.slug}/wizard`}
            style={secondaryLinkBtn}
          >
            Edit
          </Link>
          {/* Resume wizard — only surfaced for draft tournaments so
              the organizer has a clear path back into the setup flow. */}
          {t.status === "draft" && (
            <Link
              to={`/admin/${org.slug}/tournaments/${t.slug}/wizard`}
              style={primaryLinkBtn}
            >
              Continue setup →
            </Link>
          )}
          {/* Public-facing tournament page. Available once the
              tournament is in a publicly-readable status (published,
              closed, or completed) — drafts have nothing to show on
              the public route. */}
          {(t.status === "published" ||
            t.status === "closed" ||
            t.status === "completed") && (
            <PublicPageLink orgSlug={org.slug} tournamentSlug={t.slug} />
          )}
          {/* Schedule view — time estimates for every event based on
              registered teams + format. Useful during planning AND
              live (e.g. "are we tracking ahead of plan?"). */}
          <Link
            to={`/admin/${org.slug}/tournaments/${t.slug}/schedule`}
            style={secondaryLinkBtn}
          >
            Schedule
          </Link>
          <Link
            to={`/admin/${org.slug}/tournaments/${t.slug}/wizard/contacts`}
            style={secondaryLinkBtn}
          >
            Tournament Contacts
          </Link>
          {(role === "owner" || role === "admin") && (
            <Link
              to={`/admin/${org.slug}/tournaments/${t.slug}/wizard/coupons`}
              style={{
                ...primaryLinkBtn,
                background: "#fff",
                color: "#2563eb",
                border: "1px solid #2563eb",
              }}
            >
              Coupons
            </Link>
          )}
          {t.accepts_donations && (
            <Link
              to={`/admin/${org.slug}/tournaments/${t.slug}/donations`}
              style={secondaryLinkBtn}
            >
              Donations
            </Link>
          )}
          {/* Court manager is always reachable from the tournament home —
              users want it to peek at the queue / setup courts even
              before an event is active. The page itself handles the
              empty state. */}
          <Link
            to={`/admin/${org.slug}/tournaments/${t.slug}/courts`}
            style={primaryLinkBtn}
          >
            Court manager →
          </Link>
        </div>
      </div>

      {/* Cancellation result — shown after a successful cancel or retry */}
      {cancelResult && (
        <div
          style={{
            marginTop: 16,
            padding: "12px 16px",
            background: successBg,
            border: `1px solid ${successFg}`,
            borderRadius: 8,
            fontSize: 13,
            color: successFg,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Tournament cancelled.</div>
          <div>
            {cancelResult.players_refunded}{" "}
            {cancelResult.players_refunded === 1 ? "player" : "players"} refunded — $
            {(cancelResult.total_refunded_cents / 100).toFixed(2)} total.
          </div>
          {cancelResult.failures.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ color: dangerFg }}>
                {cancelResult.failures.length} refund
                {cancelResult.failures.length === 1 ? "" : "s"} failed.
              </div>
              <button
                onClick={retryFailedRefunds}
                disabled={retryBusy}
                style={{
                  marginTop: 6,
                  padding: "6px 14px",
                  background: dangerBg,
                  color: dangerFg,
                  border: `1px solid ${dangerFg}`,
                  borderRadius: 6,
                  fontSize: 13,
                  cursor: retryBusy ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                  fontWeight: 500,
                }}
              >
                {retryBusy ? "Retrying…" : "Retry failed refunds"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Stats strip */}
      <div
        style={{
          marginTop: 24,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
        }}
      >
        <Stat
          label="Players registered"
          value={totalPlayers ?? "…"}
          to={
            totalPlayers && totalPlayers > 0
              ? `/admin/${org.slug}/tournaments/${t.slug}/attendees`
              : undefined
          }
        />
        <Stat label="Events" value={events.length} />
        <Stat
          label="Change requests"
          value={
            openChangeRequestCount === null
              ? "…"
              : openChangeRequestCount > 0
                ? `${openChangeRequestCount} open`
                : "none open"
          }
          to={`/admin/${org.slug}/tournaments/${t.slug}/change-requests`}
        />
        {/* Status moved out of the stats grid into the header
            badge, next to the action buttons that mutate it. */}
        <Stat
          label="Dates"
          value={`${fmtDate(t.starts_at)} – ${fmtDate(t.ends_at)}`}
        />
      </div>

      {/* Tournament details */}
      <dl
        style={{
          marginTop: 24,
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          rowGap: 6,
          columnGap: 16,
          fontSize: 13,
          color: inkSoft,
          maxWidth: 600,
        }}
      >
        <DtDd
          label="Entry fee"
          value={compactTierPriceLabel(tiers)}
        />
        <DtDd
          label="Venue"
          value={t.locations?.name || t.location_name || "—"}
        />
        <DtDd
          label="Address"
          value={t.locations?.address || t.location_address || "—"}
        />
        <dt style={{ color: inkMuted }}>Courts at venue</dt>
        <dd style={{ margin: 0 }}>
          {venueCourtCount != null ? (
            <span style={{ fontSize: 13, color: inkSoft }}>
              {venueCourtCount} court{venueCourtCount === 1 ? "" : "s"}
            </span>
          ) : (
            <span style={{ fontSize: 13, color: inkMuted }}>
              {t.location_id != null ? (
                <>
                  Not set —{" "}
                  <Link
                    to={`/admin/${org.slug}/locations`}
                    style={{ color: courtBlue, textDecoration: "none" }}
                  >
                    add it on the venue
                  </Link>
                </>
              ) : (
                <>
                  No venue —{" "}
                  <Link
                    to={`/admin/${org.slug}/tournaments/${t.slug}/wizard`}
                    style={{ color: courtBlue, textDecoration: "none" }}
                  >
                    choose one
                  </Link>
                </>
              )}
            </span>
          )}
        </dd>
      </dl>

      {/* Pending refund requests — admin/owner only */}
      {(role === "owner" || role === "admin") && pendingWithdrawals.length > 0 && (
        <section style={{ marginTop: 32 }}>
          <h2 style={{ ...sectionH2Style, marginBottom: 12 }}>
            Pending refund requests ({pendingWithdrawals.length})
          </h2>
          <div
            style={{
              border: `1px solid ${warnFg}`,
              borderRadius: 8,
              overflow: "hidden",
              background: warnBg,
            }}
          >
            {pendingWithdrawals.map((wd, i) => {
              const playerName =
                [wd.playerFirstName, wd.playerLastName].filter(Boolean).join(" ") ||
                "Unknown player";
              return (
                <div
                  key={wd.id}
                  style={{
                    padding: "14px 16px",
                    borderTop: i === 0 ? "none" : `1px solid ${warnFg}`,
                    display: "flex",
                    gap: 12,
                    alignItems: "start",
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: ink }}>
                      {playerName}
                    </div>
                    <div style={{ fontSize: 13, color: inkSoft, marginTop: 2 }}>
                      {wd.eventName}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: inkMuted,
                        marginTop: 4,
                        display: "flex",
                        gap: 12,
                        flexWrap: "wrap",
                      }}
                    >
                      <span>
                        Paid: <strong>${(wd.eventFeeCents / 100).toFixed(2)}</strong>
                      </span>
                      <span>
                        Entitled:{" "}
                        <strong>
                          {wd.entitledRefundCents !== null
                            ? `$${(wd.entitledRefundCents / 100).toFixed(2)}`
                            : "organizer decides"}
                        </strong>
                      </span>
                      {wd.daysToStart !== null && (
                        <span>
                          {wd.daysToStart === 0
                            ? "Tournament today"
                            : `${wd.daysToStart}d to start`}
                        </span>
                      )}
                      <span>
                        Requested{" "}
                        {wd.requestedDaysAgo === 0 ? "today" : `${wd.requestedDaysAgo}d ago`}
                      </span>
                    </div>
                    {wd.withdrawalReason && (
                      <div
                        style={{
                          marginTop: 6,
                          fontSize: 13,
                          color: inkSoft,
                          fontStyle: "italic",
                        }}
                      >
                        "{wd.withdrawalReason}"
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      flexShrink: 0,
                      alignItems: "center",
                    }}
                  >
                    <button onClick={() => openApproveModal(wd)} style={primaryBtn(false)}>
                      Approve
                    </button>
                    <button
                      onClick={() => setDenyingWithdrawal(wd)}
                      style={secondaryBtn}
                    >
                      Deny
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Events list */}
      <section style={{ marginTop: 32 }}>
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <h2 style={sectionH2Style}>
            Events ({events.length})
          </h2>
          <div style={{ display: "flex", gap: 8 }}>
            {/* Bulk edit — name, status, scheduled start, max teams,
                event fee for every event at once. Per-event detail
                edits still live on the per-event edit page. */}
            {events.length > 0 && (
              <Link
                to={`/admin/${org.slug}/tournaments/${t.slug}/events/edit`}
                style={secondaryLinkBtnSmall}
              >
                Edit all
              </Link>
            )}
            <Link
              to={`/admin/${org.slug}/tournaments/${t.slug}/events/new`}
              style={primaryLinkBtnSmall}
            >
              + New event
            </Link>
          </div>
        </header>

        {events.length === 0 ? (
          <Empty>No events yet. Add one to start registering teams.</Empty>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {events.map((s) => (
              <EventCard
                key={s.event.id}
                summary={s}
                courts={courts}
                activeOwnerByCourt={activeOwnerByCourt}
                orgSlug={org.slug}
                tournamentSlug={t.slug}
                busyAction={busyAction}
                onSetStatus={setEventStatus}
                onToggleCourt={toggleCourt}
                onDelete={() => setPendingDeleteEvent(s)}
                onCopy={() => copyEvent(s.event.id)}
              />
            ))}
          </div>
        )}
      </section>

      {pendingDeleteEvent && (
        <ConfirmModal
          title={`Delete "${pendingDeleteEvent.event.name}"?`}
          body={
            <div>
              The event will disappear from the dashboard. Match history,
              standings, and team registrations stay in the database — if
              this turns out to be a mistake, an admin can restore the
              event by clearing its <code>deleted_at</code> column.
              {pendingDeleteEvent.teamCount > 0 && (
                <div style={{ marginTop: 8 }}>
                  <strong>{pendingDeleteEvent.teamCount}</strong>{" "}
                  {pendingDeleteEvent.teamCount === 1 ? "team is" : "teams are"}{" "}
                  registered for this event.
                </div>
              )}
            </div>
          }
          confirmLabel={deletingEvent ? "Deleting…" : "Delete event"}
          onCancel={() => setPendingDeleteEvent(null)}
          onConfirm={confirmDeleteEvent}
        />
      )}

      {showCancelModal && (
        <CancelTournamentModal
          reason={cancelReason}
          onReasonChange={setCancelReason}
          busy={cancelBusy}
          error={cancelError}
          onConfirm={cancelTournament}
          onCancel={() => {
            setShowCancelModal(false);
            setCancelError(null);
          }}
        />
      )}

      {approvingWithdrawal && (
        <ApproveWithdrawalModal
          withdrawal={approvingWithdrawal}
          amountStr={approveAmountStr}
          onAmountChange={setApproveAmountStr}
          busy={approveBusy}
          error={approveError}
          onConfirm={submitApprove}
          onCancel={() => {
            setApprovingWithdrawal(null);
            setApproveError(null);
          }}
        />
      )}

      {denyingWithdrawal && (
        <ConfirmModal
          title="Deny refund request?"
          body={
            <div style={{ fontSize: 13, color: inkSoft, lineHeight: 1.5 }}>
              <p style={{ margin: "0 0 8px" }}>
                <strong>
                  {[denyingWithdrawal.playerFirstName, denyingWithdrawal.playerLastName]
                    .filter(Boolean)
                    .join(" ")}
                </strong>{" "}
                will not receive a refund for their{" "}
                <strong>{denyingWithdrawal.eventName}</strong> registration. Their
                status will remain "withdrawn."
              </p>
              {denyBusy && (
                <p style={{ margin: 0, color: inkMuted }}>Processing…</p>
              )}
            </div>
          }
          confirmLabel={denyBusy ? "Denying…" : "Deny refund"}
          onCancel={() => setDenyingWithdrawal(null)}
          onConfirm={submitDeny}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Per-event card
// ─────────────────────────────────────────────────────────────────────

function EventCard({
  summary,
  courts,
  activeOwnerByCourt,
  orgSlug,
  tournamentSlug,
  busyAction,
  onSetStatus,
  onToggleCourt,
  onDelete,
  onCopy,
}: {
  summary: EventSummary;
  courts: number[];
  activeOwnerByCourt: Map<number, string>;
  orgSlug: string;
  tournamentSlug: string;
  busyAction: string | null;
  onSetStatus: (eventId: string, status: EventStatus) => Promise<void>;
  onToggleCourt: (eventId: string, courtNumber: number) => Promise<void>;
  onDelete: () => void;
  onCopy: () => void;
}) {
  const { event, teamCount, courtNumbers } = summary;
  const claimed = new Set(courtNumbers);

  // If the event has a scheduled start, derive the end from the same
  // estimator math the schedule page uses, so the two views agree.
  const scheduledStart = event.scheduled_start_at
    ? new Date(event.scheduled_start_at)
    : null;
  const scheduledEnd = (() => {
    if (!scheduledStart || teamCount < 2) return null;
    const courtsForEvent = Math.max(1, courtNumbers.length);
    const teamsPerPool =
      event.pool_count > 0
        ? Math.max(2, Math.ceil(teamCount / event.pool_count))
        : Math.max(2, teamCount);
    const pool = estimatePoolPlay({
      courts: courtsForEvent,
      pools: event.pool_count,
      teamsPerPool,
      minutesPerGame: event.pool_minutes_per_game,
      playEachOpponentTimes: event.play_each_team_times,
    });
    const medal =
      event.teams_advancing_to_playoff > 0
        ? estimateMedalRound({
            courts: courtsForEvent,
            teamsAdvancing: event.teams_advancing_to_playoff,
            rounds: (event.playoff_rounds as 1 | 2) ?? 1,
            format: event.medal_match_format,
            minutesPerGame: event.medal_minutes_per_game,
          })
        : null;
    const totalMinutes = pool.totalMinutes + (medal?.totalMinutes ?? 0);
    return new Date(scheduledStart.getTime() + totalMinutes * 60_000);
  })();

  return (
    <div
      style={{
        padding: 16,
        background: "#ffffff",
        border: `1px solid ${rule}`,
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "start",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, fontFamily: bodyFontStack, color: ink }}>
              {event.name}
            </h3>
            <EventStatusBadge status={event.status} />
          </div>
          <div style={{ color: inkMuted, fontSize: 12, marginTop: 4 }}>
            {event.format} · {event.gender} ·{" "}
            {event.bracket_type.replace("_", " ")} · {teamCount}{" "}
            {teamCount === 1 ? "team" : "teams"}
            {event.max_teams ? ` / ${event.max_teams}` : ""}
          </div>
          {scheduledStart && (
            <div
              style={{
                color: inkSoft,
                fontSize: 12,
                marginTop: 4,
                fontWeight: 500,
              }}
            >
              {fmtScheduledRange(scheduledStart, scheduledEnd)}
            </div>
          )}
          {eligibilityChips(event).length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 4,
                marginTop: 6,
              }}
            >
              {eligibilityChips(event).map((c) => (
                <span
                  key={c}
                  style={{
                    padding: "2px 6px",
                    background: cream,
                    color: inkSoft,
                    border: `1px solid ${ruleSoft}`,
                    borderRadius: 3,
                    fontSize: 10,
                    fontWeight: 500,
                    fontFamily: monoFontStack,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                  }}
                >
                  {c}
                </span>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {/* Lifecycle: draft → ready → active.
              Draft is for "still being configured"; Ready to play is
              "configured + waiting to start"; Active is running. From
              draft we offer both "Mark ready" (just stage it) and
              "Start event" (skip ready, go straight to active) so the
              organizer isn't forced through an extra click on event
              day. */}
          {event.status === "draft" && (
            <button
              onClick={() => onSetStatus(event.id, "ready")}
              disabled={busyAction === `status:${event.id}` || teamCount < 2}
              title={
                teamCount < 2
                  ? "Add at least 2 teams first."
                  : "Mark this event configured and ready to play. Doesn't start match generation."
              }
              style={secondaryBtn}
            >
              Mark ready
            </button>
          )}
          {(event.status === "draft" || event.status === "ready") && (
            <button
              onClick={() => onSetStatus(event.id, "active")}
              disabled={busyAction === `status:${event.id}` || teamCount < 2}
              title={teamCount < 2 ? "Add at least 2 teams first." : ""}
              style={primaryBtn(
                busyAction === `status:${event.id}` || teamCount < 2,
              )}
            >
              Start event
            </button>
          )}
          {(event.status === "active" || event.status === "medal_round") && (
            <>
              <button
                onClick={() => onSetStatus(event.id, "on_hold")}
                disabled={busyAction === `status:${event.id}`}
                style={secondaryBtn}
              >
                Pause
              </button>
              <button
                onClick={() => onSetStatus(event.id, "complete")}
                disabled={busyAction === `status:${event.id}`}
                style={secondaryBtn}
              >
                Mark complete
              </button>
            </>
          )}
          {event.status === "on_hold" && (
            <button
              onClick={() => onSetStatus(event.id, "active")}
              disabled={busyAction === `status:${event.id}`}
              style={primaryBtn(busyAction === `status:${event.id}`)}
            >
              Resume
            </button>
          )}
          {event.status === "complete" && (
            <>
              <button
                onClick={() => onSetStatus(event.id, "verified")}
                disabled={busyAction === `status:${event.id}`}
                style={primaryBtn(busyAction === `status:${event.id}`)}
              >
                Verify
              </button>
              <button
                onClick={() => onSetStatus(event.id, "active")}
                disabled={busyAction === `status:${event.id}`}
                style={secondaryBtn}
              >
                Reopen
              </button>
            </>
          )}
          {event.status === "verified" && (
            <button
              onClick={() => onSetStatus(event.id, "complete")}
              disabled={busyAction === `status:${event.id}`}
              style={secondaryBtn}
            >
              Unverify
            </button>
          )}
          <Link
            to={`/admin/${orgSlug}/tournaments/${tournamentSlug}/events/${event.id}/edit`}
            style={secondaryLinkBtnSmall}
          >
            Edit
          </Link>
          <Link
            to={`/admin/${orgSlug}/tournaments/${tournamentSlug}/events/${event.id}`}
            style={secondaryLinkBtnSmall}
          >
            Open →
          </Link>
          <button
            onClick={onCopy}
            disabled={busyAction === `copy:${event.id}`}
            style={secondaryBtn}
            title="Duplicate this event's settings as a new draft. Registrations and results are not copied."
          >
            {busyAction === `copy:${event.id}` ? "Copying…" : "Copy"}
          </button>
          <button
            onClick={onDelete}
            style={dangerBtn(false)}
            title="Hide this event from the dashboard. Match history and registrations stay in the database for recovery."
          >
            Delete
          </button>
        </div>
      </div>

      {/* Court allocation chips */}
      <div style={{ marginTop: 12 }}>
        <div
          style={{
            fontSize: 11,
            color: inkMuted,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontFamily: headingFontStack,
            marginBottom: 6,
          }}
        >
          Courts assigned
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {courts.length === 0 ? (
            <span style={{ color: inkMuted, fontSize: 13 }}>
              Set a court count on this tournament's venue to assign courts.
            </span>
          ) : (
            courts.map((n) => {
              const mine = claimed.has(n);
              const ownedByOther =
                !mine &&
                activeOwnerByCourt.has(n) &&
                activeOwnerByCourt.get(n) !== event.id;
              const busy =
                busyAction === `court:${event.id}:${n}`;
              return (
                <button
                  key={n}
                  onClick={() => onToggleCourt(event.id, n)}
                  disabled={busy || ownedByOther}
                  title={
                    ownedByOther
                      ? "Already claimed by another active event."
                      : ""
                  }
                  style={courtChip(mine, ownedByOther, busy)}
                >
                  Court {n}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// Tournament-status auto-transition rules. Returns the status the
// tournament SHOULD have given current data, or null if no change.
// Mirrors autoTransitionEventStatus's pattern (single function,
// page-load-evaluated). Only forward transitions; manual buttons
// own the rest.
//
//   published → closed     once registration_closes_at is in the past
//   published|closed
//             → completed  once every non-cancelled event has reached
//                          'complete' or 'verified' AND there's at
//                          least one such event (an empty tournament
//                          shouldn't auto-complete).
//
// Doesn't touch draft/cancelled — those are organizer-controlled
// states that shouldn't auto-flip.
function inferTournamentStatus(
  t: Tournament,
  events: Event[],
): TournamentStatus | null {
  // Auto-close when reg window passes.
  if (
    t.status === "published" &&
    t.registration_closes_at &&
    new Date(t.registration_closes_at).getTime() <= Date.now()
  ) {
    return "closed";
  }

  // Auto-complete when all events are wrapped.
  if (t.status === "published" || t.status === "closed") {
    const live = events.filter((e) => e.status !== "verified" && e.status !== "complete");
    if (events.length > 0 && live.length === 0) {
      return "completed";
    }
  }

  return null;
}

// Buttons that mutate tournament_status. The set shown depends on
// current state — same pattern as the per-event status actions.
//
//   draft     → Publish, Cancel
//   published → Close registration, Cancel
//   closed    → Reopen registration, Mark complete, Cancel
//   completed → Reopen          (back to closed)
//   cancelled → Reactivate      (back to draft)
//
// Auto-transitions (closed/completed) live in inferTournamentStatus
// and run on every reload(). These buttons cover everything that
// requires deliberate organizer intent — open to public, reopen
// after auto-close, or pull the plug.
function TournamentStatusActions({
  status,
  busy,
  onSetStatus,
  onRequestCancel,
}: {
  status: TournamentStatus;
  busy: boolean;
  onSetStatus: (s: TournamentStatus) => Promise<void>;
  onRequestCancel: () => void;
}) {
  const cancel = (
    <button
      key="cancel"
      onClick={onRequestCancel}
      disabled={busy}
      style={dangerStatusBtn(busy)}
      title="Cancel the tournament. All paid registrations will be refunded per the cancellation policy."
    >
      Cancel
    </button>
  );
  switch (status) {
    case "draft":
      return (
        <>
          <button
            onClick={() => void onSetStatus("published")}
            disabled={busy}
            style={primaryStatusBtn(busy)}
            title="Open the tournament for registration. Public tournament page becomes visible."
          >
            Publish
          </button>
          {cancel}
        </>
      );
    case "published":
      return (
        <>
          <button
            onClick={() => void onSetStatus("closed")}
            disabled={busy}
            style={secondaryStatusBtn}
            title="Close registration. Tournament keeps running; new sign-ups blocked."
          >
            Close registration
          </button>
          {cancel}
        </>
      );
    case "closed":
      return (
        <>
          <button
            onClick={() => void onSetStatus("published")}
            disabled={busy}
            style={secondaryStatusBtn}
            title="Reopen registration."
          >
            Reopen registration
          </button>
          <button
            onClick={() => void onSetStatus("completed")}
            disabled={busy}
            style={primaryStatusBtn(busy)}
            title="Mark the tournament complete. Auto-fires when every event is complete/verified."
          >
            Mark complete
          </button>
          {cancel}
        </>
      );
    case "completed":
      return (
        <button
          onClick={() => void onSetStatus("closed")}
          disabled={busy}
          style={secondaryStatusBtn}
          title="Reopen the tournament — drops back to closed so events can be unverified or replayed."
        >
          Reopen
        </button>
      );
    case "cancelled":
      return (
        <button
          onClick={() => void onSetStatus("draft")}
          disabled={busy}
          style={secondaryStatusBtn}
          title="Restore the tournament to draft so it can be reconfigured + republished."
        >
          Reactivate
        </button>
      );
  }
}

function TournamentStatusBadge({ status }: { status: TournamentStatus }) {
  const palette: Record<
    TournamentStatus,
    { bg: string; fg: string; label: string }
  > = {
    draft:     { bg: cream,      fg: inkSoft,   label: "Draft"     },
    published: { bg: successBg,  fg: successFg, label: "Published" },
    closed:    { bg: warnBg,     fg: warnFg,    label: "Closed"    },
    completed: { bg: infoBg,     fg: infoFg,    label: "Completed" },
    cancelled: { bg: dangerBg,   fg: dangerFg,  label: "Cancelled" },
  };
  const c = palette[status];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        background: c.bg,
        color: c.fg,
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        fontFamily: headingFontStack,
      }}
    >
      {c.label}
    </span>
  );
}

function EventStatusBadge({ status }: { status: EventStatus }) {
  const palette: Record<EventStatus, { bg: string; fg: string; label: string }> = {
    draft:       { bg: cream,      fg: inkSoft,   label: "Draft"        },
    ready:       { bg: warnBg,     fg: warnFg,    label: "Ready to play"},
    active:      { bg: successBg,  fg: successFg, label: "Active"       },
    on_hold:     { bg: dangerBg,   fg: dangerFg,  label: "On hold"      },
    medal_round: { bg: warnBg,     fg: warnFg,    label: "Medal round"  },
    complete:    { bg: infoBg,     fg: infoFg,    label: "Complete"     },
    verified:    { bg: successBg,  fg: successFg, label: "Verified"     },
  };
  const c = palette[status];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        background: c.bg,
        color: c.fg,
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        fontFamily: headingFontStack,
      }}
    >
      {c.label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bits
// ─────────────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  to,
}: {
  label: string;
  value: string | number;
  to?: string;
}) {
  const content = (
    <>
      <div
        style={{
          fontSize: 11,
          color: inkMuted,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontFamily: headingFontStack,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          marginTop: 4,
          color: to ? courtBlue : ink,
          fontFamily: bodyFontStack,
        }}
      >
        {value}
        {to && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 400,
              marginLeft: 6,
              color: inkMuted,
            }}
          >
            view →
          </span>
        )}
      </div>
    </>
  );
  const baseStyle: CSSProperties = {
    padding: 12,
    background: bg,
    border: `1px solid ${rule}`,
    borderRadius: 8,
    display: "block",
  };
  if (to) {
    return (
      <Link to={to} style={{ ...baseStyle, textDecoration: "none" }}>
        {content}
      </Link>
    );
  }
  return <div style={baseStyle}>{content}</div>;
}

function DtDd({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt style={{ color: inkMuted }}>{label}</dt>
      <dd style={{ margin: 0, color: inkSoft }}>{value}</dd>
    </>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 24,
        textAlign: "center",
        background: bg,
        border: `1px dashed ${rule}`,
        borderRadius: 8,
        color: inkSoft,
        fontSize: 13,
        fontFamily: bodyFontStack,
      }}
    >
      {children}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: "10px 14px",
        background: dangerBg,
        border: `1px solid ${dangerFg}`,
        borderRadius: 6,
        color: dangerFg,
        fontSize: 13,
        fontFamily: bodyFontStack,
      }}
    >
      {message}
    </div>
  );
}

// Two-button group for the public tournament page: an "Open" link
// (opens in a new tab so the admin keeps their workspace) and a
// "Copy link" button that puts the full URL on the clipboard for
// pasting into emails / texts / social.
function PublicPageLink({
  orgSlug,
  tournamentSlug,
}: {
  orgSlug: string;
  tournamentSlug: string;
}) {
  const [copied, setCopied] = useState(false);
  const relativePath = `/t/${orgSlug}/${tournamentSlug}`;
  const fullUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${relativePath}`
      : relativePath;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      // Brief flash, then revert so the button label doesn't lie.
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail in non-secure contexts / iframes;
      // fall back to a select-and-copy hint via the title attr.
      window.prompt("Copy this URL:", fullUrl);
    }
  };

  return (
    <div style={{ display: "flex", gap: 4 }}>
      <a
        href={relativePath}
        target="_blank"
        rel="noreferrer"
        title={`Open ${fullUrl}`}
        style={{
          ...secondaryLinkBtn,
          display: "inline-block",
          whiteSpace: "nowrap",
        }}
      >
        Public page ↗
      </a>
      <button
        onClick={onCopy}
        title={`Copy ${fullUrl}`}
        style={{
          padding: "8px 12px",
          background: copied ? successBg : bg,
          color: copied ? successFg : inkSoft,
          border: `1px solid ${copied ? successFg : rule}`,
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 500,
          cursor: "pointer",
          fontFamily: bodyFontStack,
          whiteSpace: "nowrap",
        }}
      >
        {copied ? "Copied!" : "Copy link"}
      </button>
    </div>
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// Render the scheduled window on an event card. When start and end
// fall on the same calendar day, show "Sat May 16 · 9:00 AM – 1:30 PM"
// — readable at a glance. Cross-day windows include the date on both
// sides so the second day isn't ambiguous.
function fmtScheduledRange(start: Date, end: Date | null): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
  };
  const time = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (!end) {
    return `${start.toLocaleDateString(undefined, opts)} · ${time(start)}`;
  }
  const sameDay = start.toDateString() === end.toDateString();
  if (sameDay) {
    return `${start.toLocaleDateString(undefined, opts)} · ${time(start)} – ${time(end)}`;
  }
  return `${start.toLocaleDateString(undefined, opts)} ${time(start)} → ${end.toLocaleDateString(undefined, opts)} ${time(end)}`;
}

// ─────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────

const pageH1Style: CSSProperties = {
  fontFamily: displayFontStack,
  fontSize: "clamp(22px, 3.5vw, 30px)",
  lineHeight: 1.05,
  letterSpacing: "-0.2px",
  margin: 0,
  color: ink,
};

const sectionH2Style: CSSProperties = {
  fontFamily: headingFontStack,
  fontSize: 16,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  margin: 0,
  color: ink,
};

const primaryLinkBtn: CSSProperties = {
  padding: "8px 16px",
  background: ink,
  color: bg,
  textDecoration: "none",
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  fontFamily: headingFontStack,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
  display: "inline-block",
};

const primaryLinkBtnSmall: CSSProperties = {
  ...primaryLinkBtn,
  padding: "6px 12px",
  fontSize: 12,
};

const secondaryLinkBtn: CSSProperties = {
  padding: "8px 14px",
  background: "transparent",
  color: ink,
  textDecoration: "none",
  border: `2px solid ${ink}`,
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  fontFamily: headingFontStack,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
  display: "inline-block",
};

const secondaryLinkBtnSmall: CSSProperties = {
  ...secondaryLinkBtn,
  padding: "6px 10px",
  fontSize: 12,
};

function primaryBtn(busy: boolean): CSSProperties {
  return {
    padding: "6px 12px",
    background: busy ? inkMuted : ink,
    color: bg,
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: headingFontStack,
    letterSpacing: "0.03em",
    textTransform: "uppercase",
    cursor: busy ? "not-allowed" : "pointer",
    opacity: busy ? 0.7 : 1,
  };
}

const secondaryBtn: CSSProperties = {
  padding: "6px 12px",
  background: "transparent",
  color: ink,
  border: `1px solid ${rule}`,
  borderRadius: 6,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: bodyFontStack,
};

// Tournament-status header buttons share a slightly larger size
// than the per-event row buttons so they read as page-level
// actions next to the page heading.
function primaryStatusBtn(busy: boolean): CSSProperties {
  return {
    padding: "8px 14px",
    background: busy ? inkMuted : ink,
    color: bg,
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: headingFontStack,
    letterSpacing: "0.03em",
    textTransform: "uppercase",
    cursor: busy ? "not-allowed" : "pointer",
    opacity: busy ? 0.7 : 1,
    whiteSpace: "nowrap",
  };
}

const secondaryStatusBtn: CSSProperties = {
  padding: "8px 14px",
  background: "transparent",
  color: ink,
  border: `1px solid ${rule}`,
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: bodyFontStack,
  whiteSpace: "nowrap",
};

function dangerStatusBtn(busy: boolean): CSSProperties {
  return {
    padding: "8px 14px",
    background: dangerBg,
    color: dangerFg,
    border: `1px solid ${dangerFg}`,
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: bodyFontStack,
    whiteSpace: "nowrap",
  };
}

function dangerBtn(busy: boolean): CSSProperties {
  return {
    padding: "6px 12px",
    background: dangerBg,
    color: dangerFg,
    border: `1px solid ${dangerFg}`,
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: bodyFontStack,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Approve withdrawal modal
// ─────────────────────────────────────────────────────────────────────

function ApproveWithdrawalModal({
  withdrawal,
  amountStr,
  onAmountChange,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  withdrawal: PendingWithdrawal;
  amountStr: string;
  onAmountChange: (v: string) => void;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [busy, onCancel]);

  const playerName =
    [withdrawal.playerFirstName, withdrawal.playerLastName].filter(Boolean).join(" ") ||
    "Unknown player";
  const maxDollars = (withdrawal.eventFeeCents / 100).toFixed(2);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--overlay)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 1000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="approve-withdrawal-modal-title"
        style={{
          background: "var(--surface)",
          borderRadius: 8,
          padding: 24,
          maxWidth: 440,
          width: "100%",
          boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
        }}
      >
        <h2
          id="approve-withdrawal-modal-title"
          style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 600 }}
        >
          Approve refund
        </h2>
        <p style={{ margin: "0 0 16px", fontSize: 13, color: inkSoft }}>
          {playerName} — {withdrawal.eventName}
        </p>

        <div style={{ fontSize: 13, color: inkSoft, marginBottom: 12, lineHeight: 1.5 }}>
          <div style={{ display: "flex", gap: 16, marginBottom: 8 }}>
            <span>
              Paid: <strong style={{ color: ink }}>${maxDollars}</strong>
            </span>
            <span>
              Entitled:{" "}
              <strong style={{ color: ink }}>
                {withdrawal.entitledRefundCents !== null
                  ? `$${(withdrawal.entitledRefundCents / 100).toFixed(2)}`
                  : "—"}
              </strong>
            </span>
          </div>
          {withdrawal.withdrawalReason && (
            <div style={{ fontStyle: "italic", color: inkMuted, marginBottom: 8 }}>
              "{withdrawal.withdrawalReason}"
            </div>
          )}
        </div>

        <label style={{ display: "block", marginBottom: 16 }}>
          <div
            style={{ fontSize: 13, fontWeight: 500, color: ink, marginBottom: 4 }}
          >
            Refund amount (max ${maxDollars})
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 14, color: inkSoft }}>$</span>
            <input
              type="number"
              min="0"
              max={maxDollars}
              step="0.01"
              value={amountStr}
              onChange={(e) => onAmountChange(e.target.value)}
              disabled={busy}
              style={{
                width: "100%",
                padding: "8px 10px",
                border: `1px solid ${error ? "#dc2626" : "#d1d5db"}`,
                borderRadius: 6,
                fontSize: 14,
                fontFamily: "inherit",
                boxSizing: "border-box",
              }}
            />
          </div>
          {error && (
            <div
              style={{
                marginTop: 6,
                fontSize: 12,
                color: "#dc2626",
              }}
            >
              {error}
            </div>
          )}
        </label>

        <p style={{ margin: "0 0 16px", fontSize: 12, color: inkMuted }}>
          $0.00 approves the request with no refund (status stays "withdrawn").
          The server enforces the final cap.
        </p>

        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
          <button
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: "8px 16px",
              background: "var(--surface)",
              color: "var(--text-muted)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 13,
              cursor: busy ? "not-allowed" : "pointer",
              fontFamily: "inherit",
              opacity: busy ? 0.6 : 1,
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            style={{
              padding: "8px 16px",
              background: busy ? inkMuted : ink,
              color: bg,
              border: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              cursor: busy ? "not-allowed" : "pointer",
              fontFamily: "inherit",
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy ? "Processing…" : "Approve refund"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Cancel tournament modal
// ─────────────────────────────────────────────────────────────────────

function CancelTournamentModal({
  reason,
  onReasonChange,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  reason: string;
  onReasonChange: (v: string) => void;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [busy, onCancel]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--overlay)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 1000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-tournament-modal-title"
        style={{
          background: "var(--surface)",
          borderRadius: 8,
          padding: 24,
          maxWidth: 480,
          width: "100%",
          boxShadow: "0 10px 40px rgba(0, 0, 0, 0.2)",
        }}
      >
        <h2
          id="cancel-tournament-modal-title"
          style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 600 }}
        >
          Cancel tournament?
        </h2>
        <div style={{ fontSize: 13, color: "#444", lineHeight: 1.5 }}>
          <p style={{ margin: "0 0 12px" }}>
            All paid registrations will be refunded per the cancellation policy.
            Every affected player will receive an email with their refund amount.
            This action cannot be undone.
          </p>
          {error && (
            <div
              style={{
                marginBottom: 12,
                padding: "8px 10px",
                background: dangerBg,
                border: `1px solid ${dangerFg}`,
                borderRadius: 6,
                color: dangerFg,
              }}
            >
              {error}
            </div>
          )}
          <label style={{ display: "block" }}>
            <div style={{ fontWeight: 500, marginBottom: 4 }}>
              Reason for cancellation (required)
            </div>
            <textarea
              value={reason}
              onChange={(e) => onReasonChange(e.target.value)}
              disabled={busy}
              rows={3}
              placeholder="e.g. The venue is no longer available due to a scheduling conflict."
              style={{
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
          </label>
        </div>
        <div
          style={{
            marginTop: 20,
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
          <button
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: "8px 16px",
              background: "var(--surface)",
              color: "var(--text-muted)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 13,
              cursor: busy ? "not-allowed" : "pointer",
              fontFamily: "inherit",
              opacity: busy ? 0.6 : 1,
            }}
          >
            Keep tournament
          </button>
          <button
            onClick={onConfirm}
            disabled={busy || !reason.trim()}
            style={{
              padding: "8px 16px",
              background: busy || !reason.trim() ? "var(--text-subtle)" : "var(--danger)",
              color: "var(--primary-contrast)",
              border: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              cursor: busy || !reason.trim() ? "not-allowed" : "pointer",
              fontFamily: "inherit",
            }}
          >
            {busy ? "Cancelling…" : "Cancel tournament"}
          </button>
        </div>
      </div>
    </div>
  );
}

async function extractFnError(fnErr: unknown): Promise<string> {
  const ctx = (fnErr as { context?: Response }).context;
  if (ctx) {
    try {
      const body = (await ctx.json()) as { error?: string };
      if (body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return (fnErr as { message?: string }).message ?? "Unknown error.";
}

function courtChip(
  mine: boolean,
  ownedByOther: boolean,
  busy: boolean,
): CSSProperties {
  const chipBg = mine ? ink : ownedByOther ? cream : bg;
  const fg = mine ? bg : ownedByOther ? inkMuted : inkSoft;
  const border = mine
    ? ink
    : ownedByOther
      ? rule
      : creamDeep;
  return {
    padding: "4px 10px",
    background: chipBg,
    color: fg,
    border: `1px solid ${border}`,
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 500,
    cursor: busy || ownedByOther ? "not-allowed" : "pointer",
    fontFamily: bodyFontStack,
    opacity: busy ? 0.6 : 1,
  };
}
