import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../../supabase";
import type { Database } from "../../types/supabase";
import { usePlatformAdmin } from "../../hooks/usePlatformAdmin";
import {
  PlayerPicker,
  emptySelection,
  type PlayerSelection,
} from "../../components/PlayerPicker";
import { ConfirmModal } from "../../components/ConfirmModal";
import {
  previewMerge,
  commitMerge,
  PICK_FIELDS,
  type MergePreview,
  type MergeRegistration,
  type MergeOverrides,
  type PickField,
} from "../../lib/mergePlayers";
import {
  ink,
  inkSoft,
  inkMuted,
  rule,
  ruleSoft,
  bg,
  cream,
  courtGreen,
  successBg,
  successFg,
  bodyFontStack,
  breadcrumbLinkStyle,
  pageH1Style,
  panelStyle,
  ctaPrimaryStyle,
  ctaSecondaryStyle,
  statusPanelStyle,
} from "../../lib/publicTheme";

// Platform-admin "Merge accounts" wizard. Two steps:
//   1. Pick a Source account (removed after merge) and a Destination account
//      (kept). The Source's data folds into the Destination.
//   2. Review the two profiles field-by-field, choose which value survives on
//      each field, and commit the merge.
//
// Maps onto lib/mergePlayers: Destination = winner (kept), Source = loser
// (removed). So previewMerge(destinationId, sourceId) and
// commitMerge(destinationId, sourceId, overrides). In the preview result,
// preview.winner = Destination, preview.loser = Source.

type PlayerRow = Database["public"]["Tables"]["players"]["Row"];

// ─── Field helpers (lifted from the retired MergePlayerModal) ──────────────────

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

// NOT NULL columns on players — never let the admin blank these via the Source.
const REQUIRED_FIELDS = new Set<PickField>(["first_name", "last_name"]);

type PickValue = string | number | null;
type Side = "source" | "destination";
type PickMap = Partial<Record<PickField, Side>>;

function isBlank(v: PickValue): boolean {
  return v === null || (typeof v === "string" && v.trim() === "");
}

// Two values represent "the same decision" — both blank, or equal (strings
// compared trimmed). Fields that match need no override.
function valuesMatch(a: PickValue, b: PickValue): boolean {
  if (isBlank(a) && isBlank(b)) return true;
  if (isBlank(a) || isBlank(b)) return false;
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  return a === b;
}

// Human-readable value for a non-blank field. Gender codes → words; everything
// else → the raw string/number. Blank is handled by the caller (renders "—").
function formatFieldValue(field: PickField, value: PickValue): string {
  if (field === "gender") {
    if (value === "M") return "Male";
    if (value === "F") return "Female";
    if (value === "X") return "Other";
  }
  return String(value);
}

// Default pick per field: the Destination's value, UNLESS the Destination is
// blank and the Source has one (so the only data present is never dropped).
function computeDefaultPicks(preview: MergePreview): PickMap {
  const picks: PickMap = {};
  for (const field of PICK_FIELDS) {
    const dest = preview.winner[field];
    const src = preview.loser[field];
    picks[field] = isBlank(dest) && !isBlank(src) ? "source" : "destination";
  }
  return picks;
}

// Turn the picks into the override payload: only fields where the admin chose
// the Source's (differing) value. Never blanks a required (NOT NULL) name.
function buildOverrides(preview: MergePreview, picks: PickMap): MergeOverrides {
  const overrides: MergeOverrides = {};
  for (const field of PICK_FIELDS) {
    if (picks[field] !== "source") continue;
    const dest = preview.winner[field];
    const src = preview.loser[field];
    if (valuesMatch(dest, src)) continue; // Source == Destination — no-op
    if (REQUIRED_FIELDS.has(field) && isBlank(src)) continue; // never blank a name
    overrides[field] = src;
  }
  return overrides;
}

