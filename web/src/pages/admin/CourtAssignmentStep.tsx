import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../supabase";
import { NoCourtCountNotice } from "../../components/NoCourtCountNotice";
import { useEventScheduling } from "../../hooks/useEventScheduling";
import { fmtTime } from "../../lib/scheduleTime";
import type { Database } from "../../types/supabase";
import {
  ink,
  inkSoft,
  inkMuted,
  cream,
  rule,
  ruleSoft,
  courtBlue,
  courtGreen,
  courtRed,
  warnBg,
  warnFg,
  bodyFontStack,
} from "../../lib/publicTheme";

type EventRow = Database["public"]["Tables"]["events"]["Row"];
type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];

// Bracket Setup wizard — Court assignment step (after "Confirm settings").
//
// Recommends the courts THIS event should use, accounting for what else is
// already scheduled that day (other Bert & Erne events in this tournament on
// the same day: their courts, times and rosters). The recommendation runs
// the ONE scheduling engine (schedulePacker via eventPlacement) — this event
// as the movable item, the same-day siblings fixed. The director can toggle
// courts; changes persist to event_courts (delete-then-insert for this
// event), matching the Schedule page's writes.
//
// Self-saving inline step: it writes, then calls onSaved so the console
// reloads and the wizard's court gate (≥1 court assigned) clears — the happy
// path is one tap → Next because the recommendation is pre-applied.
export function CourtAssignmentStep({
  event,
  tournament,
  teamCount,
  players,
  orgSlug,
  tournamentSlug,
  onSaved,
}: {
  event: EventRow;
  tournament: Tournament;
  teamCount: number;
  players: ReadonlySet<string>;
  orgSlug: string;
  tournamentSlug: string;
  onSaved: () => void;
}) {
  const { loading, error, venueCourts, hasVenue, siblings, factsFor, recommend } =
    useEventScheduling({ event, tournament, teamCount, players });

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  // Pre-apply the recommendation at most once per mount.
  const seeded = useRef(false);

  // Persist the full court set for this event: delete-then-insert, the same
  // pattern the Schedule page's auto-schedule uses.
  const persist = useCallback(
    async (courts: number[]) => {
      setSaving(true);
      setSaveErr(null);
      const { error: delErr } = await supabase
        .from("event_courts")
        .delete()
        .eq("event_id", event.id);
      if (delErr) {
        setSaveErr(delErr.message);
        setSaving(false);
        return;
      }
      if (courts.length > 0) {
        const { error: insErr } = await supabase
          .from("event_courts")
          .insert(courts.map((c) => ({ event_id: event.id, court_number: c })));
        if (insErr) {
          setSaveErr(insErr.message);
          setSaving(false);
          return;
        }
      }
      setSaving(false);
      onSaved();
    },
    [event.id, onSaved],
  );

  // Seed the selection once the day's schedule has loaded: respect courts the
  // event already holds; otherwise pre-select AND persist the recommendation
  // so the gate is satisfied on arrival.
  useEffect(() => {
    if (seeded.current || loading || venueCourts == null || venueCourts < 1)
      return;
    seeded.current = true;
    void (async () => {
      const { data } = await supabase
        .from("event_courts")
        .select("court_number")
        .eq("event_id", event.id);
      const existing = (data ?? []).map((r) => r.court_number as number);
      if (existing.length > 0) {
        setSelected(new Set(existing));
        return;
      }
      const rec = recommend([]);
      const recCourts = rec?.courts ?? [];
      setSelected(new Set(recCourts));
      await persist(recCourts);
    })();
  }, [loading, venueCourts, event.id, recommend, persist]);

  if (loading) {
    return <div style={{ color: inkMuted, fontSize: 13 }}>Loading the day’s schedule…</div>;
  }
  if (error) {
    return (
      <div style={errBox}>{error}</div>
    );
  }
  if (venueCourts == null || venueCourts < 1) {
    return (
      <NoCourtCountNotice
        orgSlug={orgSlug}
        tournamentSlug={tournamentSlug}
        hasVenue={hasVenue}
      />
    );
  }

  const selectedList = Array.from(selected).sort((a, b) => a - b);
  const facts = factsFor(selectedList);
  const rec = recommend(selectedList);
  // The recommended window frames the "used by" view — a court is "taken"
  // only if a sibling holds it while this event would run.
  const winStart = rec?.startMs ?? null;
  const winEnd = rec?.endMs ?? null;

  // court number → siblings holding it during this event's window.
  const usageByCourt = new Map<number, { name: string; label: string }[]>();
  if (winStart != null && winEnd != null) {
    for (const s of siblings) {
      const overlaps = s.startMs < winEnd && s.placement.endMs > winStart;
      if (!overlaps) continue;
      for (const c of s.placement.courts) {
        const arr = usageByCourt.get(c) ?? [];
        arr.push({
          name: s.event.name,
          label: `${fmtTime(new Date(s.startMs))}–${fmtTime(new Date(s.placement.endMs))}`,
        });
        usageByCourt.set(c, arr);
      }
    }
  }

  const toggle = (court: number) => {
    const next = new Set(selected);
    if (next.has(court)) next.delete(court);
    else next.add(court);
    setSelected(next);
    void persist(Array.from(next).sort((a, b) => a - b));
  };

  const conflicts = selectedList.filter((c) => usageByCourt.has(c));
  const why = buildWhy(facts.courtsNeeded, rec?.courts ?? [], rec?.heldBy ?? null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ margin: 0, fontSize: 13.5, color: inkSoft, lineHeight: 1.55 }}>
        Recommended courts for this event, based on the other events already
        scheduled today. Tap a court to add or remove it.
      </p>

      {why && (
        <div style={whyBox}>{why}</div>
      )}

      {/* Court grid — mobile-first: square tiles that wrap. */}
      <div
        role="group"
        aria-label="Courts for this event — tap to toggle"
        style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
      >
        {Array.from({ length: venueCourts }, (_, i) => i + 1).map((n) => {
          const mine = selected.has(n);
          const usedBy = usageByCourt.get(n);
          const taken = !!usedBy && !mine;
          const clash = !!usedBy && mine;
          return (
            <button
              key={n}
              type="button"
              aria-pressed={mine}
              onClick={() => toggle(n)}
              disabled={saving}
              title={
                usedBy
                  ? `Court ${n} — used by ${usedBy.map((u) => `${u.name} ${u.label}`).join(", ")}`
                  : `Court ${n} — free`
              }
              style={{
                width: 56,
                minHeight: 52,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 2,
                padding: "6px 4px",
                borderRadius: 8,
                cursor: saving ? "wait" : "pointer",
                fontFamily: bodyFontStack,
                background: mine ? courtBlue : taken ? warnBg : "#ffffff",
                color: mine ? "#ffffff" : taken ? warnFg : inkSoft,
                border: `1px solid ${
                  clash ? courtRed : mine ? courtBlue : taken ? warnFg : rule
                }`,
                boxShadow: clash ? `0 0 0 2px ${courtRed}` : undefined,
              }}
            >
              <span style={{ fontSize: 15, fontWeight: 700 }}>{n}</span>
              <span style={{ fontSize: 9, lineHeight: 1 }}>
                {mine ? "using" : taken ? "taken" : "free"}
              </span>
            </button>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 11, color: inkMuted }}>
        <LegendSwatch color={courtBlue} label="This event" />
        <LegendSwatch color={warnFg} label="Used by another event" outline />
        <LegendSwatch color={courtGreen} label="Free" outline />
      </div>

      {/* Who is on the taken courts today */}
      {usageByCourt.size > 0 && (
        <div style={{ fontSize: 12, color: inkSoft, lineHeight: 1.6 }}>
          <div style={{ fontWeight: 600, color: ink, marginBottom: 2 }}>
            Busy courts while this event runs
          </div>
          {Array.from(usageByCourt.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([court, uses]) => (
              <div key={court}>
                Court {court}: {uses.map((u) => `${u.name} (${u.label})`).join(", ")}
              </div>
            ))}
        </div>
      )}

      {conflicts.length > 0 && (
        <div style={conflictBox}>
          ⚠ Court{conflicts.length === 1 ? "" : "s"} {conflicts.join(", ")} {conflicts.length === 1 ? "is" : "are"} also used by
          another event during this event’s window. Pick open courts, or adjust
          the start time on the next step.
        </div>
      )}

      <div style={{ fontSize: 12, color: inkMuted }}>
        {selectedList.length === 0 ? (
          <span style={{ color: warnFg }}>
            No courts selected — assign at least one to continue.
          </span>
        ) : (
          <>
            Assigned: <strong style={{ color: ink }}>
              {selectedList.length} court{selectedList.length === 1 ? "" : "s"}
            </strong>{" "}
            ({selectedList.join(", ")}). This event can keep {facts.courtsNeeded}{" "}
            busy.
          </>
        )}
      </div>

      {saveErr && <div style={errBox}>Couldn’t save courts: {saveErr}</div>}
    </div>
  );
}

