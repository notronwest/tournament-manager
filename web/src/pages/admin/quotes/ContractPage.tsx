import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../../supabase";
import { usePlatformAdmin } from "../../../hooks/usePlatformAdmin";
import {
  bodyFontStack,
  breadcrumbLinkStyle,
  courtGreen,
  courtRed,
  ctaPrimaryStyle,
  ctaSecondaryStyle,
  headingFontStack,
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

type ContractStatus = Database["public"]["Enums"]["contract_status"];
type ContractRow = Database["public"]["Tables"]["contracts"]["Row"];
type QuoteRow = Database["public"]["Tables"]["quotes"]["Row"];
type CustomerRow = Database["public"]["Tables"]["quote_customers"]["Row"];
type RevisionRow = Database["public"]["Tables"]["quote_revisions"]["Row"];
type LineItemRow = Database["public"]["Tables"]["quote_line_items"]["Row"];

type ContractWithContext = ContractRow & {
  quotes: QuoteRow & {
    quote_customers: CustomerRow | null;
    quote_revisions: (RevisionRow & { quote_line_items: LineItemRow[] })[];
  };
};

export const CURRENT_TERMS_VERSION = "v1.0-2026";

export const STANDARD_TERMS = `
1. DEPOSIT. A non-refundable deposit of $200 is required to reserve the event date. The deposit will be applied toward the final balance.

2. TRAVEL. Travel within 50 miles of Lincoln, NH is provided at no additional charge. For events beyond 50 miles, the organizer agrees to cover: one (1) night lodging per tournament day, a per-diem of $50 per night, and mileage reimbursement at the current IRS standard mileage rate.

3. PAYMENT. Full payment is due within 15 days of the event date. Late payments may result in service suspension.

4. INDEPENDENT CONTRACTOR. White Mountain Pickleball Club (WMPC) operates as an independent contractor. This agreement does not create an employment relationship. WMPC reserves the right to use subcontractors at its sole discretion.

5. ENTIRE AGREEMENT. This contract, once signed by both parties, constitutes the entire agreement and must be executed before each event. Modifications require written consent from both parties.
`.trim();

function formatDollars(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? "-" : ""}$${(abs / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  signed_offline: "Signed (offline)",
};

const CONTRACT_STATUS_COLORS: Record<ContractStatus, string> = {
  draft: inkMuted,
  sent: "#1e6cd6",
  signed_offline: courtGreen,
};

export default function ContractPage() {
  const { quoteId, contractId } = useParams<{ quoteId: string; contractId: string }>();
  const isPlatformAdmin = usePlatformAdmin();
  const navigate = useNavigate();

  const [contract, setContract] = useState<ContractWithContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    if (!isPlatformAdmin || !contractId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("contracts")
        .select(`
          *,
          quotes (
            *,
            quote_customers (*),
            quote_revisions (
              *,
              quote_line_items (*)
            )
          )
        `)
        .eq("id", contractId)
        .single();
      if (cancelled) return;
      setLoading(false);
      if (error || !data) {
        setLoadError(error?.message ?? "Contract not found.");
        return;
      }
      setContract(data as ContractWithContext);
    })();
    return () => { cancelled = true; };
  }, [isPlatformAdmin, contractId]);

  async function handleStatusChange(newStatus: ContractStatus) {
    if (!contract) return;
    setUpdatingStatus(true);
    setStatusError(null);
    const { error } = await supabase
      .from("contracts")
      .update({ status: newStatus })
      .eq("id", contract.id);
    setUpdatingStatus(false);
    if (error) {
      setStatusError(error.message);
      return;
    }
    setContract((prev) => prev ? { ...prev, status: newStatus } : prev);
  }

  if (isPlatformAdmin === null || loading) {
    return <div style={{ padding: 24, color: inkSoft, fontSize: 14, fontFamily: bodyFontStack }}>Loading…</div>;
  }
  if (!isPlatformAdmin) {
    return (
      <main style={{ padding: 24, maxWidth: 600, margin: "0 auto", fontFamily: bodyFontStack }}>
        <h1 style={{ ...pageH1Style, fontSize: 20, marginTop: 0 }}>Access denied</h1>
        <Link to={`/admin/quotes/${quoteId}`} style={breadcrumbLinkStyle}>← Back to quote</Link>
      </main>
    );
  }
  if (loadError || !contract) {
    return (
      <main style={{ padding: 24, maxWidth: 600, margin: "0 auto", fontFamily: bodyFontStack }}>
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 16 }}>{loadError ?? "Contract not found."}</div>
        <Link to={`/admin/quotes/${quoteId}`} style={breadcrumbLinkStyle}>← Back to quote</Link>
      </main>
    );
  }

  const quote = contract.quotes;
  const customer = quote.quote_customers;
  const revision = quote.quote_revisions.find((r) => r.id === contract.revision_id)
    ?? quote.quote_revisions[0];
  const lineItems = revision?.quote_line_items ?? [];

  const subtotalCents = revision?.subtotal_cents ?? 0;
  const generatedDate = new Date(contract.generated_at).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });

  return (
    <main style={{ padding: "24px 24px 80px", maxWidth: 860, margin: "0 auto", fontFamily: bodyFontStack }}>
      {/* Navigation */}
      <div style={{ marginBottom: 16, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button
          onClick={() => navigate(`/admin/quotes/${quoteId}`)}
          style={{ ...breadcrumbLinkStyle, background: "none", border: "none", cursor: "pointer", padding: 0 }}
        >
          ← Back to quote
        </button>
      </div>

      {/* Page header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ ...pageH1Style, fontSize: 22, marginTop: 0, marginBottom: 4 }}>
            Contract
          </h1>
          <p style={{ fontSize: 13, color: inkMuted, margin: 0 }}>
            Generated {generatedDate} · Terms {contract.terms_version}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: CONTRACT_STATUS_COLORS[contract.status],
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            {CONTRACT_STATUS_LABELS[contract.status]}
          </span>
          <button
            onClick={() => window.print()}
            style={ctaPrimaryStyle}
          >
            Print / Save as PDF
          </button>
        </div>
      </div>

      {/* Status controls */}
      <div style={{ ...panelMutedStyle, marginBottom: 20 }}>
        <p style={{ fontSize: 12, fontWeight: 700, color: inkMuted, textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 10px" }}>
          Contract status
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(["draft", "sent", "signed_offline"] as ContractStatus[]).map((s) => (
            <button
              key={s}
              disabled={updatingStatus || contract.status === s}
              onClick={() => handleStatusChange(s)}
              style={{
                padding: "6px 14px",
                borderRadius: 20,
                border: `1px solid ${contract.status === s ? ink : rule}`,
                background: contract.status === s ? ink : "transparent",
                color: contract.status === s ? "#fff" : inkSoft,
                fontSize: 13,
                fontWeight: 600,
                cursor: contract.status === s ? "default" : "pointer",
                fontFamily: bodyFontStack,
                opacity: updatingStatus ? 0.6 : 1,
              }}
            >
              {CONTRACT_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        {statusError && (
          <p style={{ fontSize: 13, color: courtRed, margin: "8px 0 0" }}>{statusError}</p>
        )}
      </div>

      {/* ── Printable contract document ── */}
      <div
        id="contract-document"
        style={{
          border: `1px solid ${rule}`,
          borderRadius: 8,
          padding: "40px 48px",
          background: "#fff",
          fontFamily: bodyFontStack,
        }}
      >
        {/* Header */}
        <div style={{ borderBottom: `2px solid ${ink}`, paddingBottom: 20, marginBottom: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
            <div>
              <h2 style={{ fontFamily: headingFontStack, fontSize: 22, fontWeight: 700, color: ink, margin: "0 0 4px" }}>
                White Mountain Pickleball Club
              </h2>
              <p style={{ fontSize: 13, color: inkSoft, margin: 0, lineHeight: 1.6 }}>
                Ron West · ron@whitemountainpickleball.com<br />
                (603) 722-0754 · whitemountainpickleball.com
              </p>
            </div>
            <div style={{ textAlign: "right" }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: ink, margin: "0 0 2px" }}>
                INDEPENDENT CONTRACTOR AGREEMENT
              </p>
              <p style={{ fontSize: 12, color: inkMuted, margin: 0 }}>
                Generated: {generatedDate}
              </p>
              <p style={{ fontSize: 12, color: inkMuted, margin: 0 }}>
                Terms version: {contract.terms_version}
              </p>
            </div>
          </div>
        </div>

        {/* Customer & Event details */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 28 }}>
          <div>
            <p style={{ fontSize: 11, fontWeight: 700, color: inkMuted, textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 8px" }}>
              Client
            </p>
            {customer ? (
              <>
                <p style={{ fontSize: 14, fontWeight: 600, color: ink, margin: "0 0 2px" }}>{customer.name}</p>
                {customer.org_name && (
                  <p style={{ fontSize: 13, color: inkSoft, margin: "0 0 2px" }}>{customer.org_name}</p>
                )}
                <p style={{ fontSize: 13, color: inkSoft, margin: 0 }}>{customer.email}</p>
                {customer.phone && (
                  <p style={{ fontSize: 13, color: inkSoft, margin: 0 }}>{customer.phone}</p>
                )}
              </>
            ) : (
              <p style={{ fontSize: 14, color: inkMuted, fontStyle: "italic", margin: 0 }}>No customer on file</p>
            )}
          </div>
          <div>
            <p style={{ fontSize: 11, fontWeight: 700, color: inkMuted, textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 8px" }}>
              Event
            </p>
            <p style={{ fontSize: 14, fontWeight: 600, color: ink, margin: "0 0 2px" }}>
              {quote.event_name || <span style={{ color: inkMuted, fontStyle: "italic" }}>Untitled event</span>}
            </p>
            {quote.event_dates && (
              <p style={{ fontSize: 13, color: inkSoft, margin: "0 0 2px" }}>{quote.event_dates}</p>
            )}
            <p style={{ fontSize: 13, color: inkSoft, margin: 0 }}>
              {quote.num_days} day{quote.num_days !== 1 ? "s" : ""}
              {quote.distance_miles > 0 ? ` · ${quote.distance_miles} mi from Lincoln, NH` : ""}
            </p>
          </div>
        </div>

        {/* Line items */}
        <div style={{ marginBottom: 28 }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: inkMuted, textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 10px" }}>
            Services &amp; Pricing
          </p>
          {lineItems.length === 0 ? (
            <p style={{ fontSize: 13, color: inkMuted }}>No line items on record.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${ink}` }}>
                  <th style={{ textAlign: "left", padding: "6px 0", fontSize: 12, color: inkSoft, fontWeight: 700 }}>Service</th>
                  <th style={{ textAlign: "right", padding: "6px 8px", fontSize: 12, color: inkSoft, fontWeight: 700 }}>Qty</th>
                  <th style={{ textAlign: "right", padding: "6px 8px", fontSize: 12, color: inkSoft, fontWeight: 700 }}>Unit price</th>
                  <th style={{ textAlign: "right", padding: "6px 0", fontSize: 12, color: inkSoft, fontWeight: 700 }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((li) => (
                  <tr key={li.id} style={{ borderBottom: `1px solid ${ruleSoft}` }}>
                    <td style={{ padding: "9px 0", color: ink }}>{li.label}</td>
                    <td style={{ padding: "9px 8px", textAlign: "right", color: inkSoft }}>{li.qty}</td>
                    <td style={{ padding: "9px 8px", textAlign: "right", color: inkSoft }}>{formatDollars(li.unit_price_cents)}</td>
                    <td style={{ padding: "9px 0", textAlign: "right", fontWeight: 600, color: ink }}>{formatDollars(li.line_total_cents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `2px solid ${ink}` }}>
                  <td colSpan={3} style={{ padding: "10px 0", fontWeight: 700, fontSize: 14, color: ink }}>Total</td>
                  <td style={{ padding: "10px 0", textAlign: "right", fontWeight: 700, fontSize: 16, color: ink }}>
                    {formatDollars(subtotalCents)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        {/* Deposit callout */}
        <div style={{ background: "#f8f6f0", border: `1px solid ${rule}`, borderRadius: 6, padding: "12px 16px", marginBottom: 28, fontSize: 13 }}>
          <strong style={{ color: ink }}>Deposit required: $200.00</strong>
          <span style={{ color: inkSoft }}> — non-refundable, applied toward the balance above.</span>
        </div>

        {/* Standard terms */}
        <div style={{ marginBottom: 36 }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: inkMuted, textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 12px" }}>
            Terms &amp; Conditions
          </p>
          <div style={{ fontSize: 13, color: ink, lineHeight: 1.7 }}>
            {STANDARD_TERMS.split("\n\n").map((para, i) => (
              <p key={i} style={{ margin: "0 0 12px" }}>{para}</p>
            ))}
          </div>
        </div>

        {/* Signature blocks */}
        <div style={{ borderTop: `1px solid ${rule}`, paddingTop: 24 }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: inkMuted, textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 24px" }}>
            Signatures
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40 }}>
            <div>
              <div style={{ borderBottom: `1px solid ${ink}`, height: 40, marginBottom: 6 }} />
              <p style={{ fontSize: 12, color: inkSoft, margin: 0 }}>Ron West · White Mountain Pickleball Club</p>
              <p style={{ fontSize: 12, color: inkMuted, margin: "2px 0 0" }}>Date: _______________</p>
            </div>
            <div>
              <div style={{ borderBottom: `1px solid ${ink}`, height: 40, marginBottom: 6 }} />
              <p style={{ fontSize: 12, color: inkSoft, margin: 0 }}>
                {customer ? `${customer.name}${customer.org_name ? ` · ${customer.org_name}` : ""}` : "Client"}
              </p>
              <p style={{ fontSize: 12, color: inkMuted, margin: "2px 0 0" }}>Date: _______________</p>
            </div>
          </div>
        </div>
      </div>

      {/* Action bar */}
      <div style={{ marginTop: 20, display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={() => window.print()} style={ctaPrimaryStyle}>
          Print / Save as PDF
        </button>
        <Link to={`/admin/quotes/${quoteId}`} style={ctaSecondaryStyle}>
          Back to quote
        </Link>
      </div>

      {/* Print-only styles */}
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #contract-document, #contract-document * { visibility: visible !important; }
          #contract-document {
            position: fixed !important;
            top: 0 !important; left: 0 !important;
            width: 100% !important;
            border: none !important;
            border-radius: 0 !important;
            padding: 32px 48px !important;
          }
        }
      `}</style>
    </main>
  );
}