const fullName = (p: { first_name: string; last_name: string }) =>
  `${p.first_name} ${p.last_name}`.trim();

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function MergeAccountsPage() {
  const isPlatformAdmin = usePlatformAdmin();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [step, setStep] = useState<1 | 2>(1);
  const [sourceSelection, setSourceSelection] = useState<PlayerSelection>(emptySelection);
  const [destSelection, setDestSelection] = useState<PlayerSelection>(emptySelection);

  const source = sourceSelection.mode === "existing" ? sourceSelection.player : null;
  const destination = destSelection.mode === "existing" ? destSelection.player : null;

  // Pre-resolve ?destination=<playerId> into the Destination picker on mount.
  const prefillId = searchParams.get("destination");
  useEffect(() => {
    if (!prefillId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("players")
        .select("*")
        .eq("id", prefillId)
        .is("deleted_at", null)
        .single();
      if (cancelled || !data) return;
      const p = data as PlayerRow;
      setDestSelection({
        mode: "existing",
        player: p,
        emailDraft: p.email ?? "",
        phoneDraft: p.phone ?? "",
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [prefillId]);

  // Step-2 preview state.
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [picks, setPicks] = useState<PickMap>({});

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Fetch the preview whenever we're on step 2 without one. Guarded on the two
  // ids so a Back → change → Next re-runs it.
  useEffect(() => {
    if (step !== 2 || !source || !destination) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreviewLoading(true);
    setPreviewError(null);
    (async () => {
      try {
        const p = await previewMerge(destination.id, source.id);
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
  }, [step, source, destination]);

  const overrides = useMemo<MergeOverrides>(
    () => (preview ? buildOverrides(preview, picks) : {}),
    [preview, picks],
  );
  const overrideCount = Object.keys(overrides).length;

  const bothPicked = !!source && !!destination;
  const samePlayer = bothPicked && source!.id === destination!.id;
  const step1Valid = bothPicked && !samePlayer;

  const goNext = () => {
    if (!step1Valid) return;
    // Fresh preview each time we advance (ids may have changed).
    setPreview(null);
    setPicks({});
    setPreviewError(null);
    setCommitError(null);
    setStep(2);
  };

  const goBack = () => {
    setStep(1);
    setCommitError(null);
  };

  const runCommit = async () => {
    if (!source || !destination) return;
    setCommitting(true);
    setCommitError(null);
    try {
      await commitMerge(destination.id, source.id, overrides);
      setConfirmOpen(false);
      setDone(true);
    } catch (e) {
      setConfirmOpen(false);
      setCommitError((e as Error).message ?? "Merge failed.");
    } finally {
      setCommitting(false);
    }
  };

  // ─── Gating ─────────────────────────────────────────────────────────────────
  if (isPlatformAdmin === null) {
    return (
      <div style={{ padding: 24, color: inkMuted, fontSize: 14, fontFamily: bodyFontStack }}>
        Loading…
      </div>
    );
  }
  if (!isPlatformAdmin) {
    return (
      <main style={{ padding: "24px 32px", maxWidth: 600, margin: "0 auto", fontFamily: bodyFontStack }}>
        <h1 style={{ ...pageH1Style, fontSize: 20, marginTop: 0 }}>Access denied</h1>
        <p style={{ color: inkSoft, fontSize: 14 }}>
          This page is restricted to platform administrators.
        </p>
        <Link to="/admin" style={breadcrumbLinkStyle}>
          ← Back to admin
        </Link>
      </main>
    );
  }

  // ─── Success view ─────────────────────────────────────────────────────────────
  if (done && destination) {
    const destName = fullName(destination);
    return (
      <main style={pageStyle}>
        <div style={{ marginBottom: 16 }}>
          <Link to="/admin/attendees" style={breadcrumbLinkStyle}>
            ← All players
          </Link>
        </div>
        <h1 style={{ ...pageH1Style, fontSize: 24, marginBottom: 12 }}>Accounts merged</h1>
        <div style={statusPanelStyle("success")}>
          Merged. The source account was removed and its data now lives on{" "}
          <strong>{destName || "the destination account"}</strong>.
        </div>
        <div style={{ marginTop: 20 }}>
          <button
            type="button"
            onClick={() => navigate(`/admin/players/${destination.id}`)}
            style={{ ...ctaPrimaryStyle, fontSize: 13, padding: "10px 18px" }}
          >
            Done
          </button>
        </div>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <div style={{ marginBottom: 16 }}>
        <Link to="/admin/attendees" style={breadcrumbLinkStyle}>
          ← All players
        </Link>
      </div>

      {/* Step indicator */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, fontSize: 12, color: inkMuted }}>
        <StepDot n={1} active={step === 1} done={step > 1} label="Select accounts" />
        <span aria-hidden style={{ color: rule }}>—</span>
        <StepDot n={2} active={step === 2} done={false} label="Account details" />
      </div>

      {step === 1 ? (
        <StepSelect
          sourceSelection={sourceSelection}
          destSelection={destSelection}
          onSourceChange={setSourceSelection}
          onDestChange={setDestSelection}
          source={source}
          destination={destination}
          samePlayer={samePlayer}
          canNext={step1Valid}
          onCancel={() => navigate(-1)}
          onNext={goNext}
        />
      ) : (
        <StepDetails
          source={source}
          destination={destination}
          preview={preview}
          previewLoading={previewLoading}
          previewError={previewError}
          picks={picks}
          onPick={(field, side) => setPicks((prev) => ({ ...prev, [field]: side }))}
          overrideCount={overrideCount}
          committing={committing}
          commitError={commitError}
          onBack={goBack}
          onMergeClick={() => setConfirmOpen(true)}
        />
      )}

      {confirmOpen && preview && source && destination && (
        <ConfirmModal
          title="Merge these accounts?"
          confirmLabel="Merge accounts"
          onCancel={() => setConfirmOpen(false)}
          onConfirm={runCommit}
          body={
            <>
              <strong>{fullName(source)}</strong> will be merged into{" "}
              <strong>{fullName(destination)}</strong> and removed. Its
              registrations, payments, and history move to the destination.
              {overrideCount > 0 && (
                <>
                  {" "}
                  <strong>{overrideCount}</strong> field choice
                  {overrideCount === 1 ? "" : "s"} will be applied.
                </>
              )}{" "}
              This isn't easily reversible.
            </>
          }
        />
      )}
    </main>
  );
}

// ─── Step 1 — select accounts ─────────────────────────────────────────────────

function StepSelect({
  sourceSelection,
  destSelection,
  onSourceChange,
  onDestChange,
  source,
  destination,
  samePlayer,
  canNext,
  onCancel,
  onNext,
}: {
  sourceSelection: PlayerSelection;
  destSelection: PlayerSelection;
  onSourceChange: (s: PlayerSelection) => void;
  onDestChange: (s: PlayerSelection) => void;
  source: PlayerRow | null;
  destination: PlayerRow | null;
  samePlayer: boolean;
  canNext: boolean;
  onCancel: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <h1 style={{ ...pageH1Style, fontSize: 24, marginBottom: 6 }}>Select accounts to merge</h1>
      <p style={{ fontSize: 14, color: inkSoft, margin: "0 0 24px", maxWidth: 560, lineHeight: 1.55 }}>
        Please choose the accounts you would like to merge.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 20,
        }}
      >
        <AccountColumn
          columnLabel="Source account · removed after merge"
          pickerLabel="Source account"
          selection={sourceSelection}
          onChange={onSourceChange}
          excludeIds={destination ? [destination.id] : []}
          player={source}
          tone="danger"
        />
        <AccountColumn
          columnLabel="Destination account · kept"
          pickerLabel="Destination account"
          selection={destSelection}
          onChange={onDestChange}
          excludeIds={source ? [source.id] : []}
          player={destination}
          tone="success"
        />
      </div>

      {samePlayer && (
        <div style={{ ...statusPanelStyle("danger"), marginTop: 20 }} role="alert">
          The source and destination must be two different accounts.
        </div>
      )}

      <div style={footerRowStyle}>
        <button type="button" onClick={onCancel} style={{ ...ctaSecondaryStyle, ...footerBtnStyle }}>
          Cancel
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canNext}
          style={{
            ...ctaPrimaryStyle,
            ...footerBtnStyle,
            opacity: canNext ? 1 : 0.5,
            cursor: canNext ? "pointer" : "not-allowed",
          }}
        >
          Next
        </button>
      </div>
    </>
  );
}

function AccountColumn({
  columnLabel,
  pickerLabel,
  selection,
  onChange,
  excludeIds,
  player,
  tone,
}: {
  columnLabel: string;
  pickerLabel: string;
  selection: PlayerSelection;
  onChange: (s: PlayerSelection) => void;
  excludeIds: string[];
  player: PlayerRow | null;
  tone: "success" | "danger";
}) {
  const accent = tone === "success" ? successFg : "#9c2412";
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: accent,
          marginBottom: 8,
        }}
      >
        {columnLabel}
      </div>
      <div style={{ display: "flex", marginBottom: 12 }}>
        <PlayerPicker
          label={pickerLabel}
          selection={selection}
          onChange={onChange}
          excludePlayerIds={excludeIds}
        />
      </div>
      {player && <PlayerPreviewCard player={player} accent={accent} />}
    </div>
  );
}

function PlayerPreviewCard({ player, accent }: { player: PlayerRow; accent: string }) {
  const ratings: { label: string; value: number | null }[] = [
    { label: "Doubles", value: player.self_rating_doubles },
    { label: "Mixed", value: player.self_rating_mixed },
    { label: "Singles", value: player.self_rating_singles },
  ].filter((r) => r.value != null);

  return (
    <div style={{ ...panelStyle, borderLeft: `4px solid ${accent}`, padding: 16 }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: ink, lineHeight: 1.2 }}>
        {fullName(player)}
      </div>
      <div style={{ fontSize: 12, color: inkMuted, marginTop: 2 }}>
        {player.auth_user_id ? "Has login account" : "No login account"}
      </div>

      <div style={infoHeaderStyle}>Information</div>
      <InfoRow label="Email" value={player.email} />
      <InfoRow label="Phone" value={player.phone} />

      {ratings.length > 0 && (
        <>
          <div style={infoHeaderStyle}>Self ratings</div>
          {ratings.map((r) => (
            <InfoRow key={r.label} label={r.label} value={String(r.value)} />
          ))}
        </>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string | null }) {
  const blank = isBlank(value);
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "3px 0", fontSize: 13 }}>
      <span style={{ color: inkMuted }}>{label}</span>
      <span style={{ color: blank ? inkMuted : ink, fontWeight: blank ? 400 : 500, textAlign: "right", overflowWrap: "anywhere" }}>
        {blank ? "—" : value}
      </span>
    </div>
  );
}

