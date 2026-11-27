import { useEffect, useMemo, useState } from "react";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { useAuth } from "../../auth/AuthProvider";
import { ConfirmModal } from "../../components/ConfirmModal";
import {
  fetchOrgMembers,
  addOrgMember,
  setOrgMemberRole,
  removeOrgMember,
  memberName,
  ORG_ROLES,
  ROLE_LABELS,
  ROLE_BLURBS,
  type OrgMember,
  type OrgRole,
} from "../../lib/orgMembers";
import {
  ink,
  inkSoft,
  inkMuted,
  rule,
  bodyFontStack,
  pageH1Style,
  pageSubStyle,
  panelStyle,
  panelMutedStyle,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  ctaSecondaryStyle,
  ghostButtonStyle,
  inlineActionStyle,
  inputStyle,
  pillStyle,
  statusPanelStyle,
} from "../../lib/publicTheme";

// Users and Roles — who can sign in and manage this organization. Deliberately
// separate from Contacts: a contact is someone the org emails or registers, a
// user here is someone with a login and admin access to the org itself.
//
// Reads and writes go through the admin-org-members edge function (see
// lib/orgMembers) because emails live in auth.users, which the browser
// client can't read. The guard rails — owner-only owner changes, never
// strand the last owner, never edit your own row — are enforced there too;
// the UI just explains them before you hit one.

// Search only earns its space once the list is long enough to scan badly.
const SEARCH_THRESHOLD = 8;

