import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../supabase";
import { NoCourtCountNotice } from "../../components/NoCourtCountNotice";
import { useEventScheduling } from "../../hooks/useEventScheduling";
import { fmtDuration } from "../../lib/estimator";
import { fmtTime, fromLocalInput, toLocalInput } from "../../lib/scheduleTime";
import type { HoldReason } from "../../lib/schedulePacker";
import type { Database } from "../../types/supabase";
import {
  ink,
  inkSoft,
  inkMuted,
  bg,
  cream,
  rule,
  ruleSoft,
  courtBlue,
  courtRed,
  warnFg,
  bodyFontStack,
} from "../../lib/publicTheme";

type EventRow = Database["public"]["Tables"]["events"]["Row"];
type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];

// Bracket Setup wizard — Event start-time step (after "Court assignment").
//
// Recommends when THIS event should start: the earliest slot where its courts
// fit alongside the same-day siblings and no player is double-booked — from
// the ONE scheduling engine (schedulePacker via eventPlacement), this event
// movable, siblings fixed. Shows the day's events with this one's proposed
// slot + projected end, and lets the director change the start. Persists to
// events.scheduled_start_at.
export function EventStartTimeStep({
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

  const [thisCourts, setThisCourts] = useState<number[]>([]);
  const [localValue, setLocalValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const seeded = useRef(false);

  const persist = useCallback(
    async (iso: string | null) => {
      setSaving(true);
      setSaveErr(null);
      const { error: updErr } = await supabase
        .from("events")
        .update({ scheduled_start_at: iso })
        .eq("id", event.id);
      setSaving(false);
      if (updErr) {
        setSaveErr(updErr.message);
        return;
      }
      onSaved();
    },
    [event.id, onSaved],
  );

  // Seed once the day's schedule loads: load this event's chosen courts (so
  // the duration reflects them), then respect an existing start or pre-fill
  // AND persist the recommended one so the gate is satisfied on arrival.
  useEffect(() => {
    if (seeded.current || loading || venueCourts == null || venueCourts < 1)
      return;
    seeded.current = true;
    void (async () => {
      const { data } = await supabase
        .from("event_courts")
        .select("court_number")
        .eq("event_id", event.id);
      const courts = (data ?? []).map((r) => r.court_number as number).sort((a, b) => a - b);
      setThisCourts(courts);
      if (event.scheduled_start_at) {
        setLocalValue(toLocalInput(event.scheduled_start_at));
        return;
      }
      const rec = recommend(courts);
      if (!rec) return;
      const iso = new Date(rec.startMs).toISOString();
      setLocalValue(toLocalInput(iso));
      await persist(iso);
    })();
  }, [loading, venueCourts, event.id, event.scheduled_start_at, recommend, persist]);

  if (loading) {
    return <div style={{ color: inkMuted, fontSize: 13 }}>Loading the day’s schedule…</div>;
  }
  if (error) {
    return <div style={errBox}>{error}</div>;
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

  const facts = factsFor(thisCourts);
  const rec = recommend(thisCourts);
  const chosenMs = fromLocalInput(localValue)
    ? new Date(fromLocalInput(localValue)!).getTime()
    : (rec?.startMs ?? null);
  const projectedEndMs =
    chosenMs != null ? chosenMs + facts.totalMinutes * 60_000 : null;

  const why = buildWhy(rec?.heldBy ?? null, siblings, rec?.startMs ?? null);

  // The day as a single ordered list: siblings + this event's proposed slot.
  type Slot = {
    id: string;
    name: string;
    startMs: number;
    endMs: number;
    courts: number[];
    isThis: boolean;
  };
  const slots: Slot[] = siblings.map((s) => ({
    id: s.event.id,
    name: s.event.name,
    startMs: s.startMs,
    endMs: s.placement.endMs,
    courts: s.placement.courts,
    isThis: false,
  }));
  if (chosenMs != null && projectedEndMs != null) {
    slots.push({
      id: event.id,
      name: event.name,
      startMs: chosenMs,
      endMs: projectedEndMs,
      courts: rec?.courts ?? thisCourts,
      isThis: true,
    });
  }
  slots.sort((a, b) => a.startMs - b.startMs || (a.isThis ? -1 : 1));

  const recDiffers =
    rec != null && chosenMs != null && rec.startMs !== chosenMs;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ margin: 0, fontSize: 13.5, color: inkSoft, lineHeight: 1.55 }}>
        Recommended start for this event, fit around the other events scheduled
        today. Adjust it if you need to.
      </p>

      {why && <div style={whyBox}>{why}</div>}

      {/* Start-time input */}
      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: inkSoft }}>
        <span>Start time</span>
        <input
          type="datetime-local"
          value={localValue}
          disabled={saving}
          onChange={(e) => {
            setLocalValue(e.target.value);
            void persist(fromLocalInput(e.target.value));
          }}
          style={{
            padding: "8px 10px",
            border: `1px solid ${rule}`,
            borderRadius: 6,
            fontSize: 14,
            fontFamily: bodyFontStack,
            background: "#ffffff",
            maxWidth: 260,
          }}
        />
      </label>

      {chosenMs != null && projectedEndMs != null && (
        <div style={{ fontSize: 12.5, color: inkSoft }}>
          Runs{" "}
          <strong style={{ color: ink }}>
            {fmtTime(new Date(chosenMs))}–{fmtTime(new Date(projectedEndMs))}
          </strong>{" "}
          ({fmtDuration(facts.totalMinutes)})
          {teamCount < 2 && (
            <span style={{ color: inkMuted }}>
              {" "}
              · estimated on max teams until players sign up
            </span>
          )}
        </div>
      )}

      {recDiffers && rec && (
        <button
          type="button"
          onClick={() => {
            const iso = new Date(rec.startMs).toISOString();
            setLocalValue(toLocalInput(iso));
            void persist(iso);
          }}
          style={{
            alignSelf: "flex-start",
            padding: "6px 12px",
            fontSize: 12,
            fontWeight: 600,
            color: courtBlue,
            background: "transparent",
            border: `1px solid ${courtBlue}`,
            borderRadius: 6,
            cursor: "pointer",
            fontFamily: bodyFontStack,
          }}
        >
          Use recommended {fmtTime(new Date(rec.startMs))}
        </button>
      )}

      {/* The day's timeline */}
      <div>
        <div style={{ fontWeight: 600, color: ink, fontSize: 13, marginBottom: 6 }}>
          Today’s events
        </div>
        {slots.length === 0 ? (
          <div style={{ fontSize: 12.5, color: inkMuted }}>
            No other events scheduled today — this one can start at the
            tournament’s start time.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {slots.map((s) => (
              <div
                key={s.id + (s.isThis ? "-this" : "")}
                style={{
                  display: "flex",
                  gap: 10,
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: `1px solid ${s.isThis ? courtBlue : ruleSoft}`,
                  background: s.isThis ? cream : bg,
                }}
              >
                <div
                  style={{
                    minWidth: 92,
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: s.isThis ? courtBlue : ink,
                  }}
                >
                  {fmtTime(new Date(s.startMs))}
                  <div style={{ fontSize: 10, fontWeight: 400, color: inkMuted }}>
                    to {fmtTime(new Date(s.endMs))}
                  </div>
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: ink }}>
                    {s.name}
                    {s.isThis && (
                      <span
                        style={{
                          marginLeft: 6,
                          fontSize: 10,
                          fontWeight: 700,
                          color: "#ffffff",
                          background: courtBlue,
                          padding: "1px 6px",
                          borderRadius: 999,
                        }}
                      >
                        THIS EVENT
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: inkMuted, marginTop: 1 }}>
                    {s.courts.length > 0
                      ? `courts ${fmtCourts(s.courts)}`
                      : "no courts yet"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {!localValue && (
        <div style={{ fontSize: 12, color: warnFg }}>
          Set a start time to continue.
        </div>
      )}

      {saveErr && <div style={errBox}>Couldn’t save the start time: {saveErr}</div>}
    </div>
  );
}

// "Earliest clear slot is 10:30 AM — 8:00–10:15 is taken by Women's 3.5" /
// "…— Women's 3.5 shares 2 players".
function buildWhy(
  heldBy: HoldReason | null,
  siblings: { event: { id: string; name: string }; startMs: number; placement: { endMs: number } }[],
  startMs: number | null,
): string | null {
  if (startMs == null) return null;
  const name = (id: string) =>
    siblings.find((s) => s.event.id === id)?.event.name ?? "another event";
  if (!heldBy) {
    return "This is the tournament’s start time — nothing is in the way.";
  }
  const at = `Earliest clear slot is ${fmtTime(new Date(startMs))}`;
  if (heldBy.playerClashes.length > 0) {
    const parts = heldBy.playerClashes.map(
      (c) => `${name(c.id)} shares ${c.shared} player${c.shared === 1 ? "" : "s"}`,
    );
    return `${at} — ${parts.join("; ")}.`;
  }
  // Courts short earlier: name a sibling running across the rejected time.
  const blocker = siblings.find(
    (s) => s.startMs <= heldBy.atMs && s.placement.endMs > heldBy.atMs,
  );
  if (blocker) {
    return `${at} — ${fmtTime(new Date(blocker.startMs))}–${fmtTime(new Date(blocker.placement.endMs))} is taken by ${blocker.event.name}.`;
  }
  return `${at} — earlier slots were ${heldBy.courtsShort} court${heldBy.courtsShort === 1 ? "" : "s"} short.`;
}

function fmtCourts(courts: number[]): string {
  const sorted = [...courts].sort((a, b) => a - b);
  const contiguous = sorted.every((c, i) => i === 0 || c === sorted[i - 1] + 1);
  return contiguous && sorted.length > 1
    ? `${sorted[0]}–${sorted[sorted.length - 1]}`
    : sorted.join(", ");
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

const errBox = {
  padding: "9px 11px",
  background: "#fef2f2",
  border: `1px solid ${courtRed}`,
  borderRadius: 6,
  fontSize: 12.5,
  color: courtRed,
  lineHeight: 1.5,
} as const;
