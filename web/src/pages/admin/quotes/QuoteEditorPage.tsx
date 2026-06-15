import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../../supabase";
import { useAuth } from "../../../auth/AuthProvider";
import { usePlatformAdmin } from "../../../hooks/usePlatformAdmin";
import { computeQuote } from "../../../lib/quotePricing";
import type { QuoteLineInput, QuotePlatform } from "../../../lib/quotePricing";
import {
  LOCAL_RADIUS_MILES,
} from "../../../lib/quotePricing";
import {
  bodyFontStack,
  breadcrumbLinkStyle,
  courtBlue,
  courtGreen,
  courtRed,
  courtYellow,
  ctaPrimaryDisabledStyle,
  ctaPrimaryStyle,
  ctaSecondaryStyle,
  headingFontStack,
  ink,
  infoBg,
  inkMuted,
  inkSoft,
  inputStyle,
  pageH1Style,
  panelMutedStyle,
  panelStyle,
  rule,
  ruleSoft,
  sectionH2Style,
  statusPanelStyle,
} from "../../../lib/publicTheme";
import type { Database } from "../../../types/supabase";

type QuoteStatus = Database["public"]["Enums"]["quote_status"];
type ContractStatus = Database["public"]["Enums"]["contract_status"];
type ContractRow = Database["public"]["Tables"]["contracts"]["Row"];
type ServiceRow = Database["public"]["Tables"]["service_catalog"]["Row"];
type ServiceCategory = Database["public"]["Enums"]["service_category"];
type QuoteRow = Database["public"]["Tables"]["quotes"]["Row"];
type CustomerRow = Database["public"]["Tables"]["quote_customers"]["Row"];
type RevisionRow = Database["public"]["Tables"]["quote_revisions"]["Row"];
type LineItemRow = Database["public"]["Tables"]["quote_line_items"]["Row"];

const CONTRACT_TERMS_VERSION = "v1.0-2026";

const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  signed_offline: "Signed",
};

type RevisionWithLines = RevisionRow & { quote_line_items: LineItemRow[] };
type QuoteWithAll = QuoteRow & {
  quote_customers: CustomerRow | null;
  quote_revisions: RevisionWithLines[];
};

const STATUS_OPTIONS: { value: QuoteStatus; label: string }[] = [
  { value: "submitted", label: "Submitted" },
  { value: "draft", label: "Draft" },
  { value: "quoted", label: "Quoted" },
  { value: "accepted", label: "Accepted" },
  { value: "declined", label: "Declined" },
];

const CATEGORY_ORDER: ServiceCategory[] = ["core", "setup", "branding", "awards", "equipment", "media"];
const CATEGORY_LABELS: Record<ServiceCategory, string> = {
  core: "Core Services",
  setup: "Tournament Setup",
  branding: "Branding & Design",
  awards: "Awards",
  equipment: "Equipment",
  media: "Media",
};

