import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { ConfirmModal } from "../../components/ConfirmModal";
import {
  fetchOrgContacts,
  removeOrgContact,
  type OrgContact,
  type ContactSource,
} from "../../lib/orgContacts";
import {
  parseContactsFile,
  autoMap,
  CONTACT_FIELDS,
  type ContactField,
  type ParsedFile,
} from "../../lib/parseContactsFile";
import {
  ink,
  inkSoft,
  inkMuted,
  cream,
  rule,
  ruleSoft,
  courtBlue,
  courtGreen,
  bodyFontStack,
  headingFontStack,
  displayFontStack,
  panelStyle,
  panelMutedStyle,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  ctaSecondaryStyle,
  ghostButtonStyle,
  inputStyle,
  statusPanelStyle,
} from "../../lib/publicTheme";

type Panel = "none" | "import" | "compose";

type ImportResult = {
  added: number;
  matchedExisting: number;
  linked: number;
  skipped: number;
  total: number;
};

export default function OrgContactsPage() {
  const { org } = useCurrentOrg();
  const [contacts, setContacts] = useState<OrgContact[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("none");
  const [search, setSearch] = useState("");
  const [removeTarget, setRemoveTarget] = useState<OrgContact | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  // Bump to force a refetch (e.g. after an import) without a named loader
  // callback (which the react-hooks set-state-in-effect rule flags).
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!org) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchOrgContacts(org.id);
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
  }, [org, reloadKey]);

  // Recipient filters + individual selection.
  const [sourceFilter, setSourceFilter] = useState<"all" | ContactSource>("all");
  const [subscribedOnly, setSubscribedOnly] = useState(true);
  const [addedSince, setAddedSince] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const emailable = useMemo(
    () => (contacts ?? []).filter((c) => c.email && !c.unsubscribed),
    [contacts],
  );
  const emailableIds = useMemo(
    () => new Set(emailable.map((c) => c.playerId)),
    [emailable],
  );

  // Rows shown = search + source + date-added + subscription filters.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (contacts ?? []).filter((c) => {
      if (
        q &&
        !`${c.firstName} ${c.lastName} ${c.email ?? ""} ${c.city ?? ""}`
          .toLowerCase()
          .includes(q)
      )
        return false;
      if (sourceFilter !== "all" && c.source !== sourceFilter) return false;
      if (subscribedOnly && c.unsubscribed) return false;
      if (addedSince) {
        // Registrants have no "added" date; a date floor excludes them.
        if (!c.addedAt || c.addedAt.slice(0, 10) < addedSince) return false;
      }
      return true;
    });
  }, [contacts, search, sourceFilter, subscribedOnly, addedSince]);

  const visibleEmailable = useMemo(
    () => visible.filter((c) => emailableIds.has(c.playerId)),
    [visible, emailableIds],
  );
  const allVisibleSelected =
    visibleEmailable.length > 0 &&
    visibleEmailable.every((c) => selected.has(c.playerId));

  // Recipients the send targets: the checked emailable, or ALL emailable when
  // nothing is checked (so "email everyone" still works with no fuss).
  const recipientIds = useMemo(() => {
    if (selected.size > 0)
      return emailable.filter((c) => selected.has(c.playerId)).map((c) => c.playerId);
    return emailable.map((c) => c.playerId);
  }, [selected, emailable]);

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleEmailable.forEach((c) => next.delete(c.playerId));
      else visibleEmailable.forEach((c) => next.add(c.playerId));
      return next;
    });
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const hasActiveFilter =
    sourceFilter !== "all" || !subscribedOnly || addedSince !== "" || search.trim() !== "";

  if (!org) return null;

  return (
    <div style={{ fontFamily: bodyFontStack, color: ink }}>
      <h1 style={{ ...displayHeading }}>Contacts</h1>
      <p style={{ color: inkSoft, fontSize: 15, margin: "0 0 20px", maxWidth: 620, lineHeight: 1.55 }}>
        Everyone in your club's contact list — your registrants plus anyone you've
        imported. Import a spreadsheet of contacts, or email the whole list at once.
      </p>

      {/* Action bar */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 20 }}>
        <button
          style={ctaPrimaryStyle}
          onClick={() => setPanel(panel === "import" ? "none" : "import")}
        >
          Import contacts
        </button>
        <button
          style={recipientIds.length > 0 ? ctaSecondaryStyle : { ...ctaSecondaryStyle, opacity: 0.5, cursor: "not-allowed" }}
          disabled={recipientIds.length === 0}
          onClick={() => setPanel(panel === "compose" ? "none" : "compose")}
          title={recipientIds.length === 0 ? "No contacts with an email address selected" : undefined}
        >
          {selected.size > 0
            ? `Email ${recipientIds.length} selected`
            : `Email all contacts (${recipientIds.length})`}
        </button>
      </div>

      {actionMsg && (
        <div style={{ ...statusPanelStyle("success"), marginBottom: 16 }} role="status">
          {actionMsg}
        </div>
      )}

      {panel === "import" && org && (
        <ImportPanel
          orgId={org.id}
          onClose={() => setPanel("none")}
          onImported={(r) => {
            setActionMsg(
              `Imported ${r.added} new · ${r.matchedExisting} matched existing · ${r.skipped} skipped.`,
            );
            setPanel("none");
            setReloadKey((k) => k + 1);
          }}
        />
      )}

      {panel === "compose" && org && (
        <ComposePanel
          orgId={org.id}
          recipientIds={recipientIds}
          selectionActive={selected.size > 0}
          onClose={() => setPanel("none")}
          onSent={(n) => {
            setActionMsg(`Your message is being sent to ${n} contact${n === 1 ? "" : "s"}.`);
            setPanel("none");
          }}
        />
      )}

      {/* Contacts list */}
      {loadError && (
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 16 }} role="alert">
          {loadError}
        </div>
      )}

      {contacts === null ? (
        <div style={{ color: inkMuted }}>Loading…</div>
      ) : contacts.length === 0 ? (
        <div
          style={{
            border: `1px dashed ${rule}`,
            borderRadius: 10,
            padding: 28,
            textAlign: "center",
            color: inkMuted,
            background: cream,
          }}
        >
          No contacts yet. Import a CSV or spreadsheet to get started — your
          tournament registrants will show up here automatically too.
        </div>
      ) : (
        <>
          {/* Filters */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
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
              <input
                type="date"
                value={addedSince}
                onChange={(e) => setAddedSince(e.target.value)}
                style={{ ...inputStyle, maxWidth: 160 }}
              />
            </label>
            <label style={{ fontSize: 13, color: inkSoft, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={subscribedOnly}
                onChange={(e) => setSubscribedOnly(e.target.checked)}
                style={{ width: 15, height: 15 }}
              />
              Subscribed only
            </label>
            <input
              type="search"
              placeholder="Search name, email, city…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ ...inputStyle, maxWidth: 220, marginLeft: "auto" }}
            />
          </div>

          {/* Count + selection summary */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 13, color: inkMuted }}>
              {visible.length} shown · {emailable.length} emailable
              {selected.size > 0 && ` · ${selected.size} selected`}
            </div>
            {selected.size > 0 && (
              <button style={ghostButtonStyle} onClick={() => setSelected(new Set())}>
                Clear selection
              </button>
            )}
          </div>

          <div style={{ overflowX: "auto", border: `1px solid ${rule}`, borderRadius: 10 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 680 }}>
              <thead>
                <tr style={{ background: cream }}>
                  <th style={{ ...thStyle, width: 36, textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleAllVisible}
                      disabled={visibleEmailable.length === 0}
                      title="Select all shown emailable"
                      style={{ width: 15, height: 15 }}
                    />
                  </th>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Email</th>
                  <th style={thStyle}>Phone</th>
                  <th style={thStyle}>City</th>
                  <th style={thStyle}>Source</th>
                  <th style={{ ...thStyle, width: 90 }}></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => {
                  const canPick = emailableIds.has(c.playerId);
                  return (
                    <tr
                      key={c.playerId}
                      style={{
                        borderTop: `1px solid ${ruleSoft}`,
                        background: selected.has(c.playerId) ? "#f4f9ff" : undefined,
                      }}
                    >
                      <td style={{ ...tdStyle, textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={selected.has(c.playerId)}
                          disabled={!canPick}
                          onChange={() => toggleOne(c.playerId)}
                          title={canPick ? undefined : "No email / unsubscribed — can't be emailed"}
                          style={{ width: 15, height: 15 }}
                        />
                      </td>
                      <td style={tdStyle}>
                        {c.firstName} {c.lastName}
                      </td>
                      <td style={{ ...tdStyle, color: c.email ? ink : inkMuted }}>
                        {c.email ?? "—"}
                        {c.unsubscribed && (
                          <span style={unsubPill} title="Unsubscribed — excluded from emails">
                            unsubscribed
                          </span>
                        )}
                      </td>
                      <td style={tdStyle}>{c.phone ?? "—"}</td>
                      <td style={tdStyle}>{c.city ?? "—"}</td>
                      <td style={tdStyle}>
                        <SourcePill source={c.source} />
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        {c.source === "registrant" ? (
                          <span style={{ color: inkMuted, fontSize: 12 }} title="Registrants are managed via their registration">
                            —
                          </span>
                        ) : (
                          <button style={ghostButtonStyle} onClick={() => setRemoveTarget(c)}>
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {visible.length === 0 && (
                  <tr>
                    <td style={{ ...tdStyle, color: inkMuted }} colSpan={7}>
                      No contacts match {hasActiveFilter ? "these filters" : "your search"}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {removeTarget && (
        <ConfirmModal
          title="Remove contact?"
          body={
            <>
              Remove <strong>{removeTarget.firstName} {removeTarget.lastName}</strong> from
              this club's contact list? This doesn't delete the player — it just takes
              them off your list.
            </>
          }
          confirmLabel="Remove"
          onCancel={() => setRemoveTarget(null)}
          onConfirm={async () => {
            try {
              await removeOrgContact(org.id, removeTarget.playerId);
              setContacts((prev) => (prev ?? []).filter((c) => c.playerId !== removeTarget.playerId));
            } finally {
              setRemoveTarget(null);
            }
          }}
        />
      )}
    </div>
  );
}

// ── Import panel ──────────────────────────────────────────────────────
function ImportPanel({
  orgId,
  onClose,
  onImported,
}: {
  orgId: string;
  onClose: () => void;
  onImported: (r: ImportResult) => void | Promise<void>;
}) {
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [mapping, setMapping] = useState<Record<ContactField, number>>({
    first_name: -1,
    last_name: -1,
    email: -1,
    phone: -1,
    city: -1,
    state: -1,
  });
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setParsing(true);
    setParsed(null);
    try {
      const p = await parseContactsFile(file);
      if (p.headers.length === 0 || p.rows.length === 0) {
        setError("That file looks empty — no header row or data rows found.");
        return;
      }
      setParsed(p);
      setMapping(autoMap(p.headers));
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Couldn't read that file.");
    } finally {
      setParsing(false);
    }
  };

  // Rows usable = those with a non-empty first or last name once mapped.
  const readyCount = useMemo(() => {
    if (!parsed) return 0;
    const fi = mapping.first_name;
    const li = mapping.last_name;
    let n = 0;
    for (const r of parsed.rows) {
      const first = fi >= 0 ? (r[fi] ?? "").trim() : "";
      const last = li >= 0 ? (r[li] ?? "").trim() : "";
      if (first || last) n++;
    }
    return n;
  }, [parsed, mapping]);

  const nameMapped = mapping.first_name >= 0 || mapping.last_name >= 0;

  const doImport = async () => {
    if (!parsed) return;
    setImporting(true);
    setError(null);
    try {
      const rows = parsed.rows.map((r) => ({
        first_name: at(r, mapping.first_name),
        last_name: at(r, mapping.last_name),
        email: at(r, mapping.email),
        phone: at(r, mapping.phone),
        city: at(r, mapping.city),
        state: at(r, mapping.state),
      }));
      const { data, error: fnErr } = await supabase.functions.invoke("import-contacts", {
        body: { organizationId: orgId, rows },
      });
      if (fnErr) {
        setError(await readFnError(fnErr));
        return;
      }
      await onImported(data as ImportResult);
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Import failed.");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div style={{ ...panelStyle, marginBottom: 20 }}>
      <PanelHeader title="Import contacts" onClose={onClose} />
      <p style={{ fontSize: 13, color: inkSoft, margin: "0 0 12px", lineHeight: 1.55 }}>
        Upload a <strong>.csv</strong>, <strong>.xlsx</strong>, or <strong>.xls</strong> file.
        We'll match people to existing players by email so you don't get duplicates.
      </p>

      <input
        type="file"
        accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(e) => void onFile(e.target.files?.[0])}
        style={{ fontSize: 14, marginBottom: 12 }}
      />

      {parsing && <div style={{ color: inkMuted, fontSize: 13 }}>Reading file…</div>}

      {error && (
        <div style={{ ...statusPanelStyle("danger"), margin: "8px 0" }} role="alert">
          {error}
        </div>
      )}

      {parsed && (
        <div style={{ ...panelMutedStyle, marginTop: 8 }}>
          <div style={{ fontSize: 13, color: inkSoft, marginBottom: 12 }}>
            Found <strong>{parsed.rows.length}</strong> row{parsed.rows.length === 1 ? "" : "s"}.
            Match your columns to contact fields:
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
            {CONTACT_FIELDS.map((f) => (
              <label
                key={f.key}
                style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}
              >
                <span style={{ width: 96, color: inkSoft, flexShrink: 0 }}>
                  {f.label}
                  {f.required && <span style={{ color: courtGreen }}> *</span>}
                </span>
                <select
                  value={mapping[f.key]}
                  onChange={(e) =>
                    setMapping((m) => ({ ...m, [f.key]: Number(e.target.value) }))
                  }
                  style={{ ...inputStyle, maxWidth: 280 }}
                >
                  <option value={-1}>— not imported —</option>
                  {parsed.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `Column ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <div style={{ fontSize: 13, color: inkSoft, margin: "14px 0 12px" }}>
            {readyCount} ready
            {parsed.rows.length - readyCount > 0 && (
              <> · {parsed.rows.length - readyCount} skipped (no name)</>
            )}
          </div>

          {!nameMapped && (
            <div style={{ ...statusPanelStyle("warn"), marginBottom: 12 }}>
              Map at least a first or last name column to import.
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button
              style={nameMapped && readyCount > 0 && !importing ? ctaPrimaryStyle : ctaPrimaryDisabledStyle}
              disabled={!nameMapped || readyCount === 0 || importing}
              onClick={doImport}
            >
              {importing ? "Importing…" : `Import ${readyCount} contact${readyCount === 1 ? "" : "s"}`}
            </button>
            <button style={ctaSecondaryStyle} onClick={onClose} disabled={importing}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Compose / email panel ─────────────────────────────────────────────
function ComposePanel({
  orgId,
  recipientIds,
  selectionActive,
  onClose,
  onSent,
}: {
  orgId: string;
  recipientIds: string[];
  selectionActive: boolean;
  onClose: () => void;
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

  const canSend = subject.trim().length > 0 && body.trim().length > 0 && consent && recipientCount > 0;

  const send = async () => {
    setError(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("send-contact-broadcast", {
        // Always pass the explicit recipient list so the send matches exactly
        // what's shown (filters + individual picks, or all emailable).
        body: { organizationId: orgId, subject: subject.trim(), body, consent: true, playerIds: recipientIds, bodyIsHtml },
      });
      if (fnErr) {
        setError(await readFnError(fnErr));
        return;
      }
      const n = (data as { recipientCount?: number })?.recipientCount ?? recipientCount;
      onSent(n);
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Send failed.");
    }
  };

  return (
    <div style={{ ...panelStyle, marginBottom: 20 }}>
      <PanelHeader title={selectionActive ? "Email selected contacts" : "Email all contacts"} onClose={onClose} />
      <p style={{ fontSize: 13, color: inkSoft, margin: "0 0 14px", lineHeight: 1.55 }}>
        This goes to <strong>{recipientCount}</strong> {selectionActive ? "selected " : ""}contact{recipientCount === 1 ? "" : "s"} with
        an email address (unsubscribed contacts are skipped). Recipients get a one-click
        unsubscribe link automatically.
      </p>

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
          <button
            type="button"
            role="tab"
            aria-selected={!bodyIsHtml}
            onClick={() => { setBodyIsHtml(false); setShowPreview(false); }}
            style={modeBtnStyle(!bodyIsHtml)}
          >
            Plain text
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={bodyIsHtml}
            onClick={() => setBodyIsHtml(true)}
            style={modeBtnStyle(bodyIsHtml)}
          >
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
              // Sandboxed with no allow-* so scripts can't run — renders the
              // admin's HTML safely without executing it in our app.
              sandbox=""
              srcDoc={body}
              style={{
                width: "100%",
                height: 340,
                marginTop: 10,
                border: `1px solid ${rule}`,
                borderRadius: 6,
                background: "#fff",
              }}
            />
          )}
        </div>
      )}

      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13, color: inkSoft, marginBottom: 14, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }}
        />
        <span>
          I have permission to email these contacts. They are members, registrants, or
          people who opted in to hear from this club.
        </span>
      </label>

      {error && (
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 12 }} role="alert">
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          style={canSend ? ctaPrimaryStyle : ctaPrimaryDisabledStyle}
          disabled={!canSend}
          onClick={() => setConfirming(true)}
        >
          Send
        </button>
        <button style={ctaSecondaryStyle} onClick={onClose}>
          Cancel
        </button>
      </div>

      {confirming && (
        <ConfirmModal
          title="Send this email?"
          destructive={false}
          body={
            <>
              Send “{subject.trim()}” to <strong>{recipientCount}</strong> contact
              {recipientCount === 1 ? "" : "s"}? This can't be unsent.
            </>
          }
          confirmLabel="Send now"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            await send();
            setConfirming(false);
          }}
        />
      )}
    </div>
  );
}

// ── small shared bits ─────────────────────────────────────────────────
function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
      <h2 style={{ fontFamily: headingFontStack, fontSize: 16, textTransform: "uppercase", letterSpacing: "0.06em", margin: 0 }}>
        {title}
      </h2>
      <button onClick={onClose} style={{ ...ghostButtonStyle, color: inkMuted, textDecoration: "none", fontSize: 20, lineHeight: 1 }} aria-label="Close">
        ×
      </button>
    </div>
  );
}

function SourcePill({ source }: { source: ContactSource }) {
  const map: Record<ContactSource, { label: string; bg: string; fg: string }> = {
    registrant: { label: "Registrant", bg: "#e8f4eb", fg: courtGreen },
    import: { label: "Imported", bg: "#dceeff", fg: courtBlue },
    manual: { label: "Manual", bg: cream, fg: inkSoft },
  };
  const s = map[source];
  return (
    <span
      style={{
        display: "inline-block",
        background: s.bg,
        color: s.fg,
        fontSize: 11,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 999,
      }}
    >
      {s.label}
    </span>
  );
}

// Unwrap a supabase FunctionsError — the edge function's JSON body is on
// err.context as a Response (same idiom as CreateOrganizationPage).
async function readFnError(err: unknown): Promise<string> {
  const ctx = (err as { context?: Response })?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const b = (await ctx.json()) as { error?: string };
      if (b?.error) return b.error;
    } catch {
      /* fall through */
    }
  }
  return (err as { message?: string })?.message ?? "Something went wrong.";
}

function at(row: string[], idx: number): string {
  return idx >= 0 ? (row[idx] ?? "").trim() : "";
}

const displayHeading: CSSProperties = {
  fontFamily: displayFontStack,
  fontSize: "clamp(24px, 3.5vw, 32px)",
  lineHeight: 1.1,
  margin: "0 0 6px",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 11,
  color: inkMuted,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  fontWeight: 600,
  fontFamily: headingFontStack,
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  verticalAlign: "middle",
};

const fieldLabel: CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: inkSoft,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  marginBottom: 6,
};

// Segmented Plain-text / HTML toggle button.
function modeBtnStyle(active: boolean): CSSProperties {
  return {
    padding: "4px 11px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 5,
    cursor: "pointer",
    fontFamily: bodyFontStack,
    border: `1px solid ${active ? ink : rule}`,
    background: active ? ink : "transparent",
    color: active ? "#ffffff" : inkSoft,
  };
}

const unsubPill: CSSProperties = {
  display: "inline-block",
  marginLeft: 8,
  background: "#fdeae6",
  color: "#9c2412",
  fontSize: 10,
  fontWeight: 600,
  padding: "1px 6px",
  borderRadius: 999,
};