// "Pool play needs 6 courts; 1–6 are open when this runs." Uses the packer's
// hold reason when the earliest slot was court-short.
function buildWhy(
  courtsNeeded: number,
  recommended: number[],
  heldBy: import("../../lib/schedulePacker").HoldReason | null,
): string | null {
  if (recommended.length === 0) {
    return `This event needs ${courtsNeeded} court${courtsNeeded === 1 ? "" : "s"}, but none are open in its window today. Free up courts, or move it later on the next step.`;
  }
  const list =
    recommended.length > 1
      ? `${recommended[0]}–${recommended[recommended.length - 1]}`
      : `${recommended[0]}`;
  const base = `Pool play needs ${courtsNeeded} court${courtsNeeded === 1 ? "" : "s"}; ${list} ${recommended.length === 1 ? "is" : "are"} open when this event runs.`;
  if (heldBy && heldBy.courtsShort > 0) {
    return `${base} Earlier slots were ${heldBy.courtsShort} court${heldBy.courtsShort === 1 ? "" : "s"} short.`;
  }
  return base;
}

function LegendSwatch({
  color,
  label,
  outline,
}: {
  color: string;
  label: string;
  outline?: boolean;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: 3,
          background: outline ? "#ffffff" : color,
          border: `1px solid ${color}`,
        }}
      />
      {label}
    </span>
  );
}

const whyBox = {
  padding: "9px 11px",
  background: cream,
  border: `1px solid ${ruleSoft}`,
  borderRadius: 6,
  fontSize: 12.5,
  color: inkSoft,
  lineHeight: 1.5,
} as const;

const conflictBox = {
  padding: "9px 11px",
  background: warnBg,
  border: `1px solid ${warnFg}`,
  borderRadius: 6,
  fontSize: 12.5,
  color: warnFg,
  lineHeight: 1.5,
} as const;

const errBox = {
  padding: "9px 11px",
  background: "#fef2f2",
  border: `1px solid ${courtRed}`,
  borderRadius: 6,
  fontSize: 12.5,
  color: courtRed,
  lineHeight: 1.5,
} as const;
