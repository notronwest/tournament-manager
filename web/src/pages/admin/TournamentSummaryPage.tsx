import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { SPOT_HOLDING_STATUSES } from "../../lib/registrationStatus";
import type { Database } from "../../types/supabase";
import type { EventRegistration, Match, Player } from "../../lib/bracketTeams";
import {
  buildTournamentSummary,
  summaryAsText,
  type ReportHeader,
  type SummaryEvent,
  type TournamentSummary,
} from "../../lib/tournamentSummary";
import { TournamentSummaryReport } from "../../components/TournamentSummaryReport";
import { displayHeading, fieldLabel } from "./contactsUi";
import {
  ink,
  inkSoft,
  inkMuted,
  rule,
  bodyFontStack,
  ctaPrimaryStyle,
  ctaSecondaryStyle,
  inputStyle,
  statusPanelStyle,
} from "../../lib/publicTheme";

// End-of-tournament summary report — the "here's how it went" sheet the
// organizer sends the client: every bracket with its podium, headline
// numbers (players, teams, points, hours of play) and a handful of fun
// facts. Rendered from the tournament's own results; the organizer adds an
// optional note and prints / saves as PDF. Nothing here is persisted.

type TournamentRow = Database["public"]["Tables"]["tournaments"]["Row"] & {
  locations: {
    name: string | null;
    address: string | null;
    address_line2: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
  } | null;
};

const PAGE = 1000;

// supabase-js caps a select at 1000 rows; a big tournament can carry more
// matches (or registrations) than that, so page through in order.
async function fetchAll<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) return { rows, error: error.message };
    const chunk = data ?? [];
    rows.push(...chunk);
    if (chunk.length < PAGE) return { rows, error: null };
  }
}

function composeAddress(loc: NonNullable<TournamentRow["locations"]>): string | null {
  const parts: string[] = [];
  if (loc.address) parts.push(loc.address);
  if (loc.address_line2) parts.push(loc.address_line2);
  const stateZip =
    loc.state && loc.postal_code ? `${loc.state} ${loc.postal_code}` : (loc.state ?? loc.postal_code ?? null);
  const cityStateZip = [loc.city, stateZip].filter(Boolean).join(", ");
  if (cityStateZip) parts.push(cityStateZip);
  return parts.length > 0 ? parts.join(", ") : null;
}

