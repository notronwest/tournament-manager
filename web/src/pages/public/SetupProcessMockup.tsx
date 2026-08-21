import { useState } from "react";
import SiteFooter from "../../components/SiteFooter";
import {
  ink,
  inkSoft,
  inkMuted,
  rule,
  ruleSoft,
  courtBlue,
  courtGreen,
  successBg,
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
// MOCKUP — Setup as its OWN process/UI (integrated with the opportunity, not
// buried in the quote editor), + a place to MANAGE the setup questions you ask
// (establish & grow them; the customer form is built from these). Sample data,
// local state. Route: /mockups/setup.
// ─────────────────────────────────────────────────────────────────────

type Tab = "setup" | "questions";

export default function SetupProcessMockup() {
  const [tab, setTab] = useState<Tab>("setup");
  return (
    <div style={pageWrapStyle}>
      <main style={{ ...contentColStyle(920), padding: "32px 20px 120px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ fontFamily: displayFontStack, fontSize: 26, color: ink, margin: 0 }}>Tournament Setup</h1>
          <div style={{ fontSize: 13, color: inkMuted }}>MOCKUP · sample data</div>
        </div>
        <p style={{ fontSize: 14, color: inkSoft, margin: "6px 0 18px", maxWidth: 640, lineHeight: 1.5 }}>
          Setup is its own process — one per tournament, kicked off from a signed
          opportunity. Manage it here, and define the questions you ask organizers
          under <strong>Setup questions</strong>.
        </p>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${rule}`, marginBottom: 20 }}>
          {([["setup", "This setup"], ["questions", "Setup questions"]] as [Tab, string][]).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                background: "none", border: "none", cursor: "pointer", padding: "10px 14px",
                fontFamily: bodyFontStack, fontSize: 14, fontWeight: tab === id ? 700 : 500,
                color: tab === id ? ink : inkMuted,
                borderBottom: `2px solid ${tab === id ? courtBlue : "transparent"}`,
                marginBottom: -1,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "setup" ? <SetupDetail /> : <QuestionsManager />}
      </main>
      <SiteFooter />
    </div>
  );
}

// ─── Tab 1: a specific setup (the process) ───────────────────────────

const SETUP_STAGES = ["Sent", "Opened", "Submitted", "In review", "Complete"];

function SetupDetail() {
  const [stageIdx, setStageIdx] = useState(2); // Submitted
  const [copied, setCopied] = useState(false);
  const link = "bertanderne.com/setup/8f3a…c21";

  return (
    <>
      {/* Header row — linked to the opportunity */}
      <div style={{ ...panelStyle, padding: "16px 20px", marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: ink }}>Summer Slam Concord</div>
            <div style={{ fontSize: 13, color: inkSoft, marginTop: 2 }}>
              Concord Rec Dept · Aug 23–24 ·{" "}
              <a href="#" onClick={(e) => e.preventDefault()} style={{ color: courtBlue, textDecoration: "none" }}>
                ← from the signed opportunity
              </a>
            </div>
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, padding: "4px 10px", borderRadius: 999, background: successBg, color: courtGreen }}>
            {SETUP_STAGES[stageIdx]}
          </span>
        </div>
      </div>

      {/* Setup's own progress */}
      <div style={{ ...panelStyle, padding: "18px 20px", marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: inkSoft, marginBottom: 14, fontFamily: headingFontStack }}>
          Setup progress
        </div>
        <div style={{ display: "flex", overflowX: "auto" }}>
          {SETUP_STAGES.map((s, i) => (
            <div key={s} style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 96 }}>
              <button onClick={() => setStageIdx(i)} title={`Move to ${s}`} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flex: 1, fontFamily: bodyFontStack }}>
                <span style={{ width: 26, height: 26, borderRadius: 999, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, background: i < stageIdx ? courtGreen : i === stageIdx ? courtBlue : "#fff", color: i <= stageIdx ? "#fff" : inkMuted, border: `2px solid ${i < stageIdx ? courtGreen : i === stageIdx ? courtBlue : rule}` }}>
                  {i < stageIdx ? "✓" : i + 1}
                </span>
                <span style={{ fontSize: 11.5, fontWeight: i === stageIdx ? 700 : 500, color: i === stageIdx ? ink : inkMuted, whiteSpace: "nowrap" }}>{s}</span>
              </button>
              {i < SETUP_STAGES.length - 1 && <span style={{ height: 2, width: 14, background: i < stageIdx ? courtGreen : rule, marginTop: 13 }} />}
            </div>
          ))}
        </div>
      </div>

      {/* Customer link */}
      <div style={{ ...panelStyle, padding: "16px 20px", marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: ink, marginBottom: 8 }}>Organizer's setup link</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input readOnly value={link} style={{ ...inputStyle, flex: 1, minWidth: 220, fontSize: 13, color: inkSoft }} />
          <button style={{ ...ctaSecondaryStyle, fontSize: 13 }} onClick={() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {copied ? "Copied!" : "Copy link"}
          </button>
        </div>
        <div style={{ fontSize: 12, color: inkMuted, marginTop: 8 }}>Send this to the organizer however you like — they fill it out, answers land below.</div>
      </div>

      {/* Answers, grouped */}
      <div style={{ ...panelStyle, padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: inkSoft, fontFamily: headingFontStack }}>Their answers</div>
          <span style={{ fontSize: 12, color: inkMuted }}>9 of 14 answered</span>
        </div>
        <p style={{ fontSize: 12.5, color: inkMuted, margin: "0 0 16px" }}>Read-only — this is what the organizer submitted.</p>
        {ANSWER_GROUPS.map((g) => (
          <div key={g.title} style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: ink, marginBottom: 8 }}>{g.title}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px 20px" }}>
              {g.items.map(([q, a]) => (
                <div key={q}>
                  <div style={{ fontSize: 11.5, color: inkMuted, textTransform: "uppercase", letterSpacing: "0.03em" }}>{q}</div>
                  <div style={{ fontSize: 13.5, color: a ? ink : inkMuted, marginTop: 2 }}>{a || "— not answered"}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

const ANSWER_GROUPS: { title: string; items: [string, string][] }[] = [
  { title: "The basics", items: [["Venue", "Concord Community Center"], ["Courts", "8 indoor"], ["Check-in", "7:30 AM, main lobby"], ["Ball", "Franklin X-40"]] },
  { title: "Rules & the day", items: [["Outside food", "Yes"], ["Outside alcohol", "No"], ["Filming own games", "Yes"], ["Parking", "Lot B, free; overflow at the church"]] },
  { title: "Extras", items: [["Paddle raffle", "Yes — one/day"], ["MoneyBall game", "Saturday 2pm"], ["Prizes", ""], ["Sponsors", ""]] },
];

// ─── Tab 2: manage the setup questions (establish & grow) ────────────

type QType = "short" | "long" | "yesno" | "select" | "multi" | "number";
const TYPE_LABEL: Record<QType, string> = { short: "Short text", long: "Long text", yesno: "Yes / No", select: "Choose one", multi: "Choose many", number: "Number" };
type Question = { id: number; label: string; type: QType; required: boolean };
type Section = { id: number; title: string; questions: Question[] };

let uid = 100;
const INITIAL_SECTIONS: Section[] = [
  { id: 1, title: "The basics", questions: [
    { id: 11, label: "Venue name & address", type: "short", required: true },
    { id: 12, label: "Number of courts", type: "number", required: false },
    { id: 13, label: "Check-in location & time", type: "short", required: false },
  ]},
  { id: 2, title: "Events & format", questions: [
    { id: 21, label: "Which skill levels?", type: "short", required: false },
    { id: 22, label: "Is it DUPR rated?", type: "yesno", required: false },
    { id: 23, label: "Format per event", type: "select", required: false },
  ]},
  { id: 3, title: "Rules & the day", questions: [
    { id: 31, label: "Outside food allowed?", type: "yesno", required: false },
    { id: 32, label: "Outside alcohol allowed?", type: "yesno", required: false },
    { id: 33, label: "Can players film their own games?", type: "yesno", required: false },
    { id: 34, label: "Parking details", type: "long", required: false },
  ]},
  { id: 4, title: "Extras", questions: [
    { id: 41, label: "Want a MoneyBall game?", type: "yesno", required: false },
    { id: 42, label: "Prizes you're offering", type: "multi", required: false },
  ]},
];

function QuestionsManager() {
  const [sections, setSections] = useState<Section[]>(INITIAL_SECTIONS);

  const addQuestion = (sid: number) =>
    setSections((prev) => prev.map((s) => s.id === sid ? { ...s, questions: [...s.questions, { id: ++uid, label: "", type: "short", required: false }] } : s));
  const updateQuestion = (sid: number, qid: number, patch: Partial<Question>) =>
    setSections((prev) => prev.map((s) => s.id === sid ? { ...s, questions: s.questions.map((q) => q.id === qid ? { ...q, ...patch } : q) } : s));
  const removeQuestion = (sid: number, qid: number) =>
    setSections((prev) => prev.map((s) => s.id === sid ? { ...s, questions: s.questions.filter((q) => q.id !== qid) } : s));
  const addSection = () => setSections((prev) => [...prev, { id: ++uid, title: "New section", questions: [] }]);
  const updateSection = (sid: number, title: string) =>
    setSections((prev) => prev.map((s) => s.id === sid ? { ...s, title } : s));

  return (
    <>
      <div style={{ ...statusPanelStyle("info"), marginBottom: 18, fontSize: 13.5, lineHeight: 1.5 }}>
        These are the questions we ask organizers during setup. Add, rename, and reorder them —
        <strong> the customer's setup form is built from this list</strong>, so it grows as you do.
      </div>

      {sections.map((s) => (
        <section key={s.id} style={{ ...panelStyle, padding: 18, marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={{ color: inkMuted, cursor: "grab", fontSize: 15 }} title="Drag to reorder">⋮⋮</span>
            <input value={s.title} onChange={(e) => updateSection(s.id, e.target.value)} style={{ ...inputStyle, fontWeight: 700, fontSize: 15, border: "none", background: "transparent", padding: "2px 0", flex: 1 }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {s.questions.map((q) => (
              <div key={q.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: `1px solid ${ruleSoft}`, borderRadius: 8, background: "#fff", flexWrap: "wrap" }}>
                <span style={{ color: inkMuted, cursor: "grab" }} title="Drag to reorder">⋮⋮</span>
                <input value={q.label} placeholder="Question the organizer answers…" onChange={(e) => updateQuestion(s.id, q.id, { label: e.target.value })} style={{ ...inputStyle, flex: "1 1 220px", minWidth: 0, fontSize: 13.5, padding: "6px 8px" }} />
                <select value={q.type} onChange={(e) => updateQuestion(s.id, q.id, { type: e.target.value as QType })} style={{ ...inputStyle, width: 130, fontSize: 12.5, padding: "6px 8px" }}>
                  {(Object.keys(TYPE_LABEL) as QType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </select>
                <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, color: inkSoft, cursor: "pointer", whiteSpace: "nowrap" }}>
                  <input type="checkbox" checked={q.required} onChange={(e) => updateQuestion(s.id, q.id, { required: e.target.checked })} style={{ accentColor: courtGreen }} />
                  Required
                </label>
                <button onClick={() => removeQuestion(s.id, q.id)} title="Remove" style={{ background: "none", border: "none", cursor: "pointer", color: inkMuted, fontSize: 16, padding: "0 4px" }}>×</button>
              </div>
            ))}
            {s.questions.length === 0 && <div style={{ fontSize: 12.5, color: inkMuted, padding: "4px 2px" }}>No questions yet.</div>}
          </div>
          <button onClick={() => addQuestion(s.id)} style={{ ...ctaSecondaryStyle, fontSize: 12.5, padding: "6px 12px", marginTop: 12 }}>+ Add question</button>
        </section>
      ))}

      <button onClick={addSection} style={{ ...ctaPrimaryStyle, fontSize: 13 }}>+ Add a section</button>
    </>
  );
}
