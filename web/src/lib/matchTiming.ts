import { useEffect, useState } from "react";

// Helpers for matches.started_at / ended_at / duration_seconds (migration
// 20261002120000). The DB stamps the timestamps on status change; the client
// only reads them. Kept out of the component file so Vite fast refresh keeps
// working (component files must export components only).

// Re-render on an interval. One interval per mounted caller; the court grids
// mount at most one timer per court, so the cost is trivial.
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

// 754 → "12:34"; 3725 → "1:02:05". Never negative (clock skew between the
// browser and the DB can put started_at a second or two in the future).
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

// 754 → "13 min"; 3725 → "1 h 2 min". For completed matches and reports.
export function formatDurationShort(totalSeconds: number): string {
  const m = Math.round(Math.max(0, totalSeconds) / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} h` : `${h} h ${rem} min`;
}

// Which planned game length applies to a match: a playoff match carries its
// own minutes on the row; a round-robin match uses the event's pool setting.
// Null when neither is known — the clock then has no "over" threshold.
export function plannedMinutesFor(
  match: { stage: string; match_minutes_per_game: number | null },
  event: { pool_minutes_per_game: number } | null | undefined,
): number | null {
  if (match.match_minutes_per_game != null) return match.match_minutes_per_game;
  if (match.stage === "round_robin") return event?.pool_minutes_per_game ?? null;
  return null;
}
