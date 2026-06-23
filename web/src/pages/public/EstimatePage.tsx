import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import SiteFooter from "../../components/SiteFooter";
import {
  bg,
  bodyFontStack,
  contentColStyle,
  courtBlue,
  courtGreen,
  courtYellow,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  headingFontStack,
  ink,
  infoBg,
  inputStyle,
  inkMuted,
  inkSoft,
  pageH1Style,
  pageSubStyle,
  pageWrapStyle,
  panelStyle,
  rule,
  ruleSoft,
  sectionH2Style,
  statusPanelStyle,
} from "../../lib/publicTheme";
import { computeQuote } from "../../lib/quotePricing";
import type { QuoteLineInput, QuotePlatform } from "../../lib/quotePricing";
import { supabase } from "../../supabase";
import type { Database } from "../../types/supabase";

type ServiceRow = Database["public"]["Tables"]["service_catalog"]["Row"];
type ServiceCategory = Database["public"]["Enums"]["service_category"];

const CATEGORY_LABELS: Record<ServiceCategory, string> = {
  core: "Core Services",
  setup: "Tournament Setup",
  branding: "Branding & Design",
  awards: "Awards",
  equipment: "Equipment",
  media: "Media",
};

const CATEGORY_ORDER: ServiceCategory[] = [
  "core",
  "setup",
  "branding",
  "awards",
  "equipment",
  "media",
];

