import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  buildTeams,
  computeMedals,
  computeStandings,
  groupStandingsByPool,
  poolLabel,
  teamByAnyRegId,
  type Medal,
} from "../lib/bracketTeams";
import { playoffStageLabel } from "../lib/matchLabel";
import { playoffRoundName } from "../lib/playoffBracket";
import { packRoundRobinRounds } from "../lib/roundRobinRounds";
import { fetchPublicResults, type PublicEvent, type PublicMatch, type PublicResultsPayload } from "../lib/publicResults";
import { StandingsTable } from "./StandingsTable";
import {
  bodyFontStack,
  courtRed,
  cream,
  headingFontStack,
  ink,
  inkMuted,
  inkSoft,
  monoFontStack,
  rule,
  ruleSoft,
} from "../lib/publicTheme";

// "Brackets" tab on the public tournament page: one bracket (event) at a
// time — its standings per pool, every pool-play round with scores as they're
// entered, then the playoff / medal games. Reads the same public results
// payload as the live results page and refreshes every 30s while open, so a
// player can leave it up on their phone between games.

const REFRESH_MS = 30_000;

export function BracketStandingsPanel({
  orgSlug,
  tournamentSlug,
  selectedEventId,
  onSelectEvent,
}: {
  orgSlug: string;
  tournamentSlug: string;
  selectedEventId: string | null;
  onSelectEvent: (eventId: string) => void;
}) {
  const [payload, setPayload] = useState<PublicResultsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshing = useRef(false);

  const load = useCallback(
    async (initial: boolean) => {
      if (refreshing.current) return;
      refreshing.current = true;
      const { data, error: err } = await fetchPublicResults(orgSlug, tournamentSlug);
      refreshing.current = false;
      if (err) {
        if (initial) setError(err);
      } else {
        setPayload(data);
        setError(null);
      }
      setLoading(false);
    },
    [orgSlug, tournamentSlug],
  );

  useEffect(() => {
    // Same fetch-on-mount + poll shape as LiveResultsPage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(true);
    const poll = setInterval(() => void load(false), REFRESH_MS);
    return () => clearInterval(poll);
  }, [load]);

  const events = useMemo(() => {
    const list = payload?.events ?? [];
    return [...list].sort(
      (a, b) =>
        (a.schedule_order ?? Number.MAX_SAFE_INTEGER) - (b.schedule_order ?? Number.MAX_SAFE_INTEGER) ||
        (a.scheduled_start_at ?? "").localeCompare(b.scheduled_start_at ?? "") ||
        a.name.localeCompare(b.name),
    );
  }, [payload]);

  // Fall back to the first bracket when the URL names none (or a stale one).
  const selected = events.find((e) => e.id === selectedEventId) ?? events[0] ?? null;

  if (loading) return <div style={{ color: inkMuted, fontSize: 14 }}>Loading brackets…</div>;
  if (error) return <div style={{ color: courtRed, fontSize: 14 }}>{error}</div>;
  if (!payload || events.length === 0) {
    return (
      <div style={emptyBox}>No brackets yet — standings and scores appear here once play starts.</div>
    );
  }

  return (
    <div style={{ fontFamily: bodyFontStack, color: ink }}>
      {/* Bracket picker */}
      <div role="list" aria-label="Brackets" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        {events.map((e) => {
          const active = selected?.id === e.id;
          return (
            <button
              key={e.id}
              type="button"
              role="listitem"
              aria-pressed={active}
              onClick={() => onSelectEvent(e.id)}
              style={{ ...chip, ...(active ? chipActive : null) }}
            >
              {e.name}
            </button>
          );
        })}
      </div>

      {selected && <BracketDetail key={selected.id} event={selected} payload={payload} />}
    </div>
  );
}

