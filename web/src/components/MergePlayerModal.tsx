import { useEffect, useState, type CSSProperties } from "react";
import {
  PlayerPicker,
  emptySelection,
  type PlayerSelection,
} from "./PlayerPicker";
import { ConfirmModal } from "./ConfirmModal";
import {
  previewMerge,
  commitMerge,
  type MergePreview,
  type MergeMoves,
} from "../lib/mergePlayers";
import {
  ink,
  inkSoft,
  inkMuted,
  rule,
  ruleSoft,
  bg,
  panelStyle,
  bodyFontStack,
  headingFontStack,
  ghostButtonStyle,
  ctaSecondaryStyle,
  statusPanelStyle,
} from "../lib/publicTheme";

// Platform-admin "merge duplicate players" flow. The current player on the
// PlayerDetailPage is the WINNER (kept); the admin searches for the duplicate
// (LOSER) whose data gets folded in and is then soft-deleted.
//
// Steps: pick the duplicate → preview the impact (what moves + conflicts) →
// confirm → commit. The server (admin-merge-players) enforces platform-admin
// authz and does the actual re-pointing.

// Human labels for the moves map, in the order we want to show them.
const MOVE_LABELS: { key: keyof MergeMoves; label: string }[] = [
  { key: "event_registrations", label: "Event registrations" },
  { key: "registrations", label: "Tournament registrations" },
  { key: "player_ratings", label: "Skill ratings" },
  { key: "partner_invites", label: "Partner invites" },
  { key: "payments", label: "Payments" },
  { key: "manual_payments", label: "Manual payments" },
  { key: "tournament_change_requests", label: "Change requests" },
  { key: "organization_contacts", label: "Org contact entries" },
  { key: "contact_broadcast_recipients", label: "Email recipients" },
];

