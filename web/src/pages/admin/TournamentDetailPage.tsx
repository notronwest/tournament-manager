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
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];
type EventStatus = Database["public"]["Enums"]["event_status"];
type TournamentStatus = Database["public"]["Enums"]["tournament_status"];
type EventCourt = Database["public"]["Tables"]["event_courts"]["Row"];

type EventSummary = {
  event: Event;
  teamCount: number;
  courtNumbers: number[];
};

// Tournament homepage: stats + events list with per-event status,
// court allocation, and start/complete actions. The court manager
// link sits at the top because it's tournament-wide — a single
// dispatcher across all active events.
export default function TournamentDetailPage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();
  const [t, setT] = useState<Tournament | null>(null);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [eventCourts, setEventCourts] = useState<EventCourt[]>([]);
  const [totalPlayers, setTotalPlayers] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pendingDeleteEvent, setPendingDeleteEvent] = useState<EventSummary | null>(null);
  const [deletingEvent, setDeletingEvent] = useState(false);

  const reload = useCallback(async () => {
    if (!org || !tournamentSlug) return;
    // Don't flip loading=true on subsequent reloads — that flashes the
    // "Loading…" skeleton on every mutation. The initial useState(true)
    // covers the first paint; after that we update in place.
    setError(null);

    const { data: tData, error: tErr } = await supabase
      .from("tournaments")
      .select("*")
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

    // Events + their registrations + court allocations, in parallel.
    const [evRes, regsRes, courtsRes] = await Promise.all([
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
    ]);

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

  const setCourtCount = async (n: number) => {
    if (!t) return;
    setBusyAction("court_count");
    const { error: updErr } = await supabase
      .from("tournaments")
      .update({ court_count: n })
      .eq("id", t.id);
    setBusyAction(null);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    await reload();
  };

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
    return <div style={{ color: "#666", fontSize: 14 }}>Loading…</div>;
  if (error) return <ErrorBox message={error} />;
  if (!t) return null;

  const courts = Array.from({ length: t.court_count }, (_, i) => i + 1);

  return (
    <div>
      <Link
        to={`/admin/${org.slug}/tournaments`}
        style={{
          color: "#2563eb",
          textDecoration: "none",
          fontSize: 13,
        }}
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
            <h1 style={{ margin: 0, fontSize: 22 }}>{t.name}</h1>
            <TournamentStatusBadge status={t.status} />
          </div>
          <p style={{ color: "#666", margin: "4px 0 0", fontSize: 14 }}>
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
          />
          {/* Schedule view — time estimates for every event based on
              registered teams + format. Useful during planning AND
              live (e.g. "are we tracking ahead of plan?"). */}
          <Link
            to={`/admin/${org.slug}/tournaments/${t.slug}/schedule`}
            style={{
              ...primaryLinkBtn,
              background: "#fff",
              color: "#2563eb",
              border: "1px solid #2563eb",
            }}
          >
            Schedule
          </Link>
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
          color: "#555",
          maxWidth: 600,
        }}
      >
        <DtDd
          label="Entry fee"
          value={`$${(t.entry_fee_cents / 100).toFixed(2)}`}
        />
        <DtDd label="Location" value={t.location_name || "—"} />
        <DtDd label="Address" value={t.location_address || "—"} />
        <dt style={{ color: "#888" }}>Courts at venue</dt>
        <dd style={{ margin: 0 }}>
          <input
            type="number"
            min="1"
            max="32"
            value={t.court_count}
            onChange={(e) => {
              const n = parseInt(e.target.value || "1", 10);
              if (Number.isFinite(n) && n >= 1 && n <= 32) void setCourtCount(n);
            }}
            disabled={busyAction === "court_count"}
            style={{
              width: 60,
              padding: "4px 8px",
              border: "1px solid #e2e2e2",
              borderRadius: 4,
              fontSize: 13,
              fontFamily: "inherit",
            }}
          />
        </dd>
      </dl>

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
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            Events ({events.length})
          </h2>
          <Link
            to={`/admin/${org.slug}/tournaments/${t.slug}/events/new`}
            style={primaryLinkBtnSmall}
          >
            + New event
          </Link>
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
}) {
  const { event, teamCount, courtNumbers } = summary;
  const claimed = new Set(courtNumbers);

  return (
    <div
      style={{
        padding: 16,
        background: "#fff",
        border: "1px solid #e5e7eb",
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
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
              {event.name}
            </h3>
            <EventStatusBadge status={event.status} />
          </div>
          <div style={{ color: "#888", fontSize: 12, marginTop: 4 }}>
            {event.format} · {event.gender} ·{" "}
            {event.bracket_type.replace("_", " ")} · {teamCount}{" "}
            {teamCount === 1 ? "team" : "teams"}
            {event.max_teams ? ` / ${event.max_teams}` : ""}
          </div>
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
            style={secondaryLinkBtn}
          >
            Edit
          </Link>
          <Link
            to={`/admin/${orgSlug}/tournaments/${tournamentSlug}/events/${event.id}`}
            style={secondaryLinkBtn}
          >
            Open →
          </Link>
          <button
            onClick={onDelete}
            style={dangerStatusBtn(false)}
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
            color: "#888",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginBottom: 6,
          }}
        >
          Courts assigned
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {courts.length === 0 ? (
            <span style={{ color: "#999", fontSize: 13 }}>
              Set "Courts at venue" above to assign courts.
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
}: {
  status: TournamentStatus;
  busy: boolean;
  onSetStatus: (s: TournamentStatus) => Promise<void>;
}) {
  const cancel = (
    <button
      key="cancel"
      onClick={() => void onSetStatus("cancelled")}
      disabled={busy}
      style={dangerStatusBtn(busy)}
      title="Cancel the tournament. Stays in the org's history but won't run."
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
    draft:     { bg: "#f3f4f6", fg: "#666",    label: "Draft" },
    published: { bg: "#dcfce7", fg: "#166534", label: "Published" },
    closed:    { bg: "#fef3c7", fg: "#92400e", label: "Closed" },
    completed: { bg: "#dbeafe", fg: "#1e40af", label: "Completed" },
    cancelled: { bg: "#fee2e2", fg: "#991b1b", label: "Cancelled" },
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
        letterSpacing: 0.5,
      }}
    >
      {c.label}
    </span>
  );
}