// ─── Step 2 — account details / field picker ──────────────────────────────────

function StepDetails({
  source,
  destination,
  preview,
  previewLoading,
  previewError,
  picks,
  onPick,
  overrideCount,
  committing,
  commitError,
  onBack,
  onMergeClick,
}: {
  source: PlayerRow | null;
  destination: PlayerRow | null;
  preview: MergePreview | null;
  previewLoading: boolean;
  previewError: string | null;
  picks: PickMap;
  onPick: (field: PickField, side: Side) => void;
  overrideCount: number;
  committing: boolean;
  commitError: string | null;
  onBack: () => void;
  onMergeClick: () => void;
}) {
  const sourceName = source ? fullName(source) : "Source";
  const destName = destination ? fullName(destination) : "Destination";

  return (
    <>
      <h1 style={{ ...pageH1Style, fontSize: 24, marginBottom: 6 }}>Account details</h1>
      <p style={{ fontSize: 14, color: inkSoft, margin: "0 0 20px", maxWidth: 620, lineHeight: 1.55 }}>
        Choose which value to keep for each field. The <strong>Merged account</strong> column
        shows the result. Everything else — registrations, payments, history — moves to the
        destination automatically.
      </p>

      {previewLoading && (
        <div style={{ fontSize: 14, color: inkMuted, padding: "24px 0" }}>
          Loading account details…
        </div>
      )}
      {previewError && (
        <div style={statusPanelStyle("danger")} role="alert">
          {previewError}
        </div>
      )}

      {preview && !previewLoading && (
        <>
          <ComparisonTable
            preview={preview}
            sourceName={sourceName}
            destName={destName}
            picks={picks}
            onPick={onPick}
          />
          <ConflictsCallout preview={preview} />
        </>
      )}

      {commitError && (
        <div style={{ ...statusPanelStyle("danger"), marginTop: 16 }} role="alert">
          {commitError}
        </div>
      )}

      <div style={footerRowStyle}>
        <button
          type="button"
          onClick={onBack}
          disabled={committing}
          style={{ ...ctaSecondaryStyle, ...footerBtnStyle, opacity: committing ? 0.6 : 1 }}
        >
          Back
        </button>
        <button
          type="button"
          onClick={onMergeClick}
          disabled={!preview || previewLoading || committing}
          style={{
            ...mergeBtnStyle,
            opacity: !preview || previewLoading || committing ? 0.5 : 1,
            cursor: !preview || previewLoading || committing ? "not-allowed" : "pointer",
          }}
        >
          {committing ? "Merging…" : "Merge accounts"}
          {overrideCount > 0 && !committing ? ` (${overrideCount})` : ""}
        </button>
      </div>
    </>
  );
}

