import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { supabase } from "../supabase";
import { setHelpPresent } from "../lib/helpPresence";
import {
  ink,
  inkSoft,
  inkMuted,
  cream,
  rule,
  courtBlue,
  courtGreen,
  bodyFontStack,
  headingFontStack,
  inputStyle,
} from "../lib/publicTheme";

// Persistent "Need help?" affordance for tournament / register / checkout pages.
// Opens a panel with the tournament's real organizer contacts (email/phone) AND
// a quick message form that reuses the existing submit-contact-form function
// (emails the organizer). `context` (e.g. "registration", "checkout") is folded
// into the message so the organizer knows where the person got stuck.
type Contact = {
  id: string;
  name: string;
  role: string | null;
  phone: string | null;
  email: string | null;
};

export default function HelpButton({
  tournamentId,
  tournamentName,
  context,
}: {
  tournamentId: string;
  tournamentName?: string | null;
  context?: string;
}) {
  const [open, setOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  // Tell the global FeedbackWidget to hide its floating launcher while this
  // Need-help button is on the page (feedback lives inside our panel instead).
  useEffect(() => {
    setHelpPresent(true);
    return () => setHelpPresent(false);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ ...fabStyle, ...(isMobile ? { bottom: 84, right: 14, padding: "9px 15px", fontSize: 13 } : null) }}
        aria-expanded={open}
        aria-label="Need help?"
      >
        {open && <span style={{ fontSize: 15, lineHeight: 1 }}>×</span>}
        Need help?
      </button>

      {open && (
        <>
          {/* Scrim on mobile so the sheet reads as a modal */}
          {isMobile && (
            <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(20,24,31,0.35)", zIndex: 1399 }} />
          )}
          <div
            role="dialog"
            aria-label="Get help"
            style={{
              ...panelStyle,
              ...(isMobile
                ? { left: 12, right: 12, bottom: 12, width: "auto", maxHeight: "80vh", overflowY: "auto" }
                : null),
            }}
          >
            <HelpPanel tournamentId={tournamentId} tournamentName={tournamentName} context={context} onClose={() => setOpen(false)} />
          </div>
        </>
      )}
    </>
  );
}

