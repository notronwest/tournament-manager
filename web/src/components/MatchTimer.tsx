import { bodyFontStack, inkMuted, monoFontStack, successFg, warnFg } from "../lib/publicTheme";
import { formatElapsed, useNow } from "../lib/matchTiming";

// Live clock for a match that is on a court. Reads matches.started_at
// (stamped by the DB when the match is loaded) and ticks once a second.
// When the division's planned minutes-per-game is known, the clock turns
// amber once the match runs past it, so a director can spot the court
// that is holding up the round without doing arithmetic.
//
// A match loaded before timing shipped has no started_at; the card then
// says so instead of showing a clock that would be wrong.
export default function MatchTimer({
  startedAt,
  expectedMinutes,
}: {
  startedAt: string | null | undefined;
  // The division's planned game length (pool / semifinal / medal minutes).
  // Null or 0 = no threshold; the clock stays green.
  expectedMinutes?: number | null;
}) {
  const now = useNow(1000);
  if (!startedAt) {
    return (
      <div style={{ textAlign: "center", fontSize: 12, color: inkMuted, marginTop: 8, fontFamily: bodyFontStack }}>
        Not timed — loaded before the clock shipped
      </div>
    );
  }
  const elapsedSec = (now - new Date(startedAt).getTime()) / 1000;
  const limitSec = expectedMinutes && expectedMinutes > 0 ? expectedMinutes * 60 : null;
  const over = limitSec != null && elapsedSec > limitSec;
  const overMin = over && limitSec != null ? Math.floor((elapsedSec - limitSec) / 60) : 0;
  const started = new Date(startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  return (
    <div
      style={{ textAlign: "center", marginTop: 8, fontFamily: bodyFontStack }}
      role="timer"
      aria-live="off"
      aria-label={`Match time ${formatElapsed(elapsedSec)}${over ? ", over the planned length" : ""}`}
    >
      <div
        style={{
          fontFamily: monoFontStack,
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: "0.04em",
          lineHeight: 1.1,
          color: over ? warnFg : successFg,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatElapsed(elapsedSec)}
      </div>
      <div style={{ fontSize: 11, color: over ? warnFg : inkMuted, marginTop: 2 }}>
        Started {started}
        {limitSec != null &&
          (over
            ? ` · ${overMin < 1 ? "just" : `${overMin} min`} over the ${expectedMinutes}-min plan`
            : ` · ${expectedMinutes} min planned`)}
      </div>
    </div>
  );
}