function EventStatusBadge({ status }: { status: EventStatus }) {
  const palette: Record<EventStatus, { bg: string; fg: string; label: string }> = {
    draft:       { bg: "#f3f4f6", fg: "#666",    label: "Draft" },
    ready:       { bg: "#fef3c7", fg: "#92400e", label: "Ready to play" },
    active:      { bg: "#dcfce7", fg: "#166534", label: "Active" },
    on_hold:     { bg: "#ffedd5", fg: "#9a3412", label: "On hold" },
    medal_round: { bg: "#fde68a", fg: "#92400e", label: "Medal round" },
    complete:    { bg: "#dbeafe", fg: "#1e40af", label: "Complete" },
    verified:    { bg: "#ede9fe", fg: "#5b21b6", label: "Verified" },
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
        letterSpacing: 0.5,
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
          color: "#888",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          marginTop: 4,
          color: to ? "#2563eb" : undefined,
        }}
      >
        {value}
        {to && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 400,
              marginLeft: 6,
              color: "#888",
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
    background: "#fafafa",
    border: "1px solid #e5e7eb",
    borderRadius: 6,
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
      <dt style={{ color: "#888" }}>{label}</dt>
      <dd style={{ margin: 0 }}>{value}</dd>
    </>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
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

function ErrorBox({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: 10,
        background: "#fef2f2",
        border: "1px solid #fecaca",
        borderRadius: 6,
        color: "#991b1b",
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// ─────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────

const primaryLinkBtn: CSSProperties = {
  padding: "8px 16px",
  background: "#2563eb",
  color: "#fff",
  textDecoration: "none",
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  whiteSpace: "nowrap",
};

const primaryLinkBtnSmall: CSSProperties = {
  padding: "6px 12px",
  background: "#2563eb",
  color: "#fff",
  textDecoration: "none",
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
};

const secondaryLinkBtn: CSSProperties = {
  padding: "6px 12px",
  background: "#fff",
  color: "#2563eb",
  textDecoration: "none",
  border: "1px solid #2563eb",
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
};

function primaryBtn(busy: boolean): CSSProperties {
  return {
    padding: "6px 12px",
    background: busy ? "#9ca3af" : "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: "inherit",
  };
}

const secondaryBtn: CSSProperties = {
  padding: "6px 12px",
  background: "#fff",
  color: "#555",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "inherit",
};

// Tournament-status header buttons share a slightly larger size
// than the per-event row buttons so they read as page-level
// actions next to the page heading.
function primaryStatusBtn(busy: boolean): CSSProperties {
  return {
    padding: "8px 14px",
    background: busy ? "#9ca3af" : "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  };
}

const secondaryStatusBtn: CSSProperties = {
  padding: "8px 14px",
  background: "#fff",
  color: "#555",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
};

function dangerStatusBtn(busy: boolean): CSSProperties {
  return {
    padding: "8px 14px",
    background: "#fff",
    color: "#991b1b",
    border: "1px solid #fecaca",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  };
}

function courtChip(
  mine: boolean,
  ownedByOther: boolean,
  busy: boolean,
): CSSProperties {
  const bg = mine ? "#2563eb" : ownedByOther ? "#f3f4f6" : "#fff";
  const fg = mine ? "#fff" : ownedByOther ? "#9ca3af" : "#444";
  const border = mine
    ? "#2563eb"
    : ownedByOther
      ? "#e5e7eb"
      : "#d1d5db";
  return {
    padding: "4px 10px",
    background: bg,
    color: fg,
    border: `1px solid ${border}`,
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 500,
    cursor: busy || ownedByOther ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    opacity: busy ? 0.6 : 1,
  };
}