function formatDollars(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? "-" : ""}$${(abs / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// Line item state for the editor. Includes potential override of unit_price.
type LineState = {
  key: string;
  label: string;
  qty: number;
  unitPriceCents: number;
  overridePriceCents: string; // "" = use catalog price, otherwise override
  passThroughCostCents: number;
};

export default function QuoteEditorPage() {
  const { quoteId } = useParams<{ quoteId: string }>();
  // quoteId is undefined when mounted via the static /admin/quotes/new route
  // (no :quoteId segment), and "new" when mounted via the dynamic route.
  const isNew = !quoteId || quoteId === "new";
  const isPlatformAdmin = usePlatformAdmin();
  const { user } = useAuth();
  const navigate = useNavigate();

  // ── Load quote (edit mode) ─────────────────────────────────────────────
  const [quoteData, setQuoteData] = useState<QuoteWithAll | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(!isNew);

  // ── Service catalog ────────────────────────────────────────────────────
  const [catalog, setCatalog] = useState<ServiceRow[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // ── Event basics ───────────────────────────────────────────────────────
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
  const [status, setStatus] = useState<QuoteStatus>("draft");

  // Customer fields (for new quotes)
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerOrg, setCustomerOrg] = useState("");

  // ── Line items ─────────────────────────────────────────────────────────
  // selected[key] = true/false; lineStates[key] = qty + price override
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [lineStates, setLineStates] = useState<Record<string, LineState>>({});

  // On-site management toggle: per_day or pct_revenue
  const [onsiteMgmtMode, setOnsiteMgmtMode] = useState<"per_day" | "pct_revenue">("per_day");
  const [onsitePct, setOnsitePct] = useState(20);

  // ── Revision history ───────────────────────────────────────────────────
  const [viewingRevision, setViewingRevision] = useState<RevisionWithLines | null>(null);

  // ── Share token ────────────────────────────────────────────────────────
  type ShareTokenRow = Database["public"]["Tables"]["quote_share_tokens"]["Row"];
  const [shareToken, setShareToken] = useState<ShareTokenRow | null>(null);
  const [shareTokenLoaded, setShareTokenLoaded] = useState(false);
  const [generatingToken, setGeneratingToken] = useState(false);
  const [revokingToken, setRevokingToken] = useState(false);
  const [shareTokenError, setShareTokenError] = useState<string | null>(null);

  // ── Save state ─────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // ── Contract state ────────────────────────────────────────────────────
  const [contracts, setContracts] = useState<ContractRow[]>([]);
  const [generatingContract, setGeneratingContract] = useState(false);
  const [contractError, setContractError] = useState<string | null>(null);

  // Load service catalog
  useEffect(() => {
    supabase
      .from("service_catalog")
      .select("*")
      .order("sort_order")
      .then(({ data, error }) => {
        if (error) { setCatalogError("Could not load service catalog."); return; }
        const rows = data ?? [];
        setCatalog(rows);

        // Initialize line states from catalog
        const states: Record<string, LineState> = {};
        for (const svc of rows) {
          states[svc.key] = {
            key: svc.key,
            label: svc.name,
            qty: 1,
            unitPriceCents: svc.unit_price_cents,
            overridePriceCents: "",
            passThroughCostCents: 0,
          };
        }
        setLineStates(states);

        if (isNew) {
          // Default-select core + setup services (same as EstimatePage)
          const sel: Record<string, boolean> = {};
          for (const svc of rows) {
            sel[svc.key] = svc.category === "core" || svc.category === "setup";
          }
          setSelected(sel);
        }
      });
  }, [isNew]);

  // Load existing quote
  useEffect(() => {
    if (isNew || !isPlatformAdmin) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("quotes")
        .select(`
          *,
          quote_customers (*),
          quote_revisions (
            *,
            quote_line_items (*)
          )
        `)
        .eq("id", quoteId as string)
        .single();
      if (cancelled) return;
      setLoadingQuote(false);
      if (error || !data) {
        setLoadError(error?.message ?? "Quote not found.");
        return;
      }
      const q = data as QuoteWithAll;
      setQuoteData(q);

        // Populate form from quote
        setEventName(q.event_name ?? "");
        setEventDates(q.event_dates ?? "");
        setNumDays(q.num_days);
        setNumEvents(q.num_events);
        setNumEntries(q.num_entries);
        setMultiEventPlayers(q.multi_event_players);
        setDistanceMiles(q.distance_miles);
        setPlatform(q.platform as QuotePlatform);
        setFirstEventFee(q.first_event_fee_cents / 100);
        setAdditionalEventFee(q.additional_event_fee_cents / 100);
        setStatus(q.status);

        // Populate line states from current revision
        const currentRev = q.quote_revisions.find((r) => r.is_current);
        if (currentRev) {
          const sel: Record<string, boolean> = {};
          const states: Record<string, LineState> = {};
          for (const li of currentRev.quote_line_items) {
            sel[li.service_key] = true;
            states[li.service_key] = {
              key: li.service_key,
              label: li.label,
              qty: li.qty,
              unitPriceCents: li.unit_price_cents,
              overridePriceCents: "",
              passThroughCostCents: li.passthrough_cost_cents,
            };
          }
          setSelected(sel);
          setLineStates((prev) => ({ ...prev, ...states }));
        }
    })();
    return () => { cancelled = true; };
  }, [isNew, quoteId, isPlatformAdmin]);

  // Load contracts for this quote
  useEffect(() => {
    if (isNew || !isPlatformAdmin || !quoteId) return;
    supabase
      .from("contracts")
      .select("*")
      .eq("quote_id", quoteId)
      .order("generated_at", { ascending: false })
      .then(({ data }) => setContracts(data ?? []));
  }, [isNew, quoteId, isPlatformAdmin]);

  // Load active share token for this quote
  useEffect(() => {
    if (isNew || !isPlatformAdmin || !quoteId) return;
    supabase
      .from("quote_share_tokens")
      .select("*")
      .eq("quote_id", quoteId)
      .eq("revoked", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .then(({ data }) => {
        const active = (data ?? []).find(
          (t) => !t.expires_at || new Date(t.expires_at) > new Date()
        );
        setShareToken(active ?? null);
        setShareTokenLoaded(true);
      });
  }, [isNew, quoteId, isPlatformAdmin]);

  async function handleGenerateShareLink() {
    if (!quoteId) return;
    setGeneratingToken(true);
    setShareTokenError(null);
    const { data, error } = await supabase
      .from("quote_share_tokens")
      .insert({ quote_id: quoteId })
      .select("*")
      .single();
    setGeneratingToken(false);
    if (error || !data) {
      setShareTokenError(error?.message ?? "Failed to generate share link.");
      return;
    }
    setShareToken(data);
  }

  async function handleRevokeShareLink() {
    if (!shareToken) return;
    setRevokingToken(true);
    setShareTokenError(null);
    const { error } = await supabase
      .from("quote_share_tokens")
      .update({ revoked: true })
      .eq("id", shareToken.id);
    setRevokingToken(false);
    if (error) {
      setShareTokenError(error.message ?? "Failed to revoke share link.");
      return;
    }
    setShareToken(null);
  }

  async function handleGenerateContract() {
    if (!quoteId || !quoteData) return;
    const currentRev = quoteData.quote_revisions.find((r) => r.is_current);
    if (!currentRev) {
      setContractError("Save a revision first before generating a contract.");
      return;
    }
    setGeneratingContract(true);
    setContractError(null);
    const { data, error } = await supabase
      .from("contracts")
      .insert({
        quote_id: quoteId,
        revision_id: currentRev.id,
        terms_version: CONTRACT_TERMS_VERSION,
        created_by: user?.id ?? null,
      })
      .select("id")
      .single();
    setGeneratingContract(false);
    if (error || !data) {
      setContractError(error?.message ?? "Failed to generate contract.");
      return;
    }
    navigate(`/admin/quotes/${quoteId}/contract/${data.id}`);
  }

  // ── Derive line items for pricing engine ───────────────────────────────
  const totalEntrants = numEntries + multiEventPlayers;

  function qtyForUnit(unit: ServiceRow["unit"], key: string): number {
    switch (unit) {
      case "per_day": return numDays;
      case "per_event": return numEvents;
      case "per_entrant": return totalEntrants;
      case "per_player": return numEntries;
      case "flat": return 1;
      case "each": return lineStates[key]?.qty ?? 1;
    }
  }

  // Effective unit price for a service (considering override)
  function effectivePrice(key: string, catalogPrice: number): number {
    const override = lineStates[key]?.overridePriceCents;
    if (override !== "" && override !== undefined) {
      const parsed = parseInt(override, 10);
      if (!isNaN(parsed) && parsed >= 0) return parsed;
    }
    return catalogPrice;
  }

  // Organizer revenue (for % of revenue mode)
  const organizerRevenueCents =
    numEntries * (firstEventFee * 100) +
    multiEventPlayers * (additionalEventFee * 100);

  const lineItems = useMemo<QuoteLineInput[]>(() => {
    return catalog
      .filter((svc) => {
        if (!selected[svc.key]) return false;
        if (svc.key === "onsite_mgmt_day" && onsiteMgmtMode === "pct_revenue") return false;
        return true;
      })
      .map((svc) => ({
        key: svc.key,
        label: svc.name,
        qty: qtyForUnit(svc.unit, svc.key),
        unitPriceCents: effectivePrice(svc.key, svc.unit_price_cents),
        passThroughCostCents: lineStates[svc.key]?.passThroughCostCents ?? 0,
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, selected, lineStates, numDays, numEvents, totalEntrants, onsiteMgmtMode]);

  // On-site pct mode: virtual line item
  const onsitePctLineCents = Math.round(organizerRevenueCents * onsitePct / 100);

  const allLineItems = useMemo<QuoteLineInput[]>(() => {
    if (onsiteMgmtMode === "pct_revenue" && selected["onsite_mgmt_day"]) {
      return [
        ...lineItems,
        {
          key: "onsite_mgmt_pct",
          label: `On-site management (${onsitePct}% of revenue)`,
          qty: 1,
          unitPriceCents: onsitePctLineCents,
          passThroughCostCents: 0,
        },
      ];
    }
    return lineItems;
  }, [lineItems, onsiteMgmtMode, selected, onsitePct, onsitePctLineCents]);

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
        lineItems: allLineItems,
      }),
    [numDays, numEvents, numEntries, multiEventPlayers, platform, distanceMiles, firstEventFee, additionalEventFee, allLineItems]
  );

  // ── Save ───────────────────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    setSavedMsg(null);

    try {
      let finalQuoteId = quoteId as string;

      if (isNew) {
        // Create customer if name+email provided
        let customerId: string | null = null;
        if (customerName.trim() && customerEmail.trim()) {
          const { data: cust, error: custErr } = await supabase
            .from("quote_customers")
            .insert({
              name: customerName.trim(),
              email: customerEmail.trim(),
              phone: customerPhone.trim() || null,
              org_name: customerOrg.trim() || null,
            })
            .select("id")
            .single();
          if (custErr || !cust) throw custErr ?? new Error("Customer insert failed");
          customerId = cust.id;
        }

        // Create quote
        const { data: newQuote, error: quoteErr } = await supabase
          .from("quotes")
          .insert({
            customer_id: customerId,
            status,
            source: "admin",
            event_name: eventName.trim() || null,
            event_dates: eventDates.trim() || null,
            num_days: numDays,
            distance_miles: distanceMiles,
            platform,
            num_events: numEvents,
            num_entries: numEntries,
            multi_event_players: multiEventPlayers,
            first_event_fee_cents: Math.round(firstEventFee * 100),
            additional_event_fee_cents: Math.round(additionalEventFee * 100),
          })
          .select("id")
          .single();
        if (quoteErr || !newQuote) throw quoteErr ?? new Error("Quote insert failed");
        finalQuoteId = newQuote.id;
      } else {
        // Update event basics on existing quote
        const { error: updateErr } = await supabase
          .from("quotes")
          .update({
            status,
            event_name: eventName.trim() || null,
            event_dates: eventDates.trim() || null,
            num_days: numDays,
            distance_miles: distanceMiles,
            platform,
            num_events: numEvents,
            num_entries: numEntries,
            multi_event_players: multiEventPlayers,
            first_event_fee_cents: Math.round(firstEventFee * 100),
            additional_event_fee_cents: Math.round(additionalEventFee * 100),
          })
          .eq("id", finalQuoteId);
        if (updateErr) throw updateErr;

        // Mark prior revisions as not current
        const { error: markErr } = await supabase
          .from("quote_revisions")
          .update({ is_current: false })
          .eq("quote_id", finalQuoteId)
          .eq("is_current", true);
        if (markErr) throw markErr;
      }

      // Determine next revision number
      const { data: existingRevs } = await supabase
        .from("quote_revisions")
        .select("revision_number")
        .eq("quote_id", finalQuoteId)
        .order("revision_number", { ascending: false })
        .limit(1);
      const nextRevNum = existingRevs && existingRevs.length > 0
        ? existingRevs[0].revision_number + 1
        : 1;

      // Insert new revision
      const { data: revision, error: revErr } = await supabase
        .from("quote_revisions")
        .insert({
          quote_id: finalQuoteId,
          revision_number: nextRevNum,
          created_by: "admin",
          subtotal_cents: quote.wmpcTotalCents,
          estimated_revenue_cents: quote.organizerRevenueCents,
          estimated_net_cents: quote.estimatedNetCents,
          is_current: true,
        })
        .select("id")
        .single();
      if (revErr || !revision) throw revErr ?? new Error("Revision insert failed");

      // Insert line items for this revision
      const lineItemRows = [
        ...quote.lines.map((l) => ({
          revision_id: revision.id,
          service_key: l.key,
          label: l.label,
          qty: l.qty,
          unit_price_cents: l.unitPriceCents,
          passthrough_cost_cents: l.passThroughCostCents ?? 0,
          line_total_cents: l.lineTotalCents,
        })),
        // Travel as a virtual line item if flagged
        ...(quote.travel.flagged
          ? [{
              revision_id: revision.id,
              service_key: "travel",
              label: "Travel (lodging + per diem + mileage)",
              qty: 1,
              unit_price_cents: quote.travel.totalCents,
              passthrough_cost_cents: 0,
              line_total_cents: quote.travel.totalCents,
            }]
          : []),
      ];

      if (lineItemRows.length > 0) {
        const { error: lineErr } = await supabase.from("quote_line_items").insert(lineItemRows);
        if (lineErr) throw lineErr;
      }

      setSavedMsg(`Revision ${nextRevNum} saved.`);
      if (isNew) {
        navigate(`/admin/quotes/${finalQuoteId}`);
      } else {
        // Reload quote to show updated revision history
        window.location.reload();
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  // ── Guard ──────────────────────────────────────────────────────────────
  if (isPlatformAdmin === null || (loadingQuote && !isNew)) {
    return <div style={{ padding: 24, color: inkSoft, fontSize: 14, fontFamily: bodyFontStack }}>Loading…</div>;
  }
  if (!isPlatformAdmin) {
    return (
      <main style={{ padding: 24, maxWidth: 600, margin: "0 auto", fontFamily: bodyFontStack }}>
        <h1 style={{ ...pageH1Style, fontSize: 20, marginTop: 0 }}>Access denied</h1>
        <Link to="/admin/quotes" style={breadcrumbLinkStyle}>← Back to quotes</Link>
      </main>
    );
  }
  if (loadError) {
    return (
      <main style={{ padding: 24, maxWidth: 600, margin: "0 auto", fontFamily: bodyFontStack }}>
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 16 }}>{loadError}</div>
        <Link to="/admin/quotes" style={breadcrumbLinkStyle}>← Back to quotes</Link>
      </main>
    );
  }

  const revisions = (quoteData?.quote_revisions ?? []).slice().sort((a, b) => b.revision_number - a.revision_number);
  const grouped = CATEGORY_ORDER.reduce((acc, cat) => {
    acc[cat] = catalog.filter((s) => s.category === cat);
    return acc;
  }, {} as Record<ServiceCategory, ServiceRow[]>);

  // Revision viewer
  if (viewingRevision) {
    return (
      <main style={{ padding: "24px 24px 48px", maxWidth: 860, margin: "0 auto", fontFamily: bodyFontStack }}>
        <div style={{ marginBottom: 16, display: "flex", gap: 12, alignItems: "center" }}>
          <button onClick={() => setViewingRevision(null)} style={{ ...breadcrumbLinkStyle, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            ← Back to editor
          </button>
        </div>
        <h1 style={{ ...pageH1Style, fontSize: 22, marginTop: 0, marginBottom: 4 }}>
          Revision #{viewingRevision.revision_number} (read-only)
        </h1>
        <p style={{ fontSize: 13, color: inkMuted, margin: "0 0 20px" }}>
          Created {new Date(viewingRevision.created_at).toLocaleString()} by {viewingRevision.created_by}
        </p>
        <div style={{ ...panelStyle, marginBottom: 16 }}>
          {viewingRevision.quote_line_items.length === 0 ? (
            <p style={{ color: inkMuted, fontSize: 14, margin: 0 }}>No line items in this revision.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${rule}` }}>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontSize: 12, color: inkMuted }}>Service</th>
                  <th style={{ textAlign: "right", padding: "6px 8px", fontSize: 12, color: inkMuted }}>Qty</th>
                  <th style={{ textAlign: "right", padding: "6px 8px", fontSize: 12, color: inkMuted }}>Unit price</th>
                  <th style={{ textAlign: "right", padding: "6px 8px", fontSize: 12, color: inkMuted }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {viewingRevision.quote_line_items.map((li) => (
                  <tr key={li.id} style={{ borderBottom: `1px solid ${ruleSoft}` }}>
                    <td style={{ padding: "8px 8px", color: ink }}>{li.label}</td>
                    <td style={{ padding: "8px 8px", textAlign: "right", color: inkSoft }}>{li.qty}</td>
                    <td style={{ padding: "8px 8px", textAlign: "right", color: inkSoft }}>{formatDollars(li.unit_price_cents)}</td>
                    <td style={{ padding: "8px 8px", textAlign: "right", fontWeight: 600, color: ink }}>{formatDollars(li.line_total_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <SummaryCell label="WMPC cost" value={formatDollars(viewingRevision.subtotal_cents)} color={courtYellow} />
          <SummaryCell label="Organizer revenue" value={formatDollars(viewingRevision.estimated_revenue_cents)} color={courtGreen} />
          <SummaryCell label="Estimated net" value={formatDollars(viewingRevision.estimated_net_cents)} color={viewingRevision.estimated_net_cents >= 0 ? courtGreen : courtRed} />
        </div>
      </main>
    );
  }

  return (
    <main style={{ padding: "24px 24px 120px", maxWidth: 900, margin: "0 auto", fontFamily: bodyFontStack }}>
      <div style={{ marginBottom: 16 }}>
        <Link to="/admin/quotes" style={breadcrumbLinkStyle}>← Back to quotes</Link>
      </div>

      <h1 style={{ ...pageH1Style, fontSize: 24, marginTop: 0, marginBottom: 20 }}>
        {isNew ? "Start a quote" : (quoteData?.event_name || "Edit quote")}
      </h1>

      {catalogError && (
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 16 }}>{catalogError}</div>
      )}
      {saveError && (
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 16 }}>{saveError}</div>
      )}
      {savedMsg && (
        <div style={{ ...statusPanelStyle("success"), marginBottom: 16 }}>{savedMsg}</div>
      )}

      {/* ── Status ── */}
      <div style={{ ...panelMutedStyle, marginBottom: 20 }}>
        <h2 style={{ ...sectionH2Style, marginTop: 0, fontSize: 14 }}>Status</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setStatus(opt.value)}
              style={{
                padding: "6px 14px",
                borderRadius: 20,
                border: `1px solid ${status === opt.value ? ink : rule}`,
                background: status === opt.value ? ink : "transparent",
                color: status === opt.value ? "#fff" : inkSoft,
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: bodyFontStack,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Event basics ── */}
      <section style={{ ...panelStyle, marginBottom: 20 }}>
        <h2 style={{ ...sectionH2Style, marginTop: 0 }}>Event details</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0 20px" }}>
          <FieldRow label="Event name">
            <input style={inputStyle} type="text" value={eventName} onChange={(e) => setEventName(e.target.value)} placeholder="Summer Classic 2026" />
          </FieldRow>
          <FieldRow label="Event dates">
            <input style={inputStyle} type="text" value={eventDates} onChange={(e) => setEventDates(e.target.value)} placeholder="July 12–13, 2026" />
          </FieldRow>
          <FieldRow label="Days">
            <input style={inputStyle} type="number" min={1} max={7} value={numDays} onChange={(e) => setNumDays(Math.max(1, Number(e.target.value)))} />
          </FieldRow>
          <FieldRow label="Events / divisions">
            <input style={inputStyle} type="number" min={1} value={numEvents} onChange={(e) => setNumEvents(Math.max(1, Number(e.target.value)))} />
          </FieldRow>
          <FieldRow label="Expected players">
            <input style={inputStyle} type="number" min={0} value={numEntries} onChange={(e) => setNumEntries(Math.max(0, Number(e.target.value)))} />
          </FieldRow>
          <FieldRow label="Players in 2+ events">
            <input style={inputStyle} type="number" min={0} value={multiEventPlayers} onChange={(e) => setMultiEventPlayers(Math.max(0, Number(e.target.value)))} />
          </FieldRow>
          <FieldRow label="Distance (miles)">
            <input style={inputStyle} type="number" min={0} value={distanceMiles} onChange={(e) => setDistanceMiles(Math.max(0, Number(e.target.value)))} />
            {distanceMiles > LOCAL_RADIUS_MILES && (
              <p style={{ margin: "4px 0 0", fontSize: 12, color: inkMuted }}>Travel cost will be included.</p>
            )}
          </FieldRow>
          <FieldRow label="Platform">
            <select
              style={{ ...inputStyle, cursor: "pointer" }}
              value={platform}
              onChange={(e) => setPlatform(e.target.value as QuotePlatform)}
            >
              <option value="bertanderne">bert & erne</option>
              <option value="pickleballbrackets">PickleballBrackets</option>
            </select>
          </FieldRow>
        </div>
        <div style={{ borderTop: `1px solid ${rule}`, paddingTop: 14, marginTop: 4 }}>
          <p style={{ fontSize: 12, fontWeight: 700, color: inkMuted, textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 12px" }}>Organizer registration pricing</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0 20px" }}>
            <FieldRow label="First event fee ($)">
              <input style={inputStyle} type="number" min={0} value={firstEventFee} onChange={(e) => setFirstEventFee(Math.max(0, Number(e.target.value)))} />
            </FieldRow>
            <FieldRow label="Additional event fee ($)">
              <input style={inputStyle} type="number" min={0} value={additionalEventFee} onChange={(e) => setAdditionalEventFee(Math.max(0, Number(e.target.value)))} />
            </FieldRow>
          </div>
        </div>
      </section>

      {/* ── Customer (new only) ── */}
      {isNew && (
        <section style={{ ...panelStyle, marginBottom: 20 }}>
          <h2 style={{ ...sectionH2Style, marginTop: 0 }}>Customer (optional)</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0 20px" }}>
            <FieldRow label="Name">
              <input style={inputStyle} type="text" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Jane Smith" />
            </FieldRow>
            <FieldRow label="Email">
              <input style={inputStyle} type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} placeholder="jane@example.com" />
            </FieldRow>
            <FieldRow label="Phone">
              <input style={inputStyle} type="tel" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="(603) 555-0100" />
            </FieldRow>
            <FieldRow label="Organization">
              <input style={inputStyle} type="text" value={customerOrg} onChange={(e) => setCustomerOrg(e.target.value)} placeholder="Seacoast Pickleball" />
            </FieldRow>
          </div>
        </section>
      )}

      {/* ── Line items / services ── */}
      <section style={{ ...panelStyle, marginBottom: 20 }}>
        <h2 style={{ ...sectionH2Style, marginTop: 0 }}>Services</h2>
        <p style={{ fontSize: 13, color: inkSoft, margin: "0 0 16px" }}>
          Check services, override unit prices, and adjust quantities. "Override price" is empty = use catalog rate.
        </p>

        {CATEGORY_ORDER.map((cat) => {
          const services = grouped[cat];
          if (!services || services.length === 0) return null;
          return (
            <div key={cat} style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: inkMuted, margin: "0 0 6px" }}>
                {CATEGORY_LABELS[cat]}
              </p>
              <div style={{ border: `1px solid ${ruleSoft}`, borderRadius: 8, overflow: "hidden" }}>
                {services.map((svc, i) => {
                  const isChecked = !!selected[svc.key];
                  const ls = lineStates[svc.key];
                  const isOnsiteDay = svc.key === "onsite_mgmt_day";

                  return (
                    <div key={svc.key}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "10px 14px",
                          background: isChecked ? infoBg : "#fff",
                          borderTop: i > 0 ? `1px solid ${ruleSoft}` : "none",
                          cursor: "pointer",
                        }}
                        onClick={() => setSelected((prev) => ({ ...prev, [svc.key]: !prev[svc.key] }))}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {}}
                          style={{ cursor: "pointer", flexShrink: 0 }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontSize: 14, fontWeight: 500, color: ink }}>{svc.name}</span>
                          {svc.plus_passthrough_cost && (
                            <span style={{ fontSize: 12, color: inkMuted, marginLeft: 6 }}>+ materials cost</span>
                          )}
                        </div>
                        <div
                          style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {/* Qty input for "each" units */}
                          {isChecked && svc.unit === "each" && (
                            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                              <label style={{ fontSize: 12, color: inkMuted }}>Qty</label>
                              <input
                                type="number"
                                min={1}
                                value={ls?.qty ?? 1}
                                onChange={(e) =>
                                  setLineStates((prev) => ({
                                    ...prev,
                                    [svc.key]: { ...prev[svc.key], qty: Math.max(1, Number(e.target.value)) },
                                  }))
                                }
                                style={{ width: 60, padding: "4px 8px", fontSize: 13, border: `1px solid ${rule}`, borderRadius: 4, fontFamily: bodyFontStack }}
                              />
                            </div>
                          )}
                          {/* Auto qty hint */}
                          {isChecked && svc.unit !== "each" && (
                            <span style={{ fontSize: 12, color: inkMuted, fontStyle: "italic" }}>
                              ×{qtyForUnit(svc.unit, svc.key)}
                            </span>
                          )}
                          {/* Price override */}
                          {isChecked && (
                            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                              <label style={{ fontSize: 12, color: inkMuted }}>$</label>
                              <input
                                type="number"
                                min={0}
                                placeholder={(svc.unit_price_cents / 100).toFixed(0)}
                                value={ls?.overridePriceCents ?? ""}
                                onChange={(e) =>
                                  setLineStates((prev) => ({
                                    ...prev,
                                    [svc.key]: { ...prev[svc.key], overridePriceCents: e.target.value },
                                  }))
                                }
                                style={{ width: 80, padding: "4px 8px", fontSize: 13, border: `1px solid ${ls?.overridePriceCents ? courtBlue : rule}`, borderRadius: 4, fontFamily: bodyFontStack }}
                                title="Override unit price (leave empty for catalog rate)"
                              />
                            </div>
                          )}
                          {/* Line total */}
                          <span style={{ fontSize: 13, fontWeight: 600, color: isChecked ? courtBlue : inkMuted, minWidth: 64, textAlign: "right" }}>
                            {isChecked
                              ? formatDollars(qtyForUnit(svc.unit, svc.key) * effectivePrice(svc.key, svc.unit_price_cents))
                              : formatDollars(svc.unit_price_cents) + "/" + svc.unit.replace("per_", "")}
                          </span>
                        </div>
                      </div>

                      {/* On-site management toggle */}
                      {isOnsiteDay && isChecked && (
                        <div
                          style={{ padding: "8px 14px 10px 38px", background: infoBg, borderTop: `1px solid ${ruleSoft}` }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: inkSoft }}>Mode:</span>
                            {(["per_day", "pct_revenue"] as const).map((mode) => (
                              <label key={mode} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, color: ink, cursor: "pointer" }}>
                                <input
                                  type="radio"
                                  name="onsite-mode"
                                  checked={onsiteMgmtMode === mode}
                                  onChange={() => setOnsiteMgmtMode(mode)}
                                />
                                {mode === "per_day" ? "Flat per day" : "% of organizer revenue"}
                              </label>
                            ))}
                            {onsiteMgmtMode === "pct_revenue" && (
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <input
                                  type="number"
                                  min={0}
                                  max={100}
                                  step={0.5}
                                  value={onsitePct}
                                  onChange={(e) => setOnsitePct(Math.max(0, Math.min(100, Number(e.target.value))))}
                                  style={{ width: 64, padding: "4px 8px", fontSize: 13, border: `1px solid ${rule}`, borderRadius: 4, fontFamily: bodyFontStack }}
                                />
                                <span style={{ fontSize: 13, color: inkSoft }}>%</span>
                                <span style={{ fontSize: 12, color: inkMuted }}>
                                  = {formatDollars(onsitePctLineCents)}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </section>

      {/* ── Revision history ── */}
      {!isNew && revisions.length > 0 && (
        <section style={{ ...panelMutedStyle, marginBottom: 20 }}>
          <h2 style={{ ...sectionH2Style, marginTop: 0, fontSize: 14 }}>Revision history</h2>
          <div style={{ border: `1px solid ${rule}`, borderRadius: 8, overflow: "hidden" }}>
            {revisions.map((rev, i) => (
              <div
                key={rev.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 14px",
                  borderTop: i > 0 ? `1px solid ${ruleSoft}` : "none",
                  background: rev.is_current ? infoBg : "#fff",
                }}
              >
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: ink }}>
                    Rev #{rev.revision_number}
                    {rev.is_current && <span style={{ marginLeft: 6, fontSize: 11, color: courtGreen }}>current</span>}
                  </span>
                  <span style={{ fontSize: 12, color: inkMuted, marginLeft: 10 }}>
                    {new Date(rev.created_at).toLocaleString()} · by {rev.created_by}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: ink }}>{formatDollars(rev.subtotal_cents)}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: rev.estimated_net_cents >= 0 ? courtGreen : courtRed }}>
                    net {formatDollars(rev.estimated_net_cents)}
                  </span>
                  <button
                    onClick={() => setViewingRevision(rev)}
                    style={{ ...breadcrumbLinkStyle, background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 13 }}
                  >
                    View
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Share link ── */}
      {!isNew && shareTokenLoaded && (
        <section style={{ ...panelMutedStyle, marginBottom: 20 }}>
          <h2 style={{ ...sectionH2Style, marginTop: 0, fontSize: 14 }}>Customer share link</h2>
          <p style={{ fontSize: 13, color: inkSoft, margin: "0 0 12px" }}>
            Send this link to the customer so they can review and customize their quote — no login required.
          </p>
          {shareTokenError && (
            <div style={{ ...statusPanelStyle("danger"), marginBottom: 12 }}>{shareTokenError}</div>
          )}
          {shareToken ? (
            <div>
              <div style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 14px",
                background: "#fff",
                border: `1px solid ${rule}`,
                borderRadius: 8,
                marginBottom: 10,
                flexWrap: "wrap",
              }}>
                <code style={{ fontSize: 13, color: ink, flex: 1, wordBreak: "break-all", fontFamily: "monospace" }}>
                  {window.location.origin}/q/{shareToken.token}
                </code>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(`${window.location.origin}/q/${shareToken.token}`);
                  }}
                  style={{ ...ctaSecondaryStyle, fontSize: 12, padding: "5px 12px", flexShrink: 0 }}
                >
                  Copy
                </button>
              </div>
              <button
                onClick={handleRevokeShareLink}
                disabled={revokingToken}
                style={{
                  fontSize: 12,
                  color: courtRed,
                  background: "none",
                  border: `1px solid ${courtRed}`,
                  borderRadius: 6,
                  padding: "5px 12px",
                  cursor: revokingToken ? "not-allowed" : "pointer",
                  fontFamily: bodyFontStack,
                  opacity: revokingToken ? 0.5 : 1,
                }}
              >
                {revokingToken ? "Revoking…" : "Revoke link"}
              </button>
            </div>
          ) : (
            <button
              onClick={handleGenerateShareLink}
              disabled={generatingToken}
              style={generatingToken ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
            >
              {generatingToken ? "Generating…" : "Generate share link"}
            </button>
          )}
        </section>
      )}

      {/* ── Contracts (accepted quotes only) ── */}
      {!isNew && status === "accepted" && (
        <section style={{ ...panelMutedStyle, marginBottom: 20 }}>
          <h2 style={{ ...sectionH2Style, marginTop: 0, fontSize: 14 }}>Contracts</h2>
          <p style={{ fontSize: 13, color: inkSoft, margin: "0 0 12px" }}>
            Generate an independent-contractor agreement from the current accepted revision. Download or print it as a PDF.
          </p>
          {contractError && (
            <div style={{ ...statusPanelStyle("danger"), marginBottom: 12 }}>{contractError}</div>
          )}
          {contracts.length > 0 && (
            <div style={{ border: `1px solid ${rule}`, borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
              {contracts.map((c, i) => (
                <div
                  key={c.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 14px",
                    borderTop: i > 0 ? `1px solid ${ruleSoft}` : "none",
                    background: "#fff",
                    gap: 12,
                  }}
                >
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: ink }}>
                      {CONTRACT_STATUS_LABELS[c.status]}
                    </span>
                    <span style={{ fontSize: 12, color: inkMuted, marginLeft: 10 }}>
                      {new Date(c.generated_at).toLocaleString()} · terms {c.terms_version}
                    </span>
                  </div>
                  <Link
                    to={`/admin/quotes/${quoteId}/contract/${c.id}`}
                    style={{ ...breadcrumbLinkStyle, fontSize: 13 }}
                  >
                    View
                  </Link>
                </div>
              ))}
            </div>
          )}
          <button
            onClick={handleGenerateContract}
            disabled={generatingContract}
            style={generatingContract ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
          >
            {generatingContract ? "Generating…" : "Generate contract"}
          </button>
        </section>
      )}

      {/* ── Save button ── */}
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={saving ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
        >
          {saving ? "Saving…" : isNew ? "Create quote" : "Save revision"}
        </button>
        <Link to="/admin/quotes" style={ctaSecondaryStyle}>Cancel</Link>
      </div>

      {/* ── Sticky totals bar ── */}
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
        <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
          <SummaryCell label="WMPC cost" value={formatDollars(quote.wmpcTotalCents)} color={courtYellow} />
          <SummaryCell label="Organizer revenue" value={formatDollars(quote.organizerRevenueCents)} color={courtGreen} />
          <SummaryCell label="Estimated net" value={formatDollars(quote.estimatedNetCents)} color={quote.estimatedNetCents >= 0 ? courtGreen : "#e05050"} />
          {quote.travel.flagged && (
            <span style={{ fontSize: 11, color: courtYellow, fontFamily: bodyFontStack, opacity: 0.8, maxWidth: 160, lineHeight: 1.3 }}>
              ⚠ Travel est. included ({formatDollars(quote.travel.totalCents)})
            </span>
          )}
        </div>
      </div>
    </main>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: inkSoft, marginBottom: 4, fontFamily: bodyFontStack }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function SummaryCell({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color, fontFamily: bodyFontStack, opacity: 0.85 }}>
        {label}
      </span>
      <span style={{ fontSize: 22, fontWeight: 700, color, fontFamily: headingFontStack, letterSpacing: "0.02em", lineHeight: 1 }}>
        {value}
      </span>
    </div>
  );
}