export default function OrgUsersPage() {
  const { org, role, loading: orgLoading } = useCurrentOrg();
  const { user } = useAuth();

  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  // Admin is the common case — someone helping run the org, not a site owner.
  const [addRole, setAddRole] = useState<OrgRole>("admin");
  const [addBusy, setAddBusy] = useState(false);
  const [ownerAddPending, setOwnerAddPending] = useState(false);

  const [search, setSearch] = useState("");
  const [showRoleHelp, setShowRoleHelp] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  // A row action's outcome belongs IN the row: at 390px the page-top banner
  // can sit hundreds of pixels above the control that was just pressed, so a
  // refusal reads as "nothing happened". Removals are the exception -- their
  // row is gone by then, so that one result goes to the banner.
  const [rowNote, setRowNote] = useState<{ userId: string; tone: "success" | "danger"; text: string } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<OrgMember | null>(null);
  const [ownerTarget, setOwnerTarget] = useState<OrgMember | null>(null);

  const canManage = role === "owner" || role === "admin";
  const canManageOwners = role === "owner";

  // Same reload idiom as the other admin lists: a counter the effect watches,
  // so nothing calls setState straight out of the effect body.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    if (!org || !canManage) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchOrgMembers(org.id);
        if (cancelled) return;
        setMembers(data);
        setLoadError(null);
      } catch (e) {
        if (cancelled) return;
        setLoadError((e as { message?: string })?.message ?? "Could not load who has access.");
        setMembers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org, canManage, reloadKey]);

  // A refusal can outlive its row: if the row was already gone server-side,
  // the resync drops it and the note would have nowhere to render. Fall the
  // note back to the page-level slot in exactly that case.
  const orphanNote =
    rowNote && !(members ?? []).some((m) => m.userId === rowNote.userId) ? rowNote : null;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members ?? [];
    return (members ?? []).filter((m) =>
      `${memberName(m)} ${m.email ?? ""}`.toLowerCase().includes(q),
    );
  }, [members, search]);

  if (!org || orgLoading) return null;

  if (!canManage) {
    return (
      <div style={{ maxWidth: 760 }}>
        <h1 style={pageH1Style}>Users and Roles</h1>
        <div style={{ ...statusPanelStyle("info"), marginTop: 16 }}>
          Owners and admins manage who has access to {org.name}. Ask one of them to change
          someone’s role.
        </div>
      </div>
    );
  }

  const run = async (
    fn: () => Promise<OrgMember[]>,
    userId: string,
    success: string,
    // true when the row won't be there to carry the result (a removal).
    resultAtPageLevel = false,
  ) => {
    setActionMsg(null);
    setActionErr(null);
    setRowNote(null);
    setBusyUserId(userId);
    try {
      setMembers(await fn());
      if (resultAtPageLevel) setActionMsg(success);
      else setRowNote({ userId, tone: "success", text: success });
    } catch (e) {
      const text = (e as { message?: string })?.message ?? "Something went wrong.";
      setRowNote({ userId, tone: "danger", text });
      // The server may have refused for a reason the list explains — resync.
      reload();
    } finally {
      setBusyUserId(null);
    }
  };

  // Granting owner is a hand-over whichever door it comes through, so the Add
  // form asks the same question the row's Role picker does.
  const onAddSubmit = () => {
    if (!addEmail.trim()) return;
    if (addRole === "owner") setOwnerAddPending(true);
    else void onAdd();
  };

  const onAdd = async () => {
    const email = addEmail.trim();
    if (!email) return;
    setAddBusy(true);
    setActionMsg(null);
    setActionErr(null);
    try {
      setMembers(await addOrgMember(org.id, email, addRole));
      setActionMsg(`${email} now has ${ROLE_LABELS[addRole].toLowerCase()} access to ${org.name}.`);
      setAddEmail("");
      setAddRole("admin");
      setShowAdd(false);
    } catch (e) {
      setActionErr((e as { message?: string })?.message ?? "Could not add that person.");
    } finally {
      setAddBusy(false);
    }
  };

  const onRoleChange = (m: OrgMember, next: OrgRole) => {
    if (next === m.role) return;
    // Promoting to owner hands over the keys — confirm it rather than let a
    // stray select change do it.
    if (next === "owner") {
      setOwnerTarget(m);
      return;
    }
    void run(
      () => setOrgMemberRole(org.id, m.userId, next),
      m.userId,
      `${memberName(m)} is now ${ROLE_LABELS[next].toLowerCase()}.`,
    );
  };

  const addDisabled = addBusy || addEmail.trim().length === 0;

  return (
    <div style={{ maxWidth: 760, fontFamily: bodyFontStack }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "flex-end",
          justifyContent: "space-between",
        }}
      >
        <div style={{ minWidth: 240 }}>
          <h1 style={pageH1Style}>Users and Roles</h1>
          <p style={{ ...pageSubStyle, marginBottom: 0 }}>
            Who can sign in and manage {org.name}. Separate from Contacts, which is the people
            you email and register.
          </p>
        </div>
        {!showAdd && (
          <button type="button" style={ctaPrimaryStyle} onClick={() => setShowAdd(true)}>
            Add a person
          </button>
        )}
      </div>

      {actionMsg && (
        <div
          ref={scrollIntoView}
          style={{ ...statusPanelStyle("success"), marginTop: 20 }}
          role="status"
        >
          {actionMsg}
        </div>
      )}
      {actionErr && (
        <div
          ref={scrollIntoView}
          style={{ ...statusPanelStyle("danger"), marginTop: 20 }}
          role="alert"
        >
          {actionErr}
        </div>
      )}
      {orphanNote && (
        <div
          ref={scrollIntoView}
          style={{ ...statusPanelStyle(orphanNote.tone), marginTop: 20 }}
          role={orphanNote.tone === "danger" ? "alert" : "status"}
        >
          {orphanNote.text}
        </div>
      )}
      {loadError && (
        <div style={{ ...statusPanelStyle("danger"), marginTop: 20 }} role="alert">
          {loadError}
        </div>
      )}

      {showAdd && (
        <div style={{ ...panelMutedStyle, marginTop: 20 }}>
          <h2 style={{ fontSize: 16, color: ink, margin: "0 0 4px" }}>Add a person</h2>
          <p style={{ fontSize: 13, color: inkMuted, margin: "0 0 16px", lineHeight: 1.5 }}>
            They need an account on the site first — access is granted to a login, so have
            them sign in once before you add them.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <label style={{ flex: "1 1 240px", minWidth: 0 }}>
              <span style={labelStyle}>Email address</span>
              <input
                type="email"
                value={addEmail}
                autoComplete="off"
                placeholder="them@example.com"
                onChange={(e) => {
                  setAddEmail(e.target.value);
                  if (actionErr) setActionErr(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !addDisabled) onAddSubmit();
                }}
                style={tapInputStyle}
              />
            </label>
            <label style={{ flex: "0 1 160px", minWidth: 0 }}>
              <span style={labelStyle}>Role</span>
              <select
                value={addRole}
                onChange={(e) => setAddRole(e.target.value as OrgRole)}
                style={tapInputStyle}
              >
                {ORG_ROLES.filter((r) => r !== "owner" || canManageOwners).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
            <button
              type="button"
              style={addDisabled ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
              disabled={addDisabled}
              onClick={onAddSubmit}
            >
              {addBusy ? "Adding…" : "Add"}
            </button>
            <button
              type="button"
              style={ctaSecondaryStyle}
              onClick={() => {
                setShowAdd(false);
                setAddEmail("");
                setActionErr(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <button
          type="button"
          style={inlineActionStyle}
          aria-expanded={showRoleHelp}
          onClick={() => setShowRoleHelp((v) => !v)}
        >
          {showRoleHelp ? "▾" : "▸"} What can each role do?
        </button>
        {showRoleHelp && (
          <div style={{ ...panelStyle, marginTop: 8 }}>
            {ORG_ROLES.map((r) => (
              <div key={r} style={{ marginBottom: r === "staff" ? 0 : 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: ink, marginBottom: 2 }}>
                  {ROLE_LABELS[r]}
                </div>
                <div style={{ fontSize: 13, color: inkSoft, lineHeight: 1.5 }}>
                  {ROLE_BLURBS[r]}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {members === null ? (
        <p style={{ color: inkSoft, fontSize: 14, marginTop: 24 }}>Loading…</p>
      ) : members.length === 0 ? (
        <div style={{ ...statusPanelStyle("info"), marginTop: 24 }}>
          Nobody has access to {org.name} yet.
        </div>
      ) : (
        <>
          {members.length >= SEARCH_THRESHOLD && (
            <div style={{ marginTop: 24, maxWidth: 320 }}>
              <label>
                <span style={labelStyle}>Search</span>
                <input
                  type="search"
                  value={search}
                  placeholder="Name or email"
                  onChange={(e) => setSearch(e.target.value)}
                  style={tapInputStyle}
                />
              </label>
            </div>
          )}

          <p style={{ fontSize: 12, color: inkMuted, margin: "24px 0 8px" }}>
            {members.length === 1 ? "1 person has" : `${members.length} people have`} access
            {search.trim() && visible.length !== members.length
              ? ` · ${visible.length} shown`
              : ""}
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {visible.map((m) => (
              <MemberRow
                key={m.userId}
                member={m}
                isSelf={m.userId === user?.id}
                canManageOwners={canManageOwners}
                busy={busyUserId === m.userId}
                note={rowNote?.userId === m.userId ? rowNote : null}
                onRoleChange={onRoleChange}
                onRemove={() => setRemoveTarget(m)}
              />
            ))}
            {visible.length === 0 && (
              <p style={{ fontSize: 14, color: inkSoft }}>Nobody matches “{search.trim()}”.</p>
            )}
          </div>
        </>
      )}

      {removeTarget && (
        <ConfirmModal
          title="Remove access?"
          body={
            <>
              <strong>{memberName(removeTarget)}</strong> will lose access to {org.name}. Their
              account and their player record stay as they are — you can add them back any time.
            </>
          }
          confirmLabel="Remove access"
          onCancel={() => setRemoveTarget(null)}
          onConfirm={async () => {
            const m = removeTarget;
            setRemoveTarget(null);
            await run(
              () => removeOrgMember(org.id, m.userId),
              m.userId,
              `${memberName(m)} no longer has access to ${org.name}.`,
              true,
            );
          }}
        />
      )}

      {ownerAddPending && (
        <ConfirmModal
          title="Add this person as an owner?"
          destructive={false}
          body={
            <>
              <strong>{addEmail.trim()}</strong> will get full access to {org.name}, including
              adding and removing other owners — you included.
            </>
          }
          confirmLabel="Add as owner"
          onCancel={() => setOwnerAddPending(false)}
          onConfirm={async () => {
            setOwnerAddPending(false);
            await onAdd();
          }}
        />
      )}

      {ownerTarget && (
        <ConfirmModal
          title="Make this person an owner?"
          destructive={false}
          body={
            <>
              <strong>{memberName(ownerTarget)}</strong> will get full access to {org.name},
              including adding and removing other owners — you included.
            </>
          }
          confirmLabel="Make owner"
          onCancel={() => setOwnerTarget(null)}
          onConfirm={async () => {
            const m = ownerTarget;
            setOwnerTarget(null);
            await run(
              () => setOrgMemberRole(org.id, m.userId, "owner"),
              m.userId,
              `${memberName(m)} is now an owner.`,
            );
          }}
        />
      )}
    </div>
  );
}

function MemberRow({
  member,
  isSelf,
  canManageOwners,
  busy,
  note,
  onRoleChange,
  onRemove,
}: {
  member: OrgMember;
  isSelf: boolean;
  canManageOwners: boolean;
  busy: boolean;
  note: { tone: "success" | "danger"; text: string } | null;
  onRoleChange: (m: OrgMember, next: OrgRole) => void;
  onRemove: () => void;
}) {
  // An owner's row is owner-only territory; your own row is nobody's to edit
  // here (the server refuses it too) so there's no way to lock yourself out.
  const locked = isSelf || (member.role === "owner" && !canManageOwners);
  const heading = memberName(member);
  const roleOptions = ORG_ROLES.filter((r) => r !== "owner" || canManageOwners);

  return (
    // panelMutedStyle (white), not the cream panel: muted meta text and the
    // red Remove action both fall under the contrast floor on cream.
    <div style={{ ...panelMutedStyle, padding: 16, opacity: busy ? 0.6 : 1 }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            {/* An account with no player profile has no name, and its email
                becomes the heading — one unbreakable token that runs out of
                the card at 390px unless it is allowed to break. */}
            <span style={{ fontSize: 15, fontWeight: 700, color: ink, wordBreak: "break-word" }}>
              {heading}
            </span>
            <span style={pillStyle}>{ROLE_LABELS[member.role]}</span>
            {isSelf && (
              // Outlined on the row's own white, not a cream chip: the cream
              // fill put this label under the contrast floor once the row
              // moved to white, and a second filled chip competed with the
              // role pill beside it.
              <span
                style={{
                  fontSize: 11,
                  color: inkSoft,
                  border: `1px solid ${rule}`,
                  borderRadius: 3,
                  padding: "2px 6px",
                }}
              >
                You
              </span>
            )}
          </div>
          {/* Skipped when the email IS the heading, rather than printing the
              same address twice. */}
          {member.email && heading !== member.email && (
            <div style={{ fontSize: 13, color: inkSoft, marginTop: 4, wordBreak: "break-word" }}>
              {member.email}
            </div>
          )}
          <div style={{ fontSize: 12, color: inkMuted, marginTop: 4 }}>
            {member.lastSignInAt
              ? `Last signed in ${shortDate(member.lastSignInAt)}`
              : "Has never signed in"}
            {member.createdAt ? ` · Added ${shortDate(member.createdAt)}` : ""}
          </div>
        </div>

        {locked ? (
          <span style={{ fontSize: 12, color: inkMuted }}>
            {isSelf ? "Ask another owner or admin to change your role" : "Owner-only"}
          </span>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 12, color: inkMuted }}>Role</span>
              <select
                value={member.role}
                disabled={busy}
                aria-label={`Role for ${memberName(member)}`}
                onChange={(e) => onRoleChange(member, e.target.value as OrgRole)}
                style={{ ...tapInputStyle, width: "auto", padding: "8px 10px" }}
              >
                {roleOptions.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={onRemove}
              // courtRed + underline is the design system's destructive
              // inline action; 44px keeps it thumb-sized at 390px.
              style={{ ...ghostButtonStyle, minHeight: 44, padding: "0 2px" }}
            >
              Remove
            </button>
          </div>
        )}
      </div>

      {note && (
        <div
          ref={scrollIntoView}
          style={{ ...statusPanelStyle(note.tone), marginTop: 12, fontSize: 13 }}
          role={note.tone === "danger" ? "alert" : "status"}
        >
          {note.text}
        </div>
      )}
    </div>
  );
}

// The shared input token is 39px tall; every field on this page carries the
// 44px tap floor instead, same as the row controls.
const tapInputStyle = { ...inputStyle, minHeight: 44 } as const;

const labelStyle = {
  display: "block",
  fontSize: 12,
  color: inkMuted,
  marginBottom: 4,
} as const;

// A row can re-sort out from under the pointer when its role changes, and a
// page-level banner sits at the top of a list that may be long. Either way the
// thing the person needs to read can land off-screen, so every result panel
// brings itself into view as it mounts.
function scrollIntoView(el: HTMLDivElement | null) {
  el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}
