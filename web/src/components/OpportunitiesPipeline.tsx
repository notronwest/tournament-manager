import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../supabase";
import type { Database } from "../types/supabase";
import {
  deriveStage,
  STAGE_ORDER,
  STAGE_LABELS,
  STAGE_COLORS,
  STAGE_HINT,
  DEFAULT_VISIBLE_STAGES,
  type PipelineStage,
} from "../lib/quotePipeline";
import {
  bodyFontStack,
  ink,
  inkMuted,
  inkSoft,
  rule,
  ruleSoft,
  panelMutedStyle,
  statusPanelStyle,
} from "../lib/publicTheme";

type QuoteRow = Database["public"]["Tables"]["quotes"]["Row"];
type CustomerRow = Database["public"]["Tables"]["quote_customers"]["Row"];
type RevisionRow = Database["public"]["Tables"]["quote_revisions"]["Row"];

type QuoteWithContext = QuoteRow & {
  quote_customers: Pick<CustomerRow, "id" | "name" | "email" | "org_name"> | null;
  quote_revisions: Pick<RevisionRow, "subtotal_cents" | "estimated_net_cents" | "is_current" | "created_by">[];
};

type Row = QuoteWithContext & { stage: PipelineStage; customerUpdated: boolean };

function formatDollars(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? "-" : ""}$${(abs / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function currentRevision(revisions: QuoteWithContext["quote_revisions"]) {
  return revisions.find((r) => r.is_current) ?? revisions[0] ?? null;
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// The opportunities pipeline: every quote as an opportunity, tagged with its
// derived lifecycle stage, with multi-select show/hide filtering. Self-contained
// (fetches its own data) so it can live on the admin home AND the quotes page.
// `limit` caps the rows (home embed); omit for the full list.
export default function OpportunitiesPipeline({ limit }: { limit?: number }) {
  const [quotes, setQuotes] = useState<QuoteWithContext[]>([]);
  const [signedByQuote, setSignedByQuote] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [visible, setVisible] = useState<Set<PipelineStage>>(
    () => new Set(DEFAULT_VISIBLE_STAGES),
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [q, c] = await Promise.all([
        supabase
          .from("quotes")
          .select(`
            *,
            quote_customers (id, name, email, org_name),
            quote_revisions (subtotal_cents, estimated_net_cents, is_current, created_by)
          `)
          .order("created_at", { ascending: false }),
        supabase.from("contracts").select("quote_id, status"),
      ]);
      if (cancelled) return;
      setLoading(false);
      if (q.error) { setLoadError(q.error.message); return; }
      setQuotes((q.data ?? []) as QuoteWithContext[]);
      // A quote is "signed" if any of its contracts is signed_offline.
      const signed = new Set<string>();
      for (const row of (c.data ?? []) as { quote_id: string; status: string }[]) {
        if (row.status === "signed_offline") signed.add(row.quote_id);
      }
      setSignedByQuote(signed);
    })();
    return () => { cancelled = true; };
  }, []);

  const rows: Row[] = useMemo(() => {
    const withStage = quotes.map((q) => ({
      ...q,
      stage: deriveStage(q.status, signedByQuote.has(q.id)),
      customerUpdated: q.quote_revisions.some((r) => r.created_by === "customer"),
    }));
    return withStage.sort((a, b) => {
      const ai = STAGE_ORDER.indexOf(a.stage);
      const bi = STAGE_ORDER.indexOf(b.stage);
      if (ai !== bi) return ai - bi;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [quotes, signedByQuote]);

  const counts = useMemo(() => {
    const m = new Map<PipelineStage, number>();
    for (const r of rows) m.set(r.stage, (m.get(r.stage) ?? 0) + 1);
    return m;
  }, [rows]);

  const shown = rows.filter((r) => visible.has(r.stage));
  const capped = limit ? shown.slice(0, limit) : shown;

  const toggle = (s: PipelineStage) =>
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  if (loading) {
    return <div style={{ color: inkSoft, fontSize: 14, fontFamily: bodyFontStack }}>Loading opportunities…</div>;
  }
  if (loadError) {
    return <div style={statusPanelStyle("danger")}>{loadError}</div>;
  }

  return (
    <div style={{ fontFamily: bodyFontStack }}>
      {/* Show/hide filter — toggle each stage on or off */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        {STAGE_ORDER.map((s) => {
          const on = visible.has(s);
          const n = counts.get(s) ?? 0;
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggle(s)}
              title={on ? `Hide ${STAGE_LABELS[s]}` : `Show ${STAGE_LABELS[s]}`}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "4px 11px", borderRadius: 999, cursor: "pointer",
                fontFamily: bodyFontStack, fontSize: 12, fontWeight: 600,
                border: `1px solid ${on ? STAGE_COLORS[s] : rule}`,
                background: on ? `${STAGE_COLORS[s]}14` : "transparent",
                color: on ? STAGE_COLORS[s] : inkMuted,
                opacity: on ? 1 : 0.7,
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: 999, background: on ? STAGE_COLORS[s] : inkMuted }} />
              {STAGE_LABELS[s]}
              <span style={{ opacity: 0.75 }}>{n}</span>
            </button>
          );
        })}
      </div>

      {capped.length === 0 ? (
        <div style={{ ...panelMutedStyle, textAlign: "center", padding: 32 }}>
          <p style={{ color: inkSoft, fontSize: 14, margin: 0 }}>
            {rows.length === 0 ? "No opportunities yet." : "Nothing in the selected stages."}
          </p>
        </div>
      ) : (
        <div style={{ border: `1px solid ${rule}`, borderRadius: 10, overflow: "hidden" }}>
          {capped.map((r, i) => {
            const rev = currentRevision(r.quote_revisions);
            const amount = rev ? (rev.estimated_net_cents ?? rev.subtotal_cents) : null;
            return (
              <Link
                key={r.id}
                to={`/admin/quotes/${r.id}`}
                style={{
                  display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between",
                  textDecoration: "none", padding: "13px 16px", color: ink,
                  borderTop: i > 0 ? `1px solid ${ruleSoft}` : "none", background: "#fff",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <StageBadge stage={r.stage} />
                    <span style={{ fontWeight: 600, fontSize: 14 }}>
                      {r.quote_customers?.name || r.quote_customers?.org_name || "Unknown customer"}
                    </span>
                    {r.customerUpdated && (
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#b8860b", background: "#fef6d6", padding: "1px 7px", borderRadius: 999 }}>
                        customer replied
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 13, color: inkSoft, marginTop: 3 }}>
                    {r.event_name || "Untitled event"}
                    {r.event_dates ? ` · ${r.event_dates}` : ""}
                    {r.quote_customers?.org_name && r.quote_customers?.name ? ` · ${r.quote_customers.org_name}` : ""}
                  </div>
                  <div style={{ fontSize: 12, color: inkMuted, marginTop: 3 }}>{STAGE_HINT[r.stage]}</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  {amount != null && <div style={{ fontWeight: 600, fontSize: 14 }}>{formatDollars(amount)}</div>}
                  <div style={{ fontSize: 12, color: inkMuted, marginTop: 3 }}>{fmtDate(r.created_at)}</div>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {limit != null && shown.length > limit && (
        <div style={{ marginTop: 10, textAlign: "right" }}>
          <Link to="/admin/quotes" style={{ fontSize: 13, color: STAGE_COLORS.accepted, fontWeight: 600, textDecoration: "none" }}>
            View all {shown.length} opportunities →
          </Link>
        </div>
      )}
    </div>
  );
}

function StageBadge({ stage }: { stage: PipelineStage }) {
  return (
    <span
      style={{
        fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 999,
        background: `${STAGE_COLORS[stage]}18`, color: STAGE_COLORS[stage],
        textTransform: "uppercase", letterSpacing: "0.04em",
      } as CSSProperties}
    >
      {STAGE_LABELS[stage]}
    </span>
  );
}
