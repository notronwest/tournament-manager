import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import SiteFooter from "../../components/SiteFooter";
import {
  bodyFontStack,
  contentColStyle,
  courtGreen,
  courtRed,
  courtYellow,
  ctaPrimaryDisabledStyle,
  ctaPrimaryStyle,
  headingFontStack,
  ink,
  inkMuted,
  inkSoft,
  pageH1Style,
  pageWrapStyle,
  panelStyle,
  rule,
  ruleSoft,
  sectionH2Style,
  statusPanelStyle,
} from "../../lib/publicTheme";
import type { Database, Json } from "../../types/supabase";

type ServiceCategory = Database["public"]["Enums"]["service_category"];
type ServiceRow = Database["public"]["Tables"]["service_catalog"]["Row"];

// These service categories are always required (admin locked).
const REQUIRED_CATEGORIES: ServiceCategory[] = ["core", "setup"];
// Virtual service keys that are always required regardless of category.
const REQUIRED_VIRTUAL_KEYS = new Set(["onsite_mgmt_pct", "travel"]);

interface LineItem {
  id: string;
  service_key: string;
  label: string;
  qty: number;
  unit_price_cents: number;
  passthrough_cost_cents: number;
  line_total_cents: number;
}

interface QuotePayload {
  quote_id: string;
  event_name: string | null;
  event_dates: string | null;
  num_days: number;
  num_events: number;
  num_entries: number;
  multi_event_players: number;
  distance_miles: number;
  platform: string;
  first_event_fee_cents: number;
  additional_event_fee_cents: number;
  revision_id: string;
  revision_number: number;
  revision_notes: string | null;
  subtotal_cents: number;
  estimated_revenue_cents: number;
  estimated_net_cents: number;
  line_items: LineItem[] | null;
}

