// Shapes and formatting shared by the platform-fee editor and the lists it
// sits in. Kept out of the component file so that file only exports
// components (react-refresh), and out of _shared/platformFee.ts because
// presentation is not part of the money math the edge function runs.

// A fee as the database stores it. null for a level that inherits.
export type PlatformFeeValue = { bps: number; fixedCents: number } | null;

// "3%" / "3% + $0.30" — the compact form a list row uses. Trailing ".00" is
// dropped so a whole-percent rate reads as one.
export function formatFeeShort(bps: number, fixedCents: number): string {
  const pct = `${(bps / 100).toFixed(2).replace(/\.00$/, "")}%`;
  return fixedCents > 0 ? `${pct} + $${(fixedCents / 100).toFixed(2)}` : pct;
}

// What went wrong, in the page's own words, with the next move — never the
// database's. Left raw, a refused save renders as `new row violates
// row-level security policy for table "organizations"`, which names a table
// and a mechanism and gives the reader nothing to do.
//
// EVERY branch says the fee is unchanged, because the one thing a failed
// money setting must never leave ambiguous is whether it took effect.
//
// The permission case does NOT arrive as a permission error. A write the
// policy refuses updates zero rows, and `.single()` turns zero rows into
// PostgREST's PGRST116 — HTTP 406, "JSON object requested, multiple (or no)
// rows returned". Observed live: revoking platform-admin mid-session and
// saving produced a 406, not a "row-level security" string, so matching on
// that string alone would have left the most likely failure on the generic
// fallback.
export type SaveFailure = { code?: string | null; message: string };

export function platformFeeSaveMessage(err: SaveFailure | string): string {
  const code = typeof err === "string" ? "" : (err.code ?? "");
  const m = (typeof err === "string" ? err : err.message).toLowerCase();

  // Refused by the policy or the trigger — including the zero-rows disguise.
  if (
    code === "PGRST116" ||
    code === "42501" ||
    m.includes("row-level security") ||
    m.includes("platform admin") ||
    m.includes("permission denied") ||
    m.includes("no) rows returned")
  ) {
    return "That fee wasn't saved — your account can't change platform fees. The fee is unchanged; ask a platform admin to make the change.";
  }
  if (code === "23514" || m.includes("check constraint") || m.includes("violates check")) {
    return "That fee wasn't saved — the percentage must be between 0 and 100 and the fixed amount 0 or more. The fee is unchanged.";
  }
  if (m.includes("failed to fetch") || m.includes("network")) {
    return "That fee wasn't saved — the connection dropped. The fee is unchanged; try again.";
  }
  return "That fee wasn't saved. The fee is unchanged; try again, and if it keeps failing take a note of what you were setting.";
}

// Save attempts are numbered for the life of the PAGE, not of a mount, and
// the number is what tells a repeated refusal from the one before it.
//
// A per-mount counter restarting at 0 collided with the keys of an earlier
// visit to the screen: leave, come back, and the first few refusals were
// taken for ones already shown and never scrolled into view — the same bug
// as keying on the message text, with a number that was also not unique.
let attemptSeq = 0;
export function nextSaveAttempt(): number {
  return ++attemptSeq;
}
