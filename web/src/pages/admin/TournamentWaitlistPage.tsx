import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { ConfirmModal } from "../../components/ConfirmModal";
import {
  PlayerPicker,
  emptySelection,
  type PlayerSelection,
} from "../../components/PlayerPicker";
import { createOrgContact } from "../../lib/orgContacts";
import { displayHeading, fieldLabel, readFnError } from "./contactsUi";
import {
  ink,
  inkSoft,
  inkMuted,
  cream,
  rule,
  ruleSoft,
  courtGreen,
  bodyFontStack,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  ctaSecondaryStyle,
  ghostButtonStyle,
  inputStyle,
  statusPanelStyle,
} from "../../lib/publicTheme";
import type { Database } from "../../types/supabase";

// Waitlist view for ONE tournament: every event's queue in order, with
// capacity, contact details, and the three things an organizer needs to do
// with it — add someone who asked, offer an open spot (emails the player via
// offer-waitlist-spot), and remove someone who's no longer interested.

type RegStatus = Database["public"]["Enums"]["registration_status"];

type Tournament = { id: string; name: string; slug: string };

type EventRow = {
  id: string;
  name: string;
  format: string;
  max_teams: number | null;
  scheduled_start_at: string | null;
};

type Reg = {
  id: string;
  event_id: string;
  player_id: string;
  status: RegStatus;
  partner_status: string;
  waitlist_position: number | null;
  registered_at: string;
  players: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
  } | null;
};

const ACTIVE: RegStatus[] = ["paid", "pending_payment"];
const WAITING: RegStatus[] = ["waitlisted", "waitlisted_pending_payment"];

export default function TournamentWaitlistPage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [regs, setRegs] = useState<Reg[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // Bump to refetch after an add / offer / remove (same pattern as Attendees).
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!org || !tournamentSlug) return;
    let cancelled = false;
    (async () => {
      const { data: t, error: tErr } = await supabase
        .from("tournaments")
        .select("id, name, slug")
        .eq("organization_id", org.id)
        .eq("slug", tournamentSlug)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (tErr) {
        setError(tErr.message);
        setLoading(false);
        return;
      }
      if (!t) {
        setError("Tournament not found.");
        setLoading(false);
        return;
      }
      const [evRes, regRes] = await Promise.all([
        supabase
          .from("events")
          .select("id, name, format, max_teams, scheduled_start_at")
          .eq("tournament_id", t.id)
          .is("deleted_at", null)
          .order("name"),
        supabase
          .from("event_registrations")
          .select(
            "id, event_id, player_id, status, partner_status, waitlist_position, registered_at, players(id, first_name, last_name, email, phone), events!inner(tournament_id)",
          )
          .eq("events.tournament_id", t.id)
          .is("deleted_at", null)
          .in("status", [...ACTIVE, ...WAITING]),
      ]);
      if (cancelled) return;
      if (evRes.error || regRes.error) {
        setError(
          evRes.error?.message ??
            regRes.error?.message ??
            "Could not load the waitlist.",
        );
        setLoading(false);
        return;
      }
      setTournament(t);
      setEvents((evRes.data ?? []) as EventRow[]);
      setRegs((regRes.data ?? []) as unknown as Reg[]);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [org, tournamentSlug, reloadKey]);

  const regsByEvent = useMemo(() => {
    const m = new Map<string, Reg[]>();
    for (const r of regs) {
      const list = m.get(r.event_id) ?? [];
      list.push(r);
      m.set(r.event_id, list);
    }
    return m;
  }, [regs]);

  const totalWaiting = useMemo(
    () =>
      new Set(
        regs.filter((r) => WAITING.includes(r.status)).map((r) => r.player_id),
      ).size,
    [regs],
  );

  if (!org) return null;
  if (error) {
    return (
      <div style={{ fontFamily: bodyFontStack, color: ink }}>
        <div style={statusPanelStyle("danger")} role="alert">
          {error}
        </div>
      </div>
    );
  }
  if (loading || !tournament)
    return <div style={{ color: inkMuted }}>Loading…</div>;

  const base = `/admin/${org.slug}/tournaments/${tournament.slug}`;
  const q = filter.trim().toLowerCase();

  return (
    <div style={{ fontFamily: bodyFontStack, color: ink }}>
      <p style={{ margin: "0 0 6px", fontSize: 13 }}>
        <Link to={base} style={{ color: inkSoft }}>
          ← {tournament.name}
        </Link>
      </p>
      <h1 style={displayHeading}>Waitlist</h1>
      <p
        style={{
          color: inkSoft,
          fontSize: 15,
          margin: "0 0 18px",
          maxWidth: 620,
          lineHeight: 1.55,
        }}
      >
        <strong>{totalWaiting}</strong> player{totalWaiting === 1 ? "" : "s"}{" "}
        waiting across {events.length} event{events.length === 1 ? "" : "s"}.
        Offer a spot when one opens and the player gets an email with a link to
        pay and claim it.
      </p>

      {notice && (
        <div
          style={{ ...statusPanelStyle("success"), marginBottom: 16 }}
          role="status"
        >
          {notice}
        </div>
      )}

      <input
        type="search"
        placeholder="Search name, email, phone…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ ...inputStyle, maxWidth: 320, marginBottom: 20 }}
        aria-label="Search the waitlist"
      />

      {events.length === 0 && (
        <div
          style={{
            border: `1px dashed ${rule}`,
            borderRadius: 10,
            padding: 28,
            textAlign: "center",
            color: inkMuted,
            background: cream,
          }}
        >
          This tournament has no events yet.
        </div>
      )}

      {events.map((ev) => (
        <EventQueue
          key={ev.id}
          event={ev}
          regs={regsByEvent.get(ev.id) ?? []}
          orgId={org.id}
          filter={q}
          onChanged={(msg) => {
            setNotice(msg);
            setReloadKey((k) => k + 1);
          }}
        />
      ))}
    </div>
  );
}