function ComparisonTable({
  preview,
  sourceName,
  destName,
  picks,
  onPick,
}: {
  preview: MergePreview;
  sourceName: string;
  destName: string;
  picks: PickMap;
  onPick: (field: PickField, side: Side) => void;
}) {
  return (
    <div style={{ overflowX: "auto", border: `1px solid ${rule}`, borderRadius: 10 }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640, fontSize: 13 }}>
        <colgroup>
          <col style={{ width: "22%" }} />
          <col style={{ width: "26%" }} />
          <col style={{ width: "26%" }} />
          <col style={{ width: "26%" }} />
        </colgroup>
        <thead>
          <tr style={{ background: bg, borderBottom: `1px solid ${rule}` }}>
            <th style={colHeadStyle} />
            <th style={colHeadStyle}>
              Source
              <span style={colHeadSubStyle}>{sourceName}</span>
            </th>
            <th style={colHeadStyle}>
              Destination
              <span style={colHeadSubStyle}>{destName}</span>
            </th>
            <th style={{ ...colHeadStyle, ...mergedColStyle }}>
              Merged account
              <span style={colHeadSubStyle}>Result</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <SubheaderRow label="General" />
          {PICK_FIELDS.map((field) => (
            <FieldRow
              key={field}
              field={field}
              destValue={preview.winner[field]}
              sourceValue={preview.loser[field]}
              selected={picks[field] ?? "destination"}
              onPick={(side) => onPick(field, side)}
            />
          ))}
          <SubheaderRow label="Registrations" />
          <RegistrationsRow preview={preview} />
        </tbody>
      </table>
    </div>
  );
}

