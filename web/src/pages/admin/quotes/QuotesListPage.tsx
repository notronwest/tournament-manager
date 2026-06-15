import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../../supabase";
import { usePlatformAdmin } from "../../../hooks/usePlatformAdmin";
import {
  bodyFontStack,
  breadcrumbLinkStyle,
  courtBlue,
  courtGreen,
  courtRed,
  ink,
  inkMuted,
  inkSoft,
  pageH1Style,
  panelMutedStyle,
  rule,
  ruleSoft,
  statusPanelStyle,
} from "../../../lib/publicTheme";
import type { Database } from "../../../types/supabase";

type QuoteStatus = Database["public"]["Enums"]["quote_status"];
type QuoteRow = Database["public"]["Tables"]["quotes"]["Row"];
type CustomerRow = Database["public"]["Tables"]["quote_customers"]["Row"];
type RevisionRow = Database["public"]["Tables"]["quote_revisions"]["Row"];

type QuoteWithContext = QuoteRow & {
  quote_customers: Pick<CustomerRow, "id" | "name" | "email" | "org_name"> | null;
  quote_revisions: Pick<RevisionRow, "subtotal_cents" | "estimated_net_cents" | "is_current">[];
};

const STATUS_LABELS: Record<QuoteStatus, string> = {
  submitted: "Submitted",
  draft: "Draft",
  quoted: "Quoted",
  accepted: "Accepted",
  declined: "Declined",
};

const STATUS_COLORS: Record<QuoteStatus, string> = {
  submitted: courtBlue,
  draft: inkMuted,
  quoted: courtGreen,
  accepted: courtGreen,
  declined: courtRed,
};

const STATUS_ORDER: QuoteStatus[] = ["submitted", "draft", "quoted", "accepted", "declined"];