export default function TournamentSummaryPage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();

  const [tournament, setTournament] = useState<TournamentRow | null>(null);
  const [events, setEvents] = useState<SummaryEvent[]>([]);
  const [regs, setRegs] = useState<EventRegistration[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!org || !tournamentSlug) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data: t, error: tErr } = await supabase
        .from("tournaments")
        .select("*, locations(name, address, address_line2, city, state, postal_code)")
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
      const tRow = t as unknown as TournamentRow;

      const { data: evs, error: evErr } = await supabase
        .from("events")
        .select("*")
        .eq("tournament_id", tRow.id)
        .is("deleted_at", null);
      if (cancelled) return;
      if (evErr) {
        setError(evErr.message);
        setLoading(false);
        return;
      }
      const eventRows = (evs ?? []) as SummaryEvent[];
      const eventIds = eventRows.map((e) => e.id);

      let regRows: EventRegistration[] = [];
      let matchRows: Match[] = [];
      if (eventIds.length > 0) {
        const [r, m] = await Promise.all([
          fetchAll<EventRegistration>((from, to) =>
            supabase
              .from("event_registrations")
              .select("*")
              .in("event_id", eventIds)
              .in("status", SPOT_HOLDING_STATUSES)
              .is("deleted_at", null)
              .order("id")
              .range(from, to),
          ),
          fetchAll<Match>((from, to) =>
            supabase
              .from("matches")
              .select("*")
              .in("event_id", eventIds)
              .order("id")
              .range(from, to),
          ),
        ]);
        if (cancelled) return;
        const firstErr = r.error ?? m.error;
        if (firstErr) {
          setError(firstErr);
          setLoading(false);
          return;
        }
        regRows = r.rows;
        matchRows = m.rows;
      }

      let playerRows: Player[] = [];
      const playerIds = Array.from(new Set(regRows.map((r) => r.player_id)));
      if (playerIds.length > 0) {
        const p = await fetchAll<Player>((from, to) =>
          supabase.from("players").select("*").in("id", playerIds).order("id").range(from, to),
        );
        if (cancelled) return;
        if (p.error) {
          setError(p.error);
          setLoading(false);
          return;
        }
        playerRows = p.rows;
      }

      setTournament(tRow);
      setEvents(eventRows);
      setRegs(regRows);
      setPlayers(playerRows);
      setMatches(matchRows);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [org, tournamentSlug]);

  const summary = useMemo<TournamentSummary | null>(
    () => (tournament ? buildTournamentSummary({ events, regs, players, matches }) : null),
    [tournament, events, regs, players, matches],
  );

  const header = useMemo<ReportHeader | null>(() => {
    if (!tournament || !org) return null;
    const loc = tournament.locations;
    return {
      tournamentName: tournament.name,
      orgName: org.name,
      startsAt: tournament.starts_at,
      endsAt: tournament.ends_at,
      venueName: loc?.name ?? tournament.location_name ?? null,
      venueAddress: (loc && composeAddress(loc)) ?? tournament.location_address ?? null,
    };
  }, [tournament, org]);

  const copyText = async () => {
    if (!summary || !header) return;
    const text = summaryAsText(header, summary, note);
    try {
      await navigator.clipboard.writeText(text);
      setCopied("Copied — paste it into your email.");
    } catch {
      setCopied("Couldn't access the clipboard. Use Print / Save as PDF instead.");
    }
    window.setTimeout(() => setCopied(null), 4000);
  };

  if (!org) return null;

  if (error) {
    return (
      <div style={{ fontFamily: bodyFontStack, color: ink }}>
        <div style={statusPanelStyle("danger")} role="alert">{error}</div>
      </div>
    );
  }
  if (loading || !tournament || !summary || !header) {
    return <div style={{ color: inkMuted }}>Building the summary…</div>;
  }

  const base = `/admin/${org.slug}/tournaments/${tournament.slug}`;
  const unscored = summary.headline.matchesTotal - summary.headline.matchesPlayed;
  const undecided = summary.events.filter((e) => e.podium.length === 0 && e.matchesTotal > 0);

  return (
    <div style={{ fontFamily: bodyFontStack, color: ink }}>
      <div className="no-print">
        <p style={{ margin: "0 0 6px", fontSize: 13 }}>
          <Link to={base} style={{ color: inkSoft }}>← {tournament.name}</Link>
        </p>
        <h1 style={displayHeading}>Summary report</h1>
        <p style={{ color: inkSoft, fontSize: 15, margin: "0 0 18px", maxWidth: 620, lineHeight: 1.55 }}>
          The end-of-tournament wrap-up for your client: every bracket and its
          winners, the headline numbers, and the fun facts. Add a note if you
          like, then save it as a PDF and send it along.
        </p>

        {(unscored > 0 || undecided.length > 0) && (
          <div style={{ ...statusPanelStyle("warn"), marginBottom: 16, fontSize: 13 }} role="status">
            <strong>This report isn't final yet.</strong>{" "}
            {unscored > 0 && (
              <>
                {unscored} {unscored === 1 ? "match has" : "matches have"} no score recorded.{" "}
              </>
            )}
            {undecided.length > 0 && (
              <>
                {undecided.length === 1 ? "One bracket has" : `${undecided.length} brackets have`} no podium yet:{" "}
                {undecided.map((e) => e.name).join(", ")}.
              </>
            )}{" "}
            Finish scoring in the{" "}
            <Link to={`${base}/courts`} style={{ color: "inherit" }}>court manager</Link>{" "}
            and this page updates on reload.
          </div>
        )}

        <div style={{ ...panelWrap, marginBottom: 16 }}>
          <label style={fieldLabel} htmlFor="summary-note">A note to the client (optional)</label>
          <textarea
            id="summary-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="Thanks for hosting us — what a weekend. A few numbers and every podium are below…"
            style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
          />
          <p style={{ fontSize: 12, color: inkSoft, margin: "6px 0 0", lineHeight: 1.5 }}>
            Prints at the top of the report. It lives only on this page — it isn't saved.
          </p>
        </div>

        <div style={actionRow}>
          <button type="button" onClick={() => window.print()} style={ctaPrimaryStyle}>
            Print / Save as PDF
          </button>
          <button type="button" onClick={copyText} style={ctaSecondaryStyle}>
            Copy as text
          </button>
          <span style={{ fontSize: 12.5, color: inkSoft }}>
            {copied ?? 'In the print dialog choose "Save as PDF" to get a file to attach.'}
          </span>
        </div>
      </div>

      <TournamentSummaryReport header={header} summary={summary} note={note} />

    </div>
  );
}

const panelWrap: CSSProperties = {
  border: `1px solid ${rule}`,
  borderRadius: 12,
  padding: 20,
  background: "#fff",
};

const actionRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  marginBottom: 20,
};
