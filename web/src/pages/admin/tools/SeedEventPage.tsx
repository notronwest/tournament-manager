import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "../../../supabase";
import { useCurrentOrg } from "../../../hooks/useCurrentOrg";
import type { Database } from "../../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];

// Dev/test tool: bulk-creates N teams worth of fake players + event
// registrations for a given event. Lets us stress-test the bracket
// generator / court manager / standings without manually entering
// dozens of teams. Players are inserted into the global `players`
// table (no auth_user_id), so they show up in any future event picker
// — that's fine, "remove team" handles cleanup.
//
// Generation rules:
//   * Names drawn from gendered pools when event.gender restricts.
//     Mixed doubles alternates captain/partner gender; mixed singles
//     just pulls from either pool randomly.
//   * Doubles: two players per team, paired via partner_registration_id.
//   * DOB set to a random adult range so age-restricted events still
//     accept the registrations.
//   * Email + phone left null. Soft-unique email allows null freely.
//
// RLS: relies on the current user being org staff or higher on the
// tournament's org — same gate as the manual Add-team form on
// EventConsolePage.
export default function SeedEventPage() {
  const { org } = useCurrentOrg();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  // Per-event current team count. Computed from event_registrations
  // (doubles teams have 2 regs each, singles have 1). Surfaced in
  // the event dropdown so we can pick "the event with fewest teams"
  // when seeding for a comparison test.
  const [teamCountByEvent, setTeamCountByEvent] = useState<
    Map<string, number>
  >(new Map());
  const [loading, setLoading] = useState(true);
  const [tournamentId, setTournamentId] = useState<string>(
    searchParams.get("tournament") ?? "",
  );
  const [eventId, setEventId] = useState<string>(
    searchParams.get("event") ?? "",
  );
  const [count, setCount] = useState("8");
  // "add"   → insert N new teams alongside whatever's already there.
  // "reset" → delete every existing team (and their matches) in the
  //           event, then insert N new teams. Lets you re-seed an
  //           event between test runs without manually removing
  //           teams one by one.
  const [mode, setMode] = useState<"add" | "reset">("add");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    mode: "add" | "reset";
    teamsAdded: number;
    teamsRemoved: number;
    playersAdded: number;
  } | null>(null);

  // Load all tournaments for this org.
  useEffect(() => {
    if (!org) return;
    let cancelled = false;
    (async () => {
      const { data, error: tErr } = await supabase
        .from("tournaments")
        .select("*")
        .eq("organization_id", org.id)
        .is("deleted_at", null)
        .order("starts_at", { ascending: false });
      if (cancelled) return;
      if (tErr) {
        setError(tErr.message);
        setLoading(false);
        return;
      }
      setTournaments(data ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [org]);

  // Load events for the selected tournament + their current team
  // counts in one round-trip. Team count = regs/2 for doubles,
  // regs/1 for singles — we compute locally rather than running an
  // aggregate query, since the event list is short and this saves a
  // second request.
  useEffect(() => {
    if (!tournamentId) {
      setEvents([]);
      setTeamCountByEvent(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      const [evRes, regsRes] = await Promise.all([
        supabase
          .from("events")
          .select("*")
          .eq("tournament_id", tournamentId)
          .is("deleted_at", null)
          .order("created_at", { ascending: true }),
        supabase
          .from("event_registrations")
          .select("event_id, events!inner(tournament_id)")
          .eq("events.tournament_id", tournamentId)
          .is("deleted_at", null),
      ]);
      if (cancelled) return;
      if (evRes.error) {
        setError(evRes.error.message);
        return;
      }
      if (regsRes.error) {
        setError(regsRes.error.message);
        return;
      }
      const evs = evRes.data ?? [];
      setEvents(evs);

      // Group regs by event, then convert to team counts using the
      // event's own format.
      const regsByEvent = new Map<string, number>();
      for (const r of regsRes.data ?? []) {
        regsByEvent.set(r.event_id, (regsByEvent.get(r.event_id) ?? 0) + 1);
      }
      const counts = new Map<string, number>();
      for (const ev of evs) {
        const regCount = regsByEvent.get(ev.id) ?? 0;
        counts.set(
          ev.id,
          ev.format === "doubles" ? Math.floor(regCount / 2) : regCount,
        );
      }
      setTeamCountByEvent(counts);
    })();
    return () => {
      cancelled = true;
    };
  }, [tournamentId]);

  // Keep URL params in sync so the picker state survives refresh
  // and links can pre-fill (e.g. a "seed this event" button on
  // the event console could navigate here with ?tournament=&event=).
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (tournamentId) next.set("tournament", tournamentId);
    else next.delete("tournament");
    if (eventId) next.set("event", eventId);
    else next.delete("event");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournamentId, eventId]);

  const selectedTournament = useMemo(
    () => tournaments.find((t) => t.id === tournamentId) ?? null,
    [tournaments, tournamentId],
  );
  const selectedEvent = useMemo(
    () => events.find((e) => e.id === eventId) ?? null,
    [events, eventId],
  );

  const onGenerate = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedEvent || !org) return;
    const n = parseInt(count, 10);
    if (!Number.isFinite(n) || n < 1) {
      setError("Team count must be at least 1.");
      return;
    }
    if (selectedEvent.max_teams && n > selectedEvent.max_teams) {
      setError(
        `Event caps at ${selectedEvent.max_teams} teams; pick a smaller count.`,
      );
      return;
    }

    setBusy(true);
    setError(null);
    setResult(null);

    const isDoubles = selectedEvent.format === "doubles";
    const playersPerTeam = isDoubles ? 2 : 1;
    const totalPlayers = n * playersPerTeam;

    // Reset mode: nuke every existing event_registration for this
    // event (plus any matches they're part of) before generating the
    // new batch. Same sequence as the per-team Remove flow on the
    // event console, scaled up to "all teams in this event."
    let teamsRemoved = 0;
    if (mode === "reset") {
      const { data: existingRegs, error: regErr } = await supabase
        .from("event_registrations")
        .select("id, partner_registration_id")
        .eq("event_id", selectedEvent.id);
      if (regErr) {
        setError(`Reset failed (listing existing teams): ${regErr.message}`);
        setBusy(false);
        return;
      }
      const existingIds = (existingRegs ?? []).map((r) => r.id);
      // teamsRemoved counts teams, not registrations — doubles have
      // 2 regs per team, singles have 1.
      teamsRemoved = isDoubles
        ? Math.floor(existingIds.length / 2)
        : existingIds.length;
      if (existingIds.length > 0) {
        // Clear the partner self-FK so the subsequent delete doesn't
        // trip on the constraint when both halves of a doubles team
        // land in the same batch.
        await supabase
          .from("event_registrations")
          .update({ partner_registration_id: null })
          .in("id", existingIds);
        // Delete matches that reference any of these regs. Without
        // this, the `on delete set null` FK would leave orphan rows
        // with null team slots — unplayable, and they'd pollute the
        // freshly-seeded event.
        const matchDeletes = await Promise.all([
          supabase.from("matches").delete().in("team_a_reg_id", existingIds),
          supabase.from("matches").delete().in("team_b_reg_id", existingIds),
        ]);
        const matchErr = matchDeletes.find((r) => r.error)?.error;
        if (matchErr) {
          setError(`Reset failed (deleting matches): ${matchErr.message}`);
          setBusy(false);
          return;
        }
        // Delete the registrations themselves. Use .select to detect
        // RLS-filtered no-op deletes — same seatbelt as the manual
        // team remove flow.
        const { data: deleted, error: delErr } = await supabase
          .from("event_registrations")
          .delete()
          .in("id", existingIds)
          .select("id");
        if (delErr) {
          setError(`Reset failed (deleting teams): ${delErr.message}`);
          setBusy(false);
          return;
        }
        if (!deleted || deleted.length < existingIds.length) {
          setError(
            `Reset blocked: only ${deleted?.length ?? 0} of ${existingIds.length} registrations deleted. Usually means an RLS policy is missing.`,
          );
          setBusy(false);
          return;
        }
      }
    }

    // Generate player rows.
    const playersToInsert = buildPlayers(
      totalPlayers,
      selectedEvent.gender,
      isDoubles,
    );
    const { data: insertedPlayers, error: pErr } = await supabase
      .from("players")
      .insert(playersToInsert)
      .select("id, first_name, last_name");
    if (pErr || !insertedPlayers) {
      setError(pErr?.message ?? "Failed to insert players.");
      setBusy(false);
      return;
    }

    // Build event_registrations. Doubles teams will get paired up via
    // partner_registration_id in a second pass once we have the IDs.
    const regsToInsert = insertedPlayers.map((p) => ({
      event_id: selectedEvent.id,
      player_id: p.id,
      event_fee_cents: selectedEvent.event_fee_cents,
      partner_status: (isDoubles ? "confirmed" : "solo") as
        | "confirmed"
        | "solo",
    }));
    const { data: insertedRegs, error: rErr } = await supabase
      .from("event_registrations")
      .insert(regsToInsert)
      .select("id");
    if (rErr || !insertedRegs) {
      setError(rErr?.message ?? "Failed to insert registrations.");
      setBusy(false);
      return;
    }

    // For doubles: pair each captain reg → partner reg and vice
    // versa. Parallel updates — order doesn't matter, every pair is
    // independent.
    if (isDoubles) {
      const pairWrites = [];
      for (let i = 0; i < n; i++) {
        const a = insertedRegs[i * 2];
        const b = insertedRegs[i * 2 + 1];
        pairWrites.push(
          supabase
            .from("event_registrations")
            .update({ partner_registration_id: b.id })
            .eq("id", a.id),
        );
        pairWrites.push(
          supabase
            .from("event_registrations")
            .update({ partner_registration_id: a.id })
            .eq("id", b.id),
        );
      }
      const results = await Promise.all(pairWrites);
      const firstErr = results.find((r) => r.error)?.error;
      if (firstErr) {
        setError(`Pair-up failed: ${firstErr.message}`);
        setBusy(false);
        return;
      }
    }

    setBusy(false);
    setResult({
      mode,
      teamsAdded: n,
      teamsRemoved,
      playersAdded: totalPlayers,
    });
    // Reflect the new total in the dropdown without a refetch. For
    // "add" the new count = existing + n. For "reset" the new count
    // is exactly n (everything before was deleted).
    setTeamCountByEvent((prev) => {
      const next = new Map(prev);
      if (mode === "reset") {
        next.set(selectedEvent.id, n);
      } else {
        next.set(selectedEvent.id, (prev.get(selectedEvent.id) ?? 0) + n);
      }
      return next;
    });
  };

  if (!org) return null;
  if (loading) {
    return (
      <div style={{ color: "#666", fontSize: 14 }}>Loading…</div>
    );
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ margin: "0 0 4px", fontSize: 22 }}>Seed test data</h1>
      <p style={{ color: "#666", margin: "0 0 24px", fontSize: 13 }}>
        Generate fake players and teams for an event so you can stress-
        test the bracket / court manager / standings without manually
        entering rosters. Use sparingly — the players land in the
        shared global table.
      </p>

      <form
        onSubmit={onGenerate}
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        <label style={fieldStyle}>
          <span style={labelStyle}>Tournament</span>
          <select
            value={tournamentId}
            onChange={(e) => {
              setTournamentId(e.target.value);
              setEventId("");
              setResult(null);
              setError(null);
            }}
            style={inputStyle}
          >
            <option value="">Pick a tournament…</option>
            {tournaments.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <label style={fieldStyle}>
          <span style={labelStyle}>Event</span>
          <select
            value={eventId}
            onChange={(e) => {
              setEventId(e.target.value);
              setResult(null);
              setError(null);
            }}
            disabled={!tournamentId}
            style={inputStyle}
          >
            <option value="">
              {tournamentId
                ? events.length === 0
                  ? "No events in this tournament"
                  : "Pick an event…"
                : "Pick a tournament first"}
            </option>
            {events.map((e) => {
              const teamCount = teamCountByEvent.get(e.id) ?? 0;
              const capSuffix = e.max_teams ? ` / ${e.max_teams}` : "";
              return (
                <option key={e.id} value={e.id}>
                  {e.name} · {e.format} · {e.gender} · {teamCount}
                  {capSuffix}{" "}
                  {teamCount === 1 ? "team" : "teams"}
                </option>
              );
            })}
          </select>
        </label>

        {selectedEvent && (
          <div
            style={{
              padding: 12,
              background: "#fafafa",
              border: "1px solid #e5e7eb",
              borderRadius: 6,
              fontSize: 13,
              color: "#555",
            }}
          >
            <div>
              <strong>Format:</strong> {selectedEvent.format} ·{" "}
              <strong>Gender:</strong> {selectedEvent.gender}
            </div>
            {selectedEvent.max_teams && (
              <div style={{ marginTop: 4 }}>
                <strong>Max teams:</strong> {selectedEvent.max_teams}
              </div>
            )}
            <div style={{ marginTop: 4, color: "#888", fontSize: 12 }}>
              Each generated team gets {selectedEvent.format === "doubles" ? "2 players" : "1 player"}.
              Players are inserted into the global players table with no
              auth account.
            </div>
          </div>
        )}

        <div style={fieldStyle}>
          <span style={labelStyle}>Mode</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => {
                setMode("add");
                setResult(null);
                setError(null);
              }}
              style={modeBtn(mode === "add")}
            >
              Add to existing
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("reset");
                setResult(null);
                setError(null);
              }}
              style={modeBtn(mode === "reset")}
            >
              Set total (reset)
            </button>
          </div>
        </div>

        <label style={fieldStyle}>
          <span style={labelStyle}>
            {mode === "add" ? "Teams to add" : "Target team total"}
          </span>
          <input
            type="number"
            min="1"
            max="128"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            style={{ ...inputStyle, maxWidth: 120 }}
          />
        </label>

        {mode === "reset" && selectedEvent && (
          <div
            style={{
              padding: 12,
              background: "#fffbeb",
              border: "1px solid #fde68a",
              borderRadius: 6,
              color: "#7a5d00",
              fontSize: 13,
            }}
          >
            <strong>Reset mode.</strong> Every existing team in this event
            ({teamCountByEvent.get(selectedEvent.id) ?? 0}) and any of
            their matches will be <strong>deleted</strong> before the new{" "}
            {count || 0} test teams are inserted. Player records in the
            global players table stay.
          </div>
        )}

        {error && (
          <div
            style={{
              padding: 12,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 6,
              color: "#991b1b",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        {result && selectedTournament && selectedEvent && (
          <div
            style={{
              padding: 12,
              background: "#dcfce7",
              border: "1px solid #bbf7d0",
              borderRadius: 6,
              color: "#166534",
              fontSize: 13,
            }}
          >
            {result.mode === "reset" && result.teamsRemoved > 0 && (
              <>
                Removed <strong>{result.teamsRemoved}</strong>{" "}
                {result.teamsRemoved === 1 ? "team" : "teams"} (and any
                matches).{" "}
              </>
            )}
            {result.mode === "reset" ? "Reset event to " : "Generated "}
            <strong>{result.teamsAdded}</strong>{" "}
            {result.teamsAdded === 1 ? "team" : "teams"} (
            {result.playersAdded} players).{" "}
            <Link
              to={`/admin/${org.slug}/tournaments/${selectedTournament.slug}/events/${selectedEvent.id}?tab=teams`}
              style={{ color: "#166534", fontWeight: 500 }}
            >
              View on the event console →
            </Link>
          </div>
        )}

        <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
          <button
            type="submit"
            disabled={busy || !selectedEvent}
            style={primaryBtn(busy || !selectedEvent)}
          >
            {busy
              ? mode === "reset"
                ? "Resetting…"
                : "Generating…"
              : mode === "reset"
                ? `Reset to ${count || 0} teams`
                : `Add ${count || 0} teams`}
          </button>
          {selectedTournament && selectedEvent && (
            <Link
              to={`/admin/${org.slug}/tournaments/${selectedTournament.slug}/events/${selectedEvent.id}?tab=teams`}
              style={secondaryLinkBtn}
            >
              Open event console
            </Link>
          )}
        </div>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Name pools
// ─────────────────────────────────────────────────────────────────────

const MALE_FIRST = [
  "Alex", "Ben", "Chris", "Dan", "Eric", "Frank", "George", "Henry",
  "Ian", "Jack", "Kevin", "Luke", "Mike", "Nate", "Oscar", "Pete",
  "Quinn", "Ryan", "Sam", "Tom", "Vic", "Will", "Xavier", "Yuri", "Zach",
  "Aaron", "Brian", "Carl", "Derek", "Evan", "Felix", "Greg", "Hugo",
  "Isaac", "Jason", "Kyle", "Liam", "Marco", "Noah", "Owen",
];
const FEMALE_FIRST = [
  "Anna", "Beth", "Claire", "Diana", "Emma", "Fiona", "Grace", "Hannah",
  "Ivy", "Jane", "Kim", "Lisa", "Maria", "Nina", "Olivia", "Paula",
  "Rita", "Sara", "Tina", "Uma", "Vera", "Wendy", "Xena", "Yara", "Zoe",
  "Amy", "Bella", "Cara", "Daisy", "Elena", "Faye", "Gina", "Holly",
  "Iris", "Jenna", "Kelly", "Layla", "Mia", "Nora", "Opal",
];
const LAST = [
  "Smith", "Johnson", "Williams", "Brown", "Davis", "Miller", "Wilson",
  "Taylor", "Anderson", "Thomas", "Jackson", "White", "Harris", "Martin",
  "Thompson", "Garcia", "Martinez", "Robinson", "Clark", "Rodriguez",
  "Lewis", "Lee", "Walker", "Hall", "Young", "Allen", "King", "Wright",
  "Scott", "Green", "Baker", "Adams", "Nelson", "Hill", "Ramirez",
  "Campbell", "Mitchell", "Roberts", "Carter", "Phillips", "Evans",
  "Turner", "Parker", "Collins", "Edwards", "Stewart", "Morris", "Cook",
];

// Per-event-gender player generator. For mixed doubles we alternate
// captain (male) / partner (female) so the team is plausibly co-ed.
// Mixed singles just pulls from either pool randomly per player.
function buildPlayers(
  count: number,
  eventGender: Database["public"]["Enums"]["event_gender"],
  isDoubles: boolean,
): Array<{
  first_name: string;
  last_name: string;
  gender: Database["public"]["Enums"]["player_gender"];
  dob: string;
}> {
  const players: Array<{
    first_name: string;
    last_name: string;
    gender: Database["public"]["Enums"]["player_gender"];
    dob: string;
  }> = [];
  for (let i = 0; i < count; i++) {
    let pool: string[];
    let g: Database["public"]["Enums"]["player_gender"];
    if (eventGender === "men") {
      pool = MALE_FIRST;
      g = "M";
    } else if (eventGender === "women") {
      pool = FEMALE_FIRST;
      g = "F";
    } else if (eventGender === "mixed" && isDoubles) {
      // Alternate within each team: captain (even index) = male,
      // partner (odd index) = female.
      pool = i % 2 === 0 ? MALE_FIRST : FEMALE_FIRST;
      g = i % 2 === 0 ? "M" : "F";
    } else {
      // mixed singles — flip a coin per player
      const male = Math.random() < 0.5;
      pool = male ? MALE_FIRST : FEMALE_FIRST;
      g = male ? "M" : "F";
    }
    const first = pool[Math.floor(Math.random() * pool.length)];
    const last = LAST[Math.floor(Math.random() * LAST.length)];
    // Random DOB in adult range (25-65 years ago) so age-restricted
    // events still accept these.
    const ageYears = 25 + Math.floor(Math.random() * 40);
    const dobMs = Date.now() - ageYears * 365.25 * 24 * 60 * 60 * 1000;
    const dob = new Date(dobMs).toISOString().slice(0, 10);
    players.push({ first_name: first, last_name: last, gender: g, dob });
  }
  return players;
}

// ─────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 13,
  color: "#555",
};
const labelStyle: CSSProperties = { fontWeight: 500 };
const inputStyle: CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  width: "100%",
};
function primaryBtn(disabled: boolean): CSSProperties {
  return {
    padding: "10px 20px",
    background: disabled ? "#9ca3af" : "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
  };
}
// Segmented toggle: the active half gets the primary palette, the
// inactive half is a neutral outline. Used for the add-vs-reset
// mode selector.
function modeBtn(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: "8px 12px",
    background: active ? "#2563eb" : "#fff",
    color: active ? "#fff" : "#555",
    border: `1px solid ${active ? "#2563eb" : "#e2e2e2"}`,
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

const secondaryLinkBtn: CSSProperties = {
  padding: "10px 20px",
  background: "#fff",
  color: "#555",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  textDecoration: "none",
  fontFamily: "inherit",
};