function SubheaderRow({ label }: { label: string }) {
  return (
    <tr>
      <td
        colSpan={4}
        style={{
          padding: "8px 14px",
          background: cream,
          borderTop: `1px solid ${rule}`,
          borderBottom: `1px solid ${ruleSoft}`,
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: inkSoft,
        }}
      >
        {label}
      </td>
    </tr>
  );
}

function FieldRow({
  field,
  destValue,
  sourceValue,
  selected,
  onPick,
}: {
  field: PickField;
  destValue: PickValue;
  sourceValue: PickValue;
  selected: Side;
  onPick: (side: Side) => void;
}) {
  // Never allow blanking a NOT NULL name via the Source side.
  const sourceDisabled = REQUIRED_FIELDS.has(field) && isBlank(sourceValue);
  const mergedValue = selected === "source" ? sourceValue : destValue;

  return (
    <tr role="radiogroup" aria-label={FIELD_LABELS[field]} style={{ borderBottom: `1px solid ${ruleSoft}` }}>
      <td style={{ ...cellStyle, color: inkSoft, fontWeight: 600 }}>{FIELD_LABELS[field]}</td>
      <td style={cellStyle}>
        <RadioValue
          field={field}
          value={sourceValue}
          selected={selected === "source"}
          disabled={sourceDisabled}
          ariaLabel={`Source ${FIELD_LABELS[field]}`}
          onClick={() => onPick("source")}
        />
      </td>
      <td style={cellStyle}>
        <RadioValue
          field={field}
          value={destValue}
          selected={selected === "destination"}
          ariaLabel={`Destination ${FIELD_LABELS[field]}`}
          onClick={() => onPick("destination")}
        />
      </td>
      <td style={{ ...cellStyle, ...mergedColStyle }}>
        <ValueText field={field} value={mergedValue} strong />
      </td>
    </tr>
  );
}

