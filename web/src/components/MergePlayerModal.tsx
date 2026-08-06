import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  PlayerPicker,
  emptySelection,
  type PlayerSelection,
} from "./PlayerPicker";
import { ConfirmModal } from "./ConfirmModal";
import {
  previewMerge,
  commitMerge,
  PICK_FIELDS,
  type MergePreview,
  type MergeMoves,
  type MergeRegistration,
  type MergeOverrides,
  type PickField,
} from "../lib/mergePlayers";
import {
  ink,
  inkSoft,
  inkMuted,
  rule,
  ruleSoft,
  bg,
  cream,
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

// Human labels for each pickable profile field.
const FIELD_LABELS: Record<PickField, string> = {
  first_name: "First name",
  last_name: "Last name",
  email: "Email",
  phone: "Phone",
  gender: "Gender",
  dob: "Date of birth",
  city: "City",
  state: "State",
  self_rating_doubles: "Self rating (doubles)",
  self_rating_mixed: "Self rating (mixed)",
  self_rating_singles: "Self rating (singles)",
};

// Fields that are NOT NULL on the players table — we never let the admin pick a
// blank value for these (the loser option is disabled when the loser is blank).
const REQUIRED_FIELDS = new Set<PickField>(["first_name", "last_name"]);

type PickValue = string | number | null;

function isBlank(v: PickValue): boolean {
  return v === null || (typeof v === "string" && v.trim() === "");
}

// Two field values are "the same decision" — both blank, or equal (strings
// compared trimmed). Fields that match need no picker row.
function valuesMatch(a: PickValue, b: PickValue): boolean {
  if (isBlank(a) && isBlank(b)) return true;
  if (isBlank(a) || isBlank(b)) return false;
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  return a === b;
}

// Human-readable value for a field. Blank → muted placeholder; gender codes →
// words; everything else → the raw string/number.
function formatFieldValue(field: PickField, value: PickValue): string {
  if (isBlank(value)) return "— (none)";
  if (field === "gender") {
    if (value === "M") return "Male";
    if (value === "F") return "Female";
    if (value === "X") return "Other";
  }
  return String(value);
}

type PickMap = Partial<Record<PickField, "winner" | "loser">>;

// Default pick per field: the winner's value, UNLESS the winner's is blank and
// the loser's is set (so the only data present is never silently dropped).
function computeDefaultPicks(preview: MergePreview): PickMap {
  const picks: PickMap = {};
  for (const field of PICK_FIELDS) {
    const w = preview.winner[field];
    const l = preview.loser[field];
    picks[field] = isBlank(w) && !isBlank(l) ? "loser" : "winner";
  }
  return picks;
}

// Turn the picks into the override payload: only fields where the admin chose
// the loser's (differing) value. Never blanks a required (NOT NULL) field.
function buildOverrides(preview: MergePreview, picks: PickMap): MergeOverrides {
  const overrides: MergeOverrides = {};
  for (const field of PICK_FIELDS) {
    if (picks[field] !== "loser") continue;
    const w = preview.winner[field];
    const l = preview.loser[field];
    if (valuesMatch(w, l)) continue; // picking loser but it equals winner — no-op
    if (REQUIRED_FIELDS.has(field) && isBlank(l)) continue; // never blank a name
    overrides[field] = l;
  }
  return overrides;
}

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

  // Per-field source pick (which record's value to keep). Seeded from the
  // winner-first default rule whenever a fresh preview loads; reset when the
  // selected duplicate changes.
  const [picks, setPicks] = useState<PickMap>({});

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
        if (!cancelled) {
          setPreview(p);
          setPicks(computeDefaultPicks(p));
        }
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
    setPicks({});
    setPreviewError(null);
    setCommitError(null);
  };

  const clearSelection = () => handleSelectionChange(emptySelection);

  // The field values that will be forced onto the kept record (loser picks that
  // differ from the winner). Empty = the RPC's default (winner keeps everything,
  // blanks backfilled) applies.
  const overrides = useMemo<MergeOverrides>(
    () => (preview ? buildOverrides(preview, picks) : {}),
    [preview, picks],
  );
  const overrideCount = Object.keys(overrides).length;

  const runCommit = async () => {
    if (!loserId) return;
    setCommitting(true);
    setCommitError(null);
    try {
      await commitMerge(winner.id, loserId, overrides);
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
              <PreviewBody
                preview={preview}
                picks={picks}
                onPick={(field, source) =>
                  setPicks((prev) => ({ ...prev, [field]: source }))
                }
              />
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
              move to the kept record.
              {overrideCount > 0 && (
                <>
                  {" "}
                  Your chosen value{overrideCount === 1 ? "" : "s"} for{" "}
                  <strong>{overrideCount}</strong> field
                  {overrideCount === 1 ? "" : "s"} will be applied to the kept
                  record.
                </>
              )}{" "}
              This isn't easily reversible.
            </>
          }
        />
      )}
    </div>
  );
}

