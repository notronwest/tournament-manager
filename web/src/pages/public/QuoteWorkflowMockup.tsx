import { useState, type CSSProperties, type ReactNode } from "react";
import SiteFooter from "../../components/SiteFooter";
import {
  ink,
  inkSoft,
  inkMuted,
  rule,
  ruleSoft,
  cream,
  courtBlue,
  courtGreen,
  successBg,
  warnBg,
  warnFg,
  bodyFontStack,
  headingFontStack,
  displayFontStack,
  pageWrapStyle,
  contentColStyle,
  panelStyle,
  ctaPrimaryStyle,
  ctaSecondaryStyle,
  statusPanelStyle,
  inputStyle,
} from "../../lib/publicTheme";

// ─────────────────────────────────────────────────────────────────────
// MOCKUP of the redesigned quote / opportunity workflow page. Sample data,
// local state only — nothing is persisted. Route: /mockups/quote-workflow.
// Goal: a step-GATED flow with prominent MANUAL stage control, a read-only
// summary that only becomes editable on demand, and a thorough activity
// timeline (created · edited · sent · accepted · signed — with when + who).
// ─────────────────────────────────────────────────────────────────────

type Stage = "new" | "drafting" | "quoted" | "accepted" | "signed" | "setup";

const STAGES: { id: Stage; label: string }[] = [
  { id: "new", label: "New" },
  { id: "drafting", label: "Drafting" },
  { id: "quoted", label: "Quoted" },
  { id: "accepted", label: "Accepted" },
  { id: "signed", label: "Signed" },
  { id: "setup", label: "Setup" },
];

// What the admin should do at each stage.
const NEXT_STEP: Record<Stage, { title: string; body: string; actions: string[] }> = {
  new: { title: "New inquiry", body: "A customer asked for a quote. Draft one from their request.", actions: ["Start drafting"] },
  drafting: { title: "Draft in progress", body: "Price it up, then send it to the customer for review.", actions: ["Send to customer"] },
  quoted: { title: "Waiting on the customer", body: "Sent Aug 12. They can accept, decline, or reply with changes.", actions: ["Mark accepted", "Mark declined"] },
  accepted: { title: "Accepted — get it signed", body: "Generate the agreement and send it. Mark it signed once you have a copy.", actions: ["Generate contract", "Mark signed"] },
  signed: { title: "Signed — ready to set up", body: "You have a signed agreement. Kick off the setup intake to gather every tournament detail.", actions: ["Start setup"] },
  setup: { title: "In setup", body: "The customer is filling out the tournament details. Review as they come in.", actions: ["Open setup intake"] },
};

// Sample activity — chronological, newest last. `who`: you / customer / system.
type Activity = { icon: string; label: string; detail?: string; when: string; who: "you" | "customer" | "system" };
const ACTIVITY: Activity[] = [
  { icon: "✦", label: "Opportunity created", detail: "from a public quote request", when: "Aug 10, 9:04 AM", who: "customer" },
  { icon: "✎", label: "Quote drafted — revision 1", detail: "$2,150 estimated", when: "Aug 10, 2:20 PM", who: "you" },
  { icon: "✉", label: "Sent to customer", detail: "share link generated", when: "Aug 11, 8:15 AM", who: "you" },
  { icon: "↩", label: "Customer replied — revision 2", detail: "asked to drop event theme design", when: "Aug 12, 7:41 AM", who: "customer" },
  { icon: "✎", label: "Re-priced — revision 3", detail: "$2,050 estimated", when: "Aug 12, 10:02 AM", who: "you" },
  { icon: "✉", label: "Sent to customer", detail: "updated quote", when: "Aug 12, 10:05 AM", who: "you" },
  { icon: "✓", label: "Marked accepted", when: "Aug 13, 4:30 PM", who: "you" },
  { icon: "📄", label: "Contract generated", when: "Aug 13, 4:33 PM", who: "you" },
  { icon: "✍", label: "Signed agreement received", when: "Aug 14, 11:10 AM", who: "you" },
];

