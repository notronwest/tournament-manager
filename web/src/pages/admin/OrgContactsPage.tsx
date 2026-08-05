import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { sendLoginLink } from "../../lib/onboardPlayer";
import { ConfirmModal } from "../../components/ConfirmModal";
import { PlayerRegistrationsModal } from "../../components/PlayerRegistrationsModal";
import {
  fetchOrgContacts,
  createOrgContact,
  updateContactPerson,
  removeOrgContact,
  type OrgContact,
  type ContactSource,
  type ContactInput,
} from "../../lib/orgContacts";
import {
  fetchOrgTournamentsWithEvents,
  adminRegisterContact,
  type PickerTournament,
  type ManualPaymentMethod,
  type RegisterKind,
} from "../../lib/adminRegister";
import { computeLineItems, priceTiers, formatUsd } from "../../lib/pricing";
import { pickActivePricingTier } from "../../lib/pricingTiers";
import {
  parseContactsFile,
  autoMap,
  CONTACT_FIELDS,
  type ContactField,
  type ParsedFile,
} from "../../lib/parseContactsFile";
import {
  displayHeading,
  thStyle,
  tdStyle,
  fieldLabel,
  unsubPill,
  readFnError,
} from "./contactsUi";
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
  panelStyle,
  panelMutedStyle,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  ctaSecondaryStyle,
  ghostButtonStyle,
  inputStyle,
  statusPanelStyle,
} from "../../lib/publicTheme";

type Panel = "none" | "import" | "add";

type ImportResult = {
  added: number;
  matchedExisting: number;
  linked: number;
  skipped: number;
  total: number;
};

