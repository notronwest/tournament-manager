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
  bodyFontStack,
  headingFontStack,
  displayFontStack,
  pageWrapStyle,
  contentColStyle,
  panelStyle,
  ctaPrimaryStyle,
  ctaSecondaryStyle,
  inputStyle,
  statusPanelStyle,
} from "../../lib/publicTheme";

// ─────────────────────────────────────────────────────────────────────
// Tournament setup intake — the form a customer fills out after their
// quote is accepted, so we can build their tournament. MOCKUP: state is
// local and "Submit" just shows a confirmation; wiring to a real record
// (and the accepted-quote → tournament conversion) is a follow-up.
//
// Content mirrors docs/tournament-host-guide.md. Five steps keep a long
// intake approachable (one focused card at a time), matching our
// "don't overwhelm" rule.
// ─────────────────────────────────────────────────────────────────────

type YesNo = "" | "yes" | "no";

type Form = {
  // Step 1 — your tournament
  tournamentName: string;
  hostingOrg: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  backupContact: string;
  startDate: string;
  endDate: string;
  rainDate: string;
  dailyStart: string;
  dailyEnd: string;
  venueName: string;
  venueAddress: string;
  setting: string; // indoor / outdoor / both
  numCourts: string;
  // Step 2 — events & registration
  brackets: string;
  format: string;
  expectedSize: string;
  capPerEvent: string;
  waitlist: YesNo;
  entryFee: string;
  perEventFee: string;
  feeIncludes: string;
  regOpen: string;
  regClose: string;
  refundPolicy: string;
  ballBrand: string;
  ballProvidedBy: string; // host / players
  partnerMatching: YesNo;
  // Step 3 — rules & the day
  clubRules: string;
  spectatorAreas: string;
  outsideFood: YesNo;
  outsideAlcohol: YesNo;
  filming: YesNo;
  otherPolicies: string;
  parking: string;
  amenities: string;
  checkIn: string;
  safety: string;
  // Step 4 — extras & prizes
  medals: boolean;
  medalPlaces: string;
  winnerPrizes: boolean;
  paddleRaffle: boolean;
  communityRaffle: boolean;
  brewerySample: boolean;
  foodVendors: boolean;
  vendorTables: boolean;
  photographer: boolean;
  announcer: boolean;
  liveScores: boolean;
  sponsors: string;
  extrasNotes: string;
};

const EMPTY: Form = {
  tournamentName: "", hostingOrg: "", contactName: "", contactEmail: "",
  contactPhone: "", backupContact: "", startDate: "", endDate: "", rainDate: "",
  dailyStart: "", dailyEnd: "", venueName: "", venueAddress: "", setting: "",
  numCourts: "", brackets: "", format: "", expectedSize: "", capPerEvent: "",
  waitlist: "", entryFee: "", perEventFee: "", feeIncludes: "", regOpen: "",
  regClose: "", refundPolicy: "", ballBrand: "", ballProvidedBy: "",
  partnerMatching: "", clubRules: "", spectatorAreas: "", outsideFood: "",
  outsideAlcohol: "", filming: "", otherPolicies: "", parking: "", amenities: "",
  checkIn: "", safety: "", medals: false, medalPlaces: "", winnerPrizes: false,
  paddleRaffle: false, communityRaffle: false, brewerySample: false,
  foodVendors: false, vendorTables: false, photographer: false, announcer: false,
  liveScores: false, sponsors: "", extrasNotes: "",
};

const STEPS = [
  "Your tournament",
  "Events & registration",
  "Rules & the day",
  "Extras & prizes",
  "Review & submit",
];