// ─── Preview body: identities · moves · conflicts ─────────────────────────────

function PreviewBody({
  preview,
  picks,
  onPick,
}: {
  preview: MergePreview;
  picks: PickMap;
  onPick: (field: PickField, source: "winner" | "loser") => void;
}) {
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

      {/* Field picker — decide, field by field, which value to keep */}
      <FieldPicker preview={preview} picks={picks} onPick={onPick} />

      {/* Registrations — informational (consolidated automatically) */}
      <RegistrationsSection preview={preview} />

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

// ─── Field picker: choose which record's value to keep, per differing field ──

function FieldPicker({
  preview,
  picks,
  onPick,
}: {
  preview: MergePreview;
  picks: PickMap;
  onPick: (field: PickField, source: "winner" | "loser") => void;
}) {
  const differing = PICK_FIELDS.filter(
    (f) => !valuesMatch(preview.winner[f], preview.loser[f]),
  );
  const matchingCount = PICK_FIELDS.length - differing.length;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: ink, marginBottom: 6 }}>
        Choose what to keep
      </div>

      {differing.length === 0 ? (
        <p style={{ fontSize: 13, color: inkMuted, margin: "0 0 4px" }}>
          Both records have the same profile details — nothing to choose.
        </p>
      ) : (
        <>
          <p style={{ fontSize: 12.5, color: inkSoft, margin: "0 0 10px", lineHeight: 1.5 }}>
            These fields differ between the two records. Pick the value to keep
            on <strong>{preview.winner.first_name || "the kept record"}</strong>.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {differing.map((field) => (
              <FieldPickRow
                key={field}
                field={field}
                winnerValue={preview.winner[field]}
                loserValue={preview.loser[field]}
                selected={picks[field] ?? "winner"}
                onPick={(source) => onPick(field, source)}
              />
            ))}
          </div>
        </>
      )}

      {matchingCount > 0 && (
        <p style={{ fontSize: 12, color: inkMuted, margin: "10px 0 0" }}>
          {matchingCount} field{matchingCount === 1 ? "" : "s"} match and{" "}
          {matchingCount === 1 ? "is" : "are"} unchanged.
        </p>
      )}
    </div>
  );
}

function FieldPickRow({
  field,
  winnerValue,
  loserValue,
  selected,
  onPick,
}: {
  field: PickField;
  winnerValue: PickValue;
  loserValue: PickValue;
  selected: "winner" | "loser";
  onPick: (source: "winner" | "loser") => void;
}) {
  // Never allow blanking a NOT NULL field (first/last name) via the loser side.
  const loserDisabled = REQUIRED_FIELDS.has(field) && isBlank(loserValue);

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: ink, marginBottom: 5 }}>
        {FIELD_LABELS[field]}
      </div>
      <div
        role="radiogroup"
        aria-label={FIELD_LABELS[field]}
        style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
      >
        <PickOption
          sourceLabel="This record"
          value={formatFieldValue(field, winnerValue)}
          selected={selected === "winner"}
          onClick={() => onPick("winner")}
        />
        <PickOption
          sourceLabel="Duplicate"
          value={formatFieldValue(field, loserValue)}
          selected={selected === "loser"}
          disabled={loserDisabled}
          onClick={() => onPick("loser")}
        />
      </div>
    </div>
  );
}

