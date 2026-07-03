import { useMemo, useState, type CSSProperties } from "react";
import { supabase } from "../supabase";
import type { Database } from "../types/supabase";
import { RatingPicker } from "./RatingPicker";
import { checkEligibility } from "../lib/eligibility";
import {
  ink,
  inkSoft,
  inkMuted,
  cream,
  creamDeep,
  warnBg,
  warnFg,
  successBg,
  successFg,
  courtGreen,
  bodyFontStack,
} from "../lib/publicTheme";

type Event = Database["public"]["Tables"]["events"]["Row"];
type Player = Database["public"]["Tables"]["players"]["Row"];

type Fmt = "doubles" | "mixed" | "singles";
type RatingCol =
  | "self_rating_doubles"
  | "self_rating_mixed"
  | "self_rating_singles";

const FMT_LABEL: Record<Fmt, string> = {
  doubles: "Doubles",
  mixed: "Mixed doubles",
  singles: "Singles",
};
const FMT_COL: Record<Fmt, RatingCol> = {
  doubles: "self_rating_doubles",
  mixed: "self_rating_mixed",
  singles: "self_rating_singles",
};

// Same format→rating mapping the eligibility check uses.
function eventFormat(ev: Event): Fmt {
  if (ev.format === "singles") return "singles";
  if (ev.format === "doubles" && ev.gender === "mixed") return "mixed";
  return "doubles";
}

// "Batch banner" rating gate (mockup C). When a player has rating-restricted
// events they can't register for purely because they have no self-rating on
// file, this prompts for all the needed formats at once; saving writes them to
// the player's row and (via onSaved) re-runs eligibility so every affected
// event unlocks together. Skippable — a player who only wants open events
// isn't forced to rate themselves.
export function RatingGateBanner({
  player,
  events,
  disabled,
  onSaved,
}: {
  player: Player;
  events: Event[];
  disabled?: boolean;
  onSaved: (ratings: Partial<Record<RatingCol, number>>) => void;
}) {
  // Formats blocking the player from a rating-restricted event ONLY because
  // they have no rating on file for that format → { format: #events blocked }.
  const needed = useMemo(() => {
    const m = new Map<Fmt, number>();
    for (const ev of events) {
      if (ev.min_rating == null && ev.max_rating == null) continue; // no rating gate
      const fmt = eventFormat(ev);
      if (player[FMT_COL[fmt]] != null) continue; // already rated for this format
      const { eligible, reasons } = checkEligibility(player, ev);
      if (eligible) continue;
      if (!reasons.some((r) => r.includes("self-rating on file"))) continue; // blocked for another reason
      m.set(fmt, (m.get(fmt) ?? 0) + 1);
    }
    return m;
  }, [events, player]);

  const [picks, setPicks] = useState<Record<Fmt, number | null>>({
    doubles: null,
    mixed: null,
    singles: null,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  // After a save, the parent's player prop gains the ratings → `needed`
  // recomputes empty and events visibly unlock. Show a brief confirmation
  // instead of vanishing outright.
  if (needed.size === 0) {
    if (!justSaved) return null;
    return (
      <div style={{ ...wrapStyle, background: successBg, borderColor: "#9cd3a9" }}>
        <div style={{ ...titleStyle, color: successFg }}>
          ✓ Ratings saved — skill-rated events unlocked below.
        </div>
      </div>
    );
  }

  const fmts = Array.from(needed.keys());
  const canSave = fmts.some((f) => picks[f] != null) && !saving;

  const save = async () => {
    setError(null);
    const updates: Partial<Record<RatingCol, number>> = {};
    for (const f of fmts) {
      const v = picks[f];
      if (v != null) updates[FMT_COL[f]] = v;
    }
    if (Object.keys(updates).length === 0) return;
    setSaving(true);
    const { error: upErr } = await supabase
      .from("players")
      .update(updates)
      .eq("id", player.id);
    setSaving(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setJustSaved(true);
    onSaved(updates);
  };

  return (
    <div style={wrapStyle}>
      <div style={titleStyle}>⚡ This tournament has skill-rated events</div>
      <div style={subStyle}>
        Add your self-rating{fmts.length > 1 ? "s" : ""} to unlock{" "}
        {fmts.length > 1 ? "them" : "it"}. Skip if you only want open events.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 15, marginTop: 14 }}>
        {fmts.map((f) => (
          <div key={f}>
            <div style={fieldLabelStyle}>
              {FMT_LABEL[f]} rating
              <span style={tagStyle}>
                {needed.get(f)} event{needed.get(f) === 1 ? "" : "s"}
              </span>
            </div>
            <RatingPicker
              value={picks[f]}
              onChange={(v) => setPicks((p) => ({ ...p, [f]: v }))}
              disabled={disabled || saving}
              size="sm"
              ariaLabel={`${FMT_LABEL[f]} self-rating`}
            />
          </div>
        ))}
      </div>

      {error && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: "#9c2412" }}>{error}</div>
      )}

      <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center" }}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSave}
          style={canSave ? saveStyle : saveDisabledStyle}
        >
          {saving ? "Saving…" : "Save ratings & unlock"}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          disabled={saving}
          style={laterStyle}
        >
          I'll skip skill-rated events
        </button>
      </div>
    </div>
  );
}

// ─── styles ──────────────────────────────────────────────────────────
const wrapStyle: CSSProperties = {
  background: warnBg,
  border: `1px solid ${creamDeep}`,
  borderRadius: 10,
  padding: "14px 16px",
  marginBottom: 14,
  fontFamily: bodyFontStack,
};
const titleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: ink,
  display: "flex",
  alignItems: "center",
  gap: 8,
};
const subStyle: CSSProperties = { fontSize: 12.5, color: inkSoft, marginTop: 4 };
const fieldLabelStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 700,
  color: ink,
  marginBottom: 8,
  display: "flex",
  alignItems: "center",
  gap: 8,
};
const tagStyle: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  color: warnFg,
  background: cream,
  border: `1px solid ${creamDeep}`,
  borderRadius: 5,
  padding: "1px 6px",
};
const saveStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "#fff",
  background: courtGreen,
  border: "none",
  borderRadius: 8,
  padding: "10px 18px",
  cursor: "pointer",
  fontFamily: "inherit",
};
const saveDisabledStyle: CSSProperties = {
  ...saveStyle,
  background: "#bcd8c2",
  cursor: "not-allowed",
};
const laterStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: inkMuted,
  background: "none",
  border: "none",
  cursor: "pointer",
  fontFamily: "inherit",
};
