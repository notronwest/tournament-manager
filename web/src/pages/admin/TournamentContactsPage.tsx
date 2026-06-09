import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { ConfirmModal } from "../../components/ConfirmModal";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Contact = Database["public"]["Tables"]["tournament_contacts"]["Row"];

type DraftContact = {
  name: string;
  role: string;
  phone: string;
  email: string;
  is_public: boolean;
  receives_form_messages: boolean;
};

const emptyDraft = (): DraftContact => ({
  name: "",
  role: "",
  phone: "",
  email: "",
  is_public: true,
  receives_form_messages: false,
});

export default function TournamentContactsPage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add form state
  const [showAdd, setShowAdd] = useState(false);
  const [addDraft, setAddDraft] = useState<DraftContact>(emptyDraft());
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Edit state — id of contact being edited
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<DraftContact>(emptyDraft());
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete state
  const [pendingDelete, setPendingDelete] = useState<Contact | null>(null);

  // Reorder busy
  const [reorderBusy, setReorderBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!org || !tournamentSlug) return;
    setError(null);

    const { data: tData, error: tErr } = await supabase
      .from("tournaments")
      .select("*")
      .eq("organization_id", org.id)
      .eq("slug", tournamentSlug)
      .is("deleted_at", null)
      .maybeSingle();

    if (tErr) { setError(tErr.message); setLoading(false); return; }
    if (!tData) { setError("Tournament not found."); setLoading(false); return; }
    setTournament(tData);

    const { data: cData, error: cErr } = await supabase
      .from("tournament_contacts")
      .select("*")
      .eq("tournament_id", tData.id)
      .is("deleted_at", null)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (cErr) { setError(cErr.message); setLoading(false); return; }
    setContacts(cData ?? []);
    setLoading(false);
  }, [org, tournamentSlug]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const handleAdd = async () => {
    if (!tournament) return;
    if (!addDraft.name.trim()) { setAddError("Name is required."); return; }
    setAddBusy(true);
    setAddError(null);
    const maxOrder = contacts.reduce((m, c) => Math.max(m, c.sort_order), -1);
    const { error: err } = await supabase.from("tournament_contacts").insert({
      tournament_id: tournament.id,
      name: addDraft.name.trim(),
      role: addDraft.role.trim() || null,
      phone: addDraft.phone.trim() || null,
      email: addDraft.email.trim() || null,
      is_public: addDraft.is_public,
      receives_form_messages: addDraft.receives_form_messages,
      sort_order: maxOrder + 1,
    });
    setAddBusy(false);
    if (err) { setAddError(err.message); return; }
    setShowAdd(false);
    setAddDraft(emptyDraft());
    void load();
  };

  const startEdit = (c: Contact) => {
    setEditingId(c.id);
    setEditDraft({
      name: c.name,
      role: c.role ?? "",
      phone: c.phone ?? "",
      email: c.email ?? "",
      is_public: c.is_public,
      receives_form_messages: c.receives_form_messages,
    });
    setEditError(null);
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    if (!editDraft.name.trim()) { setEditError("Name is required."); return; }
    setEditBusy(true);
    setEditError(null);
    const { error: err } = await supabase
      .from("tournament_contacts")
      .update({
        name: editDraft.name.trim(),
        role: editDraft.role.trim() || null,
        phone: editDraft.phone.trim() || null,
        email: editDraft.email.trim() || null,
        is_public: editDraft.is_public,
        receives_form_messages: editDraft.receives_form_messages,
        updated_at: new Date().toISOString(),
      })
      .eq("id", editingId);
    setEditBusy(false);
    if (err) { setEditError(err.message); return; }
    setEditingId(null);
    void load();
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    await supabase
      .from("tournament_contacts")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", pendingDelete.id);
    setPendingDelete(null);
    void load();
  };

  const moveContact = async (idx: number, dir: -1 | 1) => {
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= contacts.length) return;
    const a = contacts[idx];
    const b = contacts[swapIdx];
    setReorderBusy(a.id);
    await Promise.all([
      supabase
        .from("tournament_contacts")
        .update({ sort_order: b.sort_order, updated_at: new Date().toISOString() })
        .eq("id", a.id),
      supabase
        .from("tournament_contacts")
        .update({ sort_order: a.sort_order, updated_at: new Date().toISOString() })
        .eq("id", b.id),
    ]);
    setReorderBusy(null);
    void load();
  };

  if (!org || loading) return <div style={pageStyle}>Loading…</div>;
  if (error) return <div style={pageStyle}><div style={errorStyle}>{error}</div></div>;
  if (!tournament) return null;

  return (
    <div style={pageStyle}>
      <nav style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
        <Link
          to={`/admin/${org.slug}/tournaments/${tournament.slug}`}
          style={{ color: "#2563eb", textDecoration: "none" }}
        >
          {tournament.name}
        </Link>
        {" / Tournament Contacts"}
      </nav>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Tournament Contacts</h1>
        {!showAdd && (
          <button
            onClick={() => { setShowAdd(true); setAddDraft(emptyDraft()); setAddError(null); }}
            style={primaryBtn}
          >
            + Add contact
          </button>
        )}
      </div>

      {showAdd && (
        <div style={formCardStyle}>
          <h2 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600 }}>New contact</h2>
          <ContactForm
            draft={addDraft}
            onChange={setAddDraft}
            error={addError}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button onClick={handleAdd} disabled={addBusy} style={primaryBtn}>
              {addBusy ? "Saving…" : "Save contact"}
            </button>
            <button
              onClick={() => { setShowAdd(false); setAddError(null); }}
              disabled={addBusy}
              style={secondaryBtn}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {contacts.length === 0 && !showAdd ? (
        <div style={emptyStyle}>No contacts yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {contacts.map((c, idx) =>
            editingId === c.id ? (
              <div key={c.id} style={formCardStyle}>
                <h2 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600 }}>Edit contact</h2>
                <ContactForm
                  draft={editDraft}
                  onChange={setEditDraft}
                  error={editError}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                  <button onClick={handleSaveEdit} disabled={editBusy} style={primaryBtn}>
                    {editBusy ? "Saving…" : "Save"}
                  </button>
                  <button
                    onClick={() => { setEditingId(null); setEditError(null); }}
                    disabled={editBusy}
                    style={secondaryBtn}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <ContactRow
                key={c.id}
                contact={c}
                idx={idx}
                total={contacts.length}
                reorderBusy={reorderBusy}
                onEdit={() => startEdit(c)}
                onDelete={() => setPendingDelete(c)}
                onMove={(dir) => moveContact(idx, dir)}
              />
            )
          )}
        </div>
      )}

      {pendingDelete && (
        <ConfirmModal
          title={`Remove "${pendingDelete.name}"?`}
          body="This contact will be removed from the tournament. This action can be reversed by an admin via the database."
          confirmLabel="Remove contact"
          onCancel={() => setPendingDelete(null)}
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
}

function ContactForm({
  draft,
  onChange,
  error,
}: {
  draft: DraftContact;
  onChange: (d: DraftContact) => void;
  error: string | null;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {error && <div style={inlineErrorStyle}>{error}</div>}
      <div style={fieldRowStyle}>
        <label style={labelStyle}>Name *</label>
        <input
          style={inputStyle}
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder="e.g. Tournament Director"
          autoFocus
        />
      </div>
      <div style={fieldRowStyle}>
        <label style={labelStyle}>Role</label>
        <input
          style={inputStyle}
          value={draft.role}
          onChange={(e) => onChange({ ...draft, role: e.target.value })}
          placeholder="e.g. Registration, On-site contact"
        />
      </div>
      <div style={fieldRowStyle}>
        <label style={labelStyle}>Phone</label>
        <input
          style={inputStyle}
          value={draft.phone}
          onChange={(e) => onChange({ ...draft, phone: e.target.value })}
          placeholder="e.g. (555) 123-4567"
          type="tel"
        />
      </div>
      <div style={fieldRowStyle}>
        <label style={labelStyle}>Email</label>
        <input
          style={inputStyle}
          value={draft.email}
          onChange={(e) => onChange({ ...draft, email: e.target.value })}
          placeholder="e.g. director@example.com"
          type="email"
        />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
        <label style={checkboxLabelStyle}>
          <input
            type="checkbox"
            checked={draft.is_public}
            onChange={(e) => onChange({ ...draft, is_public: e.target.checked })}
          />
          {" Show on public tournament page"}
        </label>
        {draft.is_public && (
          <div style={spamWarningStyle}>
            Publicly displayed names, emails, and phone numbers can be collected
            by spam bots. Consider using a role-based address (e.g.{" "}
            <em>info@example.com</em>) instead of a personal one.
          </div>
        )}
        <label style={checkboxLabelStyle}>
          <input
            type="checkbox"
            checked={draft.receives_form_messages}
            onChange={(e) => onChange({ ...draft, receives_form_messages: e.target.checked })}
          />
          {" Receives contact form messages"}
        </label>
      </div>
    </div>
  );
}

function ContactRow({
  contact,
  idx,
  total,
  reorderBusy,
  onEdit,
  onDelete,
  onMove,
}: {
  contact: Contact;
  idx: number;
  total: number;
  reorderBusy: string | null;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const busy = reorderBusy === contact.id;
  return (
    <div style={rowCardStyle}>
      <div style={{ display: "flex", gap: 4, flexDirection: "column" }}>
        <button
          onClick={() => onMove(-1)}
          disabled={idx === 0 || busy}
          title="Move up"
          style={reorderBtn(idx === 0 || busy)}
          aria-label="Move up"
        >
          ▲
        </button>
        <button
          onClick={() => onMove(1)}
          disabled={idx === total - 1 || busy}
          title="Move down"
          style={reorderBtn(idx === total - 1 || busy)}
          aria-label="Move down"
        >
          ▼
        </button>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{contact.name}</span>
          {contact.role && (
            <span style={{ fontSize: 12, color: "#777" }}>{contact.role}</span>
          )}
          {!contact.is_public && (
            <span style={privateBadgeStyle}>Private</span>
          )}
          {contact.receives_form_messages && (
            <span style={msgBadgeStyle}>Receives messages</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 4, flexWrap: "wrap" }}>
          {contact.phone && (
            <span style={{ fontSize: 12, color: "#555" }}>{contact.phone}</span>
          )}
          {contact.email && (
            <span style={{ fontSize: 12, color: "#555" }}>{contact.email}</span>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button onClick={onEdit} style={rowActionBtn}>Edit</button>
        <button onClick={onDelete} style={rowDeleteBtn}>Remove</button>
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  padding: "24px 32px",
  maxWidth: 720,
};

const errorStyle: CSSProperties = {
  color: "#dc2626",
  fontSize: 13,
};

const inlineErrorStyle: CSSProperties = {
  color: "#dc2626",
  fontSize: 12,
  padding: "6px 10px",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 4,
};

const emptyStyle: CSSProperties = {
  padding: "24px 0",
  color: "#888",
  fontSize: 13,
};

const formCardStyle: CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: 20,
  marginBottom: 8,
};

const rowCardStyle: CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: "12px 16px",
  display: "flex",
  gap: 12,
  alignItems: "flex-start",
};

const fieldRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "120px 1fr",
  gap: 8,
  alignItems: "center",
};

const labelStyle: CSSProperties = {
  fontSize: 13,
  color: "#555",
  fontWeight: 500,
};

const checkboxLabelStyle: CSSProperties = {
  fontSize: 13,
  color: "#444",
  display: "flex",
  alignItems: "center",
  gap: 6,
  cursor: "pointer",
};

const inputStyle: CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #e2e2e2",
  borderRadius: 4,
  fontSize: 13,
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box",
};

const primaryBtn: CSSProperties = {
  padding: "6px 14px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};

const secondaryBtn: CSSProperties = {
  padding: "6px 14px",
  background: "#fff",
  color: "#555",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "inherit",
};

const rowActionBtn: CSSProperties = {
  padding: "4px 10px",
  background: "#fff",
  color: "#2563eb",
  border: "1px solid #2563eb",
  borderRadius: 4,
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
};

const rowDeleteBtn: CSSProperties = {
  padding: "4px 10px",
  background: "#fff",
  color: "#dc2626",
  border: "1px solid #fecaca",
  borderRadius: 4,
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
};

function reorderBtn(disabled: boolean): CSSProperties {
  return {
    padding: "2px 6px",
    background: "transparent",
    color: disabled ? "#ddd" : "#888",
    border: "none",
    borderRadius: 3,
    fontSize: 10,
    cursor: disabled ? "default" : "pointer",
    fontFamily: "inherit",
    lineHeight: 1,
  };
}

const privateBadgeStyle: CSSProperties = {
  padding: "2px 6px",
  background: "#f3f4f6",
  color: "#6b7280",
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 500,
};

const msgBadgeStyle: CSSProperties = {
  padding: "2px 6px",
  background: "#eff6ff",
  color: "#1d4ed8",
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 500,
};

const spamWarningStyle: CSSProperties = {
  padding: "8px 12px",
  background: "#fffbeb",
  border: "1px solid #fcd34d",
  borderRadius: 4,
  color: "#92400e",
  fontSize: 12,
  lineHeight: 1.5,
};