// ── One event's queue ───────────────────────────────────────────────

function EventQueue({
  event,
  regs,
  orgId,
  filter,
  onChanged,
}: {
  event: EventRow;
  regs: Reg[];
  orgId: string;
  filter: string;
  onChanged: (msg: string) => void;
}) {
  const isDoubles = event.format === "doubles";
  const active = regs.filter((r) => ACTIVE.includes(r.status));
  const activeTeams = isDoubles ? Math.ceil(active.length / 2) : active.length;
  const isFull = event.max_teams != null && activeTeams >= event.max_teams;
  const capLabel =
    event.max_teams != null
      ? `${activeTeams} of ${event.max_teams} ${isDoubles ? "teams" : "players"}`
      : `${activeTeams} ${isDoubles ? "teams" : "players"} · no cap`;

  const queue = regs
    .filter((r) => WAITING.includes(r.status))
    .sort((a, b) => {
      // Offered spots first (they're actionable), then by position, then by join time.
      const ao = a.status === "waitlisted_pending_payment" ? 0 : 1;
      const bo = b.status === "waitlisted_pending_payment" ? 0 : 1;
      if (ao !== bo) return ao - bo;
      const ap = a.waitlist_position ?? Number.MAX_SAFE_INTEGER;
      const bp = b.waitlist_position ?? Number.MAX_SAFE_INTEGER;
      return ap - bp || a.registered_at.localeCompare(b.registered_at);
    });
  const visible = filter
    ? queue.filter((r) => {
        const p = r.players;
        return `${p?.first_name ?? ""} ${p?.last_name ?? ""} ${p?.email ?? ""} ${p?.phone ?? ""}`
          .toLowerCase()
          .includes(filter);
      })
    : queue;

  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Reg | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const offer = async (r: Reg) => {
    setBusyId(r.id);
    setRowError(null);
    try {
      const { data, error } = await supabase.functions.invoke(
        "offer-waitlist-spot",
        {
          body: { registrationId: r.id },
        },
      );
      if (error) {
        setRowError(await readFnError(error));
        return;
      }
      const d = data as { emailed?: boolean; email?: string; detail?: string };
      const name = playerName(r);
      onChanged(
        d?.emailed
          ? `Spot offered to ${name} — emailed ${d.email}.`
          : `Spot reserved for ${name}, but no email went out (${d?.detail ?? "unknown reason"}). Reach them another way.`,
      );
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (r: Reg) => {
    setBusyId(r.id);
    setRowError(null);
    try {
      const { error } = await supabase
        .from("event_registrations")
        .update({ status: "cancelled", waitlist_position: null })
        .eq("id", r.id);
      if (error) {
        setRowError(error.message);
        return;
      }
      onChanged(`${playerName(r)} removed from the ${event.name} waitlist.`);
    } finally {
      setBusyId(null);
      setRemoving(null);
    }
  };

  return (
    <section
      style={{
        border: `1px solid ${rule}`,
        borderRadius: 12,
        background: "#fff",
        marginBottom: 16,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "14px 16px",
          borderBottom: `1px solid ${ruleSoft}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{event.name}</div>
          <div
            style={{
              fontSize: 13,
              color: isFull ? "#b45309" : inkSoft,
              marginTop: 2,
            }}
          >
            {capLabel}
            {isFull ? " · full" : ""} · {queue.length} waiting
          </div>
        </div>
        <button
          type="button"
          style={{ ...ctaSecondaryStyle, padding: "8px 14px", fontSize: 13 }}
          onClick={() => setAdding((a) => !a)}
        >
          {adding ? "Cancel" : "+ Add player"}
        </button>
      </header>

      {adding && (
        <AddToWaitlist
          event={event}
          orgId={orgId}
          existingPlayerIds={regs.map((r) => r.player_id)}
          nextPosition={
            Math.max(0, ...queue.map((r) => r.waitlist_position ?? 0)) + 1
          }
          onDone={(msg) => {
            setAdding(false);
            onChanged(msg);
          }}
        />
      )}

      {rowError && (
        <div style={{ ...statusPanelStyle("danger"), margin: 12 }} role="alert">
          {rowError}
        </div>
      )}

      {visible.length === 0 ? (
        <div style={{ padding: "16px", fontSize: 13, color: inkMuted }}>
          {queue.length === 0
            ? "No one waiting."
            : "No one on this waitlist matches your search."}
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {visible.map((r) => {
            const offered = r.status === "waitlisted_pending_payment";
            const busy = busyId === r.id;
            return (
              <li
                key={r.id}
                style={{
                  padding: "12px 16px",
                  borderTop: `1px solid ${ruleSoft}`,
                }}
              >
                <div
                  style={{ display: "flex", gap: 12, alignItems: "flex-start" }}
                >
                  <div
                    style={{
                      width: 28,
                      flexShrink: 0,
                      fontFamily: "monospace",
                      fontSize: 13,
                      color: inkMuted,
                      paddingTop: 2,
                    }}
                  >
                    {offered ? "★" : `#${r.waitlist_position ?? "–"}`}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>
                      {playerName(r)}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: inkSoft,
                        wordBreak: "break-word",
                      }}
                    >
                      {[r.players?.email, r.players?.phone]
                        .filter(Boolean)
                        .join(" · ") || "No contact details"}
                    </div>
                    <div
                      style={{ fontSize: 12, color: inkMuted, marginTop: 2 }}
                    >
                      Joined {fmtDate(r.registered_at)}
                      {isDoubles && r.partner_status === "seeking"
                        ? " · needs a partner"
                        : ""}
                    </div>
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    flexWrap: "wrap",
                    marginTop: 10,
                    paddingLeft: 40,
                  }}
                >
                  <span
                    style={{
                      ...pill,
                      background: offered ? "#fef3c7" : cream,
                      color: offered ? "#92400e" : inkSoft,
                    }}
                  >
                    {offered ? "Spot offered · unpaid" : "Waiting"}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    style={{
                      ...ctaSecondaryStyle,
                      padding: "7px 12px",
                      fontSize: 13,
                      opacity: busy ? 0.6 : 1,
                    }}
                    onClick={() => offer(r)}
                  >
                    {busy
                      ? "Working…"
                      : offered
                        ? "Resend offer"
                        : "Offer spot"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    style={{ ...ghostButtonStyle, fontSize: 13 }}
                    onClick={() => setRemoving(r)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {removing && (
        <ConfirmModal
          title="Remove from the waitlist?"
          destructive
          body={
            <>
              Remove <strong>{playerName(removing)}</strong> from the{" "}
              {event.name} waitlist? They'll need to join again to get back in
              line.
            </>
          }
          confirmLabel="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        />
      )}
    </section>
  );
}

// ── Add a player to an event's waitlist ─────────────────────────────

function AddToWaitlist({
  event,
  orgId,
  existingPlayerIds,
  nextPosition,
  onDone,
}: {
  event: EventRow;
  orgId: string;
  existingPlayerIds: string[];
  nextPosition: number;
  onDone: (msg: string) => void;
}) {
  const [selection, setSelection] = useState<PlayerSelection>(emptySelection);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ready =
    selection.mode === "existing" ||
    (selection.mode === "new" &&
      selection.firstName.trim() &&
      selection.lastName.trim());

  const submit = async () => {
    setSaving(true);
    setErr(null);
    try {
      let playerId: string;
      let label: string;
      if (selection.mode === "existing") {
        playerId = selection.player.id;
        label =
          `${selection.player.first_name ?? ""} ${selection.player.last_name ?? ""}`.trim();
      } else if (selection.mode === "new") {
        // Same matching rule as the contacts importer: reuse a player with
        // this email, otherwise create one. They join the org's contact list too.
        playerId = await createOrgContact(orgId, {
          firstName: selection.firstName.trim(),
          lastName: selection.lastName.trim(),
          email: selection.email.trim() || null,
          phone: selection.phone.trim() || null,
          city: null,
          state: null,
        });
        label = `${selection.firstName.trim()} ${selection.lastName.trim()}`;
      } else {
        return;
      }
      if (existingPlayerIds.includes(playerId)) {
        setErr(
          `${label} is already registered or waitlisted for ${event.name}.`,
        );
        return;
      }
      const { error } = await supabase.from("event_registrations").insert({
        event_id: event.id,
        player_id: playerId,
        event_fee_cents: 0,
        status: "waitlisted",
        partner_status: event.format === "doubles" ? "seeking" : "solo",
        waitlist_position: nextPosition,
      });
      if (error) {
        setErr(error.message);
        return;
      }
      onDone(
        `${label} added to the ${event.name} waitlist at #${nextPosition}.`,
      );
    } catch (e) {
      setErr(
        (e as { message?: string })?.message ??
          "Could not add to the waitlist.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        padding: 16,
        background: cream,
        borderBottom: `1px solid ${ruleSoft}`,
      }}
    >
      <div style={{ ...fieldLabel, marginBottom: 8 }}>
        Add to the {event.name} waitlist
      </div>
      <PlayerPicker
        label="Player"
        selection={selection}
        onChange={setSelection}
        excludePlayerIds={existingPlayerIds}
      />
      {err && (
        <div
          style={{ ...statusPanelStyle("danger"), marginTop: 10 }}
          role="alert"
        >
          {err}
        </div>
      )}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
          marginTop: 12,
        }}
      >
        <button
          type="button"
          disabled={!ready || saving}
          style={ready && !saving ? ctaPrimaryStyle : ctaPrimaryDisabledStyle}
          onClick={submit}
        >
          {saving ? "Adding…" : `Add at #${nextPosition}`}
        </button>
        <span style={{ fontSize: 12, color: inkMuted }}>
          No charge now — they pay only if you offer them a spot.
        </span>
      </div>
      {selection.mode !== "empty" && (
        <div style={{ marginTop: 6, fontSize: 12, color: courtGreen }}>
          {selection.mode === "existing"
            ? "Existing player selected."
            : "A new player record will be created."}
        </div>
      )}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function playerName(r: Reg): string {
  const n =
    `${r.players?.first_name ?? ""} ${r.players?.last_name ?? ""}`.trim();
  return n || "Unnamed player";
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const pill = {
  display: "inline-block",
  fontSize: 12,
  fontWeight: 600,
  padding: "3px 8px",
  borderRadius: 999,
} as const;