function RadioValue({
  field,
  value,
  selected,
  disabled = false,
  ariaLabel,
  onClick,
}: {
  field: PickField;
  value: PickValue;
  selected: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        width: "100%",
        textAlign: "left",
        padding: "4px 6px",
        borderRadius: 6,
        border: "none",
        background: selected ? cream : "transparent",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
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
      <ValueText field={field} value={value} strong={selected} />
    </button>
  );
}

function ValueText({
  field,
  value,
  strong = false,
}: {
  field: PickField;
  value: PickValue;
  strong?: boolean;
}) {
  const blank = isBlank(value);
  return (
    <span
      style={{
        color: blank ? inkMuted : ink,
        fontWeight: strong && !blank ? 600 : 400,
        overflowWrap: "anywhere",
        lineHeight: 1.35,
        minWidth: 0,
      }}
    >
      {blank ? "—" : formatFieldValue(field, value)}
    </span>
  );
}

function RegistrationsRow({ preview }: { preview: MergePreview }) {
  const destCount = preview.winner_registrations.length;
  const srcCount = preview.loser_registrations.length;
  return (
    <tr style={{ borderBottom: `1px solid ${ruleSoft}` }}>
      <td style={{ ...cellStyle, color: inkSoft, fontWeight: 600 }}>Registrations</td>
      <td style={cellStyle}>
        <RegList regs={preview.loser_registrations} />
      </td>
      <td style={cellStyle}>
        <RegList regs={preview.winner_registrations} />
      </td>
      <td style={{ ...cellStyle, ...mergedColStyle }}>
        <span style={{ fontSize: 12.5, color: inkSoft, lineHeight: 1.4 }}>
          {srcCount + destCount === 0
            ? "—"
            : `All ${srcCount + destCount} move to destination`}
        </span>
      </td>
    </tr>
  );
}

function RegList({ regs }: { regs: MergeRegistration[] }) {
  if (regs.length === 0) {
    return <span style={{ fontSize: 12.5, color: inkMuted }}>—</span>;
  }
  const current = regs.filter((r) => r.is_current);
  const previous = regs.filter((r) => !r.is_current);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <RegGroup label="Current" regs={current} />
      <RegGroup label="Previous" regs={previous} />
    </div>
  );
}

