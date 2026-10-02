import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { SPOT_HOLDING_STATUSES } from "../../lib/registrationStatus";
import type { Database } from "../../types/supabase";
import {
  ink,
  inkSoft,
  inkMuted,
  bg,
  rule,
  courtGreen,
  courtBlue,
  courtRed,
  dangerBg,
  dangerFg,
  warnBg,
  warnFg,
  bodyFontStack,
} from "../../lib/publicTheme";

type Event = Database["public"]["Tables"]["events"]["Row"];
type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Player = Database["public"]["Tables"]["players"]["Row"];
type EventRegistration =
  Database["public"]["Tables"]["event_registrations"]["Row"];

// A pool-tracking team: the captain reg id (canonical, matches how the
// app keys matches), the pair label, and the fields the app sorts on.
type Team = {
  captainRegId: string;
  label: string;
  poolIndex: number | null;
  seed: number | null;
  registeredAt: string;
};

// One printable pool: its 1-based pool index (null for a single-pool
// event), the teams numbered T1..Tn in app order, and the circle-method
// rounds over those numbers.
type PoolSheet = {
  poolIndex: number | null;
  teams: Team[];
  rounds: [number, number][][];
};

// ─────────────────────────────────────────────────────────────────────
// Printable pool tracking sheets
//
// One landscape page per pool: header (event / pool / tournament / date /
// blank court line), a numbered team legend (T1..Tn), the round-by-round
// matchups as a grid with score boxes to fill by hand, and a standings
// table to tally by hand below.
//
// Teams and pool membership come straight from the app
// (`event_registrations.pool_index`, 1-based) — NOT a recomputed split.
// Team numbering (T1..Tn) uses the same seed→registration sort the app
// uses when it generates round-robin matches, so the numbers on paper
// match the numbers the app would assign.
//
// Rounds are the classic circle method within each pool. The app itself
// does NOT store rounds — it generates a flat, position-ordered list of
// every pairing (every match carries round=1, labelled RR-1, RR-2, …) and
// the live playing order is decided dynamically by the court manager. The
// circle method here produces exactly the same SET of pairings; the round
// grouping is a print-layout convenience (it tells the desk which games
// can run concurrently) and reproduces the standalone gen_sheets.py layout
// that was used by hand at the Sept 2025 tournament.
//
// Chrome is hidden at print time via the global `.no-print` / sidebar
// rules in index.css; page-level print styling lives in the injected
// <style> below because @page / page-break can't be inline.
// ─────────────────────────────────────────────────────────────────────
export default function PoolSheetsPage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug, eventId } = useParams<{
    tournamentSlug: string;
    eventId: string;
  }>();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [event, setEvent] = useState<Event | null>(null);
  const [regs, setRegs] = useState<EventRegistration[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!org || !tournamentSlug || !eventId) return;
    setError(null);

    const { data: ev, error: evErr } = await supabase
      .from("events")
      .select("*, tournaments!inner(*)")
      .eq("id", eventId)
      .is("deleted_at", null)
      .maybeSingle();
    if (evErr) {
      setError(evErr.message);
      setLoading(false);
      return;
    }
    if (!ev) {
      setError("Event not found.");
      setLoading(false);
      return;
    }
    const t = (ev as { tournaments: Tournament | null }).tournaments;
    if (!t || t.organization_id !== org.id || t.slug !== tournamentSlug) {
      setError("Event not found in this tournament.");
      setLoading(false);
      return;
    }
    setTournament(t);
    setEvent(ev as Event);

    // Only spot-holding registrations — a tracking sheet should list the
    // teams that are actually playing, not withdrawn/cancelled rows. This
    // mirrors the event console's own team list.
    const { data: regsData, error: regsErr } = await supabase
      .from("event_registrations")
      .select("*")
      .eq("event_id", eventId)
      .in("status", SPOT_HOLDING_STATUSES)
      .is("deleted_at", null)
      .order("registered_at");
    if (regsErr) {
      setError(regsErr.message);
      setLoading(false);
      return;
    }
    const rows = regsData ?? [];
    setRegs(rows);

    const playerIds = Array.from(new Set(rows.map((r) => r.player_id)));
    if (playerIds.length === 0) {
      setPlayers([]);
    } else {
      const { data: playersData, error: playersErr } = await supabase
        .from("players")
        .select("*")
        .in("id", playerIds);
      if (playersErr) {
        setError(playersErr.message);
        setLoading(false);
        return;
      }
      setPlayers(playersData ?? []);
    }
    setLoading(false);
  }, [org, tournamentSlug, eventId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const teams = useMemo(() => buildTeams(regs, players), [regs, players]);

  // Split teams into pools, build the circle-method schedule per pool.
  // `missingPools` is true when a multi-pool event has teams that haven't
  // been assigned a pool yet — we can't print a faithful sheet then.
  const { sheets, missingPools } = useMemo(() => {
    if (!event) return { sheets: [] as PoolSheet[], missingPools: false };
    const reps = Math.max(1, event.play_each_team_times ?? 1);

    if (event.pool_count > 1) {
      const anyUnassigned = teams.some((t) => t.poolIndex == null);
      const built: PoolSheet[] = [];
      for (let p = 1; p <= event.pool_count; p++) {
        const poolTeams = teams.filter((t) => t.poolIndex === p);
        built.push({
          poolIndex: p,
          teams: poolTeams,
          rounds: repeatRounds(circleRounds(poolTeams.length), reps),
        });
      }
      return { sheets: built, missingPools: anyUnassigned };
    }

    // Single-pool event: every team is in the one pool.
    return {
      sheets: [
        {
          poolIndex: null,
          teams,
          rounds: repeatRounds(circleRounds(teams.length), reps),
        },
      ],
      missingPools: false,
    };
  }, [event, teams]);

  if (!org) return null;
  if (loading)
    return (
      <div style={{ color: inkMuted, fontSize: 14, fontFamily: bodyFontStack }}>
        Loading…
      </div>
    );
  if (error) {
    return (
      <div
        style={{
          padding: 12,
          background: dangerBg,
          border: `1px solid ${courtRed}`,
          borderRadius: 6,
          color: dangerFg,
          fontSize: 13,
          fontFamily: bodyFontStack,
        }}
      >
        {error}
      </div>
    );
  }
  if (!event || !tournament) return null;

  const dateLabel = formatTournamentDate(tournament.starts_at);
  const printablePools = sheets.filter((s) => s.teams.length > 0).length;

  return (
    <div className="poolsheets-page">
      <style>{printCss}</style>

      <div className="no-print" style={toolbarStyle}>
        <Link
          to={`/admin/${org.slug}/tournaments/${tournament.slug}/events/${event.id}`}
          style={{ color: courtBlue, textDecoration: "none", fontSize: 13 }}
        >
          ← {event.name}
        </Link>
        <div style={{ flex: 1 }} />
        {event.play_each_team_times > 1 && (
          <span style={{ fontSize: 13, color: inkSoft }}>
            Play each opponent {event.play_each_team_times}×
          </span>
        )}
        <button
          onClick={() => window.print()}
          style={printBtn}
          disabled={printablePools === 0}
        >
          Print {printablePools} pool {printablePools === 1 ? "sheet" : "sheets"}
        </button>
      </div>

      {teams.length === 0 ? (
        <Notice tone="info">
          No teams in this event yet. Add (or pair) teams before printing pool
          sheets.
        </Notice>
      ) : missingPools ? (
        <Notice tone="warn">
          This event has {event.pool_count} pools, but some teams aren’t
          assigned to a pool yet. Assign pools on the event console (Teams tab →
          “Auto-assign pools” or set each team’s pool), then come back to print.
        </Notice>
      ) : (
        sheets.map((sheet) =>
          sheet.teams.length === 0 ? null : (
            <PoolSheetPage
              key={sheet.poolIndex ?? "single"}
              sheet={sheet}
              eventName={event.name}
              tournamentName={tournament.name}
              dateLabel={dateLabel}
              poolCount={event.pool_count}
            />
          ),
        )
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// One pool's page
// ─────────────────────────────────────────────────────────────────────

function PoolSheetPage({
  sheet,
  eventName,
  tournamentName,
  dateLabel,
  poolCount,
}: {
  sheet: PoolSheet;
  eventName: string;
  tournamentName: string;
  dateLabel: string;
  poolCount: number;
}) {
  const n = sheet.teams.length;
  const poolTitle =
    poolCount > 1 && sheet.poolIndex != null
      ? `Pool ${poolLetter(sheet.poolIndex)}`
      : "Single Pool";
  // Column count keeps each column short enough for one landscape page,
  // and the `dense` tier tightens rows for bigger pools. These thresholds
  // were tuned by measuring rendered content height against the 7.8in
  // printable landscape height — pools up to ~10 teams fit on one page.
  const columns = columnsFor(n);
  const dense = n >= 7;

  return (
    <section className={dense ? "pool-sheet dense" : "pool-sheet"}>
      <header className="ps-header">
        <div>
          <div className="ps-event">{eventName}</div>
          <div className="ps-pool">
            {poolTitle} · {n} {n === 1 ? "team" : "teams"}
          </div>
        </div>
        <div className="ps-header-right">
          <div className="ps-tourn">{tournamentName}</div>
          <div className="ps-meta">
            {dateLabel ? <>{dateLabel} · </> : null}
            Courts <span className="ps-fill">&nbsp;</span>
          </div>
        </div>
      </header>

      <div className="ps-legend">
        {sheet.teams.map((t, i) => (
          <span className="ps-chip" key={t.captainRegId}>
            <b>T{i + 1}</b> {t.label}
          </span>
        ))}
      </div>

      <div className="ps-lbl">
        Games — write each team’s number in the box (T# above), enter points
      </div>
      <div className="ps-games" style={{ columnCount: columns }}>
        {sheet.rounds.map((pairs, r) => (
          <div className="ps-round" key={r}>
            <div className="ps-rhdr">Round {r + 1}</div>
            {pairs.map(([a, b], k) => (
              <div className="ps-match" key={k}>
                <span className="ps-ct" />
                <span className="ps-tid">T{a}</span>
                <span className="ps-box" />
                <span className="ps-dash">–</span>
                <span className="ps-box" />
                <span className="ps-tid">T{b}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="ps-lbl ps-standings-lbl">Standings — tally by hand</div>
      <table className="ps-standings">
        <thead>
          <tr>
            <th></th>
            <th>Team</th>
            <th>Wins</th>
            <th>Losses</th>
            <th>Pts For</th>
            <th>Pts Agst</th>
            <th>Diff</th>
            <th>Finish</th>
          </tr>
        </thead>
        <tbody>
          {sheet.teams.map((t, i) => (
            <tr key={t.captainRegId}>
              <td className="ps-tn">T{i + 1}</td>
              <td className="ps-nm">{t.label}</td>
              <td></td>
              <td></td>
              <td></td>
              <td></td>
              <td></td>
              <td className="ps-pl"></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "info" | "warn";
  children: React.ReactNode;
}) {
  const palette =
    tone === "warn"
      ? { bg: warnBg, border: warnFg, fg: warnFg }
      : { bg, border: rule, fg: inkSoft };
  return (
    <div
      className="no-print"
      style={{
        padding: 16,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 6,
        color: palette.fg,
        fontSize: 13,
        fontFamily: bodyFontStack,
        maxWidth: 620,
      }}
    >
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Scheduling + data helpers
// ─────────────────────────────────────────────────────────────────────

// Build teams from registrations exactly as the event console does:
// captain = lower-id reg of a pair (stable), pool/seed inherited from the
// captain (falling back to the partner), then sorted by seed asc
// (unseeded last) then registration order. Keeping this identical to
// EventConsolePage.buildTeams is what makes T1..Tn on paper match the
// numbers the app assigns when it generates matches.
function buildTeams(regs: EventRegistration[], players: Player[]): Team[] {
  const playerById = new Map(players.map((p) => [p.id, p]));
  const regById = new Map(regs.map((r) => [r.id, r]));

  const teams: Team[] = [];
  const seen = new Set<string>();

  for (const r of regs) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);

    let captainReg: EventRegistration = r;
    let partnerReg: EventRegistration | null = null;
    if (r.partner_registration_id) {
      const pr = regById.get(r.partner_registration_id);
      if (pr) {
        seen.add(pr.id);
        if (pr.id < captainReg.id) {
          partnerReg = captainReg;
          captainReg = pr;
        } else {
          partnerReg = pr;
        }
      }
    }

    const captain = playerById.get(captainReg.player_id);
    if (!captain) continue;
    const partner = partnerReg
      ? (playerById.get(partnerReg.player_id) ?? null)
      : null;

    teams.push({
      captainRegId: captainReg.id,
      poolIndex: captainReg.pool_index ?? partnerReg?.pool_index ?? null,
      seed: captainReg.seed ?? partnerReg?.seed ?? null,
      registeredAt: captainReg.registered_at,
      label: partner
        ? `${captain.first_name} ${captain.last_name} / ${partner.first_name} ${partner.last_name}`
        : `${captain.first_name} ${captain.last_name}`,
    });
  }

  teams.sort((a, b) => {
    const sa = a.seed ?? Number.POSITIVE_INFINITY;
    const sb = b.seed ?? Number.POSITIVE_INFINITY;
    if (sa !== sb) return sa - sb;
    return a.registeredAt.localeCompare(b.registeredAt);
  });
  return teams;
}

// Standard circle-method round-robin over team numbers 1..n. Returns
// rounds; each round is a list of [teamNumberA, teamNumberB] pairs, with
// the left/right order preserved from the circle (not sorted) so the
// layout matches the reference sheet. Odd n adds a bye so one team sits
// out each round. Verified against backups/scoresheets.html for n=4,5,6,7,9.
function circleRounds(n: number): [number, number][][] {
  if (n < 2) return [];
  const BYE = 0;
  const arr: number[] = [];
  for (let i = 1; i <= n; i++) arr.push(i);
  if (arr.length % 2 === 1) arr.push(BYE);

  const m = arr.length;
  const roundCount = m - 1;
  const rounds: [number, number][][] = [];
  for (let r = 0; r < roundCount; r++) {
    const pairs: [number, number][] = [];
    for (let i = 0; i < m / 2; i++) {
      const a = arr[i];
      const b = arr[m - 1 - i];
      if (a !== BYE && b !== BYE) pairs.push([a, b]);
    }
    rounds.push(pairs);
    // Rotate: keep arr[0] fixed, move the last element into position 1.
    const last = arr[m - 1];
    for (let i = m - 1; i > 1; i--) arr[i] = arr[i - 1];
    arr[1] = last;
  }
  return rounds;
}

// Repeat the full round cycle `reps` times (play_each_team_times), with
// round numbers continuing across cycles. reps is almost always 1.
function repeatRounds(
  rounds: [number, number][][],
  reps: number,
): [number, number][][] {
  if (reps <= 1) return rounds;
  const out: [number, number][][] = [];
  for (let r = 0; r < reps; r++) out.push(...rounds.map((p) => [...p]));
  return out;
}

// Columns the games grid flows into, sized so a pool fits one landscape
// page. Tuned against measured render heights (see the density tier in the
// print CSS): 2/3/4/5 columns as the pool grows.
function columnsFor(n: number): number {
  if (n <= 4) return 2;
  if (n <= 7) return 3;
  if (n <= 8) return 4;
  return 5;
}

// 1-based pool index → "A", "B", … (matches EventConsolePage/resultsExport).
function poolLetter(index: number): string {
  return String.fromCharCode(64 + index);
}

function formatTournamentDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// ─────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────

const toolbarStyle = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginBottom: 24,
  flexWrap: "wrap" as const,
};

const printBtn = {
  padding: "8px 16px",
  background: courtBlue,
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: bodyFontStack,
};

// All sheet styling lives in one CSS string so the print rules can use
// @page / page-break / column selectors (inline styles can't carry them).
// One landscape page per .pool-sheet; rounds flow into balanced columns.
const printCss = `
  @page {
    size: landscape;
    margin: 0.35in;
  }

  /* Box model mirrors the proven standalone sheet: an 11in × 8.5in
     landscape page. One .pool-sheet per printed page. */
  .pool-sheet {
    background: #fff;
    color: ${ink};
    font-family: ${bodyFontStack};
    width: 11in;
    min-height: 8.5in;
    margin: 14px auto;
    padding: 0.34in 0.42in;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    page-break-after: always;
  }
  .pool-sheet:last-child {
    page-break-after: auto;
  }

  .ps-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    border-bottom: 3px solid ${ink};
    padding-bottom: 7px;
    margin-bottom: 8px;
  }
  .ps-event {
    font-size: 25px;
    font-weight: 800;
    letter-spacing: -0.5px;
  }
  .ps-pool {
    font-size: 13px;
    font-weight: 700;
    color: ${courtGreen};
    text-transform: uppercase;
    letter-spacing: 2px;
  }
  .ps-header-right {
    text-align: right;
  }
  .ps-tourn {
    font-size: 12px;
    font-weight: 700;
  }
  .ps-meta {
    font-size: 11px;
    color: ${inkMuted};
  }
  .ps-fill {
    display: inline-block;
    border-bottom: 1px solid ${ink};
    min-width: 90px;
  }

  .ps-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 3px 10px;
    margin-bottom: 9px;
    padding-bottom: 8px;
    border-bottom: 1px solid ${rule};
  }
  .ps-chip {
    font-size: 10.5px;
    white-space: nowrap;
  }
  .ps-chip b {
    color: ${courtGreen};
  }

  .ps-lbl {
    font-size: 9.5px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: ${inkMuted};
    margin: 0 0 5px;
  }
  .ps-standings-lbl {
    margin-top: 12px;
  }

  .ps-games {
    column-gap: 16px;
  }
  .ps-round {
    break-inside: avoid;
    -webkit-column-break-inside: avoid;
    margin-bottom: 9px;
    border: 1px solid ${rule};
    border-radius: 4px;
    overflow: hidden;
  }
  .ps-rhdr {
    background: ${bg};
    font-size: 9px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: ${courtGreen};
    padding: 3px 7px;
    border-bottom: 1px solid ${rule};
  }
  .ps-match {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 7px;
    font-size: 12px;
    font-weight: 700;
    border-bottom: 1px solid ${bg};
  }
  .ps-round .ps-match:last-child {
    border-bottom: none;
  }
  .ps-ct {
    width: 20px;
    height: 18px;
    border: 1px dashed ${rule};
    border-radius: 2px;
    flex: none;
  }
  .ps-tid {
    min-width: 24px;
    text-align: center;
    color: ${courtGreen};
    font-weight: 800;
  }
  .ps-box {
    width: 26px;
    height: 20px;
    border: 1px solid ${ink};
    border-radius: 2px;
    flex: none;
  }
  .ps-dash {
    color: ${inkMuted};
  }

  .ps-standings {
    width: 100%;
    border-collapse: collapse;
  }
  .ps-standings th {
    background: ${bg};
    font-size: 8.5px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: ${inkMuted};
    border: 1px solid ${rule};
    padding: 4px 3px;
  }
  .ps-standings td {
    border: 1px solid ${rule};
    height: 22px;
    padding: 2px 5px;
    font-size: 11px;
  }
  .ps-standings .ps-tn {
    font-weight: 800;
    color: ${courtGreen};
    text-align: center;
    width: 30px;
  }
  .ps-standings .ps-nm {
    font-weight: 600;
  }
  .ps-standings .ps-pl {
    background: ${bg};
  }

  /* Density tier for larger pools (7+ teams): tighten rows and type so
     the extra rounds + standings still land on one landscape page. */
  .pool-sheet.dense .ps-event {
    font-size: 22px;
  }
  .pool-sheet.dense .ps-legend {
    gap: 2px 8px;
    margin-bottom: 6px;
    padding-bottom: 6px;
  }
  .pool-sheet.dense .ps-chip {
    font-size: 10px;
  }
  .pool-sheet.dense .ps-round {
    margin-bottom: 6px;
  }
  .pool-sheet.dense .ps-match {
    padding: 2px 6px;
    gap: 3px;
    font-size: 11px;
  }
  .pool-sheet.dense .ps-ct {
    width: 18px;
    height: 15px;
  }
  .pool-sheet.dense .ps-box {
    width: 24px;
    height: 17px;
  }
  .pool-sheet.dense .ps-standings td {
    height: 18px;
    padding: 1px 5px;
    font-size: 10px;
  }

  @media screen {
    .pool-sheet {
      border: 1px solid ${rule};
      border-radius: 6px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
    }
  }

  @media print {
    .poolsheets-page {
      background: #fff;
    }
    .pool-sheet {
      width: auto;
      min-height: 0;
      margin: 0;
      padding: 0.15in 0.1in;
      box-shadow: none;
      border: none;
    }
  }
`;