function PickOption({
  sourceLabel,
  value,
  selected,
  disabled = false,
  onClick,
}: {
  sourceLabel: string;
  value: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${sourceLabel}: ${value}`}
      disabled={disabled}
      onClick={onClick}
      style={{
        flex: "1 1 180px",
        minWidth: 0,
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        textAlign: "left",
        padding: "8px 10px",
        borderRadius: 8,
        border: selected ? `2px solid ${ink}` : `1px solid ${rule}`,
        // pad-compensate the thinner unselected border so heights match
        margin: selected ? 0 : 1,
        background: selected ? cream : "#fff",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        fontFamily: bodyFontStack,
      }}
    >
      <span
        aria-hidden
        style={{
          flex: "0 0 auto",
          width: 14,
          height: 14,
          marginTop: 2,
          borderRadius: "50%",
          border: `2px solid ${selected ? ink : inkMuted}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected && (
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: ink }} />
        )}
      </span>
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.07em",
            color: inkMuted,
            marginBottom: 2,
          }}
        >
          {sourceLabel}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 13,
            color: ink,
            fontWeight: selected ? 600 : 400,
            overflowWrap: "anywhere",
            lineHeight: 1.35,
          }}
        >
          {value}
        </span>
      </span>
    </button>
  );
}

// ─── Registrations: both parties' history, split Current / Previous ───────────

function RegistrationsSection({ preview }: { preview: MergePreview }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: ink, marginBottom: 4 }}>
        Registrations
      </div>
      <p style={{ fontSize: 12, color: inkMuted, margin: "0 0 8px", lineHeight: 1.5 }}>
        For reference — every registration below moves to the kept record
        automatically. Nothing to choose here.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <RegistrationsParty
          name={`${preview.winner.first_name} ${preview.winner.last_name}`.trim()}
          role="Keep"
          regs={preview.winner_registrations}
        />
        <RegistrationsParty
          name={`${preview.loser.first_name} ${preview.loser.last_name}`.trim()}
          role="Remove"
          regs={preview.loser_registrations}
        />
      </div>
    </div>
  );
}

function RegistrationsParty({
  name,
  role,
  regs,
}: {
  name: string;
  role: "Keep" | "Remove";
  regs: MergeRegistration[];
}) {
  const current = regs.filter((r) => r.is_current);
  const previous = regs.filter((r) => !r.is_current);
  const accent = role === "Keep" ? "#1e6b2c" : "#9c2412";

  return (
    <div
      style={{
        border: `1px solid ${rule}`,
        borderRadius: 8,
        padding: "8px 12px",
        background: "#fff",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 8,
          marginBottom: regs.length > 0 ? 6 : 0,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: ink }}>
          {name || "This record"}
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: accent,
          }}
        >
          {role}
        </span>
      </div>
      {regs.length === 0 ? (
        <div style={{ fontSize: 12.5, color: inkMuted }}>No registrations.</div>
      ) : (
        <>
          <RegistrationGroup label="Current" regs={current} />
          <RegistrationGroup label="Previous" regs={previous} />
        </>
      )}
    </div>
  );
}

function RegistrationGroup({
  label,
  regs,
}: {
  label: string;
  regs: MergeRegistration[];
}) {
  if (regs.length === 0) return null;
  return (
    <div style={{ marginTop: 4 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: inkMuted,
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
        {regs.map((r, i) => (
          <li
            key={`${r.event_name}-${r.tournament}-${i}`}
            style={{ fontSize: 12.5, color: inkSoft, lineHeight: 1.45, padding: "1px 0" }}
          >
            <span style={{ color: ink }}>{r.event_name}</span>
            {r.format ? ` · ${r.format}` : ""} · {r.tournament} · {r.status}
          </li>
        ))}
      </ul>
    </div>
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
