import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import type { Database } from "../../types/supabase";
import {
  ink,
  inkMuted,
  cream,
  creamDeep,
  courtRed,
  monoFontStack,
  displayFontStack,
  pageWrapStyle,
  contentColStyle,
} from "../../lib/publicTheme";

type PublicContact = Pick<
  Database["public"]["Tables"]["tournament_contacts"]["Row"],
  "id" | "name" | "role" | "phone" | "email" | "receives_form_messages"
>;

export default function TournamentContactPage() {
  const { orgSlug, tournamentSlug } = useParams<{
    orgSlug: string;
    tournamentSlug: string;
  }>();

  const [tournamentName, setTournamentName] = useState<string | null>(null);
  const [tournamentId, setTournamentId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<PublicContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgSlug || !tournamentSlug) return;

    async function load() {
      const { data: org, error: orgErr } = await supabase
        .from("organizations")
        .select("id")
        .eq("slug", orgSlug!)
        .is("deleted_at", null)
        .maybeSingle();
      if (orgErr || !org) {
        setError(orgErr?.message ?? "Organization not found.");
        setLoading(false);
        return;
      }

      const { data: t, error: tErr } = await supabase
        .from("tournaments")
        .select("id, name")
        .eq("organization_id", org.id)
        .eq("slug", tournamentSlug!)
        .in("status", ["published", "closed", "completed"])
        .is("deleted_at", null)
        .maybeSingle();
      if (tErr || !t) {
        setError(tErr?.message ?? "Tournament not found.");
        setLoading(false);
        return;
      }
      setTournamentId(t.id);
      setTournamentName(t.name);

      const { data: contactRows } = await supabase
        .from("tournament_contacts")
        .select("id, name, role, phone, email, receives_form_messages")
        .eq("tournament_id", t.id)
        .eq("is_public", true)
        .is("deleted_at", null)
        .order("sort_order", { ascending: true });
      setContacts(contactRows ?? []);
      setLoading(false);
    }

    load();
  }, [orgSlug, tournamentSlug]);

  if (loading) {
    return (
      <main style={pageWrapStyle}>
        <div style={contentColStyle(680)}>
          <p style={{ color: inkMuted, fontSize: 14 }}>Loading…</p>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main style={pageWrapStyle}>
        <div style={contentColStyle(680)}>
          <p style={{ color: "#991b1b", fontSize: 14 }}>{error}</p>
        </div>
      </main>
    );
  }

  return (
    <main style={pageWrapStyle}>
      <div style={contentColStyle(680)}>
        <div style={{ marginBottom: 8 }}>
          <Link
            to={`/t/${orgSlug}/${tournamentSlug}`}
            style={{ fontSize: 13, color: inkMuted, textDecoration: "none" }}
          >
            ← {tournamentName}
          </Link>
        </div>

        <header
          style={{
            background: `linear-gradient(180deg, ${cream} 0%, ${creamDeep} 100%)`,
            borderRadius: 10,
            padding: "32px 28px 24px",
            marginBottom: 28,
          }}
        >
          <div
            style={{
              fontFamily: monoFontStack,
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.2em",
              color: courtRed,
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            Contact
          </div>
          <h1
            style={{
              fontFamily: displayFontStack,
              fontSize: "clamp(26px, 4vw, 36px)",
              lineHeight: 0.95,
              margin: 0,
              color: ink,
            }}
          >
            {tournamentName}
          </h1>
        </header>

        {tournamentId && (
          <ContactForm tournamentId={tournamentId} contacts={contacts} />
        )}
      </div>
    </main>
  );
}

function ContactForm({
  tournamentId,
  contacts,
}: {
  tournamentId: string;
  contacts: PublicContact[];
}) {
  const { user } = useAuth();

  // Contacts eligible for the recipient picker: flagged
  // receives_form_messages and have an email address (#148 AC#3).
  const selectableContacts = contacts.filter(
    (c) => c.receives_form_messages && c.email,
  );

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  // Prefill the message from a ?message= param so callers can hand the user a
  // ready-to-send note — e.g. checkout's "message the organizer" link when the
  // org hasn't finished Stripe setup. Still fully editable.
  const [searchParams] = useSearchParams();
  const [message, setMessage] = useState(
    () => searchParams.get("message") ?? "",
  );
  // The sender's explicit recipient pick ("" until they choose one).
  const [targetContactId, setTargetContactId] = useState<string>("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Prefill name + email for signed-in users from their player record
  // (#148 AC#2). Still editable. Runs when the user resolves.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("players")
        .select("first_name, last_name, email")
        .eq("auth_user_id", user.id)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled || !data) return;
      setName([data.first_name, data.last_name].filter(Boolean).join(" "));
      setEmail(data.email ?? "");
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Effective recipient, DERIVED during render (not synced via an effect):
  // the user's pick if still valid, else the first selectable contact. This
  // matters because `contacts` load async — a state+effect default could
  // leave the dropdown SHOWING a recipient while submitting an empty id,
  // which makes the server silently fan the message out to every contact.
  const effectiveTargetId = selectableContacts.some(
    (c) => c.id === targetContactId,
  )
    ? targetContactId
    : selectableContacts[0]?.id ?? "";

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !message.trim()) return;
    setStatus("sending");
    setErrorMsg(null);

    const body: Record<string, string> = {
      tournamentId,
      senderName: name.trim(),
      senderEmail: email.trim(),
      message: message.trim(),
    };
    if (effectiveTargetId) body.targetContactId = effectiveTargetId;

    const { data, error } = await supabase.functions.invoke(
      "submit-contact-form",
      { body },
    );

    if (error) {
      let msg = "Something went wrong sending your message. Please try again.";
      try {
        const ctx = (error as { context?: Response }).context;
        if (ctx) {
          const j = (await ctx.json()) as { error?: string };
          if (j?.error) msg = j.error;
        }
      } catch {
        /* fall back to the generic message */
      }
      setErrorMsg(msg);
      setStatus("error");
      return;
    }
    if ((data as { error?: string } | null)?.error) {
      setErrorMsg((data as { error: string }).error);
      setStatus("error");
      return;
    }
    setStatus("sent");
    setName("");
    setEmail("");
    setMessage("");
  };

  const inputStyle: CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    fontSize: 14,
    fontFamily: "inherit",
    marginTop: 4,
  };
  const labelStyle: CSSProperties = {
    display: "block",
    fontSize: 13,
    color: "#555",
    marginBottom: 12,
  };

  return (
    <section>
      <h2 style={{ margin: "0 0 10px", fontSize: 18, color: ink }}>
        Contact the organizers
      </h2>

      {contacts.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          {contacts.map((c) => (
            <div
              key={c.id}
              style={{
                fontSize: 14,
                color: "#444",
                lineHeight: 1.5,
                marginBottom: 8,
              }}
            >
              <strong>{c.name}</strong>
              {c.role && <span style={{ color: "#666" }}> · {c.role}</span>}
              <div style={{ color: "#666", fontSize: 13 }}>
                {c.email && (
                  <a href={`mailto:${c.email}`} style={{ color: "#2563eb" }}>
                    {c.email}
                  </a>
                )}
                {c.email && c.phone && " · "}
                {c.phone && (
                  <a href={`tel:${c.phone}`} style={{ color: "#2563eb" }}>
                    {c.phone}
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {status === "sent" ? (
        <div
          style={{
            padding: 14,
            background: "#e8f4eb",
            border: "1px solid #bfe3c8",
            borderRadius: 8,
            color: "#1e6b2c",
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          {(() => {
            const recipient = selectableContacts.find(
              (c) => c.id === effectiveTargetId,
            );
            return recipient
              ? `Thanks — your message was sent to ${recipient.name}. They'll reply to the email you provided.`
              : "Thanks — your message was sent to the organizers. They'll reply to the email you provided.";
          })()}
        </div>
      ) : (
        <form onSubmit={onSubmit} style={{ maxWidth: 520 }}>
          <p
            style={{
              fontSize: 14,
              color: "#666",
              margin: "0 0 14px",
              lineHeight: 1.5,
            }}
          >
            Have a question about this tournament? Send the organizers a note.
          </p>
          {selectableContacts.length > 0 && (
            <label style={labelStyle}>
              Direct your question to…
              <select
                value={effectiveTargetId}
                onChange={(e) => setTargetContactId(e.target.value)}
                style={{ ...inputStyle, background: "#fff" }}
              >
                {selectableContacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.role ? ` · ${c.role}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label style={labelStyle}>
            Your name
            <input
              type="text"
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            Your email
            <input
              type="email"
              required
              maxLength={200}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            Message
            <textarea
              required
              maxLength={5000}
              rows={5}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </label>
          {status === "error" && errorMsg && (
            <div
              style={{
                padding: 12,
                background: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: 8,
                color: "#991b1b",
                fontSize: 13,
                marginBottom: 12,
              }}
            >
              {errorMsg}
            </div>
          )}
          <button
            type="submit"
            disabled={status === "sending"}
            style={{
              padding: "10px 20px",
              background: status === "sending" ? "#9ca3af" : "#14181f",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: status === "sending" ? "not-allowed" : "pointer",
              fontFamily: "inherit",
            }}
          >
            {status === "sending" ? "Sending…" : "Send message"}
          </button>
        </form>
      )}
    </section>
  );
}
