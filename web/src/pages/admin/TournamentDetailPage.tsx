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
import { eligibilityChips } from "../../lib/eligibility";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];
type EventStatus = Database["public"]["Enums"]["event_status"];
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
    setT(tData);

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
          <h1 style={{ margin: "0 0 4px", fontSize: 22 }}>{t.name}</h1>
          <p style={{ color: "#666", margin: 0, fontSize: 14 }}>
            {t.description || "No description."}
          </p>
        </div>
        {/* Court manager is always reachable from the tournament home —
            users want it to peek at the queue / setup courts even before
            an event is active. The page itself handles the empty state. */}
        <Link
          to={`/admin/${org.slug}/tournaments/${t.slug}/courts`}
          style={primaryLinkBtn}
        >
          Court manager →
        </Link>
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
        <Stat label="Status" value={t.status} />
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
              />
            ))}
          </div>
        )}
      </section>
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
}: {
  summary: EventSummary;
  courts: number[];
  activeOwnerByCourt: Map<number, string>;
  orgSlug: string;
  tournamentSlug: string;
  busyAction: string | null;
  onSetStatus: (eventId: string, status: EventStatus) => Promise<void>;
  onToggleCourt: (eventId: string, courtNumber: number) => Promise<void>;
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

function EventStatusBadge({ status }: { status: EventStatus }) {
  const palette: Record<EventStatus, { bg: string; fg: string; label: string }> = {
    draft:       { bg: "#f3f4f6", fg: "#666",    label: "Draft" },
    ready:       { bg: "#fef3c7", fg: "#92400e", label: "Ready" },
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