function BracketDetail({ event, payload }: { event: PublicEvent; payload: PublicResultsPayload }) {
  const view = useMemo(() => {
    const regs = payload.registrations.filter((r) => r.event_id === event.id);
    const teams = buildTeams(regs, payload.players);
    const byReg = teamByAnyRegId(teams);
    const matches = payload.matches.filter((m) => m.event_id === event.id);
    const rr = matches.filter((m) => m.stage === "round_robin");
    const playoff = matches.filter((m) => m.stage === "playoff");
    const standings = computeStandings(teams, rr);
    const multiPool = event.pool_count > 1;
    const groups = groupStandingsByPool(standings, multiPool);
    const medals = computeMedals(event as unknown as Parameters<typeof computeMedals>[0], playoff, byReg);

    // Pool-play rounds, per pool: a match belongs to its teams' pool.
    const poolOf = (m: PublicMatch): number | null => {
      for (const regId of [m.team_a_reg_id, m.team_b_reg_id]) {
        const p = regId ? byReg.get(regId)?.poolIndex : null;
        if (p != null) return p;
      }
      return null;
    };
    const rrByPool = new Map<number | null, PublicMatch[]>();
    for (const m of rr) {
      const key = multiPool ? poolOf(m) : null;
      const arr = rrByPool.get(key) ?? [];
      arr.push(m);
      rrByPool.set(key, arr);
    }
    const poolRounds = [...rrByPool.entries()]
      .sort(([a], [b]) => (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER))
      .map(([pool, ms]) => ({ pool, rounds: packRoundRobinRounds(ms) }));

    // Playoff groups: by bracket + round for double elim, by round otherwise.
    const isDE = event.bracket_type === "double_elim";
    const groupMap = new Map<string, PublicMatch[]>();
    for (const m of playoff) {
      const key = isDE ? `${m.bracket ?? "winners"}:${m.round}` : `r:${m.round}`;
      const arr = groupMap.get(key) ?? [];
      arr.push(m);
      groupMap.set(key, arr);
    }
    const order: Record<string, number> = { winners: 0, consolation: 1, final: 2, r: 0 };
    const playoffGroups = [...groupMap.entries()]
      .sort(([a], [b]) => {
        const [ba, ra] = a.split(":");
        const [bb, rb] = b.split(":");
        return (order[ba] ?? 0) - (order[bb] ?? 0) || Number(ra) - Number(rb);
      })
      .map(([key, rows]) => {
        const [b, r] = key.split(":");
        const sorted = [...rows].sort((x, y) => x.position - y.position);
        let title: string;
        if (!isDE) {
          title = playoffRoundName(Number(r), event.playoff_rounds, sorted.length);
        } else if (sorted.length === 1 && sorted[0].label) {
          title = sorted[0].label;
        } else {
          title = `${b === "final" ? "Final" : b === "winners" ? "Winners bracket" : "Consolation bracket"} · round ${r}`;
        }
        // Per-game caption ("Gold Medal Final", "Semifinal 2") when the box
        // holds more than one game, so the bronze game isn't mistaken for gold.
        const captions = sorted.length > 1 ? sorted.map((m) => (isDE ? m.label : playoffStageLabel(m, playoff, event)) ?? null) : sorted.map(() => null);
        return { key, title, rows: sorted, captions };
      });

    const played = matches.filter((m) => m.status === "completed").length;
    const live = matches.filter((m) => m.status === "in_progress").length;
    return { teams, byReg, groups, medals, poolRounds, playoffGroups, multiPool, played, total: matches.length, live, rrCount: rr.length };
  }, [event, payload]);

  const labelFor = (regId: string | null): string =>
    (regId && view.byReg.get(regId)?.label) || "TBD";

  const formatLine = `${capitalize(event.gender)} ${event.format}${
    view.multiPool ? ` · ${event.pool_count} pools` : ""
  }${event.teams_advancing_to_playoff > 0 ? ` · top ${event.teams_advancing_to_playoff} to playoffs` : ""}`;

  const phase =
    view.medals.some((m) => m.place === "gold") ? "Final" : view.played > 0 || view.live > 0 ? "In progress" : "Not started";

  return (
    <section style={card} aria-label={event.name}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 18, fontFamily: headingFontStack, letterSpacing: "0.02em", overflowWrap: "anywhere" }}>
            {event.name}
          </h3>
          <div style={{ fontSize: 12.5, color: inkSoft, marginTop: 2 }}>{formatLine}</div>
        </div>
        <div style={{ fontSize: 12, color: inkMuted, fontFamily: monoFontStack, whiteSpace: "nowrap" }}>
          {phase} · {view.played} of {view.total} games
          {view.live > 0 && <span style={{ color: courtRed }}> · {view.live} on court</span>}
        </div>
      </div>

      {view.total === 0 ? (
        <p style={{ color: inkMuted, fontSize: 14, margin: "14px 0 0" }}>
          {view.teams.length} {view.teams.length === 1 ? "team" : "teams"} registered — games haven't been drawn yet.
        </p>
      ) : (
        <>
          {view.medals.length > 0 && <Podium medals={view.medals} />}

          {/* Standings */}
          {view.rrCount > 0 && (
            <div style={{ marginTop: 16 }}>
              <h4 style={h4}>Standings</h4>
              <div style={{ display: "grid", gap: 14 }}>
                {view.groups.map((g) => (
                  <div key={g.pool ?? "all"}>
                    {view.multiPool && <div style={poolHead}>{poolLabel(g.pool)}</div>}
                    <StandingsTable
                      rows={g.rows}
                      highlightTop={!view.multiPool && event.teams_advancing_to_playoff > 0 ? event.teams_advancing_to_playoff : undefined}
                    />
                  </div>
                ))}
              </div>
              {!view.multiPool && event.teams_advancing_to_playoff > 0 && (
                <div style={{ fontSize: 11.5, color: inkMuted, marginTop: 6 }}>
                  Shaded rows are in playoff position. Ties break on head-to-head, then point differential.
                </div>
              )}
            </div>
          )}

          {/* Pool play, round by round */}
          {view.poolRounds.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <h4 style={h4}>Pool play</h4>
              <div style={{ display: "grid", gap: 12 }}>
                {view.poolRounds.map(({ pool, rounds }) => (
                  <div key={pool ?? "all"}>
                    {view.multiPool && <div style={poolHead}>{poolLabel(pool)}</div>}
                    <div style={roundGrid}>
                      {rounds.map((ms, i) => (
                        <div key={i} style={roundBox}>
                          <div style={roundTitle}>Round {i + 1}</div>
                          {ms.map((m) => (
                            <MatchLine key={m.id} m={m} labelFor={labelFor} />
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Playoffs / medal games */}
          {view.playoffGroups.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <h4 style={h4}>Playoffs</h4>
              <div style={roundGrid}>
                {view.playoffGroups.map((g) => (
                  <div key={g.key} style={roundBox}>
                    <div style={roundTitle}>{g.title}</div>
                    {g.rows.map((m, i) => (
                      <MatchLine key={m.id} m={m} labelFor={labelFor} caption={g.captions[i]} />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// One game: "A v B" with the score once submitted, the court while it's on,
// a dash while it waits. Winner in bold.
function MatchLine({
  m,
  labelFor,
  caption,
}: {
  m: PublicMatch;
  labelFor: (regId: string | null) => string;
  caption?: string | null;
}) {
  const done = m.status === "completed";
  const live = m.status === "in_progress";
  const aWon = done && m.winner_reg_id != null && m.winner_reg_id === m.team_a_reg_id;
  const bWon = done && m.winner_reg_id != null && m.winner_reg_id === m.team_b_reg_id;
  let right: string;
  if (done) right = `${m.team_a_score ?? "–"}–${m.team_b_score ?? "–"}`;
  else if (live) right = m.court ? `On ${m.court}` : "Playing";
  else if (m.if_necessary) right = "if needed";
  else right = "—";
  return (
    <div style={matchRow}>
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        {caption && <span style={{ display: "block", fontSize: 10.5, color: inkMuted, letterSpacing: 0.3 }}>{caption}</span>}
        <span style={{ fontWeight: aWon ? 700 : 400 }}>{labelFor(m.team_a_reg_id)}</span>
        <span style={{ color: inkMuted }}> v </span>
        <span style={{ fontWeight: bWon ? 700 : 400 }}>{labelFor(m.team_b_reg_id)}</span>
      </span>
      <span
        style={{
          color: done ? ink : live ? courtRed : inkMuted,
          whiteSpace: "nowrap",
          fontVariantNumeric: "tabular-nums",
          fontWeight: done ? 600 : 400,
        }}
      >
        {right}
      </span>
    </div>
  );
}

function Podium({ medals }: { medals: Medal[] }) {
  const order: Medal["place"][] = ["gold", "silver", "bronze"];
  const byPlace = new Map(medals.map((m) => [m.place, m]));
  const palette: Record<Medal["place"], { bg: string; fg: string; label: string }> = {
    gold: { bg: "#fbf3d0", fg: "#8a6500", label: "1st" },
    silver: { bg: "#eceef1", fg: "#5b6672", label: "2nd" },
    bronze: { bg: "#f4e6da", fg: "#8a5a2b", label: "3rd" },
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 14 }}>
      {order
        .filter((p) => byPlace.has(p))
        .map((p) => {
          const c = palette[p];
          return (
            <div key={p} style={{ padding: "10px 12px", background: c.bg, borderRadius: 8, border: `1px solid ${ruleSoft}` }}>
              <div style={{ fontSize: 10, color: c.fg, textTransform: "uppercase", letterSpacing: 1, fontWeight: 700, fontFamily: monoFontStack, marginBottom: 3 }}>
                {c.label}
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: ink, overflowWrap: "anywhere" }}>{byPlace.get(p)!.team.label}</div>
            </div>
          );
        })}
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}


const card: CSSProperties = {
  padding: 16,
  background: "var(--surface)",
  border: `1px solid ${rule}`,
  borderRadius: 8,
};

const emptyBox: CSSProperties = {
  padding: 20,
  background: "var(--surface)",
  border: `1px solid ${rule}`,
  borderRadius: 8,
  color: inkMuted,
  fontSize: 14,
};

const chip: CSSProperties = {
  padding: "10px 14px",
  minHeight: 44,
  borderRadius: 999,
  border: `1px solid ${rule}`,
  background: "#fff",
  color: ink,
  fontFamily: bodyFontStack,
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  textAlign: "left",
};

const chipActive: CSSProperties = {
  background: ink,
  color: cream,
  borderColor: ink,
};

const h4: CSSProperties = {
  margin: "0 0 8px",
  fontSize: 13,
  fontFamily: headingFontStack,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: inkSoft,
};

const poolHead: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  color: inkMuted,
  fontFamily: monoFontStack,
  margin: "0 0 6px",
};

const roundGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
  gap: 10,
};

const roundBox: CSSProperties = {
  border: `1px solid ${ruleSoft}`,
  borderRadius: 6,
  padding: "8px 10px",
  minWidth: 0,
};

const roundTitle: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: inkMuted,
  marginBottom: 4,
  fontFamily: monoFontStack,
};

const matchRow: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  padding: "3px 0",
};
