import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import {
  parsePbFile,
  parseAttendees,
  resolveColumns,
  unmappedColumns,
  type ParsedFile,
  type ParsedAttendees,
} from "../../lib/pbImport";
import { buildPlan, planTotals, type ImportPlan } from "../../lib/pbReconcile";
import {
  fetchExistingPbState,
  runPbImport,
  type PbImportSummary,
} from "../../lib/pbRegistrationImport";
import {
  ink,
  inkSoft,
  inkMuted,
  courtGreen,
  courtRed,
  pageH1Style,
  panelStyle,
  panelMutedStyle,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  ctaSecondaryStyle,
  statusPanelStyle,
  bodyFontStack,
  breadcrumbLinkStyle,
} from "../../lib/publicTheme";

// Import an org's PickleballBrackets.com registrant export into this tournament
// (#981 / D-0045). Upload the "Export Player w/ Events (Flat File)" → preview the
// idempotent plan (divisions, players, DUPR, partners, adds/drops) → import.
type Tournament = { id: string; name: string; slug: string };

export default function PbImportPage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [parsedFile, setParsedFile] = useState<ParsedFile | null>(null);
  const [attendees, setAttendees] = useState<ParsedAttendees | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<PbImportSummary | null>(null);

  useEffect(() => {
    if (!org || !tournamentSlug) return;
    void (async () => {
      const { data, error: tErr } = await supabase
        .from("tournaments")
        .select("id, name, slug")
        .eq("organization_id", org.id)
        .eq("slug", tournamentSlug)
        .is("deleted_at", null)
        .maybeSingle();
      if (tErr) setLoadError(tErr.message);
      else if (!data) setLoadError("Tournament not found.");
      else setTournament(data as Tournament);
    })();
  }, [org, tournamentSlug]);

  const unmapped = useMemo(() => {
    if (!parsedFile) return [];
    return unmappedColumns(parsedFile.headers, resolveColumns(parsedFile.headers));
  }, [parsedFile]);

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file || !tournament) return;
      setError(null);
      setSummary(null);
      setPlan(null);
      setParsing(true);
      try {
        const pf = await parsePbFile(file);
        if (pf.headers.length === 0 || pf.rows.length === 0) {
          setError("That file looks empty — no header row or data rows found.");
          return;
        }
        setParsedFile(pf);
        const parsed = parseAttendees(pf);
        setAttendees(parsed);
        const existing = await fetchExistingPbState(tournament.id);
        setPlan(buildPlan(parsed, existing));
      } catch (e) {
        setError((e as { message?: string })?.message ?? "Couldn't read that file.");
      } finally {
        setParsing(false);
      }
    },
    [tournament],
  );

  const doImport = useCallback(async () => {
    if (!org || !tournament || !attendees) return;
    setImporting(true);
    setError(null);
    try {
      const res = await runPbImport({
        organizationId: org.id,
        tournamentId: tournament.id,
        attendees: attendees.attendees,
      });
      setSummary(res);
      // Re-read state so a follow-up preview reflects what was written.
      const existing = await fetchExistingPbState(tournament.id);
      setPlan(buildPlan(attendees, existing));
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Import failed.");
    } finally {
      setImporting(false);
    }
  }, [org, tournament, attendees]);

  const totals = plan ? planTotals(plan) : null;
  const duprCoverage = useMemo(() => {
    if (!plan) return { withDupr: 0, total: 0 };
    const withDupr = plan.players.filter(
      (p) => p.duprDoubles !== null || p.duprSingles !== null,
    ).length;
    return { withDupr, total: plan.players.length };
  }, [plan]);

  if (!org) return null;

  return (
    <div style={{ padding: "24px 32px", maxWidth: 820, fontFamily: bodyFontStack, color: ink }}>
      <Link
        to={`/admin/${org.slug}/tournaments/${tournamentSlug}`}
        style={breadcrumbLinkStyle}
      >
        ← {tournament?.name ?? "Tournament"}
      </Link>
      <h1 style={pageH1Style}>Import from PickleballBrackets</h1>
      <p style={{ fontSize: 14, color: inkSoft, lineHeight: 1.6, maxWidth: 640 }}>
        Registration and division setup happen on PickleballBrackets.com. When
        registration closes, export <strong>Player w/ Events (Flat File)</strong>{" "}
        from the PB.com Attendees page and upload it here. Bert &amp; Erne creates
        the divisions, players (with DUPR), and doubles partnerships — then you run
        the event here. Re-run any time; it reconciles instead of duplicating.
      </p>

      {loadError && (
        <div style={{ ...statusPanelStyle("danger"), margin: "12px 0" }} role="alert">
          {loadError}
        </div>
      )}

      <div style={{ ...panelStyle, marginTop: 16 }}>
        <input
          type="file"
          accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => void onFile(e.target.files?.[0])}
          disabled={!tournament || parsing || importing}
          style={{ fontSize: 14 }}
        />
        {parsing && <div style={{ color: inkMuted, fontSize: 13, marginTop: 8 }}>Reading file…</div>}
      </div>

      {error && (
        <div style={{ ...statusPanelStyle("danger"), margin: "12px 0" }} role="alert">
          {error}
        </div>
      )}

      {plan && totals && (
        <div style={{ ...panelMutedStyle, marginTop: 16 }}>
          <h2 style={{ fontSize: 17, margin: "0 0 12px" }}>Preview</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
              gap: 10,
              marginBottom: 12,
            }}
          >
            <Stat label="Attendees" value={attendees?.attendees.length ?? 0} />
            <Stat label="Players" value={totals.players} />
            <Stat label="Divisions" value={totals.divisions} sub={`${totals.divisionsNew} new`} />
            <Stat label="Entries to add" value={totals.add} accent={courtGreen} />
            <Stat label="Unchanged" value={totals.unchanged} />
            <Stat label="Doubles teams" value={totals.pairs} />
            <Stat
              label="DUPR on file"
              value={`${duprCoverage.withDupr}/${duprCoverage.total}`}
            />
            <Stat label="Flagged drops" value={totals.drop} accent={totals.drop ? courtRed : undefined} />
          </div>

          {/* Divisions detected */}
          <Section title={`Divisions (${totals.divisions})`}>
            <ul style={listStyle}>
              {plan.divisionsToCreate.map((d) => (
                <li key={d.key} style={liStyle}>
                  <span style={{ color: courtGreen, fontWeight: 600 }}>new</span> {d.raw}
                  <DivMeta d={d} />
                </li>
              ))}
              {plan.divisionsExisting.map((k) => (
                <li key={k} style={liStyle}>
                  <span style={{ color: inkMuted }}>exists</span> {k}
                </li>
              ))}
            </ul>
          </Section>

          {/* Drops */}
          {plan.toDrop.length > 0 && (
            <div style={{ ...statusPanelStyle("warn"), margin: "8px 0" }}>
              <strong>{plan.toDrop.length}</strong> entr
              {plan.toDrop.length === 1 ? "y is" : "ies are"} in Bert &amp; Erne but
              no longer in this export. They are <strong>not</strong> removed — review
              them manually on the Attendees page.
            </div>
          )}

          {/* Unmapped columns */}
          {unmapped.length > 0 && (
            <Section title={`Unmapped columns (${unmapped.length})`}>
              <p style={{ fontSize: 12, color: inkMuted, margin: "0 0 6px" }}>
                Columns the import ignores (most alternate rating systems fall here
                by design). Only DUPR is imported for seeding.
              </p>
              <div style={{ fontSize: 12, color: inkSoft }}>{unmapped.join(", ")}</div>
            </Section>
          )}

          {/* Warnings */}
          {plan.warnings.length > 0 && (
            <Section title={`Warnings (${plan.warnings.length})`}>
              <ul style={listStyle}>
                {plan.warnings.map((w, i) => (
                  <li key={i} style={{ ...liStyle, color: courtRed }}>{w}</li>
                ))}
              </ul>
            </Section>
          )}
          {plan.skippedRows > 0 && (
            <div style={{ fontSize: 12, color: inkMuted, marginTop: 6 }}>
              {plan.skippedRows} row{plan.skippedRows === 1 ? "" : "s"} skipped (no usable name).
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button
              style={totals.add > 0 || totals.divisionsNew > 0 ? ctaPrimaryStyle : ctaPrimaryDisabledStyle}
              disabled={importing || (totals.add === 0 && totals.divisionsNew === 0)}
              onClick={() => void doImport()}
            >
              {importing
                ? "Importing…"
                : `Import ${totals.add} entr${totals.add === 1 ? "y" : "ies"}`}
            </button>
          </div>
        </div>
      )}

      {summary && (
        <div style={{ ...statusPanelStyle("success"), marginTop: 16 }}>
          <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Import complete</h2>
          <ul style={{ ...listStyle, color: ink }}>
            <li style={liStyle}>
              Divisions: {summary.divisions.created} created, {summary.divisions.matched} matched
            </li>
            <li style={liStyle}>
              Players: {summary.players.created} created, {summary.players.matched} matched,{" "}
              {summary.players.duprRefreshed} DUPR refreshed
            </li>
            <li style={liStyle}>
              Entries: {summary.entries.added} added, {summary.entries.unchanged} unchanged
            </li>
            <li style={liStyle}>Doubles teams paired: {summary.partnersPaired}</li>
            {summary.drops.length > 0 && (
              <li style={{ ...liStyle, color: courtRed }}>
                {summary.drops.length} entry(ies) flagged as dropped (not removed)
              </li>
            )}
          </ul>
          {summary.warnings && summary.warnings.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer", fontSize: 13 }}>
                {summary.warnings.length} warning(s)
              </summary>
              <ul style={listStyle}>
                {summary.warnings.map((w, i) => (
                  <li key={i} style={liStyle}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          {summary.errors && summary.errors.length > 0 && (
            <details style={{ marginTop: 8 }} open>
              <summary style={{ cursor: "pointer", fontSize: 13, color: courtRed }}>
                {summary.errors.length} error(s)
              </summary>
              <ul style={listStyle}>
                {summary.errors.map((w, i) => (
                  <li key={i} style={{ ...liStyle, color: courtRed }}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          <Link
            to={`/admin/${org.slug}/tournaments/${tournamentSlug}/attendees`}
            style={{ ...ctaSecondaryStyle, display: "inline-block", marginTop: 12, textDecoration: "none" }}
          >
            View attendees →
          </Link>
        </div>
      )}
    </div>
  );
}

function DivMeta({ d }: { d: ImportPlan["divisionsToCreate"][number] }) {
  const bits: string[] = [];
  if (d.gender) bits.push(d.gender);
  if (d.format) bits.push(d.format);
  if (d.bracketType === "skill" && d.low !== null) bits.push(`${d.low}–${d.high ?? ""}`);
  if (d.bracketType === "age" && d.low !== null) bits.push(`age ${d.low}–${d.high ?? ""}`);
  if (bits.length === 0) return null;
  return <span style={{ color: inkMuted, fontSize: 12 }}> — {bits.join(" · ")}</span>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: inkSoft, marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
}) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e6e8ec", borderRadius: 8, padding: "8px 10px" }}>
      <div style={{ fontSize: 11, color: inkMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent ?? ink }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: inkMuted }}>{sub}</div>}
    </div>
  );
}

const listStyle: React.CSSProperties = { margin: 0, paddingLeft: 18, fontSize: 13, color: inkSoft };
const liStyle: React.CSSProperties = { margin: "2px 0", lineHeight: 1.5 };
