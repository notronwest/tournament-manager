import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { ConfirmModal } from "../../components/ConfirmModal";
import { fetchOrgContacts, type OrgContact, type ContactSource } from "../../lib/orgContacts";
import { EmailHistory } from "./EmailHistory";
import {
  EMAIL_RE,
  displayHeading,
  fieldLabel,
  modeBtnStyle,
  readFnError,
} from "./contactsUi";
import {
  ink,
  inkSoft,
  inkMuted,
  cream,
  rule,
  ruleSoft,
  courtGreen,
  bodyFontStack,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  ctaSecondaryStyle,
  ghostButtonStyle,
  inputStyle,
  statusPanelStyle,
} from "../../lib/publicTheme";

// The Email surface — split out of the old overloaded Contacts screen. Two tabs:
// Compose (write + pick recipients via filters) and History (delivery status).
export default function EmailPage() {
  const { org, role } = useCurrentOrg();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "history" ? "history" : "compose";
  const setTab = (t: "compose" | "history") =>
    setParams(t === "history" ? { tab: "history" } : {}, { replace: true });

  if (!org) return null;

  return (
    <div style={{ fontFamily: bodyFontStack, color: ink }}>
      <h1 style={displayHeading}>Email</h1>
      <p style={{ color: inkSoft, fontSize: 15, margin: "0 0 18px", maxWidth: 620, lineHeight: 1.55 }}>
        Write to your contact list and track how it landed. Use the filters to
        choose exactly who a message goes to.
      </p>

      <div role="tablist" aria-label="Email" style={{ display: "flex", gap: 6, marginBottom: 20 }}>
        <button role="tab" aria-selected={tab === "compose"} onClick={() => setTab("compose")} style={modeBtnStyle(tab === "compose")}>
          Compose
        </button>
        <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")} style={modeBtnStyle(tab === "history")}>
          History
        </button>
      </div>

      {tab === "compose" ? (
        <ComposeTab
          orgId={org.id}
          orgDefaultReplyTo={org.contact_email ?? null}
          senderEmail={user?.email ?? ""}
          canEditDefault={role === "owner" || role === "admin"}
        />
      ) : (
        <EmailHistory />
      )}
    </div>
  );
}