function formatDollars(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? "-" : ""}$${(abs / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function currentRevision(revisions: QuoteWithContext["quote_revisions"]) {
  return revisions.find((r) => r.is_current) ?? revisions[0] ?? null;
}

export default function QuotesListPage() {
  const isPlatformAdmin = usePlatformAdmin();
  const [quotes, setQuotes] = useState<QuoteWithContext[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<QuoteStatus | "all">("all");

  useEffect(() => {
    if (!isPlatformAdmin) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("quotes")
        .select(`
          *,
          quote_customers (id, name, email, org_name),
          quote_revisions (subtotal_cents, estimated_net_cents, is_current)
        `)
        .order("created_at", { ascending: false });
      if (cancelled) return;
      setLoading(false);
      if (error) { setLoadError(error.message); return; }
      setQuotes((data ?? []) as QuoteWithContext[]);
    })();
    return () => { cancelled = true; };
  }, [isPlatformAdmin]);

  if (isPlatformAdmin === null) {
    return <div style={{ padding: 24, color: inkSoft, fontSize: 14, fontFamily: bodyFontStack }}>Loading…</div>;
  }

  if (!isPlatformAdmin) {
    return (
      <main style={{ padding: 24, maxWidth: 600, margin: "0 auto", fontFamily: bodyFontStack }}>
        <h1 style={{ ...pageH1Style, fontSize: 20, marginTop: 0 }}>Access denied</h1>
        <p style={{ color: inkSoft, fontSize: 14 }}>This page is restricted to platform administrators.</p>
        <Link to="/admin" style={breadcrumbLinkStyle}>← Back to admin</Link>
      </main>
    );
  }

  // Sort: submitted first, then by created_at desc within each status group
  const sorted = [...quotes].sort((a, b) => {
    const ai = STATUS_ORDER.indexOf(a.status);
    const bi = STATUS_ORDER.indexOf(b.status);
    if (ai !== bi) return ai - bi;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  const filtered =
    filterStatus === "all" ? sorted : sorted.filter((q) => q.status === filterStatus);

  const submittedCount = quotes.filter((q) => q.status === "submitted").length;

  return (
    <main style={{ padding: "24px 24px 48px", maxWidth: 900, margin: "0 auto", fontFamily: bodyFontStack }}>
      <div style={{ marginBottom: 20 }}>
        <Link to="/admin" style={breadcrumbLinkStyle}>← Back to admin</Link>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ ...pageH1Style, fontSize: 24, marginTop: 0, marginBottom: 4 }}>Quotes</h1>
          {submittedCount > 0 && (
            <p style={{ fontSize: 13, color: courtBlue, margin: 0, fontWeight: 600 }}>
              {submittedCount} submitted proposal{submittedCount !== 1 ? "s" : ""} awaiting review
            </p>
          )}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Link
            to="/admin/quotes/catalog"
            style={{
              fontSize: 13,
              color: inkSoft,
              textDecoration: "none",
              padding: "6px 12px",
              border: `1px solid ${rule}`,
              borderRadius: 6,
            }}
          >
            Service catalog
          </Link>
          <Link
            to="/admin/quotes/new"
            style={{
              display: "inline-block",
              padding: "8px 16px",
              background: ink,
              color: "#fff",
              textDecoration: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            + Start a quote
          </Link>
        </div>
      </div>

      {/* Status filter */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {(["all", ...STATUS_ORDER] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            style={{
              padding: "5px 12px",
              borderRadius: 20,
              border: `1px solid ${filterStatus === s ? ink : rule}`,
              background: filterStatus === s ? ink : "transparent",
              color: filterStatus === s ? "#fff" : inkSoft,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: bodyFontStack,
            }}
          >
            {s === "all" ? "All" : STATUS_LABELS[s]}
            {s !== "all" && (
              <span style={{ marginLeft: 5, opacity: 0.7 }}>
                ({quotes.filter((q) => q.status === s).length})
              </span>
            )}
          </button>
        ))}
      </div>

      {loadError && (
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 20 }}>{loadError}</div>
      )}

      {loading ? (
        <div style={{ color: inkSoft, fontSize: 14 }}>Loading quotes…</div>
      ) : filtered.length === 0 ? (
        <div style={{ ...panelMutedStyle, textAlign: "center", padding: 40 }}>
          <p style={{ color: inkSoft, fontSize: 14, margin: 0 }}>
            {filterStatus === "all" ? "No quotes yet." : `No ${STATUS_LABELS[filterStatus].toLowerCase()} quotes.`}
          </p>
        </div>
      ) : (
        <div style={{ border: `1px solid ${rule}`, borderRadius: 10, overflow: "hidden" }}>
          {filtered.map((q, i) => {
            const rev = currentRevision(q.quote_revisions);
            const customer = q.quote_customers;
            return (
              <Link
                key={q.id}
                to={`/admin/quotes/${q.id}`}
                style={{
                  display: "block",
                  textDecoration: "none",
                  padding: "14px 18px",
                  borderTop: i > 0 ? `1px solid ${ruleSoft}` : "none",
                  background: "#fff",
                  color: ink,
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: STATUS_COLORS[q.status],
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                        }}
                      >
                        {STATUS_LABELS[q.status]}
                      </span>
                      <span style={{ fontSize: 11, color: inkMuted }}>·</span>
                      <span style={{ fontSize: 12, color: inkMuted }}>
                        {new Date(q.created_at).toLocaleDateString()}
                      </span>
                      {q.source === "admin" && (
                        <>
                          <span style={{ fontSize: 11, color: inkMuted }}>·</span>
                          <span style={{ fontSize: 11, color: inkMuted }}>admin-created</span>
                        </>
                      )}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: ink, marginBottom: 2 }}>
                      {q.event_name || <span style={{ color: inkMuted, fontStyle: "italic" }}>Untitled</span>}
                    </div>
                    <div style={{ fontSize: 13, color: inkSoft }}>
                      {customer
                        ? `${customer.name}${customer.org_name ? ` · ${customer.org_name}` : ""} · ${customer.email}`
                        : <span style={{ fontStyle: "italic" }}>No customer</span>}
                    </div>
                    {q.event_dates && (
                      <div style={{ fontSize: 12, color: inkMuted, marginTop: 2 }}>{q.event_dates}</div>
                    )}
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    {rev ? (
                      <>
                        <div style={{ fontSize: 14, fontWeight: 700, color: ink }}>
                          {formatDollars(rev.subtotal_cents)}
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: rev.estimated_net_cents >= 0 ? courtGreen : courtRed,
                            fontWeight: 600,
                          }}
                        >
                          net {formatDollars(rev.estimated_net_cents)}
                        </div>
                      </>
                    ) : (
                      <span style={{ fontSize: 12, color: inkMuted }}>No revision</span>
                    )}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