function formatDollars(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? "-" : ""}$${(abs / 100).toFixed(2).replace(/\.00$/, "")}`;
}

function labelStyle(): React.CSSProperties {
  return {
    display: "block",
    fontSize: 13,
    fontWeight: 600,
    color: inkSoft,
    marginBottom: 4,
    fontFamily: bodyFontStack,
  };
}

function fieldRowStyle(): React.CSSProperties {
  return { marginBottom: 16 };
}

export default function EstimatePage() {
  // ── Event basics ─────────────────────────────────────────────────────
  const [eventName, setEventName] = useState("");
  const [eventDates, setEventDates] = useState("");
  const [numDays, setNumDays] = useState(1);
  const [numEvents, setNumEvents] = useState(5);
  const [numEntries, setNumEntries] = useState(70);
  const [multiEventPlayers, setMultiEventPlayers] = useState(0);
  const [distanceMiles, setDistanceMiles] = useState(0);
  const [platform, setPlatform] = useState<QuotePlatform>("bertanderne");
  const [firstEventFee, setFirstEventFee] = useState(70);
  const [additionalEventFee, setAdditionalEventFee] = useState(20);

  // ── Service catalog ───────────────────────────────────────────────────
  const [catalog, setCatalog] = useState<ServiceRow[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  useEffect(() => {
    supabase
      .from("service_catalog")
      .select("*")
      .eq("active", true)
      .order("sort_order")
      .then(({ data, error }) => {
        if (error) {
          setCatalogError("Could not load services. Please refresh.");
          return;
        }
        setCatalog(data ?? []);
        // Default-select core + setup services
        const defaultSelected: Record<string, boolean> = {};
        const defaultQty: Record<string, number> = {};
        for (const svc of data ?? []) {
          const autoSelect =
            svc.category === "core" || svc.category === "setup";
          defaultSelected[svc.key] = autoSelect;
          defaultQty[svc.key] = 1;
        }
        setSelected(defaultSelected);
        setQuantities(defaultQty);
      });
  }, []);

  // ── Derive line items for pricing engine ──────────────────────────────
  const totalEntrants = numEntries + multiEventPlayers;

  function qtyForUnit(
    unit: ServiceRow["unit"],
    key: string
  ): number {
    switch (unit) {
      case "per_day": return numDays;
      case "per_event": return numEvents;
      case "per_entrant": return totalEntrants;
      case "per_player": return numEntries;
      case "flat": return 1;
      case "each": return quantities[key] ?? 1;
    }
  }

  const lineItems = useMemo<QuoteLineInput[]>(() => {
    return catalog
      .filter((svc) => selected[svc.key])
      .map((svc) => ({
        key: svc.key,
        label: svc.name,
        qty: qtyForUnit(svc.unit, svc.key),
        unitPriceCents: svc.unit_price_cents,
        passThroughCostCents: svc.plus_passthrough_cost
          ? (quantities[svc.key + "_passthrough"] ?? 0) * 100
          : 0,
        isPassthrough: svc.is_passthrough,
      }));
    // qtyForUnit reads numDays/numEvents/totalEntrants/numEntries/quantities inline
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, selected, quantities, numDays, numEvents, numEntries, multiEventPlayers]);

  const quote = useMemo(
    () =>
      computeQuote({
        numDays,
        numEvents,
        numEntries,
        multiEventPlayers,
        platform,
        distanceMiles,
        firstEventFeeCents: firstEventFee * 100,
        additionalEventFeeCents: additionalEventFee * 100,
        lineItems,
      }),
    [
      numDays,
      numEvents,
      numEntries,
      multiEventPlayers,
      platform,
      distanceMiles,
      firstEventFee,
      additionalEventFee,
      lineItems,
    ]
  );

  // ── Lead-capture form ─────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [orgName, setOrgName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      // 1. Insert customer
      const { data: customer, error: custErr } = await supabase
        .from("quote_customers")
        .insert({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim() || null,
          org_name: orgName.trim() || null,
        })
        .select("id")
        .single();
      if (custErr || !customer) throw custErr ?? new Error("Customer insert failed");

      // 2. Insert quote
      const { data: quoteRow, error: quoteErr } = await supabase
        .from("quotes")
        .insert({
          customer_id: customer.id,
          status: "submitted",
          source: "public",
          event_name: eventName.trim() || null,
          event_dates: eventDates.trim() || null,
          num_days: numDays,
          distance_miles: distanceMiles,
          platform,
        })
        .select("id")
        .single();
      if (quoteErr || !quoteRow) throw quoteErr ?? new Error("Quote insert failed");

      // 3. Insert revision
      const { data: revision, error: revErr } = await supabase
        .from("quote_revisions")
        .insert({
          quote_id: quoteRow.id,
          revision_number: 1,
          created_by: "public",
          subtotal_cents: quote.wmpcTotalCents,
          estimated_revenue_cents: quote.organizerRevenueCents,
          estimated_net_cents: quote.estimatedNetCents,
          is_current: true,
        })
        .select("id")
        .single();
      if (revErr || !revision) throw revErr ?? new Error("Revision insert failed");

      // 4. Insert line items
      if (quote.lines.length > 0) {
        const { error: lineErr } = await supabase
          .from("quote_line_items")
          .insert(
            quote.lines.map((l) => ({
              revision_id: revision.id,
              service_key: l.key,
              label: l.label,
              qty: l.qty,
              unit_price_cents: l.unitPriceCents,
              passthrough_cost_cents: l.passThroughCostCents ?? 0,
              is_passthrough: l.isPassthrough ?? false,
              line_total_cents: l.lineTotalCents,
            }))
          );
        if (lineErr) throw lineErr;
      }

      setSubmitted(true);
    } catch {
      setSubmitError("Something went wrong. Please try again or email us directly.");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  if (submitted) {
    return (
      <div style={pageWrapStyle}>
        <div style={contentColStyle(640)}>
          <h1 style={pageH1Style}>Proposal Received</h1>
          <div style={{ ...statusPanelStyle("success"), marginBottom: 24 }}>
            <strong>Thank you, {name}!</strong> We received your estimate
            request and will be in touch at {email} shortly.
          </div>
          <p style={{ fontSize: 14, color: inkSoft }}>
            Want to browse upcoming tournaments in the meantime?
          </p>
          <Link to="/" style={{ ...ctaPrimaryStyle, textDecoration: "none", display: "inline-block" }}>
            Back to tournaments
          </Link>
        </div>
        <SiteFooter />
      </div>
    );
  }

  const grouped = CATEGORY_ORDER.reduce(
    (acc, cat) => {
      acc[cat] = catalog.filter((s) => s.category === cat);
      return acc;
    },
    {} as Record<ServiceCategory, ServiceRow[]>
  );

  return (
    <div style={pageWrapStyle}>
      <div style={{ ...contentColStyle(900), paddingBottom: 120 }}>
        <h1 style={pageH1Style}>Get an Estimate</h1>
        <p style={pageSubStyle}>
          Pick the services you want, enter your event size, and see your
          projected cost, revenue, and estimated net — then submit as a
          proposal and we'll follow up.
        </p>

        {catalogError && (
          <div style={{ ...statusPanelStyle("danger"), marginBottom: 24 }}>
            {catalogError}
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr",
            gap: 0,
          }}
        >
          {/* ── Event Basics ── */}
          <section
            style={{
              ...panelStyle,
              marginBottom: 20,
            }}
          >
            <h2 style={{ ...sectionH2Style, marginTop: 0 }}>Event Basics</h2>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                gap: "0 20px",
              }}
            >
              <div style={fieldRowStyle()}>
                <label style={labelStyle()}>Event name</label>
                <input
                  style={inputStyle}
                  type="text"
                  placeholder="e.g. Summer Classic 2026"
                  value={eventName}
                  onChange={(e) => setEventName(e.target.value)}
                />
              </div>
              <div style={fieldRowStyle()}>
                <label style={labelStyle()}>Event dates</label>
                <input
                  style={inputStyle}
                  type="text"
                  placeholder="e.g. July 12–13, 2026"
                  value={eventDates}
                  onChange={(e) => setEventDates(e.target.value)}
                />
              </div>
              <div style={fieldRowStyle()}>
                <label style={labelStyle()}>Number of days</label>
                <input
                  style={inputStyle}
                  type="number"
                  min={1}
                  max={7}
                  value={numDays}
                  onChange={(e) => setNumDays(Math.max(1, Number(e.target.value)))}
                />
              </div>
              <div style={fieldRowStyle()}>
                <label style={labelStyle()}>Number of events/divisions</label>
                <input
                  style={inputStyle}
                  type="number"
                  min={1}
                  value={numEvents}
                  onChange={(e) => setNumEvents(Math.max(1, Number(e.target.value)))}
                />
              </div>
              <div style={fieldRowStyle()}>
                <label style={labelStyle()}>Expected players</label>
                <input
                  style={inputStyle}
                  type="number"
                  min={1}
                  value={numEntries}
                  onChange={(e) => setNumEntries(Math.max(1, Number(e.target.value)))}
                />
              </div>
              <div style={fieldRowStyle()}>
                <label style={labelStyle()}>Players entering 2+ events</label>
                <input
                  style={inputStyle}
                  type="number"
                  min={0}
                  value={multiEventPlayers}
                  onChange={(e) =>
                    setMultiEventPlayers(Math.max(0, Number(e.target.value)))
                  }
                />
              </div>
              <div style={fieldRowStyle()}>
                <label style={labelStyle()}>Distance from WMPC (miles)</label>
                <input
                  style={inputStyle}
                  type="number"
                  min={0}
                  value={distanceMiles}
                  onChange={(e) =>
                    setDistanceMiles(Math.max(0, Number(e.target.value)))
                  }
                />
                {distanceMiles > 50 && (
                  <p style={{ fontSize: 12, color: inkMuted, margin: "4px 0 0" }}>
                    Travel cost will be included (lodging + per diem + mileage).
                  </p>
                )}
              </div>
              <div style={fieldRowStyle()}>
                <label style={labelStyle()}>Platform</label>
                <select
                  style={{ ...inputStyle, cursor: "pointer" }}
                  value={platform}
                  onChange={(e) => {
                    const p = e.target.value as QuotePlatform;
                    setPlatform(p);
                    setSelected((prev) => ({
                      ...prev,
                      registration_be: p === "bertanderne",
                      registration_pb: p === "pickleballbrackets",
                    }));
                  }}
                >
                  <option value="bertanderne">bert & erne</option>
                  <option value="pickleballbrackets">PickleballBrackets</option>
                </select>
              </div>
            </div>

            {/* Registration pricing */}
            <div
              style={{
                borderTop: `1px solid ${rule}`,
                paddingTop: 16,
                marginTop: 4,
              }}
            >
              <p
                style={{
                  fontSize: 13,
                  color: inkSoft,
                  margin: "0 0 12px",
                  fontWeight: 600,
                }}
              >
                Your registration pricing
              </p>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: "0 20px",
                }}
              >
                <div style={fieldRowStyle()}>
                  <label style={labelStyle()}>First event fee ($)</label>
                  <input
                    style={inputStyle}
                    type="number"
                    min={0}
                    value={firstEventFee}
                    onChange={(e) =>
                      setFirstEventFee(Math.max(0, Number(e.target.value)))
                    }
                  />
                </div>
                <div style={fieldRowStyle()}>
                  <label style={labelStyle()}>Additional event fee ($)</label>
                  <input
                    style={inputStyle}
                    type="number"
                    min={0}
                    value={additionalEventFee}
                    onChange={(e) =>
                      setAdditionalEventFee(Math.max(0, Number(e.target.value)))
                    }
                  />
                </div>
              </div>
            </div>
          </section>

          {/* ── Services ── */}
          <section style={{ ...panelStyle, marginBottom: 20 }}>
            <h2 style={{ ...sectionH2Style, marginTop: 0 }}>
              Services
            </h2>
            <p style={{ fontSize: 13, color: inkSoft, margin: "0 0 16px" }}>
              Check the services you want. Quantities for day-based and
              event-based services update automatically when you change your
              event basics above.
            </p>

            {CATEGORY_ORDER.map((cat) => {
              const services = grouped[cat];
              if (!services || services.length === 0) return null;
              return (
                <div key={cat} style={{ marginBottom: 20 }}>
                  <p
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                      color: inkMuted,
                      margin: "0 0 8px",
                      fontFamily: bodyFontStack,
                    }}
                  >
                    {CATEGORY_LABELS[cat]}
                  </p>
                  <div
                    style={{
                      border: `1px solid ${ruleSoft}`,
                      borderRadius: 8,
                      overflow: "hidden",
                    }}
                  >
                    {services.map((svc, i) => {
                      const isChecked = !!selected[svc.key];
                      const autoQty = svc.unit !== "each";
                      const qty = qtyForUnit(svc.unit, svc.key);
                      const lineTotal = isChecked
                        ? qty * svc.unit_price_cents
                        : 0;

                      return (
                        <div
                          key={svc.key}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 12,
                            padding: "10px 14px",
                            background: isChecked ? infoBg : bg,
                            borderTop: i > 0 ? `1px solid ${ruleSoft}` : "none",
                            cursor: "pointer",
                          }}
                          onClick={() =>
                            setSelected((prev) => ({
                              ...prev,
                              [svc.key]: !prev[svc.key],
                            }))
                          }
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {}}
                            style={{ cursor: "pointer", flexShrink: 0 }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <span
                              style={{
                                fontSize: 14,
                                fontWeight: 500,
                                color: ink,
                              }}
                            >
                              {svc.name}
                            </span>
                            {svc.plus_passthrough_cost && (
                              <span
                                style={{
                                  fontSize: 12,
                                  color: inkMuted,
                                  marginLeft: 6,
                                }}
                              >
                                + materials cost
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              flexShrink: 0,
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {!autoQty && isChecked && (
                              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                <label style={{ fontSize: 12, color: inkMuted }}>Qty</label>
                                <input
                                  type="number"
                                  min={1}
                                  value={quantities[svc.key] ?? 1}
                                  onChange={(e) =>
                                    setQuantities((prev) => ({
                                      ...prev,
                                      [svc.key]: Math.max(1, Number(e.target.value)),
                                    }))
                                  }
                                  style={{
                                    width: 64,
                                    padding: "4px 8px",
                                    fontSize: 13,
                                    border: `1px solid ${rule}`,
                                    borderRadius: 4,
                                    fontFamily: bodyFontStack,
                                  }}
                                />
                              </div>
                            )}
                            {autoQty && isChecked && (
                              <span
                                style={{
                                  fontSize: 12,
                                  color: inkMuted,
                                  fontStyle: "italic",
                                }}
                              >
                                ×{qty}
                              </span>
                            )}
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: isChecked ? courtBlue : inkMuted,
                                fontFamily: bodyFontStack,
                                minWidth: 70,
                                textAlign: "right",
                              }}
                            >
                              {isChecked
                                ? formatDollars(lineTotal)
                                : formatDollars(svc.unit_price_cents) +
                                  "/" +
                                  svc.unit.replace("per_", "")}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </section>

          {/* ── Lead capture / Submit ── */}
          <section style={{ ...panelStyle, marginBottom: 20 }}>
            <h2 style={{ ...sectionH2Style, marginTop: 0 }}>Submit Proposal</h2>
            <p style={{ fontSize: 13, color: inkSoft, margin: "0 0 16px" }}>
              We'll review your estimate and follow up within one business day.
            </p>
            <form onSubmit={handleSubmit}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: "0 20px",
                }}
              >
                <div style={fieldRowStyle()}>
                  <label style={labelStyle()}>
                    Your name <span style={{ color: courtBlue }}>*</span>
                  </label>
                  <input
                    style={inputStyle}
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Jane Smith"
                  />
                </div>
                <div style={fieldRowStyle()}>
                  <label style={labelStyle()}>
                    Email <span style={{ color: courtBlue }}>*</span>
                  </label>
                  <input
                    style={inputStyle}
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="jane@example.com"
                  />
                </div>
                <div style={fieldRowStyle()}>
                  <label style={labelStyle()}>Phone</label>
                  <input
                    style={inputStyle}
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="(603) 555-0100"
                  />
                </div>
                <div style={fieldRowStyle()}>
                  <label style={labelStyle()}>Organization / club</label>
                  <input
                    style={inputStyle}
                    type="text"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    placeholder="Seacoast Pickleball Club"
                  />
                </div>
              </div>

              {submitError && (
                <div style={{ ...statusPanelStyle("danger"), marginBottom: 16 }}>
                  {submitError}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || !name.trim() || !email.trim()}
                style={
                  submitting || !name.trim() || !email.trim()
                    ? ctaPrimaryDisabledStyle
                    : ctaPrimaryStyle
                }
              >
                {submitting ? "Submitting…" : "Submit Proposal"}
              </button>
            </form>
          </section>
        </div>
      </div>

      {/* ── Sticky summary card ── */}
      <div
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          background: ink,
          borderTop: `3px solid ${courtYellow}`,
          zIndex: 100,
          padding: "12px 20px",
        }}
      >
        <div
          style={{
            maxWidth: 900,
            margin: "0 auto",
            display: "flex",
            gap: 24,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <SummaryCell
            label="What we cost"
            value={formatDollars(quote.wmpcTotalCents)}
            accent={courtYellow}
          />
          <SummaryCell
            label="You bring in"
            value={formatDollars(quote.organizerRevenueCents)}
            accent={courtGreen}
          />
          <SummaryCell
            label="Estimated net"
            value={formatDollars(quote.estimatedNetCents)}
            accent={quote.estimatedNetCents >= 0 ? courtGreen : "#e05050"}
          />
          {quote.travel.flagged && (
            <span
              style={{
                fontSize: 11,
                color: courtYellow,
                fontFamily: bodyFontStack,
                opacity: 0.8,
                maxWidth: 160,
                lineHeight: 1.3,
              }}
            >
              ⚠ Travel est. included ({formatDollars(quote.travel.totalCents)})
            </span>
          )}
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}

function SummaryCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: accent,
          fontFamily: bodyFontStack,
          opacity: 0.85,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: accent,
          fontFamily: headingFontStack,
          letterSpacing: "0.02em",
          lineHeight: 1,
        }}
      >
        {value}
      </span>
    </div>
  );
}