const stageIndex = (s: Stage) => STAGES.findIndex((x) => x.id === s);

export default function QuoteWorkflowMockup() {
  const [stage, setStage] = useState<Stage>("quoted");
  const [editing, setEditing] = useState(false);
  const curIdx = stageIndex(stage);
  const step = NEXT_STEP[stage];

  return (
    <div style={pageWrapStyle}>
      <main style={{ ...contentColStyle(920), padding: "32px 20px 120px" }}>
        <div style={{ fontSize: 13, color: courtBlue, marginBottom: 8 }}>← Back to opportunities</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ fontFamily: displayFontStack, fontSize: 28, color: ink, margin: 0 }}>Summer Slam Concord</h1>
          <div style={{ fontSize: 13, color: inkMuted }}>MOCKUP · sample data</div>
        </div>
        <div style={{ fontSize: 14, color: inkSoft, marginTop: 4 }}>
          Jane Rivera · Concord Rec Dept · Aug 23–24 · 10 divisions
        </div>

        {/* ── Stage stepper — click a step to move the opportunity ─────────── */}
        <div style={{ ...panelStyle, marginTop: 20, padding: "18px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: inkSoft, fontFamily: headingFontStack }}>
              Stage
            </div>
            <div style={{ fontSize: 12, color: inkMuted }}>Click a step to move this opportunity there</div>
          </div>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 0, overflowX: "auto" }}>
            {STAGES.map((s, i) => {
              const done = i < curIdx;
              const active = i === curIdx;
              const color = done ? courtGreen : active ? courtBlue : inkMuted;
              return (
                <div key={s.id} style={{ display: "flex", alignItems: "flex-start", flex: 1, minWidth: 92 }}>
                  <button
                    type="button"
                    onClick={() => setStage(s.id)}
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flex: 1, fontFamily: bodyFontStack }}
                    title={`Move to ${s.label}`}
                  >
                    <span
                      style={{
                        width: 30, height: 30, borderRadius: 999, display: "inline-flex", alignItems: "center", justifyContent: "center",
                        fontSize: 13, fontWeight: 700,
                        background: done ? courtGreen : active ? courtBlue : "#fff",
                        color: done || active ? "#fff" : inkMuted,
                        border: `2px solid ${done ? courtGreen : active ? courtBlue : rule}`,
                      }}
                    >
                      {done ? "✓" : i + 1}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: active ? 700 : 500, color: active ? ink : color, whiteSpace: "nowrap" }}>{s.label}</span>
                  </button>
                  {i < STAGES.length - 1 && (
                    <span style={{ flex: "0 0 auto", height: 2, width: 18, background: i < curIdx ? courtGreen : rule, marginTop: 15 }} />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Next step — gates the workflow ──────────────────────────────── */}
        <div style={{ ...statusPanelStyle(stage === "signed" || stage === "setup" ? "success" : "info"), marginTop: 16, padding: "16px 18px" }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: inkSoft, marginBottom: 6, fontFamily: headingFontStack }}>
            Next step
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, color: ink }}>{step.title}</div>
          <div style={{ fontSize: 13.5, color: inkSoft, margin: "4px 0 12px", lineHeight: 1.5 }}>{step.body}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {step.actions.map((a, i) => (
              <button key={a} type="button" style={i === 0 ? primaryBtn : secondaryBtn} onClick={() => advance(stage, setStage)}>
                {a}
              </button>
            ))}
          </div>
        </div>

        {/* ── Two columns: read-only quote summary + activity timeline ─────── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, marginTop: 16, alignItems: "start" }}>
          {/* Quote summary — read-only until you click Edit */}
          <section style={{ ...panelStyle, padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <SectionTitle>Quote · revision 3</SectionTitle>
              {!editing ? (
                <button type="button" style={miniBtn} onClick={() => setEditing(true)}>Edit quote</button>
              ) : (
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" style={{ ...miniBtn, ...primaryBtnMini }} onClick={() => setEditing(false)}>Save revision 4</button>
                  <button type="button" style={miniBtn} onClick={() => setEditing(false)}>Cancel</button>
                </div>
              )}
            </div>
            <div style={{ fontSize: 12.5, color: inkMuted, marginBottom: 14 }}>
              {editing ? "Editing — saving records a new revision." : "The current quote. Read-only — click Edit to make changes."}
            </div>

            {editing && (
              <div style={{ ...statusPanelStyle("warn"), fontSize: 12.5, marginBottom: 14 }}>
                You're editing the working draft. This is the only editable part of the page.
              </div>
            )}

            <SummaryGrid editing={editing} />

            <div style={{ borderTop: `1px solid ${ruleSoft}`, marginTop: 14, paddingTop: 12, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 13, color: inkSoft }}>Estimated to customer</span>
              <span style={{ fontSize: 20, fontWeight: 700, color: ink, fontFamily: displayFontStack }}>$2,050</span>
            </div>
          </section>

          {/* Activity timeline */}
          <section style={{ ...panelStyle, padding: 20 }}>
            <SectionTitle>Activity</SectionTitle>
            <div style={{ fontSize: 12.5, color: inkMuted, marginBottom: 16 }}>
              Everything that's happened — created, edited, sent, and signed.
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {ACTIVITY.map((a, i) => (
                <div key={i} style={{ display: "flex", gap: 12 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <span style={{ width: 26, height: 26, borderRadius: 999, background: whoBg(a.who), color: whoColor(a.who), display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>
                      {a.icon}
                    </span>
                    {i < ACTIVITY.length - 1 && <span style={{ width: 2, flex: 1, minHeight: 14, background: ruleSoft }} />}
                  </div>
                  <div style={{ paddingBottom: 16 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: ink }}>{a.label}</div>
                    {a.detail && <div style={{ fontSize: 12.5, color: inkSoft, marginTop: 1 }}>{a.detail}</div>}
                    <div style={{ fontSize: 12, color: inkMuted, marginTop: 2 }}>
                      {a.when} · {a.who === "you" ? "You" : a.who === "customer" ? "Customer" : "System"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

// Advancing from the next-step buttons just moves to the following stage (mockup).
function advance(stage: Stage, setStage: (s: Stage) => void) {
  const i = stageIndex(stage);
  if (i < STAGES.length - 1) setStage(STAGES[i + 1].id);
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 style={{ fontFamily: headingFontStack, fontSize: 13, textTransform: "uppercase", letterSpacing: "0.06em", color: inkSoft, margin: 0 }}>
      {children}
    </h2>
  );
}

function SummaryGrid({ editing }: { editing: boolean }) {
  const fields: [string, string][] = [
    ["Event", "Summer Slam Concord"],
    ["Dates", "Aug 23–24 (2 days)"],
    ["Divisions", "10"],
    ["Expected players", "70"],
    ["Distance", "50 mi"],
    ["Services", "On-site mgmt, Registration, Setup, Flyer"],
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 16px" }}>
      {fields.map(([k, v]) => (
        <div key={k}>
          <div style={{ fontSize: 11, color: inkMuted, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>{k}</div>
          {editing ? (
            <input defaultValue={v} style={{ ...inputStyle, fontSize: 13, padding: "6px 8px" }} />
          ) : (
            <div style={{ fontSize: 13.5, color: ink }}>{v}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function whoBg(who: Activity["who"]): string {
  return who === "you" ? successBg : who === "customer" ? warnBg : cream;
}
function whoColor(who: Activity["who"]): string {
  return who === "you" ? courtGreen : who === "customer" ? warnFg : inkMuted;
}

const primaryBtn: CSSProperties = { ...ctaPrimaryStyle, fontSize: 13, padding: "9px 16px" };
const secondaryBtn: CSSProperties = { ...ctaSecondaryStyle, fontSize: 13, padding: "9px 16px" };
const miniBtn: CSSProperties = { ...ctaSecondaryStyle, fontSize: 12, padding: "5px 11px" };
const primaryBtnMini: CSSProperties = { ...ctaPrimaryStyle, fontSize: 12, padding: "5px 11px" };