// Contacts = management surface only (list + search + CRUD + register-for-event).
// Sending email lives on the separate Email page.
export default function OrgContactsPage() {
  const { org } = useCurrentOrg();
  const [contacts, setContacts] = useState<OrgContact[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("none");
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | ContactSource>("all");
  const [subscribedOnly, setSubscribedOnly] = useState(false);
  const [addedSince, setAddedSince] = useState("");
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const onSendLoginLink = async (c: OrgContact) => {
    if (!org || loginBusy) return;
    setLoginBusy(c.playerId);
    setActionMsg(null);
    setActionErr(null);
    const res = await sendLoginLink(c.playerId, { organizationId: org.id });
    if (res.ok) {
      setActionMsg(
        `${res.createdAccount ? "Account created and login link" : "Login link"} emailed to ${c.firstName} ${c.lastName}.`,
      );
      if (res.createdAccount) setReloadKey((k) => k + 1);
    } else {
      setActionErr(`Couldn't send a login link to ${c.firstName}: ${res.error}`);
    }
    setLoginBusy(null);
  };

  const [editTarget, setEditTarget] = useState<OrgContact | null>(null);
  const [removeTarget, setRemoveTarget] = useState<OrgContact | null>(null);
  const [registerTarget, setRegisterTarget] = useState<OrgContact | null>(null);
  const [regsTarget, setRegsTarget] = useState<OrgContact | null>(null);

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

  const reload = () => setReloadKey((k) => k + 1);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (contacts ?? []).filter((c) => {
      if (q && !`${c.firstName} ${c.lastName} ${c.email ?? ""} ${c.city ?? ""}`.toLowerCase().includes(q)) return false;
      if (sourceFilter !== "all" && c.source !== sourceFilter) return false;
      if (subscribedOnly && c.unsubscribed) return false;
      if (addedSince) {
        if (!c.addedAt || c.addedAt.slice(0, 10) < addedSince) return false;
      }
      return true;
    });
  }, [contacts, search, sourceFilter, subscribedOnly, addedSince]);

  const hasActiveFilter =
    sourceFilter !== "all" || subscribedOnly || addedSince !== "" || search.trim() !== "";

  if (!org) return null;

  return (
    <div style={{ fontFamily: bodyFontStack, color: ink }}>
      <h1 style={displayHeading}>Contacts</h1>
      <p style={{ color: inkSoft, fontSize: 15, margin: "0 0 20px", maxWidth: 620, lineHeight: 1.55 }}>
        Manage your club's contact list — your tournament registrants plus anyone you add
        or import. Add a contact, edit their details, or register them for an event.
      </p>

      {/* Action bar */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 20 }}>
        <button style={ctaPrimaryStyle} onClick={() => setPanel(panel === "add" ? "none" : "add")}>
          Add contact
        </button>
        <button style={ctaSecondaryStyle} onClick={() => setPanel(panel === "import" ? "none" : "import")}>
          Import contacts
        </button>
      </div>

      {actionMsg && (
        <div style={{ ...statusPanelStyle("success"), marginBottom: 16 }} role="status">
          {actionMsg}
        </div>
      )}
      {actionErr && (
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 16 }} role="alert">
          {actionErr}
        </div>
      )}

      {panel === "add" && (
        <AddContactPanel
          onClose={() => setPanel("none")}
          onSaved={async (input) => {
            await createOrgContact(org.id, input);
            setActionMsg(`Added ${input.firstName} ${input.lastName}.`.trim());
            setPanel("none");
            reload();
          }}
        />
      )}

      {panel === "import" && (
        <ImportPanel
          orgId={org.id}
          onClose={() => setPanel("none")}
          onImported={(r) => {
            setActionMsg(`Imported ${r.added} new · ${r.matchedExisting} matched existing · ${r.skipped} skipped.`);
            setPanel("none");
            reload();
          }}
        />
      )}

      {loadError && (
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 16 }} role="alert">
          {loadError}
        </div>
      )}

      {contacts === null ? (
        <div style={{ color: inkMuted }}>Loading…</div>
      ) : contacts.length === 0 ? (
        <div style={{ border: `1px dashed ${rule}`, borderRadius: 10, padding: 28, textAlign: "center", color: inkMuted, background: cream }}>
          No contacts yet. Add one or import a CSV/spreadsheet — your tournament registrants
          will show up here automatically too.
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
              <input type="date" value={addedSince} onChange={(e) => setAddedSince(e.target.value)} style={{ ...inputStyle, maxWidth: 160 }} />
            </label>
            <label style={{ fontSize: 13, color: inkSoft, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={subscribedOnly} onChange={(e) => setSubscribedOnly(e.target.checked)} style={{ width: 15, height: 15 }} />
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

          <div style={{ fontSize: 13, color: inkMuted, marginBottom: 10 }}>
            {visible.length} of {contacts.length} shown
          </div>

          <div style={{ overflowX: "auto", border: `1px solid ${rule}`, borderRadius: 10 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 720 }}>
              <thead>
                <tr style={{ background: cream }}>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Email</th>
                  <th style={thStyle}>Phone</th>
                  <th style={thStyle}>City</th>
                  <th style={thStyle}>Source</th>
                  <th style={{ ...thStyle, width: 220 }}></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <tr key={c.playerId} style={{ borderTop: `1px solid ${ruleSoft}` }}>
                    <td style={tdStyle}>{c.firstName} {c.lastName}</td>
                    <td style={{ ...tdStyle, color: c.email ? ink : inkMuted }}>
                      {c.email ?? "—"}
                      {c.unsubscribed && (
                        <span style={unsubPill} title="Unsubscribed — excluded from emails">unsubscribed</span>
                      )}
                    </td>
                    <td style={tdStyle}>{c.phone ?? "—"}</td>
                    <td style={tdStyle}>{c.city ?? "—"}</td>
                    <td style={tdStyle}><SourcePill source={c.source} /></td>
                    <td style={{ ...tdStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                      <button style={rowBtn} onClick={() => setRegisterTarget(c)}>Register</button>
                      <button style={rowBtn} onClick={() => setRegsTarget(c)}>Registrations</button>
                      {c.email && (
                        <button
                          style={rowBtn}
                          disabled={loginBusy !== null}
                          onClick={() => onSendLoginLink(c)}
                          title="Email this person a magic login link (creates + links an account if needed)"
                        >
                          {loginBusy === c.playerId ? "Sending…" : "Login link"}
                        </button>
                      )}
                      <button style={rowBtn} onClick={() => setEditTarget(c)}>Edit</button>
                      {c.source === "registrant" ? (
                        <span style={{ color: inkMuted, fontSize: 12, marginLeft: 8 }} title="Registrants are managed via their registration">—</span>
                      ) : (
                        <button style={rowBtn} onClick={() => setRemoveTarget(c)}>Remove</button>
                      )}
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td style={{ ...tdStyle, color: inkMuted }} colSpan={6}>
                      No contacts match {hasActiveFilter ? "these filters" : "your search"}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editTarget && (
        <ContactFormModal
          title="Edit contact"
          initial={{
            firstName: editTarget.firstName,
            lastName: editTarget.lastName,
            email: editTarget.email,
            phone: editTarget.phone,
            city: editTarget.city,
            state: editTarget.state,
          }}
          note="Edits this person's details wherever they appear — they're a shared record across your tournaments."
          onClose={() => setEditTarget(null)}
          onSave={async (input) => {
            await updateContactPerson(editTarget.playerId, input);
            setContacts((prev) =>
              (prev ?? []).map((c) =>
                c.playerId === editTarget.playerId
                  ? { ...c, firstName: input.firstName, lastName: input.lastName, email: input.email, phone: input.phone, city: input.city, state: input.state }
                  : c,
              ),
            );
            setEditTarget(null);
            setActionMsg("Contact updated.");
          }}
        />
      )}

      {registerTarget && (
        <RegisterForEventModal
          orgId={org.id}
          contact={registerTarget}
          onClose={() => setRegisterTarget(null)}
          onDone={(msg) => {
            setRegisterTarget(null);
            setActionMsg(msg);
            reload();
          }}
        />
      )}

      {regsTarget && (
        <PlayerRegistrationsModal
          orgId={org.id}
          playerId={regsTarget.playerId}
          playerName={`${regsTarget.firstName} ${regsTarget.lastName}`.trim()}
          onClose={() => setRegsTarget(null)}
          onChanged={reload}
        />
      )}

      {removeTarget && (
        <ConfirmModal
          title="Remove contact?"
          body={
            <>
              Remove <strong>{removeTarget.firstName} {removeTarget.lastName}</strong> from
              this club's contact list? This doesn't delete the player — it just takes them off your list.
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

// ── Add contact panel ─────────────────────────────────────────────────
function AddContactPanel({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (input: ContactInput) => Promise<void>;
}) {
  return (
    <div style={{ ...panelStyle, marginBottom: 20 }}>
      <PanelHeader title="Add contact" onClose={onClose} />
      <ContactFormFields submitLabel="Add contact" onCancel={onClose} onSave={onSaved} />
    </div>
  );
}

// ── Contact form (add + edit) ─────────────────────────────────────────
function ContactFormModal({
  title,
  initial,
  note,
  onClose,
  onSave,
}: {
  title: string;
  initial: ContactInput;
  note?: string;
  onClose: () => void;
  onSave: (input: ContactInput) => Promise<void>;
}) {
  return (
    <ModalShell title={title} onClose={onClose}>
      {note && <p style={{ fontSize: 12.5, color: inkSoft, margin: "0 0 14px", lineHeight: 1.5 }}>{note}</p>}
      <ContactFormFields submitLabel="Save changes" initial={initial} onCancel={onClose} onSave={onSave} />
    </ModalShell>
  );
}

function ContactFormFields({
  initial,
  submitLabel,
  onCancel,
  onSave,
}: {
  initial?: ContactInput;
  submitLabel: string;
  onCancel: () => void;
  onSave: (input: ContactInput) => Promise<void>;
}) {
  const [firstName, setFirstName] = useState(initial?.firstName ?? "");
  const [lastName, setLastName] = useState(initial?.lastName ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [city, setCity] = useState(initial?.city ?? "");
  const [stateField, setStateField] = useState(initial?.state ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = (firstName.trim().length > 0 || lastName.trim().length > 0) && !saving;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        firstName,
        lastName,
        email: email || null,
        phone: phone || null,
        city: city || null,
        state: stateField || null,
      });
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Couldn't save the contact.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <Field label="First name">
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Last name">
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} style={inputStyle} />
        </Field>
      </div>
      <Field label="Email">
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ ...inputStyle, marginBottom: 12 }} />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 90px", gap: 12, marginBottom: 4 }}>
        <Field label="Phone">
          <input value={phone} onChange={(e) => setPhone(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="City">
          <input value={city} onChange={(e) => setCity(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="State">
          <input value={stateField} onChange={(e) => setStateField(e.target.value)} maxLength={2} style={inputStyle} />
        </Field>
      </div>

      <p style={{ fontSize: 12, color: inkMuted, margin: "8px 0 12px" }}>A first or last name is required. Everything else is optional.</p>

      {error && (
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 12 }} role="alert">{error}</div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button style={canSave ? ctaPrimaryStyle : ctaPrimaryDisabledStyle} disabled={!canSave} onClick={submit}>
          {saving ? "Saving…" : submitLabel}
        </button>
        <button style={ctaSecondaryStyle} onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </div>
  );
}

// ── Register a contact for an event (comp / offline) ──────────────────
function RegisterForEventModal({
  orgId,
  contact,
  onClose,
  onDone,
}: {
  orgId: string;
  contact: OrgContact;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [tournaments, setTournaments] = useState<PickerTournament[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tournamentId, setTournamentId] = useState<string>("");
  const [selectedEvents, setSelectedEvents] = useState<Set<string>>(new Set());
  // Default to "Leave a balance" (they owe the fee) — NOT comp — so an admin who
  // clicks through without changing the payment option doesn't accidentally
  // register someone for free.
  const [kind, setKind] = useState<RegisterKind>("invoice");
  const [method, setMethod] = useState<ManualPaymentMethod>("cash");
  const [note, setNote] = useState("");
  // Per-event offline amount, in dollars (string), keyed by event id.
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchOrgTournamentsWithEvents(orgId);
        if (cancelled) return;
        setTournaments(data);
        if (data.length > 0) setTournamentId(data[0].id);
      } catch (e) {
        if (cancelled) return;
        setLoadError((e as { message?: string })?.message ?? "Could not load tournaments.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const tournament = useMemo(
    () => (tournaments ?? []).find((t) => t.id === tournamentId) ?? null,
    [tournaments, tournamentId],
  );

  // Active pricing tier → the first/additional rates the modal prices against,
  // matching public checkout (compute_checkout_total). For a tier-priced
  // tournament events have event_fee_cents=0 and the real fee comes from here.
  const rates = useMemo(() => {
    const tier = pickActivePricingTier(tournament?.tiers ?? []);
    return {
      firstEventFeeCents: tier?.first_event_fee_cents ?? 0,
      additionalEventFeeCents: tier?.additional_event_fee_cents ?? 0,
    };
  }, [tournament]);

  // A single event's standalone (first-event) price — its override if set, else
  // the tier's first-event fee. Used for per-row labels and offline prefill.
  const eventStandalonePrice = (feeCents: number) =>
    priceTiers({ id: "", event_fee_cents: feeCents }, rates).fullPrice;

  function toggleEvent(eventId: string, feeCents: number) {
    setSelectedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
    // Default the offline amount to the event's real fee (tier-aware) on first pick.
    setAmounts((prev) =>
      prev[eventId] === undefined
        ? { ...prev, [eventId]: (eventStandalonePrice(feeCents) / 100).toFixed(2) }
        : prev,
    );
  }

  const chosen = useMemo(
    () => (tournament?.events ?? []).filter((e) => selectedEvents.has(e.id)),
    [tournament, selectedEvents],
  );

  // Real amount owed for the "Leave a balance" invoice — the tier-based total
  // (first-event rate for the priciest pick, additional-event rate for the rest,
  // per-event overrides respected). Same algorithm as checkout.
  const invoiceTotalCents = useMemo(
    () =>
      computeLineItems(
        chosen.map((e) => ({ id: e.id, event_fee_cents: e.feeCents })),
        rates,
      ).totalCents,
    [chosen, rates],
  );

  const offlineAmountsValid =
    kind === "comp" ||
    chosen.every((e) => {
      const v = Number(amounts[e.id]);
      return Number.isFinite(v) && v >= 0;
    });

  const canSubmit = chosen.length > 0 && offlineAmountsValid && !submitting;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminRegisterContact({
        organizationId: orgId,
        playerId: contact.playerId,
        registrations: chosen.map((e) => ({
          eventId: e.id,
          amountCents: kind === "offline" ? Math.round(Number(amounts[e.id]) * 100) : 0,
        })),
        kind,
        ...(kind === "offline" ? { method, note: note.trim() || undefined } : {}),
      });
      const parts: string[] = [];
      if (res.registered > 0) {
        const treatment = kind === "comp" ? "comped" : kind === "invoice" ? "balance due — they pay online" : "offline payment";
        parts.push(`Registered ${contact.firstName} for ${res.registered} event${res.registered === 1 ? "" : "s"} (${treatment}).`);
      }
      const already = res.skipped.filter((s) => s.reason === "already_registered").length;
      if (already > 0) parts.push(`${already} already registered — skipped.`);
      const otherSkips = res.skipped.filter((s) => s.reason !== "already_registered").length;
      if (otherSkips > 0) parts.push(`${otherSkips} could not be registered.`);
      if (res.registered === 0 && already === 0 && otherSkips === 0) parts.push("Nothing to register.");
      onDone(parts.join(" "));
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Registration failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title={`Register ${contact.firstName} ${contact.lastName}`.trim()} onClose={onClose}>
      {loadError && <div style={{ ...statusPanelStyle("danger"), marginBottom: 12 }}>{loadError}</div>}

      {tournaments === null ? (
        <div style={{ color: inkMuted }}>Loading tournaments…</div>
      ) : tournaments.length === 0 ? (
        <div style={{ color: inkMuted, fontSize: 14 }}>This club has no tournaments yet. Create one first.</div>
      ) : (
        <>
          <Field label="Tournament">
            <select
              value={tournamentId}
              onChange={(e) => { setTournamentId(e.target.value); setSelectedEvents(new Set()); }}
              style={{ ...inputStyle, marginBottom: 14 }}
            >
              {tournaments.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </Field>

          <div style={{ ...fieldLabel }}>Events</div>
          {tournament && tournament.events.length === 0 ? (
            <div style={{ color: inkMuted, fontSize: 13, marginBottom: 14 }}>This tournament has no events yet.</div>
          ) : (
            <div style={{ border: `1px solid ${rule}`, borderRadius: 8, marginBottom: 14, maxHeight: 220, overflowY: "auto" }}>
              {(tournament?.events ?? []).map((e) => (
                <label
                  key={e.id}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderTop: `1px solid ${ruleSoft}`, fontSize: 14, cursor: "pointer" }}
                >
                  <input type="checkbox" checked={selectedEvents.has(e.id)} onChange={() => toggleEvent(e.id, e.feeCents)} style={{ width: 15, height: 15 }} />
                  <span style={{ flex: 1 }}>{e.name}</span>
                  <span style={{ color: inkMuted, fontSize: 13 }}>
                    {eventStandalonePrice(e.feeCents) > 0 ? formatUsd(eventStandalonePrice(e.feeCents)) : "Free"}
                  </span>
                </label>
              ))}
            </div>
          )}

          {/* Payment treatment */}
          <div style={{ ...fieldLabel }}>Payment</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            <label style={radioRow}>
              <input type="radio" name="kind" checked={kind === "comp"} onChange={() => setKind("comp")} />
              <span><strong>Comp</strong> — waive the fee (register at $0)</span>
            </label>
            <label style={radioRow}>
              <input type="radio" name="kind" checked={kind === "offline"} onChange={() => setKind("offline")} />
              <span><strong>Record offline payment</strong> — collected outside the app</span>
            </label>
            <label style={radioRow}>
              <input type="radio" name="kind" checked={kind === "invoice"} onChange={() => setKind("invoice")} />
              <span><strong>Leave a balance</strong> — they log in and pay online themselves</span>
            </label>
          </div>

          {kind === "invoice" && (
            <div style={{ ...panelMutedStyle, marginBottom: 14, fontSize: 13, color: inkSoft }}>
              {chosen.length === 0 ? (
                <span style={{ color: inkMuted }}>Pick one or more events above — they'll owe the standard fee.</span>
              ) : (
                <>
                  Registers {contact.firstName} as <strong>unpaid</strong>. They'll owe{" "}
                  <strong>{formatUsd(invoiceTotalCents)}</strong>{" "}
                  and can pay online after logging in (send them a login link from their player page).
                </>
              )}
            </div>
          )}

          {kind === "offline" && (
            <div style={{ ...panelMutedStyle, marginBottom: 14 }}>
              {chosen.length === 0 ? (
                <div style={{ color: inkMuted, fontSize: 13 }}>Pick one or more events above to enter amounts.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                  {chosen.map((e) => (
                    <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ flex: 1, fontSize: 13 }}>{e.name}</span>
                      <span style={{ color: inkMuted }}>$</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={amounts[e.id] ?? ""}
                        onChange={(ev) => setAmounts((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                        style={{ ...inputStyle, maxWidth: 110 }}
                      />
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 12 }}>
                <Field label="Method">
                  <select value={method} onChange={(e) => setMethod(e.target.value as ManualPaymentMethod)} style={inputStyle}>
                    <option value="cash">Cash</option>
                    <option value="check">Check</option>
                    <option value="venmo">Venmo</option>
                    <option value="other">Other</option>
                  </select>
                </Field>
                <Field label="Note (optional)">
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. paid at the desk" style={inputStyle} />
                </Field>
              </div>
            </div>
          )}

          {error && <div style={{ ...statusPanelStyle("danger"), marginBottom: 12 }} role="alert">{error}</div>}

          <div style={{ display: "flex", gap: 8 }}>
            <button style={canSubmit ? ctaPrimaryStyle : ctaPrimaryDisabledStyle} disabled={!canSubmit} onClick={submit}>
              {submitting ? "Registering…" : `Register for ${chosen.length || "…"} event${chosen.length === 1 ? "" : "s"}`}
            </button>
            <button style={ctaSecondaryStyle} onClick={onClose} disabled={submitting}>Cancel</button>
          </div>
        </>
      )}
    </ModalShell>
  );
}

// ── A contact's registrations (list → per-reg editor) ─────────────────
// ── Import panel (bulk CSV/XLSX) ──────────────────────────────────────
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
    first_name: -1, last_name: -1, email: -1, phone: -1, city: -1, state: -1,
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
        <div style={{ ...statusPanelStyle("danger"), margin: "8px 0" }} role="alert">{error}</div>
      )}

      {parsed && (
        <div style={{ ...panelMutedStyle, marginTop: 8 }}>
          <div style={{ fontSize: 13, color: inkSoft, marginBottom: 12 }}>
            Found <strong>{parsed.rows.length}</strong> row{parsed.rows.length === 1 ? "" : "s"}. Match your columns to contact fields:
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
            {CONTACT_FIELDS.map((f) => (
              <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                <span style={{ width: 96, color: inkSoft, flexShrink: 0 }}>
                  {f.label}
                  {f.required && <span style={{ color: courtGreen }}> *</span>}
                </span>
                <select
                  value={mapping[f.key]}
                  onChange={(e) => setMapping((m) => ({ ...m, [f.key]: Number(e.target.value) }))}
                  style={{ ...inputStyle, maxWidth: 280 }}
                >
                  <option value={-1}>— not imported —</option>
                  {parsed.headers.map((h, i) => (
                    <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <div style={{ fontSize: 13, color: inkSoft, margin: "14px 0 12px" }}>
            {readyCount} ready
            {parsed.rows.length - readyCount > 0 && <> · {parsed.rows.length - readyCount} skipped (no name)</>}
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
            <button style={ctaSecondaryStyle} onClick={onClose} disabled={importing}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── small shared bits ─────────────────────────────────────────────────
function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(20,24,31,0.45)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "40px 16px", zIndex: 1000, overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ ...panelStyle, width: "100%", maxWidth: 520, margin: 0, fontFamily: bodyFontStack, color: ink }}
      >
        <PanelHeader title={title} onClose={onClose} />
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <span style={fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

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
    <span style={{ display: "inline-block", background: s.bg, color: s.fg, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999 }}>
      {s.label}
    </span>
  );
}

function at(row: string[], idx: number): string {
  return idx >= 0 ? (row[idx] ?? "").trim() : "";
}

const rowBtn: CSSProperties = { ...ghostButtonStyle, fontSize: 13, marginLeft: 8 };

const radioRow: CSSProperties = {
  display: "flex", gap: 10, alignItems: "center", fontSize: 14, color: ink, cursor: "pointer",
};