export function MergePlayerModal({
  winner,
  onClose,
  onMerged,
}: {
  winner: { id: string; first_name: string; last_name: string; email: string | null };
  onClose: () => void;
  onMerged: () => void;
}) {
  const [selection, setSelection] = useState<PlayerSelection>(emptySelection);
  const loserId = selection.mode === "existing" ? selection.player.id : null;

  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Fetch the preview whenever a duplicate is selected. The reset-on-deselect
  // case is handled in handleSelectionChange so this effect only ever runs a
  // fetch (keeps the "no setState in effect" rule happy for the reset path).
  useEffect(() => {
    if (!loserId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreviewLoading(true);
    (async () => {
      try {
        const p = await previewMerge(winner.id, loserId);
        if (!cancelled) setPreview(p);
      } catch (e) {
        if (!cancelled) {
          setPreviewError((e as Error).message ?? "Could not preview the merge.");
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [winner.id, loserId]);

  // Wrap PlayerPicker's onChange so selecting/clearing a duplicate also resets
  // any prior preview + errors (the picker's own × clears to emptySelection).
  const handleSelectionChange = (s: PlayerSelection) => {
    setSelection(s);
    setPreview(null);
    setPreviewError(null);
    setCommitError(null);
  };

  const clearSelection = () => handleSelectionChange(emptySelection);

  const runCommit = async () => {
    if (!loserId) return;
    setCommitting(true);
    setCommitError(null);
    try {
      await commitMerge(winner.id, loserId);
      setConfirmOpen(false);
      setDone(true);
    } catch (e) {
      setConfirmOpen(false);
      setCommitError((e as Error).message ?? "Merge failed.");
    } finally {
      setCommitting(false);
    }
  };

  const winnerName = `${winner.first_name} ${winner.last_name}`.trim();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Merge duplicate player"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20,24,31,0.45)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "40px 16px",
        zIndex: 1000,
        overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          ...panelStyle,
          width: "100%",
          maxWidth: 560,
          margin: 0,
          fontFamily: bodyFontStack,
          color: ink,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <h2
            style={{
              fontFamily: headingFontStack,
              fontSize: 16,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              margin: 0,
            }}
          >
            Merge duplicate player
          </h2>
          <button
            onClick={onClose}
            style={{ ...ghostButtonStyle, color: inkMuted, textDecoration: "none", fontSize: 20, lineHeight: 1 }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {done ? (
          <SuccessView winnerName={winnerName} onDone={onMerged} />
        ) : (
          <>
            {/* Keep-this-record framing */}
            <div style={{ ...statusPanelStyle("info"), marginBottom: 14 }}>
              <div style={{ fontWeight: 600, color: ink, marginBottom: 4 }}>
                Keeping {winnerName || "this record"} (winner)
              </div>
              <div style={{ fontSize: 13, color: inkSoft, lineHeight: 1.5 }}>
                Search for the <strong>duplicate</strong> below. Its data will be
                merged into this record, and the duplicate will then be removed.
              </div>
            </div>

            {/* Step 1 — pick the duplicate */}
            <div style={{ marginBottom: 6 }}>
              <PlayerPicker
                label="Duplicate to merge in (removed after)"
                selection={selection}
                onChange={handleSelectionChange}
                excludePlayerIds={[winner.id]}
              />
            </div>
            {selection.mode === "existing" && (
              <button
                type="button"
                onClick={clearSelection}
                style={{ ...ghostButtonStyle, color: inkMuted, textDecoration: "underline", fontSize: 12 }}
              >
                Pick a different duplicate
              </button>
            )}

            {/* Step 2 — preview */}
            {previewLoading && (
              <div style={{ marginTop: 14, fontSize: 13, color: inkMuted }}>
                Checking what this merge affects…
              </div>
            )}
            {previewError && (
              <div style={{ ...statusPanelStyle("danger"), marginTop: 14 }} role="alert">
                {previewError}
              </div>
            )}
            {preview && !previewLoading && (
              <PreviewBody preview={preview} />
            )}

            {commitError && (
              <div style={{ ...statusPanelStyle("danger"), marginTop: 14 }} role="alert">
                {commitError}
              </div>
            )}

            {/* Step 3 — actions */}
            <div
              style={{
                marginTop: 20,
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                onClick={onClose}
                style={{ ...ctaSecondaryStyle, fontSize: 13, padding: "10px 16px" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={!preview || previewLoading || committing}
                style={{
                  ...mergeBtnStyle,
                  opacity: !preview || previewLoading || committing ? 0.5 : 1,
                  cursor: !preview || previewLoading || committing ? "not-allowed" : "pointer",
                }}
              >
                {committing ? "Merging…" : "Merge…"}
              </button>
            </div>
          </>
        )}
      </div>

      {confirmOpen && preview && (
        <ConfirmModal
          title="Merge these players?"
          confirmLabel="Merge and remove duplicate"
          onCancel={() => setConfirmOpen(false)}
          onConfirm={runCommit}
          body={
            <>
              <strong>
                {preview.loser.first_name} {preview.loser.last_name}
              </strong>{" "}
              will be merged into{" "}
              <strong>
                {preview.winner.first_name} {preview.winner.last_name}
              </strong>
              , then soft-deleted. Their registrations, payments, and history
              move to the kept record. This isn't easily reversible.
            </>
          }
        />
      )}
    </div>
  );
}

// ─── Preview body: identities · moves · conflicts ─────────────────────────────

function PreviewBody({ preview }: { preview: MergePreview }) {
  const moves = MOVE_LABELS.filter(({ key }) => preview.moves[key] > 0);
  const c = preview.conflicts;
  const hasConflicts =
    c.both_have_accounts ||
    c.same_event_registrations.length > 0 ||
    c.same_tournament_registrations.length > 0 ||
    c.same_org_contacts.length > 0 ||
    c.invites_between_them > 0 ||
    c.partners_with_each_other.length > 0;

  return (
    <div style={{ marginTop: 16 }}>
      {/* Identities */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
        <PartyRow role="Keep" party={preview.winner} tone="success" />
        <PartyRow role="Remove" party={preview.loser} tone="danger" />
      </div>

      {/* Moves */}
      <div style={{ fontSize: 12, fontWeight: 600, color: ink, marginBottom: 6 }}>
        What moves to the kept record
      </div>
      {moves.length === 0 ? (
        <p style={{ fontSize: 13, color: inkMuted, margin: "0 0 12px" }}>
          The duplicate has no data to move — merging just removes it.
        </p>
      ) : (
        <div
          style={{
            border: `1px solid ${rule}`,
            borderRadius: 8,
            overflow: "hidden",
            marginBottom: 12,
          }}
        >
          {moves.map(({ key, label }, i) => (
            <div
              key={key}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "7px 12px",
                fontSize: 13,
                background: i % 2 ? bg : "#fff",
                borderBottom: i < moves.length - 1 ? `1px solid ${ruleSoft}` : undefined,
              }}
            >
              <span style={{ color: inkSoft }}>{label}</span>
              <span style={{ color: ink, fontWeight: 600 }}>{preview.moves[key]}</span>
            </div>
          ))}
        </div>
      )}

      {/* Conflicts */}
      <div style={{ fontSize: 12, fontWeight: 600, color: ink, margin: "4px 0 6px" }}>
        Conflicts to be aware of
      </div>
      {!hasConflicts ? (
        <div style={statusPanelStyle("success")}>
          No conflicts — the two records don't overlap anywhere.
        </div>
      ) : (
        <div style={{ ...statusPanelStyle("warn"), padding: "12px 16px" }}>
          <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8 }}>
            {c.both_have_accounts && (
              <li>
                Both have a login account — the duplicate's login will be{" "}
                <strong>detached</strong> (the kept record's login stays).
              </li>
            )}
            {c.same_event_registrations.length > 0 && (
              <li>
                Both are registered in{" "}
                <strong>{c.same_event_registrations.length}</strong> of the same
                event{c.same_event_registrations.length === 1 ? "" : "s"} — the
                duplicate's registration for{" "}
                {c.same_event_registrations.length === 1 ? "it" : "these"} will be{" "}
                <strong>dropped</strong>:
                <ConflictList
                  items={c.same_event_registrations.map(
                    (e) => `${e.event_name} · ${e.tournament}`,
                  )}
                />
              </li>
            )}
            {c.same_tournament_registrations.length > 0 && (
              <li>
                Both have a tournament-level registration in{" "}
                <strong>{c.same_tournament_registrations.length}</strong> of the
                same tournament
                {c.same_tournament_registrations.length === 1 ? "" : "s"} — the
                duplicate's is dropped:
                <ConflictList items={c.same_tournament_registrations.map((t) => t.tournament)} />
              </li>
            )}
            {c.same_org_contacts.length > 0 && (
              <li>
                Both appear as a contact in{" "}
                <strong>{c.same_org_contacts.length}</strong> of the same
                organization
                {c.same_org_contacts.length === 1 ? "" : "s"} — the duplicate's
                contact entry is dropped:
                <ConflictList items={c.same_org_contacts.map((o) => o.organization)} />
              </li>
            )}
            {c.invites_between_them > 0 && (
              <li>
                There {c.invites_between_them === 1 ? "is" : "are"}{" "}
                <strong>{c.invites_between_them}</strong> partner invite
                {c.invites_between_them === 1 ? "" : "s"} directly between them —{" "}
                {c.invites_between_them === 1 ? "it" : "they"} will be removed.
              </li>
            )}
            {c.partners_with_each_other.length > 0 && (
              <li>
                They're doubles partners with each other in{" "}
                <strong>{c.partners_with_each_other.length}</strong> event
                {c.partners_with_each_other.length === 1 ? "" : "s"} — the pairing
                will be <strong>broken</strong>:
                <ConflictList items={c.partners_with_each_other.map((e) => e.event_name)} />
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function ConflictList({ items }: { items: string[] }) {
  return (
    <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 12.5, color: inkSoft }}>
      {items.map((it, i) => (
        <li key={`${it}-${i}`}>{it}</li>
      ))}
    </ul>
  );
}

function PartyRow({
  role,
  party,
  tone,
}: {
  role: string;
  party: MergePreview["winner"];
  tone: "success" | "danger";
}) {
  const accent = tone === "success" ? "#1e6b2c" : "#9c2412";
  return (
    <div
      style={{
        border: `1px solid ${rule}`,
        borderLeft: `4px solid ${accent}`,
        borderRadius: 8,
        padding: "8px 12px",
        background: tone === "success" ? "#f6faf7" : "#fdf6f4",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: ink }}>
          {party.first_name} {party.last_name}
        </div>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: accent,
          }}
        >
          {role}
        </div>
      </div>
      <div style={{ fontSize: 12, color: inkSoft, marginTop: 2 }}>
        {party.email || "no email"}
        {" · "}
        {party.has_account ? "has login account" : "no login account"}
        {party.deleted ? " · already deleted" : ""}
      </div>
    </div>
  );
}

function SuccessView({ winnerName, onDone }: { winnerName: string; onDone: () => void }) {
  return (
    <div>
      <div style={statusPanelStyle("success")}>
        Merge complete. The duplicate was removed and its data now lives on{" "}
        <strong>{winnerName || "the kept record"}</strong>.
      </div>
      <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onDone}
          style={{ ...ctaSecondaryStyle, fontSize: 13, padding: "10px 16px" }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

const mergeBtnStyle: CSSProperties = {
  padding: "10px 16px",
  background: "#9c2412",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 13,
  fontFamily: headingFontStack,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  cursor: "pointer",
};
