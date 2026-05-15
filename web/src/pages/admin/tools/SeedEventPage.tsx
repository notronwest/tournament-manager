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
  const [loading, setLoading] = useState(true);
  const [tournamentId, setTournamentId] = useState<string>(
    searchParams.get("tournament") ?? "",
  );
  const [eventId, setEventId] = useState<string>(
    searchParams.get("event") ?? "",
  );
  const [count, setCount] = useState("8");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    teamsAdded: number;
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

  // Load events for the selected tournament.
  useEffect(() => {
    if (!tournamentId) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error: eErr } = await supabase
        .from("events")
        .select("*")
        .eq("tournament_id", tournamentId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true });
      if (cancelled) return;
      if (eErr) {
        setError(eErr.message);
        return;
      }
      setEvents(data ?? []);
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
    setResult({ teamsAdded: n, playersAdded: totalPlayers });
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
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} · {e.format} · {e.gender}
              </option>
            ))}
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

        <label style={fieldStyle}>
          <span style={labelStyle}>Teams to generate</span>
          <input
            type="number"
            min="1"
            max="128"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            style={{ ...inputStyle, maxWidth: 120 }}
          />
        </label>

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
            Generated <strong>{result.teamsAdded}</strong>{" "}
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
            {busy ? "Generating…" : "Generate teams"}
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
