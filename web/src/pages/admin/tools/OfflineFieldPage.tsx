import { useEffect, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../../supabase";
import { useCurrentOrg } from "../../../hooks/useCurrentOrg";
import {
  buildFieldFile,
  parseFieldFile,
  fieldFilename,
  downloadJson,
  type FieldFile,
  type FieldEvent,
  type SourceEvent,
  type SourceReg,
} from "../../../lib/fieldFile";
import type { Database } from "../../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];

// Offline field import/export (issue #736, part of the offline-tournament
// epic #732). Registrations LOCK Friday AM, before the director goes
// offline for the weekend — so this is the last online action for the
// roster: export the locked field to a file here, then import that same
// file on the offline laptop to seed each event's teams.
//
// Scope: this imports REGISTRATIONS ONLY. The tournament and its events are
// assumed to already exist on the target database (set up during normal,
// online planning) — matched here by case-insensitive event name. Creating
// tournaments/events from a file is out of scope.
export default function OfflineFieldPage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!org || !tournamentSlug) return;
    let cancelled = false;
    (async () => {
      const { data: t, error: tErr } = await supabase
        .from("tournaments")
        .select("*")
        .eq("organization_id", org.id)
        .eq("slug", tournamentSlug)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (tErr || !t) {
        setError(tErr?.message ?? "Tournament not found.");
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
      if (cancelled) return;
      if (evErr) {
        setError(evErr.message);
        setLoading(false);
        return;
      }
      setEvents(evs ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [org, tournamentSlug]);

  if (!org) return null;
  if (loading) return <div style={{ color: "#666", fontSize: 14 }}>Loading…</div>;
  if (error || !tournament) {
    return (
      <div style={{ color: "#991b1b", fontSize: 14 }}>
        {error ?? "Tournament not found."}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <Link
        to={`/admin/${org.slug}/tournaments/${tournament.slug}`}
        style={{ fontSize: 13, color: "#2563eb", textDecoration: "none" }}
      >
        ← {tournament.name}
      </Link>
      <h1 style={{ margin: "8px 0 4px", fontSize: 22 }}>
        Offline field import / export
      </h1>
      <p style={{ color: "#666", margin: "0 0 24px", fontSize: 13, lineHeight: 1.5 }}>
        For running this tournament fully offline. Export the locked field
        here (while still online) — then import that same file on the
        offline laptop to seed each event's teams. Plain files on disk, not
        an API sync.
      </p>

      <ExportSection tournament={tournament} events={events} />
      <ImportSection events={events} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────

function ExportSection({
  tournament,
  events,
}: {
  tournament: Tournament;
  events: Event[];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onExport = async () => {
    setBusy(true);
    setError(null);
    const sourceEvents: SourceEvent[] = events.map((e) => ({
      id: e.id,
      name: e.name,
      format: e.format,
      gender: e.gender,
    }));

    const { data, error: regErr } = await supabase
      .from("event_registrations")
      .select(
        "id, event_id, partner_registration_id, status, seed, players(first_name, last_name, email, phone, city, state, gender, dob), events!inner(tournament_id, deleted_at)",
      )
      .eq("events.tournament_id", tournament.id)
      .is("deleted_at", null)
      .is("events.deleted_at", null);
    setBusy(false);
    if (regErr) {
      setError(regErr.message);
      return;
    }

    type RawReg = {
      id: string;
      event_id: string;
      partner_registration_id: string | null;
      status: SourceReg["status"];
      seed: number | null;
      players: SourceReg["player"] | null;
    };
    const regsByEvent = new Map<string, SourceReg[]>();
    for (const r of (data ?? []) as unknown as RawReg[]) {
      if (!r.players) continue;
      const arr = regsByEvent.get(r.event_id) ?? [];
      arr.push({
        id: r.id,
        partner_registration_id: r.partner_registration_id,
        status: r.status,
        seed: r.seed,
        player: r.players,
      });
      regsByEvent.set(r.event_id, arr);
    }

    const file = buildFieldFile(
      tournament.name,
      new Date(),
      sourceEvents,
      regsByEvent,
    );
    downloadJson(fieldFilename(tournament.name, new Date()), file);
  };

  return (
    <section style={sectionStyle}>
      <h2 style={sectionTitleStyle}>Export locked field</h2>
      <p style={sectionCopyStyle}>
        Downloads every event's confirmed teams (players + partner pairing)
        as a JSON file. Run this Friday morning right after registrations
        lock, while you're still online.
      </p>
      {error && <div style={errorBoxStyle}>{error}</div>}
      <button
        type="button"
        onClick={() => void onExport()}
        disabled={busy || events.length === 0}
        style={primaryBtn(busy || events.length === 0)}
      >
        {busy ? "Exporting…" : "Download locked field (JSON)"}
      </button>
      {events.length === 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#888" }}>
          No events in this tournament yet.
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Import
// ─────────────────────────────────────────────────────────────────────

type EventPreview = {
  fileEvent: FieldEvent;
  target: Event | null;
  playerCount: number;
};

type ImportSummary = {
  eventsImported: number;
  eventsSkipped: number;
  teamsAdded: number;
  playersCreated: number;
  playersMatched: number;
  perEventErrors: string[];
};

function ImportSection({ events }: { events: Event[] }) {
  const [file, setFile] = useState<FieldFile | null>(null);
  const [preview, setPreview] = useState<EventPreview[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const onFile = async (f: File | undefined) => {
    setSummary(null);
    setParseError(null);
    setFile(null);
    setPreview(null);
    if (!f) return;
    try {
      const text = await f.text();
      const parsed = parseFieldFile(text);
      setFile(parsed);
      const byName = new Map(
        events.map((e) => [e.name.trim().toLowerCase(), e]),
      );
      setPreview(
        parsed.events.map((fe) => ({
          fileEvent: fe,
          target: byName.get(fe.name.trim().toLowerCase()) ?? null,
          playerCount: fe.teams.reduce((n, t) => n + t.players.length, 0),
        })),
      );
    } catch (e) {
      setParseError((e as Error).message);
    }
  };

  const onImport = async () => {
    if (!preview) return;
    setBusy(true);
    setSummary(null);

    const matched = preview.filter((p) => p.target);
    const perEventErrors: string[] = preview
      .filter((p) => !p.target)
      .map((p) => `"${p.fileEvent.name}" has no matching event in this tournament — skipped.`);

    // Resolve players against the local players table by email in one
    // batch, so the same person across multiple events (or already in the
    // system) doesn't get duplicated.
    const emails = new Set<string>();
    for (const p of matched) {
      for (const team of p.fileEvent.teams) {
        for (const player of team.players) {
          if (player.email) emails.add(player.email.toLowerCase());
        }
      }
    }
    const existingByEmail = new Map<string, string>();
    if (emails.size > 0) {
      const { data: existing, error: lookupErr } = await supabase
        .from("players")
        .select("id, email")
        .in("email", [...emails]);
      if (lookupErr) {
        setSummary({
          eventsImported: 0,
          eventsSkipped: preview.length,
          teamsAdded: 0,
          playersCreated: 0,
          playersMatched: 0,
          perEventErrors: [`Player lookup failed: ${lookupErr.message}`],
        });
        setBusy(false);
        return;
      }
      for (const row of existing ?? []) {
        if (row.email) existingByEmail.set(row.email.toLowerCase(), row.id);
      }
    }

    let teamsAdded = 0;
    let playersCreated = 0;
    let playersMatched = 0;
    let eventsImported = 0;

    for (const p of matched) {
      const target = p.target!;
      const existingCount = await countActiveRegs(target.id);
      if (
        target.max_teams &&
        existingCount + p.fileEvent.teams.length > target.max_teams
      ) {
        perEventErrors.push(
          `"${target.name}": importing ${p.fileEvent.teams.length} teams would exceed the ${target.max_teams}-team cap (${existingCount} already there) — skipped.`,
        );
        continue;
      }

      // Count matches against the email map as it stood before this
      // event's own inserts land in it, then insert any players not
      // already matched. Players with no email always get a fresh row
      // (soft-unique email allows this).
      let eventPlayersMatched = 0;
      const toInsert: {
        idx: number;
        team: number;
        player: (typeof p.fileEvent.teams)[number]["players"][number];
      }[] = [];
      p.fileEvent.teams.forEach((team, ti) => {
        team.players.forEach((player, pi) => {
          const key = player.email?.toLowerCase();
          if (key && existingByEmail.has(key)) {
            eventPlayersMatched += 1;
          } else {
            toInsert.push({ idx: pi, team: ti, player });
          }
        });
      });

      const insertedIdByPos = new Map<string, string>();
      if (toInsert.length > 0) {
        const { data: inserted, error: pErr } = await supabase
          .from("players")
          .insert(
            toInsert.map((x) => ({
              first_name: x.player.first_name,
              last_name: x.player.last_name,
              email: x.player.email,
              phone: x.player.phone,
              city: x.player.city,
              state: x.player.state,
              gender: x.player.gender,
              dob: x.player.dob,
            })),
          )
          .select("id");
        if (pErr || !inserted) {
          perEventErrors.push(
            `"${target.name}": failed to create players (${pErr?.message ?? "unknown error"}) — skipped.`,
          );
          continue;
        }
        toInsert.forEach((x, i) => {
          insertedIdByPos.set(`${x.team}:${x.idx}`, inserted[i].id);
          if (x.player.email) {
            existingByEmail.set(x.player.email.toLowerCase(), inserted[i].id);
          }
        });
        playersCreated += inserted.length;
      }

      const playerId = (teamIdx: number, playerIdx: number, email: string | null) => {
        const key = email?.toLowerCase();
        if (key && existingByEmail.has(key)) return existingByEmail.get(key)!;
        return insertedIdByPos.get(`${teamIdx}:${playerIdx}`)!;
      };
      playersMatched += eventPlayersMatched;

      const regsToInsert = p.fileEvent.teams.flatMap((team, ti) =>
        team.players.map((player, pi) => ({
          event_id: target.id,
          player_id: playerId(ti, pi, player.email),
          event_fee_cents: target.event_fee_cents,
          status: "paid" as const,
          partner_status: (team.players.length === 2 ? "confirmed" : "solo") as
            | "confirmed"
            | "solo",
          seed: team.seed,
        })),
      );
      const { data: insertedRegs, error: rErr } = await supabase
        .from("event_registrations")
        .insert(regsToInsert)
        .select("id");
      if (rErr || !insertedRegs) {
        perEventErrors.push(
          `"${target.name}": failed to create registrations (${rErr?.message ?? "unknown error"}) — skipped.`,
        );
        continue;
      }

      // Pair doubles teams via partner_registration_id, two rows at a time
      // in the same order they were inserted.
      let cursor = 0;
      const pairWrites = [];
      for (const team of p.fileEvent.teams) {
        if (team.players.length === 2) {
          const a = insertedRegs[cursor];
          const b = insertedRegs[cursor + 1];
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
        cursor += team.players.length;
      }
      if (pairWrites.length > 0) {
        const results = await Promise.all(pairWrites);
        const firstErr = results.find((r) => r.error)?.error;
        if (firstErr) {
          perEventErrors.push(`"${target.name}": pair-up failed: ${firstErr.message}`);
          continue;
        }
      }

      teamsAdded += p.fileEvent.teams.length;
      eventsImported += 1;
    }

    setSummary({
      eventsImported,
      eventsSkipped: preview.length - eventsImported,
      teamsAdded,
      playersCreated,
      playersMatched,
      perEventErrors,
    });
    setBusy(false);
  };

  return (
    <section style={sectionStyle}>
      <h2 style={sectionTitleStyle}>Import locked field</h2>
      <p style={sectionCopyStyle}>
        Upload the file exported above. Matches each file event to an
        existing event in <strong>this tournament</strong> by name, creates
        any players not already on file (matched by email), and seeds the
        teams.
      </p>

      <input
        type="file"
        accept=".json,application/json"
        onChange={(e) => void onFile(e.target.files?.[0])}
        style={{ fontSize: 13, marginBottom: 12 }}
      />

      {parseError && <div style={errorBoxStyle}>{parseError}</div>}

      {preview && (
        <div style={{ marginBottom: 16 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#888" }}>
                <th style={{ padding: "4px 8px 4px 0" }}>Event (file)</th>
                <th style={{ padding: "4px 8px" }}>Matches</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>Teams</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>Players</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((p) => (
                <tr key={p.fileEvent.name} style={{ borderTop: "1px solid #eee" }}>
                  <td style={{ padding: "4px 8px 4px 0" }}>{p.fileEvent.name}</td>
                  <td style={{ padding: "4px 8px", color: p.target ? "#166534" : "#991b1b" }}>
                    {p.target ? p.target.name : "no matching event"}
                  </td>
                  <td style={{ padding: "4px 8px", textAlign: "right" }}>
                    {p.fileEvent.teams.length}
                  </td>
                  <td style={{ padding: "4px 8px", textAlign: "right" }}>
                    {p.playerCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {file && preview && (
        <button
          type="button"
          onClick={() => void onImport()}
          disabled={busy || !preview.some((p) => p.target)}
          style={primaryBtn(busy || !preview.some((p) => p.target))}
        >
          {busy ? "Importing…" : "Import field"}
        </button>
      )}

      {summary && (
        <div style={{ ...resultBoxStyle, marginTop: 16 }}>
          <div>
            Imported <strong>{summary.eventsImported}</strong> event
            {summary.eventsImported === 1 ? "" : "s"} —{" "}
            <strong>{summary.teamsAdded}</strong> teams (
            {summary.playersCreated} new players, {summary.playersMatched}{" "}
            matched by email).
          </div>
          {summary.perEventErrors.length > 0 && (
            <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: "#991b1b" }}>
              {summary.perEventErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

async function countActiveRegs(eventId: string): Promise<number> {
  const { count } = await supabase
    .from("event_registrations")
    .select("id", { count: "exact", head: true })
    .eq("event_id", eventId)
    .is("deleted_at", null);
  return count ?? 0;
}

// ─────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────

const sectionStyle: CSSProperties = {
  padding: 20,
  background: "#fafafa",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  marginBottom: 20,
};
const sectionTitleStyle: CSSProperties = { margin: "0 0 8px", fontSize: 16 };
const sectionCopyStyle: CSSProperties = {
  margin: "0 0 16px",
  fontSize: 13,
  color: "#666",
  lineHeight: 1.5,
};
const errorBoxStyle: CSSProperties = {
  padding: 12,
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 6,
  color: "#991b1b",
  fontSize: 13,
  marginBottom: 12,
};
const resultBoxStyle: CSSProperties = {
  padding: 12,
  background: "#dcfce7",
  border: "1px solid #bbf7d0",
  borderRadius: 6,
  color: "#166534",
  fontSize: 13,
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