export default function TournamentSetupIntakePage() {
  const [form, setForm] = useState<Form>(EMPTY);
  const [step, setStep] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const goto = (n: number) => {
    setStep(Math.max(0, Math.min(STEPS.length - 1, n)));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (submitted) {
    return (
      <div style={pageWrapStyle}>
        <main style={{ ...contentColStyle(600), padding: "64px 24px 120px" }}>
          <div style={{ ...statusPanelStyle("success"), padding: "24px" }}>
            <div style={{ fontSize: 22, fontFamily: displayFontStack, color: ink, marginBottom: 8 }}>
              Thanks{form.contactName ? `, ${form.contactName.split(" ")[0]}` : ""}! 🎉
            </div>
            <p style={{ fontSize: 15, color: inkSoft, lineHeight: 1.6, margin: 0 }}>
              We've got what we need to start building{" "}
              <strong>{form.tournamentName || "your tournament"}</strong>. Our team
              will review your setup and follow up to confirm the details — you'll
              be able to preview the event page before anything goes live.
            </p>
          </div>
          <button style={{ ...ctaSecondaryStyle, marginTop: 20 }} onClick={() => { setSubmitted(false); goto(0); }}>
            ← Back to the form
          </button>
        </main>
        <SiteFooter />
      </div>
    );
  }

  return (
    <div style={pageWrapStyle}>
      <main style={{ ...contentColStyle(760), padding: "40px 20px 120px" }}>
        {/* Header */}
        <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: courtBlue }}>
          Bert &amp; Erne · Tournament setup
        </div>
        <h1 style={{ fontFamily: displayFontStack, fontSize: 30, color: ink, margin: "0 0 8px" }}>
          Let's build your tournament
        </h1>
        <p style={{ fontSize: 15, color: inkSoft, lineHeight: 1.6, margin: "0 0 24px", maxWidth: 620 }}>
          A few questions so we can set everything up for you. Anything you don't
          know yet is fine — leave it blank and we'll firm it up together. Most of
          this becomes your public event page.
        </p>

        {/* Step rail */}
        <StepRail step={step} onJump={goto} />

        {/* Step body */}
        <div style={{ ...panelStyle, marginTop: 20 }}>
          {step === 0 && <StepTournament form={form} set={set} />}
          {step === 1 && <StepEvents form={form} set={set} />}
          {step === 2 && <StepRules form={form} set={set} />}
          {step === 3 && <StepExtras form={form} set={set} />}
          {step === 4 && <StepReview form={form} onJump={goto} />}
        </div>

        {/* Nav */}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 20, flexWrap: "wrap" }}>
          <button
            style={{ ...ctaSecondaryStyle, visibility: step === 0 ? "hidden" : "visible" }}
            onClick={() => goto(step - 1)}
          >
            ← Back
          </button>
          {step < STEPS.length - 1 ? (
            <button style={ctaPrimaryStyle} onClick={() => goto(step + 1)}>
              Next: {STEPS[step + 1]} →
            </button>
          ) : (
            <button style={ctaPrimaryStyle} onClick={() => setSubmitted(true)}>
              Submit setup
            </button>
          )}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

// ─── Step rail ────────────────────────────────────────────────────────