function RegGroup({ label, regs }: { label: string; regs: MergeRegistration[] }) {
  if (regs.length === 0) return null;
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: inkMuted,
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 2 }}>
        {regs.map((r, i) => (
          <li key={`${r.event_name}-${r.tournament}-${i}`} style={{ fontSize: 12, color: inkSoft, lineHeight: 1.35 }}>
            <span style={{ color: ink }}>{r.event_name}</span> · {r.tournament} · {r.status}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConflictsCallout({ preview }: { preview: MergePreview }) {
  const c = preview.conflicts;
  const items: string[] = [];
  if (c.both_have_accounts) {
    items.push("Both have a login account — the source's login will be detached.");
  }
  if (c.same_event_registrations.length > 0) {
    items.push(
      `Both are registered in ${c.same_event_registrations.length} of the same event${
        c.same_event_registrations.length === 1 ? "" : "s"
      } — the source's duplicate registration will be dropped.`,
    );
  }
  if (c.same_tournament_registrations.length > 0) {
    items.push(
      `Both have a tournament-level registration in ${c.same_tournament_registrations.length} of the same tournament${
        c.same_tournament_registrations.length === 1 ? "" : "s"
      } — the source's is dropped.`,
    );
  }
  if (c.same_org_contacts.length > 0) {
    items.push(
      `Both appear as a contact in ${c.same_org_contacts.length} of the same organization${
        c.same_org_contacts.length === 1 ? "" : "s"
      } — the source's entry is dropped.`,
    );
  }
  if (c.invites_between_them > 0) {
    items.push(
      `${c.invites_between_them} partner invite${
        c.invites_between_them === 1 ? "" : "s"
      } directly between them will be removed.`,
    );
  }
  if (c.partners_with_each_other.length > 0) {
    items.push(
      `They're doubles partners with each other in ${c.partners_with_each_other.length} event${
        c.partners_with_each_other.length === 1 ? "" : "s"
      } — the pairing will be broken.`,
    );
  }

  if (items.length === 0) return null;

  return (
    <div style={{ ...statusPanelStyle("warn"), marginTop: 16 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>Heads up</div>
      <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

// ─── Small bits ────────────────────────────────────────────────────────────────

function StepDot({ n, active, done, label }: { n: number; active: boolean; done: boolean; label: string }) {
  const on = active || done;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 20,
          height: 20,
          borderRadius: "50%",
          fontSize: 11,
          fontWeight: 700,
          background: on ? ink : "transparent",
          color: on ? bg : inkMuted,
          border: on ? "none" : `1px solid ${rule}`,
        }}
      >
        {n}
      </span>
      <span style={{ color: active ? ink : inkMuted, fontWeight: active ? 600 : 400 }}>{label}</span>
    </span>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  padding: "24px 32px",
  maxWidth: 900,
  margin: "0 auto",
  fontFamily: bodyFontStack,
};

const footerRowStyle: CSSProperties = {
  marginTop: 24,
  display: "flex",
  gap: 10,
  justifyContent: "flex-end",
  flexWrap: "wrap",
};

const footerBtnStyle: CSSProperties = {
  fontSize: 13,
  padding: "10px 20px",
};

const infoHeaderStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: inkMuted,
  margin: "14px 0 6px",
  borderTop: `1px solid ${ruleSoft}`,
  paddingTop: 10,
};

const colHeadStyle: CSSProperties = {
  padding: "10px 14px",
  textAlign: "left",
  fontSize: 12,
  fontWeight: 700,
  color: ink,
  verticalAlign: "top",
};

const colHeadSubStyle: CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 400,
  color: inkMuted,
  marginTop: 2,
  overflowWrap: "anywhere",
};

const mergedColStyle: CSSProperties = {
  background: successBg,
  borderLeft: `2px solid ${courtGreen}`,
};

const cellStyle: CSSProperties = {
  padding: "8px 12px",
  verticalAlign: "top",
  color: ink,
};

const mergeBtnStyle: CSSProperties = {
  padding: "10px 20px",
  background: "#9c2412",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 13,
  fontFamily: "inherit",
  cursor: "pointer",
};
