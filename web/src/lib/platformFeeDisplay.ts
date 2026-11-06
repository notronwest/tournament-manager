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