function StepRail({ step, onJump }: { step: number; onJump: (n: number) => void }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {STEPS.map((label, i) => {
        const active = i === step;
        const done = i < step;
        return (
          <button
            key={label}
            onClick={() => onJump(i)}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "8px 12px", borderRadius: 999, cursor: "pointer",
              border: `1px solid ${active ? courtBlue : rule}`,
              background: active ? courtBlue : done ? successBg : "#fff",
              color: active ? "#fff" : done ? courtGreen : inkSoft,
              fontFamily: bodyFontStack, fontSize: 13, fontWeight: 600,
            }}
          >
            <span
              style={{
                width: 20, height: 20, borderRadius: 999, display: "inline-flex",
                alignItems: "center", justifyContent: "center", fontSize: 11,
                background: active ? "#ffffff33" : done ? courtGreen : cream,
                color: active ? "#fff" : done ? "#fff" : inkMuted,
              }}
            >
              {done ? "✓" : i + 1}
            </span>
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Step 1 — your tournament ────────────────────────────────────────

function StepTournament({ form, set }: StepProps) {
  return (
    <Section title="Your tournament" subtitle="The basics we need to get started.">
      <Field label="Tournament name" required>
        <input style={inputStyle} value={form.tournamentName} onChange={(e) => set("tournamentName", e.target.value)} placeholder="5th Annual Pickleball Angels Tournament" />
      </Field>
      <Field label="Hosting club / organization">
        <input style={inputStyle} value={form.hostingOrg} onChange={(e) => set("hostingOrg", e.target.value)} placeholder="Pickleball Angels" />
      </Field>
      <Row>
        <Field label="Primary contact" required>
          <input style={inputStyle} value={form.contactName} onChange={(e) => set("contactName", e.target.value)} placeholder="Full name" />
        </Field>
        <Field label="Contact email" required>
          <input type="email" style={inputStyle} value={form.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} placeholder="you@club.com" />
        </Field>
      </Row>
      <Row>
        <Field label="Contact phone">
          <input style={inputStyle} value={form.contactPhone} onChange={(e) => set("contactPhone", e.target.value)} placeholder="(555) 555-5555" />
        </Field>
        <Field label="Backup contact" hint="Name + phone/email, optional">
          <input style={inputStyle} value={form.backupContact} onChange={(e) => set("backupContact", e.target.value)} />
        </Field>
      </Row>
      <Row>
        <Field label="Start date" required>
          <input type="date" style={inputStyle} value={form.startDate} onChange={(e) => set("startDate", e.target.value)} />
        </Field>
        <Field label="End date">
          <input type="date" style={inputStyle} value={form.endDate} onChange={(e) => set("endDate", e.target.value)} />
        </Field>
        <Field label="Rain / backup date" hint="Outdoor events">
          <input type="date" style={inputStyle} value={form.rainDate} onChange={(e) => set("rainDate", e.target.value)} />
        </Field>
      </Row>
      <Row>
        <Field label="Daily start time">
          <input type="time" style={inputStyle} value={form.dailyStart} onChange={(e) => set("dailyStart", e.target.value)} />
        </Field>
        <Field label="Daily end time">
          <input type="time" style={inputStyle} value={form.dailyEnd} onChange={(e) => set("dailyEnd", e.target.value)} />
        </Field>
      </Row>
      <Field label="Venue name">
        <input style={inputStyle} value={form.venueName} onChange={(e) => set("venueName", e.target.value)} />
      </Field>
      <Field label="Venue address">
        <input style={inputStyle} value={form.venueAddress} onChange={(e) => set("venueAddress", e.target.value)} placeholder="Street, city, state, zip" />
      </Field>
      <Row>
        <Field label="Indoor or outdoor?">
          <select style={inputStyle} value={form.setting} onChange={(e) => set("setting", e.target.value)}>
            <option value="">Select…</option>
            <option value="indoor">Indoor</option>
            <option value="outdoor">Outdoor</option>
            <option value="both">Both</option>
          </select>
        </Field>
        <Field label="Number of courts">
          <input type="number" style={inputStyle} value={form.numCourts} onChange={(e) => set("numCourts", e.target.value)} placeholder="e.g. 8" />
        </Field>
      </Row>
    </Section>
  );
}

// ─── Step 2 — events & registration ──────────────────────────────────

function StepEvents({ form, set }: StepProps) {
  return (
    <Section title="Events & registration" subtitle="What people play, and how they sign up.">
      <Field label="Brackets you want" hint="Skill divisions, age, gender, singles/doubles — one per line is great">
        <textarea style={textarea} rows={4} value={form.brackets} onChange={(e) => set("brackets", e.target.value)} placeholder={"Men's 3.5–4.0 Doubles\nWomen's 3.0 Doubles\nMixed 3.5 Doubles\n50+ Doubles"} />
      </Field>
      <Row>
        <Field label="Format">
          <select style={inputStyle} value={form.format} onChange={(e) => set("format", e.target.value)}>
            <option value="">Not sure yet</option>
            <option>Round robin</option>
            <option>Single elimination</option>
            <option>Double elimination</option>
            <option>Pool play → bracket</option>
          </select>
        </Field>
        <Field label="Expected size" hint="Players or teams">
          <input style={inputStyle} value={form.expectedSize} onChange={(e) => set("expectedSize", e.target.value)} placeholder="e.g. 120 players" />
        </Field>
      </Row>
      <Row>
        <Field label="Cap per event" hint="Optional">
          <input style={inputStyle} value={form.capPerEvent} onChange={(e) => set("capPerEvent", e.target.value)} />
        </Field>
        <YesNoField label="Waitlist when full?" value={form.waitlist} onChange={(v) => set("waitlist", v)} />
        <YesNoField label="Partner-matching board?" value={form.partnerMatching} onChange={(v) => set("partnerMatching", v)} />
      </Row>
      <Row>
        <Field label="Entry fee (tournament)">
          <input style={inputStyle} value={form.entryFee} onChange={(e) => set("entryFee", e.target.value)} placeholder="$" />
        </Field>
        <Field label="Per-event fee">
          <input style={inputStyle} value={form.perEventFee} onChange={(e) => set("perEventFee", e.target.value)} placeholder="$" />
        </Field>
      </Row>
      <Field label="What the fee includes" hint="Shirt, lunch, etc.">
        <input style={inputStyle} value={form.feeIncludes} onChange={(e) => set("feeIncludes", e.target.value)} />
      </Field>
      <Row>
        <Field label="Registration opens">
          <input type="date" style={inputStyle} value={form.regOpen} onChange={(e) => set("regOpen", e.target.value)} />
        </Field>
        <Field label="Registration closes">
          <input type="date" style={inputStyle} value={form.regClose} onChange={(e) => set("regClose", e.target.value)} />
        </Field>
      </Row>
      <Field label="Refund / cancellation policy" hint="Shown to players at checkout">
        <textarea style={textarea} rows={2} value={form.refundPolicy} onChange={(e) => set("refundPolicy", e.target.value)} />
      </Field>
      <Row>
        <Field label="What ball will you play with?">
          <input style={inputStyle} value={form.ballBrand} onChange={(e) => set("ballBrand", e.target.value)} placeholder="e.g. Franklin X-40 (outdoor)" />
        </Field>
        <Field label="Who provides the balls?">
          <select style={inputStyle} value={form.ballProvidedBy} onChange={(e) => set("ballProvidedBy", e.target.value)}>
            <option value="">Select…</option>
            <option value="host">Host provides</option>
            <option value="players">Players bring their own</option>
          </select>
        </Field>
      </Row>
    </Section>
  );
}

// ─── Step 3 — rules & the day ────────────────────────────────────────

function StepRules({ form, set }: StepProps) {
  return (
    <Section title="Rules & the day" subtitle="These appear in your event description so players know what to expect.">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 4 }}>
        <YesNoField label="Outside food allowed?" value={form.outsideFood} onChange={(v) => set("outsideFood", v)} />
        <YesNoField label="Outside alcohol allowed?" value={form.outsideAlcohol} onChange={(v) => set("outsideAlcohol", v)} />
        <YesNoField label="Players may film their own games?" value={form.filming} onChange={(v) => set("filming", v)} />
      </div>
      <Field label="Where should spectators be?" hint="Viewing areas, off-court rules">
        <input style={inputStyle} value={form.spectatorAreas} onChange={(e) => set("spectatorAreas", e.target.value)} />
      </Field>
      <Field label="Any other club / facility rules">
        <textarea style={textarea} rows={2} value={form.clubRules} onChange={(e) => set("clubRules", e.target.value)} />
      </Field>
      <Field label="Other policies" hint="Footwear (non-marking indoor), pets, smoking/vaping, warm-up courts">
        <textarea style={textarea} rows={2} value={form.otherPolicies} onChange={(e) => set("otherPolicies", e.target.value)} />
      </Field>
      <Field label="Parking" hint="Where, cost, overflow, accessible spots, load-in — we'll put this in the description">
        <textarea style={textarea} rows={2} value={form.parking} onChange={(e) => set("parking", e.target.value)} />
      </Field>
      <Field label="On-site amenities" hint="Restrooms, water/hydration, shade/tents, seating">
        <input style={inputStyle} value={form.amenities} onChange={(e) => set("amenities", e.target.value)} />
      </Field>
      <Field label="Check-in location & time">
        <input style={inputStyle} value={form.checkIn} onChange={(e) => set("checkIn", e.target.value)} />
      </Field>
      <Field label="Safety" hint="First aid / AED location, weather / rain plan, insurance or waiver requirements">
        <textarea style={textarea} rows={2} value={form.safety} onChange={(e) => set("safety", e.target.value)} />
      </Field>
    </Section>
  );
}

// ─── Step 4 — extras & prizes ────────────────────────────────────────

function StepExtras({ form, set }: StepProps) {
  return (
    <Section title="Extras & prizes" subtitle="Optional touches that lift the event — and often pay for themselves. Check what you're interested in.">
      <CheckCard checked={form.medals} onToggle={(v) => set("medals", v)} title="Medals" desc="Typically 1st–3rd in each bracket.">
        {form.medals && (
          <Field label="Which places?" hint="e.g. 1st–3rd">
            <input style={inputStyle} value={form.medalPlaces} onChange={(e) => set("medalPlaces", e.target.value)} />
          </Field>
        )}
      </CheckCard>
      <CheckCard checked={form.winnerPrizes} onToggle={(v) => set("winnerPrizes", v)} title="Prizes beyond medals" desc="A prize alongside the medal for winners. With ~10 brackets that's ~20 items — local breweries commonly donate 4-packs; coffee roasters, gyms and restaurants are good asks too." />
      <CheckCard checked={form.paddleRaffle} onToggle={(v) => set("paddleRaffle", v)} title="Paddle raffle" desc="Raffle one paddle per day — it reliably more than covers the cost of the paddle." />
      <CheckCard checked={form.communityRaffle} onToggle={(v) => set("communityRaffle", v)} title="Broader community raffle" desc="Line up donations from local companies for a bigger raffle. We'll manage the money and the ticket sales for you — you line up the donated gifts." />
      <CheckCard checked={form.brewerySample} onToggle={(v) => set("brewerySample", v)} title="Brewery sample table" desc="A local brewer sets up a table (e.g. ~12 PM Saturday) to hand out samples — if you're comfortable with it and your venue permits." />
      <CheckCard checked={form.foodVendors} onToggle={(v) => set("foodVendors", v)} title="Food truck / coffee cart" desc="A lunch food truck or a morning coffee cart keeps players happy on-site." />
      <CheckCard checked={form.vendorTables} onToggle={(v) => set("vendorTables", v)} title="Vendor / sponsor tables" desc="Paddle brands, local shops, or sponsors with a table at the event." />

      <div style={{ borderTop: `1px solid ${ruleSoft}`, margin: "16px 0 4px", paddingTop: 16, fontSize: 13, fontWeight: 700, color: inkSoft, fontFamily: headingFontStack, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        On the day
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <Toggle label="Photographer" checked={form.photographer} onToggle={(v) => set("photographer", v)} />
        <Toggle label="Announcer for finals" checked={form.announcer} onToggle={(v) => set("announcer", v)} />
        <Toggle label="Live scores" checked={form.liveScores} onToggle={(v) => set("liveScores", v)} />
      </div>
      <Field label="Sponsors to recognize" hint="We'll list them on the event page + announcements">
        <input style={inputStyle} value={form.sponsors} onChange={(e) => set("sponsors", e.target.value)} />
      </Field>
      <Field label="Anything else we should know?">
        <textarea style={textarea} rows={2} value={form.extrasNotes} onChange={(e) => set("extrasNotes", e.target.value)} />
      </Field>
    </Section>
  );
}

// ─── Step 5 — review ─────────────────────────────────────────────────

function StepReview({ form, onJump }: { form: Form; onJump: (n: number) => void }) {
  const extras = [
    form.medals && "Medals",
    form.winnerPrizes && "Winner prizes",
    form.paddleRaffle && "Paddle raffle",
    form.communityRaffle && "Community raffle",
    form.brewerySample && "Brewery sample table",
    form.foodVendors && "Food truck / coffee",
    form.vendorTables && "Vendor tables",
    form.photographer && "Photographer",
    form.announcer && "Announcer",
    form.liveScores && "Live scores",
  ].filter(Boolean) as string[];

  return (
    <Section title="Review & submit" subtitle="A quick look before you send it over. You can jump back to any step to edit.">
      <ReviewRow label="Tournament" value={form.tournamentName} onEdit={() => onJump(0)} />
      <ReviewRow label="Dates" value={[form.startDate, form.endDate].filter(Boolean).join(" – ")} onEdit={() => onJump(0)} />
      <ReviewRow label="Venue" value={[form.venueName, form.venueAddress].filter(Boolean).join(" · ")} onEdit={() => onJump(0)} />
      <ReviewRow label="Contact" value={[form.contactName, form.contactEmail].filter(Boolean).join(" · ")} onEdit={() => onJump(0)} />
      <ReviewRow label="Brackets" value={form.brackets ? form.brackets.split("\n").filter(Boolean).length + " listed" : ""} onEdit={() => onJump(1)} />
      <ReviewRow label="Ball" value={form.ballBrand} onEdit={() => onJump(1)} />
      <ReviewRow label="Outside food / alcohol" value={[yn(form.outsideFood), yn(form.outsideAlcohol)].join(" / ")} onEdit={() => onJump(2)} />
      <ReviewRow label="Filming" value={yn(form.filming)} onEdit={() => onJump(2)} />
      <ReviewRow label="Extras" value={extras.join(", ")} onEdit={() => onJump(3)} />
      <p style={{ fontSize: 13, color: inkMuted, marginTop: 16, lineHeight: 1.5 }}>
        Blank fields are fine — we'll fill in the rest with you. Hit <strong>Submit
        setup</strong> and our team takes it from here.
      </p>
    </Section>
  );
}

function yn(v: YesNo): string {
  return v === "yes" ? "Yes" : v === "no" ? "No" : "—";
}

// ─── Shared bits ─────────────────────────────────────────────────────

type StepProps = {
  form: Form;
  set: <K extends keyof Form>(k: K, v: Form[K]) => void;
};

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div>
      <h2 style={{ fontFamily: headingFontStack, fontSize: 18, color: ink, margin: "0 0 4px" }}>{title}</h2>
      {subtitle && <p style={{ fontSize: 13.5, color: inkSoft, margin: "0 0 18px", lineHeight: 1.5 }}>{subtitle}</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>{children}</div>
    </div>
  );
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: ReactNode }) {
  return (
    <label style={{ display: "block", flex: "1 1 200px", minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: ink, marginBottom: 5 }}>
        {label}
        {required && <span style={{ color: "#9c2412", marginLeft: 3 }}>*</span>}
      </div>
      {hint && <div style={{ fontSize: 12, color: inkMuted, marginBottom: 6, lineHeight: 1.4 }}>{hint}</div>}
      {children}
    </label>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>{children}</div>;
}

function YesNoField({ label, value, onChange }: { label: string; value: YesNo; onChange: (v: YesNo) => void }) {
  return (
    <div style={{ flex: "1 1 200px", minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: ink, marginBottom: 6 }}>{label}</div>
      <div style={{ display: "flex", gap: 8 }}>
        {(["yes", "no"] as const).map((opt) => {
          const on = value === opt;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(on ? "" : opt)}
              style={{
                flex: 1, padding: "9px 0", borderRadius: 6, cursor: "pointer",
                border: `1px solid ${on ? courtBlue : rule}`,
                background: on ? courtBlue : "#fff", color: on ? "#fff" : inkSoft,
                fontFamily: bodyFontStack, fontSize: 13, fontWeight: 600,
                textTransform: "capitalize",
              }}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CheckCard({ checked, onToggle, title, desc, children }: { checked: boolean; onToggle: (v: boolean) => void; title: string; desc: string; children?: ReactNode }) {
  return (
    <div
      style={{
        border: `1px solid ${checked ? courtGreen : rule}`,
        background: checked ? successBg : "#fff",
        borderRadius: 8, padding: 14,
      }}
    >
      <label style={{ display: "flex", gap: 12, alignItems: "flex-start", cursor: "pointer" }}>
        <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} style={{ width: 18, height: 18, marginTop: 2, flexShrink: 0, accentColor: courtGreen }} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: ink }}>{title}</div>
          <div style={{ fontSize: 13, color: inkSoft, lineHeight: 1.5, marginTop: 2 }}>{desc}</div>
        </div>
      </label>
      {children && <div style={{ marginTop: 12, marginLeft: 30 }}>{children}</div>}
    </div>
  );
}

function Toggle({ label, checked, onToggle }: { label: string; checked: boolean; onToggle: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer", fontSize: 14, color: ink }}>
      <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} style={{ width: 17, height: 17, accentColor: courtGreen }} />
      {label}
    </label>
  );
}

function ReviewRow({ label, value, onEdit }: { label: string; value: string; onEdit: () => void }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "baseline", padding: "9px 0", borderBottom: `1px solid ${ruleSoft}` }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: inkMuted, textTransform: "uppercase", letterSpacing: "0.04em", width: 160, flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, fontSize: 14, color: value ? ink : inkMuted }}>{value || "—"}</div>
      <button type="button" onClick={onEdit} style={{ background: "none", border: "none", color: courtBlue, fontSize: 13, cursor: "pointer", fontFamily: bodyFontStack, flexShrink: 0 }}>Edit</button>
    </div>
  );
}

const textarea: CSSProperties = { ...inputStyle, resize: "vertical", lineHeight: 1.5 };