function formatDollars(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? "-" : ""}$${(abs / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

export default function CustomerQuotePage() {
  const { token } = useParams<{ token: string }>();

  const [payload, setPayload] = useState<QuotePayload | null>(null);
  const [catalog, setCatalog] = useState<Pick<ServiceRow, 'key' | 'category'>[]>([]);
  // If there's no token segment in the URL, we're immediately invalid.
  const [loading, setLoading] = useState(!!token);
  const [invalid, setInvalid] = useState(!token);

  // Customer selection: service_key → included (only optional lines can change)
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!token) return;

    Promise.all([
      supabase.rpc("get_quote_by_token", { p_token: token }),
      supabase.from("service_catalog").select("key,category").eq("active", true),
    ]).then(([{ data: quoteData, error: quoteErr }, { data: catData }]) => {
      setLoading(false);
      if (quoteErr || !quoteData) {
        setInvalid(true);
        return;
      }
      const p = quoteData as unknown as QuotePayload;
      setPayload(p);
      setCatalog(catData ?? []);

      // All admin-chosen lines start included
      const initSel: Record<string, boolean> = {};
      for (const li of p.line_items ?? []) {
        initSel[li.service_key] = true;
      }
      setSelected(initSel);
    });
  }, [token]);

  // Map service_key → category
  const categoryByKey = useMemo(() => {
    const m: Record<string, ServiceCategory> = {};
    for (const s of catalog) {
      m[s.key] = s.category as ServiceCategory;
    }
    return m;
  }, [catalog]);

  function isRequired(serviceKey: string): boolean {
    if (REQUIRED_VIRTUAL_KEYS.has(serviceKey)) return true;
    const cat = categoryByKey[serviceKey];
    return cat != null && (REQUIRED_CATEGORIES as string[]).includes(cat);
  }

  const allLines = payload?.line_items ?? [];
  const requiredLines = useMemo(
    () => allLines.filter((li) => isRequired(li.service_key)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allLines, categoryByKey]
  );
  const optionalLines = useMemo(
    () => allLines.filter((li) => !isRequired(li.service_key)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allLines, categoryByKey]
  );

  const selectedLines = useMemo(
    () => [
      ...requiredLines,
      ...optionalLines.filter((li) => selected[li.service_key]),
    ],
    [requiredLines, optionalLines, selected]
  );

  const selectedSubtotal = useMemo(
    () => selectedLines.reduce((sum, li) => sum + li.line_total_cents, 0),
    [selectedLines]
  );

  const organizerRevenue = useMemo(() => {
    if (!payload) return 0;
    return (
      payload.num_entries * payload.first_event_fee_cents +
      payload.multi_event_players * payload.additional_event_fee_cents
    );
  }, [payload]);

  const estimatedNet = organizerRevenue - selectedSubtotal;

  async function handleSubmit() {
    if (!token || !payload) return;
    setSubmitting(true);
    setSubmitError(null);

    const lineItemsJson: Json = selectedLines.map((li) => ({
      service_key: li.service_key,
      label: li.label,
      qty: li.qty,
      unit_price_cents: li.unit_price_cents,
      passthrough_cost_cents: li.passthrough_cost_cents,
      line_total_cents: li.line_total_cents,
    }));

    const { error } = await supabase.rpc("submit_customer_revision", {
      p_token: token,
      p_line_items: lineItemsJson,
      p_subtotal_cents: selectedSubtotal,
      p_estimated_revenue_cents: organizerRevenue,
      p_estimated_net_cents: estimatedNet,
    });

    setSubmitting(false);
    if (error) {
      setSubmitError(error.message ?? "Submission failed. Please try again.");
      return;
    }
    setSubmitted(true);
  }

  if (loading) {
    return (
      <div style={{ ...pageWrapStyle, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <p style={{ color: inkSoft, fontFamily: bodyFontStack }}>Loading your quote…</p>
      </div>
    );
  }

  if (invalid || !payload) {
    return (
      <div style={pageWrapStyle}>
        <main style={{ ...contentColStyle(560), padding: "48px 24px" }}>
          <h1 style={{ ...pageH1Style, fontSize: 22, marginTop: 0 }}>Quote not found</h1>
          <p style={{ color: inkSoft, fontFamily: bodyFontStack, fontSize: 15 }}>
            This link is invalid, has expired, or has been revoked. Please contact your WMPC
            representative for an updated link.
          </p>
        </main>
        <SiteFooter />
      </div>
    );
  }

  if (submitted) {
    return (
      <div style={pageWrapStyle}>
        <main style={{ ...contentColStyle(600), padding: "48px 24px" }}>
          <div style={{ ...statusPanelStyle("success"), marginBottom: 24 }}>
            Your selections have been submitted. WMPC will be in touch shortly.
          </div>
          <h1 style={{ ...pageH1Style, fontSize: 22, marginTop: 0 }}>
            {payload.event_name ? `Thanks, ${payload.event_name}!` : "Selections received"}
          </h1>
          <p style={{ color: inkSoft, fontFamily: bodyFontStack, fontSize: 15 }}>
            We received your customization. Our team will review and follow up with your finalized
            proposal.
          </p>
        </main>
        <SiteFooter />
      </div>
    );
  }

  return (
    <div style={pageWrapStyle}>
      <main style={{ ...contentColStyle(720), padding: "48px 24px 120px" }}>
        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <p style={{
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: inkMuted,
            fontFamily: bodyFontStack,
            margin: "0 0 8px",
          }}>
            WMPC Services Quote — Rev #{payload.revision_number}
          </p>
          <h1 style={{ ...pageH1Style, fontSize: 28, marginTop: 0, marginBottom: 4 }}>
            {payload.event_name || "Your tournament quote"}
          </h1>
          {payload.event_dates && (
            <p style={{ color: inkSoft, fontFamily: bodyFontStack, fontSize: 14, margin: 0 }}>
              {payload.event_dates}
            </p>
          )}
        </div>

        {/* Event summary */}
        <section style={{ ...panelStyle, marginBottom: 24 }}>
          <h2 style={{ ...sectionH2Style, marginTop: 0, fontSize: 14 }}>Event details</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
            {([
              ["Days", String(payload.num_days)],
              ["Events / divisions", String(payload.num_events)],
              ["Expected players", String(payload.num_entries)],
              ["Platform", payload.platform === "bertanderne" ? "bert & erne" : "PickleballBrackets"],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label}>
                <p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: inkMuted, fontFamily: bodyFontStack }}>{label}</p>
                <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: ink, fontFamily: bodyFontStack }}>{value}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Required services (read-only) */}
        {requiredLines.length > 0 && (
          <section style={{ marginBottom: 24 }}>
            <h2 style={{ ...sectionH2Style, fontSize: 13, marginTop: 0, marginBottom: 8 }}>
              Included services
            </h2>
            <p style={{ color: inkSoft, fontFamily: bodyFontStack, fontSize: 13, margin: "0 0 10px" }}>
              These services are part of your proposal and cannot be removed.
            </p>
            <div style={{ border: `1px solid ${rule}`, borderRadius: 8, overflow: "hidden" }}>
              {requiredLines.map((li, i) => (
                <div key={li.id} style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 14px",
                  borderTop: i > 0 ? `1px solid ${ruleSoft}` : "none",
                  background: "#fff",
                }}>
                  <span style={{ fontSize: 14, color: ink, fontFamily: bodyFontStack }}>{li.label}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: inkSoft, fontFamily: bodyFontStack }}>
                    {li.qty > 1 && <span style={{ color: inkMuted, marginRight: 6 }}>×{li.qty}</span>}
                    {formatDollars(li.line_total_cents)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Optional add-ons (toggleable) */}
        {optionalLines.length > 0 && (
          <section style={{ marginBottom: 24 }}>
            <h2 style={{ ...sectionH2Style, fontSize: 13, marginTop: 0, marginBottom: 4 }}>
              Optional add-ons
            </h2>
            <p style={{ color: inkSoft, fontFamily: bodyFontStack, fontSize: 13, margin: "0 0 10px" }}>
              Choose which add-ons to include in your proposal.
            </p>
            <div style={{ border: `1px solid ${rule}`, borderRadius: 8, overflow: "hidden" }}>
              {optionalLines.map((li, i) => {
                const isChecked = !!selected[li.service_key];
                return (
                  <div
                    key={li.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 14px",
                      borderTop: i > 0 ? `1px solid ${ruleSoft}` : "none",
                      background: isChecked ? "#f0fdf4" : "#fff",
                      cursor: "pointer",
                    }}
                    onClick={() =>
                      setSelected((prev) => ({ ...prev, [li.service_key]: !prev[li.service_key] }))
                    }
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {}}
                      style={{ cursor: "pointer", flexShrink: 0 }}
                    />
                    <span style={{ flex: 1, fontSize: 14, color: ink, fontFamily: bodyFontStack }}>
                      {li.label}
                    </span>
                    <span style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: isChecked ? courtGreen : inkMuted,
                      fontFamily: bodyFontStack,
                    }}>
                      {li.qty > 1 && <span style={{ color: inkMuted, marginRight: 6 }}>×{li.qty}</span>}
                      {formatDollars(li.line_total_cents)}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {submitError && (
          <div style={{ ...statusPanelStyle("danger"), marginBottom: 16 }}>{submitError}</div>
        )}

        <button
          onClick={handleSubmit}
          disabled={submitting}
          style={submitting ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
        >
          {submitting ? "Submitting…" : "Submit my selections"}
        </button>
      </main>

      {/* Sticky totals bar */}
      <div style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        background: ink,
        borderTop: `3px solid ${courtYellow}`,
        zIndex: 100,
        padding: "12px 20px",
      }}>
        <div style={{
          maxWidth: 720,
          margin: "0 auto",
          display: "flex",
          gap: 24,
          alignItems: "center",
          flexWrap: "wrap",
        }}>
          <SummaryCell label="WMPC cost" value={formatDollars(selectedSubtotal)} color={courtYellow} />
          <SummaryCell
            label="Organizer revenue (est.)"
            value={formatDollars(organizerRevenue)}
            color={courtGreen}
          />
          <SummaryCell
            label="Estimated net"
            value={formatDollars(estimatedNet)}
            color={estimatedNet >= 0 ? courtGreen : courtRed}
          />
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}

function SummaryCell({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color,
        fontFamily: bodyFontStack,
        opacity: 0.85,
      }}>
        {label}
      </span>
      <span style={{
        fontSize: 22,
        fontWeight: 700,
        color,
        fontFamily: headingFontStack,
        letterSpacing: "0.02em",
        lineHeight: 1,
      }}>
        {value}
      </span>
    </div>
  );
}