function HelpPanel({
  tournamentId,
  tournamentName,
  context,
  onClose,
}: {
  tournamentId: string;
  tournamentName?: string | null;
  context?: string;
  onClose: () => void;
}) {
  const [contacts, setContacts] = useState<Contact[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("tournament_contacts")
        .select("id, name, role, phone, email, receives_form_messages")
        .eq("tournament_id", tournamentId);
      if (cancelled) return;
      // Only show contacts that have something to reach them by.
      setContacts((data ?? []).filter((c) => c.email || c.phone).map((c) => ({
        id: c.id, name: c.name, role: c.role, phone: c.phone, email: c.email,
      })));
    })();
    return () => { cancelled = true; };
  }, [tournamentId]);

  return (
    <div style={{ padding: "14px 16px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ fontFamily: headingFontStack, fontSize: 15, fontWeight: 700, color: ink }}>
          Need a hand registering?
        </div>
        <button onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", color: inkMuted, fontSize: 20, lineHeight: 1, cursor: "pointer", padding: 0 }}>×</button>
      </div>
      <div style={{ fontSize: 12.5, color: inkSoft, lineHeight: 1.5, margin: "2px 0 14px" }}>
        {tournamentName ? `${tournamentName} — the organizer is happy to help.` : "The organizer is happy to help."}
      </div>

      {contacts === null ? (
        <div style={{ fontSize: 12.5, color: inkMuted, marginBottom: 14 }}>Loading contacts…</div>
      ) : contacts.length > 0 ? (
        <div style={{ marginBottom: 14 }}>
          <SectionLabel>Reach the organizer</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {contacts.map((c) => (
              <div key={c.id} style={{ border: `1px solid ${rule}`, borderRadius: 8, padding: "8px 10px", background: "#fff" }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: ink }}>{c.name}</div>
                {c.role && <div style={{ fontSize: 11, color: inkMuted, marginBottom: 4 }}>{c.role}</div>}
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {c.email && <a href={`mailto:${c.email}`} style={linkStyle}>✉ {c.email}</a>}
                  {c.phone && <a href={`tel:${c.phone}`} style={linkStyle}>☎ {c.phone}</a>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <MessageForm tournamentId={tournamentId} context={context} compact={!!contacts && contacts.length > 0} />

      {/* Feedback about the app itself (distinct from messaging the organizer).
          Opens the existing FeedbackWidget panel via its window event. */}
      <div style={{ borderTop: `1px solid ${rule}`, marginTop: 14, paddingTop: 12, fontSize: 12, color: inkSoft }}>
        Something wrong with the site itself?{" "}
        <button
          type="button"
          onClick={() => { onClose(); window.dispatchEvent(new Event("wmpc:open-feedback")); }}
          style={{ border: "none", background: "none", padding: 0, color: courtBlue, fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: bodyFontStack }}
        >
          Send feedback →
        </button>
      </div>
    </div>
  );
}

function MessageForm({ tournamentId, context, compact }: { tournamentId: string; context?: string; compact: boolean }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const canSend = name.trim() && email.trim() && message.trim() && status !== "sending";

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    setStatus("sending");
    setError(null);
    try {
      const body = {
        tournamentId,
        senderName: name.trim(),
        senderEmail: email.trim(),
        message: context ? `[Help request — ${context}]\n\n${message.trim()}` : message.trim(),
        // Flags this as a Need-help submission → the function CCs the platform inbox.
        helpRequest: true,
      };
      const { error: fnErr } = await supabase.functions.invoke("submit-contact-form", { body });
      if (fnErr) {
        let msg = "Couldn't send your message — please try again.";
        const ctx = (fnErr as { context?: Response }).context;
        if (ctx && typeof ctx.json === "function") {
          try {
            const j = (await ctx.json()) as { error?: string };
            if (j?.error) msg = j.error;
          } catch { /* keep default */ }
        }
        setError(msg);
        setStatus("error");
        return;
      }
      setStatus("sent");
    } catch {
      setError("Couldn't send your message — please try again.");
      setStatus("error");
    }
  };

  if (status === "sent") {
    return (
      <div style={{ background: "#e8f5ea", border: "1px solid #bfe3c6", borderRadius: 8, padding: "12px 14px", color: "#1e6b2c", fontSize: 13 }}>
        ✓ Message sent — the organizer will get back to you by email.
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <SectionLabel>{compact ? "Or send a message" : "Send the organizer a message"}</SectionLabel>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" style={{ ...inputStyle, marginBottom: 8, fontSize: 13 }} />
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Your email" type="email" style={{ ...inputStyle, marginBottom: 8, fontSize: 13 }} />
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What's giving you trouble? (e.g. can't find my event, partner, payment…)" rows={compact ? 2 : 3} style={{ ...inputStyle, marginBottom: 10, fontSize: 13, resize: "vertical", fontFamily: bodyFontStack }} />
      {error && <div style={{ fontSize: 12, color: "#9c2412", marginBottom: 8 }} role="alert">{error}</div>}
      <button type="submit" disabled={!canSend} style={{ ...sendBtn, opacity: canSend ? 1 : 0.5, cursor: canSend ? "pointer" : "default" }}>
        {status === "sending" ? "Sending…" : "Send message"}
      </button>
    </form>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: inkSoft, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
      {children}
    </div>
  );
}

const fabStyle: CSSProperties = {
  position: "fixed",
  right: 20,
  bottom: 20,
  zIndex: 1400,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "11px 18px",
  borderRadius: 999,
  border: "none",
  background: "#14181f",
  color: "#fff",
  fontSize: 14,
  fontWeight: 700,
  fontFamily: headingFontStack,
  letterSpacing: "0.02em",
  boxShadow: "0 6px 20px rgba(20,24,31,0.28)",
  cursor: "pointer",
};

const panelStyle: CSSProperties = {
  position: "fixed",
  right: 20,
  bottom: 76,
  zIndex: 1400,
  width: "min(360px, calc(100vw - 40px))",
  background: cream,
  border: `1px solid ${rule}`,
  borderRadius: 14,
  boxShadow: "0 12px 40px rgba(20,24,31,0.24)",
  fontFamily: bodyFontStack,
};

const linkStyle: CSSProperties = { fontSize: 12, color: courtBlue, textDecoration: "none" };

const sendBtn: CSSProperties = {
  width: "100%",
  padding: "9px 14px",
  borderRadius: 8,
  border: "none",
  background: courtGreen,
  color: "#fff",
  fontSize: 13,
  fontWeight: 700,
  fontFamily: headingFontStack,
};