// ── Compose tab: filters pick the recipients, then write + send ────────
function ComposeTab({
  orgId,
  orgDefaultReplyTo,
  senderEmail,
  canEditDefault,
}: {
  orgId: string;
  orgDefaultReplyTo: string | null;
  senderEmail: string;
  canEditDefault: boolean;
}) {
  const [contacts, setContacts] = useState<OrgContact[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sentMsg, setSentMsg] = useState<string | null>(null);

  // Recipient filters. (No "subscribed only" here — unsubscribed contacts can
  // never be emailed, so `emailable` already excludes them.)
  const [sourceFilter, setSourceFilter] = useState<"all" | ContactSource>("all");
  const [addedSince, setAddedSince] = useState("");
  const [search, setSearch] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [showList, setShowList] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchOrgContacts(orgId);
        if (cancelled) return;
        setContacts(data);
        setLoadError(null);
      } catch (e) {
        if (cancelled) return;
        setLoadError((e as { message?: string })?.message ?? "Could not load contacts.");
        setContacts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const emailable = useMemo(
    () => (contacts ?? []).filter((c) => c.email && !c.unsubscribed),
    [contacts],
  );

  const matched = useMemo(() => {
    const q = search.trim().toLowerCase();
    return emailable.filter((c) => {
      if (q && !`${c.firstName} ${c.lastName} ${c.email ?? ""} ${c.city ?? ""}`.toLowerCase().includes(q))
        return false;
      if (sourceFilter !== "all" && c.source !== sourceFilter) return false;
      if (addedSince) {
        if (!c.addedAt || c.addedAt.slice(0, 10) < addedSince) return false;
      }
      return true;
    });
  }, [emailable, search, sourceFilter, addedSince]);

  const recipients = useMemo(
    () => matched.filter((c) => !excluded.has(c.playerId)),
    [matched, excluded],
  );
  const recipientIds = useMemo(() => recipients.map((c) => c.playerId), [recipients]);

  function toggleExclude(id: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const hasFilter = sourceFilter !== "all" || addedSince !== "" || search.trim() !== "";

  if (contacts === null) return <div style={{ color: inkMuted }}>Loading…</div>;

  return (
    <div>
      {loadError && (
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 16 }} role="alert">
          {loadError}
        </div>
      )}
      {sentMsg && (
        <div style={{ ...statusPanelStyle("success"), marginBottom: 16 }} role="status">
          {sentMsg}
        </div>
      )}

      {emailable.length === 0 ? (
        <div style={{ border: `1px dashed ${rule}`, borderRadius: 10, padding: 28, textAlign: "center", color: inkMuted, background: cream }}>
          No contacts with an email address yet. Add or import contacts first.
        </div>
      ) : (
        <>
          {/* Recipient filters */}
          <div style={{ ...panelWrap, marginBottom: 16 }}>
            <div style={{ ...fieldLabel, marginBottom: 10 }}>Recipients</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value as "all" | ContactSource)}
                style={{ ...inputStyle, maxWidth: 180 }}
                aria-label="Filter by source"
              >
                <option value="all">All sources</option>
                <option value="registrant">Registrants</option>
                <option value="import">Imported</option>
                <option value="manual">Added manually</option>
              </select>
              <label style={{ fontSize: 13, color: inkSoft, display: "flex", gap: 6, alignItems: "center" }}>
                Added since
                <input type="date" value={addedSince} onChange={(e) => setAddedSince(e.target.value)} style={{ ...inputStyle, maxWidth: 160 }} />
              </label>
              <input
                type="search"
                placeholder="Search name, email, city…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ ...inputStyle, maxWidth: 220, marginLeft: "auto" }}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
              <div style={{ fontSize: 14, color: ink }}>
                This email will go to <strong>{recipientIds.length}</strong> contact{recipientIds.length === 1 ? "" : "s"}
                {hasFilter && matched.length !== emailable.length && (
                  <span style={{ color: inkMuted }}> · {emailable.length} total emailable</span>
                )}
                {excluded.size > 0 && <span style={{ color: inkMuted }}> · {excluded.size} removed</span>}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {excluded.size > 0 && (
                  <button style={ghostButtonStyle} onClick={() => setExcluded(new Set())}>
                    Reset removed
                  </button>
                )}
                <button style={ghostButtonStyle} onClick={() => setShowList((s) => !s)}>
                  {showList ? "Hide recipients" : "Review recipients"}
                </button>
              </div>
            </div>

            {showList && (
              <div style={{ marginTop: 12, maxHeight: 260, overflowY: "auto", border: `1px solid ${rule}`, borderRadius: 8 }}>
                {matched.length === 0 ? (
                  <div style={{ padding: 14, color: inkMuted, fontSize: 13 }}>No emailable contacts match these filters.</div>
                ) : (
                  matched.map((c) => {
                    const isOut = excluded.has(c.playerId);
                    return (
                      <div
                        key={c.playerId}
                        style={{
                          display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
                          padding: "8px 12px", borderTop: `1px solid ${ruleSoft}`, fontSize: 13,
                          opacity: isOut ? 0.5 : 1,
                        }}
                      >
                        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {c.firstName} {c.lastName} <span style={{ color: inkMuted }}>· {c.email}</span>
                        </span>
                        <button
                          style={{ ...ghostButtonStyle, fontSize: 12, flexShrink: 0 }}
                          onClick={() => toggleExclude(c.playerId)}
                        >
                          {isOut ? "Add back" : "Remove"}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>

          <ComposeForm
            orgId={orgId}
            recipientIds={recipientIds}
            orgDefaultReplyTo={orgDefaultReplyTo}
            senderEmail={senderEmail}
            canEditDefault={canEditDefault}
            onSent={(n) => {
              setSentMsg(`Your message is being sent to ${n} contact${n === 1 ? "" : "s"}. Track it on the History tab.`);
              setExcluded(new Set());
            }}
          />
        </>
      )}
    </div>
  );
}

// ── Compose form (subject / message / reply-to / send) ─────────────────
function ComposeForm({
  orgId,
  recipientIds,
  orgDefaultReplyTo,
  senderEmail,
  canEditDefault,
  onSent,
}: {
  orgId: string;
  recipientIds: string[];
  orgDefaultReplyTo: string | null;
  senderEmail: string;
  canEditDefault: boolean;
  onSent: (n: number) => void;
}) {
  const recipientCount = recipientIds.length;
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [bodyIsHtml, setBodyIsHtml] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [consent, setConsent] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Reply-to: club default if set, else the sending admin's email. Editable per send.
  const [replyTo, setReplyTo] = useState((orgDefaultReplyTo || senderEmail).trim());
  const [savedDefaultTo, setSavedDefaultTo] = useState<string | null>(orgDefaultReplyTo);
  const [savingDefault, setSavingDefault] = useState(false);
  const [savedDefault, setSavedDefault] = useState(false);

  const replyToTrimmed = replyTo.trim();
  const replyToValid = replyToTrimmed.length === 0 || EMAIL_RE.test(replyToTrimmed);
  const canSaveDefault =
    canEditDefault && replyToValid && replyToTrimmed.length > 0 &&
    replyToTrimmed !== (savedDefaultTo ?? "").trim();

  const canSend =
    subject.trim().length > 0 && body.trim().length > 0 && consent &&
    recipientCount > 0 && replyToValid;

  const saveAsDefault = async () => {
    setSavingDefault(true);
    setError(null);
    try {
      const { error: upErr } = await supabase
        .from("organizations")
        .update({ contact_email: replyToTrimmed })
        .eq("id", orgId);
      if (upErr) {
        setError(upErr.message);
        return;
      }
      setSavedDefaultTo(replyToTrimmed);
      setSavedDefault(true);
    } finally {
      setSavingDefault(false);
    }
  };

  const send = async () => {
    setError(null);
    setSending(true);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("send-contact-broadcast", {
        body: {
          organizationId: orgId,
          subject: subject.trim(),
          body,
          consent: true,
          playerIds: recipientIds,
          bodyIsHtml,
          ...(replyToTrimmed ? { replyTo: replyToTrimmed } : {}),
        },
      });
      if (fnErr) {
        setError(await readFnError(fnErr));
        return;
      }
      const n = (data as { recipientCount?: number })?.recipientCount ?? recipientCount;
      setSubject("");
      setBody("");
      setConsent(false);
      onSent(n);
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Send failed.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={panelWrap}>
      <label style={fieldLabel}>Subject</label>
      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="e.g. Summer league sign-ups are open"
        style={{ ...inputStyle, marginBottom: 14 }}
        maxLength={200}
      />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <label style={{ ...fieldLabel, marginBottom: 0 }}>Message</label>
        <div style={{ display: "flex", gap: 4 }} role="tablist" aria-label="Message format">
          <button type="button" role="tab" aria-selected={!bodyIsHtml} onClick={() => { setBodyIsHtml(false); setShowPreview(false); }} style={modeBtnStyle(!bodyIsHtml)}>
            Plain text
          </button>
          <button type="button" role="tab" aria-selected={bodyIsHtml} onClick={() => setBodyIsHtml(true)} style={modeBtnStyle(bodyIsHtml)}>
            HTML
          </button>
        </div>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={
          bodyIsHtml
            ? "Paste your HTML here — e.g. <h2>Big news</h2><p>…</p>. It's sent inside the club's branded header, footer, and unsubscribe link."
            : "Write your message… Blank lines start a new paragraph."
        }
        rows={bodyIsHtml ? 12 : 8}
        spellCheck={!bodyIsHtml}
        style={{
          ...inputStyle,
          marginBottom: bodyIsHtml ? 8 : 14,
          resize: "vertical",
          fontFamily: bodyIsHtml ? "ui-monospace, SFMono-Regular, Menlo, monospace" : bodyFontStack,
          fontSize: bodyIsHtml ? 12.5 : undefined,
        }}
      />
      {bodyIsHtml && (
        <div style={{ marginBottom: 14 }}>
          <button
            type="button"
            onClick={() => setShowPreview((p) => !p)}
            disabled={!body.trim()}
            style={{ ...ctaSecondaryStyle, padding: "5px 12px", fontSize: 12, opacity: body.trim() ? 1 : 0.5 }}
          >
            {showPreview ? "Hide preview" : "Show preview"}
          </button>
          {showPreview && body.trim() && (
            <iframe
              title="Email preview"
              sandbox=""
              srcDoc={body}
              style={{ width: "100%", height: 340, marginTop: 10, border: `1px solid ${rule}`, borderRadius: 6, background: "#fff" }}
            />
          )}
        </div>
      )}

      <label style={fieldLabel}>Reply-to address</label>
      <input
        type="email"
        value={replyTo}
        onChange={(e) => { setReplyTo(e.target.value); setSavedDefault(false); }}
        placeholder={senderEmail || "replies@yourclub.com"}
        style={{ ...inputStyle, marginBottom: 6, ...(replyToValid ? null : { borderColor: "#c0392b" }) }}
      />
      <p style={{ fontSize: 12, color: inkSoft, margin: "0 0 6px", lineHeight: 1.5 }}>
        Where recipient replies go.{" "}
        {savedDefaultTo ? "Prefilled with this club's default — edit to override just this send." : "Defaults to your email — edit to override just this send."}
      </p>
      {!replyToValid && (
        <p style={{ fontSize: 12, color: "#c0392b", margin: "0 0 6px" }} role="alert">
          Enter a valid email address (or leave blank to use the club default).
        </p>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        {canEditDefault && (
          <button
            type="button"
            onClick={saveAsDefault}
            disabled={!canSaveDefault || savingDefault}
            style={{
              ...ctaSecondaryStyle, padding: "5px 12px", fontSize: 12,
              opacity: canSaveDefault && !savingDefault ? 1 : 0.5,
              cursor: canSaveDefault && !savingDefault ? "pointer" : "default",
            }}
          >
            {savingDefault ? "Saving…" : "Save as club default"}
          </button>
        )}
        {savedDefault && <span style={{ fontSize: 12, color: courtGreen, fontWeight: 600 }}>✓ Saved as club default</span>}
      </div>

      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13, color: inkSoft, marginBottom: 14, cursor: "pointer" }}>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }} />
        <span>I have permission to email these contacts. They are members, registrants, or people who opted in to hear from this club.</span>
      </label>

      {error && (
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 12 }} role="alert">
          {error}
        </div>
      )}

      <button
        style={canSend && !sending ? ctaPrimaryStyle : ctaPrimaryDisabledStyle}
        disabled={!canSend || sending}
        onClick={() => setConfirming(true)}
      >
        {sending ? "Sending…" : `Send to ${recipientCount} contact${recipientCount === 1 ? "" : "s"}`}
      </button>

      {confirming && (
        <ConfirmModal
          title="Send this email?"
          destructive={false}
          body={
            <>
              Send “{subject.trim()}” to <strong>{recipientCount}</strong> contact{recipientCount === 1 ? "" : "s"}? This can't be unsent.
            </>
          }
          confirmLabel="Send now"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setConfirming(false);
            await send();
          }}
        />
      )}
    </div>
  );
}

const panelWrap = {
  border: `1px solid ${rule}`,
  borderRadius: 12,
  padding: 20,
  background: "#fff",
} as const;
