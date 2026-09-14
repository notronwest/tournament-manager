// Double-elimination bracket generation — pure and deterministic (#893).
//
// Shape (P = next power of two ≥ N teams, k = log2 P):
//   Winners bracket  W1..Wk        — Wr has P/2^r matches; Wk is the Winners Final.
//   Consolation      L1..L(2k−2)   — a team drops in on its FIRST loss; a second
//                                    loss eliminates. Odd rounds pair consolation
//                                    survivors; even rounds pair them with the
//                                    losers dropping from W(round/2 + 1), in
//                                    reversed order so early rematches are rare.
//                                    L(2k−2) is the Consolation Final.
//   Final format     crossover     — F1: Winners champ v Consolation champ for gold;
//                                    if the challenger wins, F2 "if necessary"
//                                    decides it. Consolation runner-up = bronze.
//                    bronze_only   — no crossover: Wk decides gold/silver and its
//                                    loser does NOT drop (it already has silver);
//                                    the consolation bracket ends one round
//                                    earlier, at L(2k−3), whose winner = bronze.
//
// P = 8 (N = 8), crossover:
//   W1 (4) → W2 (2) → W3 Winners Final
//   L1 (2): W1 losers pairwise        L2 (2): L1 winners v W2 losers
//   L3 (1): L2 winners                L4 (1): L3 winner v W3 loser  = Consolation Final
//   F1: W3 winner v L4 winner         F2 (if necessary)
//
// Byes: seeds N+1..P are BYEs. A match with a BYE on one side is not emitted —
// the real team advances and the BYE "loses", which can cascade into the
// consolation bracket (a consolation slot fed by two BYEs is itself a BYE).
// Match counts: bronze_only = 2N−4; crossover = 2N−2 (+1 if-necessary slot).
//
// Everything here is by SEED. The console maps seeds → registration ids when it
// generates match rows and stores the feed wiring on the rows (matches.bracket,
// feeds_winner_to/side, feeds_loser_to/side), so feed-forward is data-driven.

export type FinalFormat = "crossover" | "bronze_only";
export type Bracket = "winners" | "consolation" | "final";
export type Side = "a" | "b";

export type Source =
  | { kind: "seed"; seed: number }
  | { kind: "winner"; of: string }
  | { kind: "loser"; of: string }
  | { kind: "bye" };

export type Feed = { key: string; side: Side };

export type Slot = {
  key: string; // "W1-1", "L3-2", "F1", "F2"
  bracket: Bracket;
  round: number;
  position: number; // 0-based within the round
  a: Source;
  b: Source;
  feedsWinnerTo: Feed | null;
  feedsLoserTo: Feed | null;
  label: string;
  // F2 only: played only if the consolation champion wins F1.
  ifNecessary: boolean;
};

export type DoubleElim = {
  n: number;
  P: number;
  k: number;
  format: FinalFormat;
  slots: Slot[]; // emitted matches only, in play order (W1, L1, W2, L2, …, F)
};

// Standard bracket seeding order for a field of P: 1 and 2 land in opposite
// halves, 1 v P, 2 v P−1, … (1,8,4,5,2,7,3,6 for P = 8).
export function seedOrder(P: number): number[] {
  let order = [1];
  while (order.length < P) {
    const size = order.length * 2;
    const next: number[] = [];
    for (const s of order) next.push(s, size + 1 - s);
    order = next;
  }
  return order;
}

export function bracketSize(n: number): { P: number; k: number } {
  let P = 4;
  while (P < n) P *= 2;
  return { P, k: Math.log2(P) };
}

type Draft = Omit<Slot, "feedsWinnerTo" | "feedsLoserTo"> & {
  feedsWinnerTo: Feed | null;
  feedsLoserTo: Feed | null;
};

export function buildDoubleElim(n: number, format: FinalFormat): DoubleElim {
  if (n < 3) throw new Error("Double elimination needs at least 3 teams.");
  const { P, k } = bracketSize(n);
  const drafts = new Map<string, Draft>();
  const add = (d: Draft) => drafts.set(d.key, d);
  const W = (r: number, i: number) => `W${r}-${i + 1}`;
  const L = (r: number, i: number) => `L${r}-${i + 1}`;

  // Winners bracket
  const order = seedOrder(P);
  for (let r = 1; r <= k; r++) {
    const count = P / 2 ** r;
    for (let i = 0; i < count; i++) {
      const a: Source = r === 1 ? { kind: "seed", seed: order[2 * i] } : { kind: "winner", of: W(r - 1, 2 * i) };
      const b: Source = r === 1 ? { kind: "seed", seed: order[2 * i + 1] } : { kind: "winner", of: W(r - 1, 2 * i + 1) };
      add({
        key: W(r, i), bracket: "winners", round: r, position: i, a, b,
        feedsWinnerTo: null, feedsLoserTo: null, ifNecessary: false,
        label: r === k ? "Winners Final" : `Winners R${r} M${i + 1}`,
      });
    }
  }
  // Consolation bracket — the last round takes the Winners Final loser only in
  // crossover; in bronze_only that team already holds silver, so the bracket
  // stops one round earlier and L(2k−3)'s winner is bronze.
  const lastL = format === "crossover" ? 2 * k - 2 : 2 * k - 3;
  for (let r = 1; r <= lastL; r++) {
    const j = Math.ceil(r / 2); // which W round feeds this "block"
    const count = P / 2 ** (j + 1);
    for (let i = 0; i < count; i++) {
      let a: Source, b: Source;
      if (r === 1) {
        a = { kind: "loser", of: W(1, 2 * i) };
        b = { kind: "loser", of: W(1, 2 * i + 1) };
      } else if (r % 2 === 0) {
        // drop-in round: consolation survivor v W(j+1) loser, reversed to avoid rematches
        a = { kind: "winner", of: L(r - 1, i) };
        b = { kind: "loser", of: W(j + 1, count - 1 - i) };
      } else {
        a = { kind: "winner", of: L(r - 1, 2 * i) };
        b = { kind: "winner", of: L(r - 1, 2 * i + 1) };
      }
      const isFinal = r === lastL;
      add({
        key: L(r, i), bracket: "consolation", round: r, position: i, a, b,
        feedsWinnerTo: null, feedsLoserTo: null, ifNecessary: false,
        label: isFinal ? (format === "bronze_only" ? "Bronze Medal Match" : "Consolation Final") : `Consolation R${r} M${i + 1}`,
      });
    }
  }
  // Finals
  if (format === "crossover") {
    add({ key: "F1", bracket: "final", round: 1, position: 0, a: { kind: "winner", of: W(k, 0) }, b: { kind: "winner", of: L(lastL, 0) },
      feedsWinnerTo: null, feedsLoserTo: null, ifNecessary: false, label: "Final" });
    add({ key: "F2", bracket: "final", round: 2, position: 0, a: { kind: "loser", of: "F1" }, b: { kind: "winner", of: "F1" },
      feedsWinnerTo: null, feedsLoserTo: null, ifNecessary: true, label: "Final (if necessary)" });
  }

  // Wire feeds from the sources (each match's winner/loser feeds exactly one slot).
  for (const d of drafts.values()) {
    for (const side of ["a", "b"] as Side[]) {
      const src = d[side];
      if (src.kind === "winner") drafts.get(src.of)!.feedsWinnerTo = { key: d.key, side };
      if (src.kind === "loser") drafts.get(src.of)!.feedsLoserTo = { key: d.key, side };
    }
  }

  // Resolve byes: a match with a BYE on one side is not played.
  const resolvedWinner = new Map<string, Source>(); // for unplayed matches
  const resolvedLoser = new Map<string, Source>();
  const played = new Set<string>();
  const resolve = (src: Source): Source => {
    if (src.kind === "seed") return src.seed > n ? { kind: "bye" } : src;
    if (src.kind === "bye") return src;
    if (played.has(src.of)) return src;
    const m = src.kind === "winner" ? resolvedWinner.get(src.of) : resolvedLoser.get(src.of);
    return m ?? src;
  };
  // Dependency order: W1, L1, W2, L2, W3, L3, L4, … then finals. Consolation
  // round r depends on W(ceil(r/2)+1) losers for even r, so process W rounds
  // ahead of the L rounds that need them.
  const orderKeys: string[] = [];
  for (let r = 1; r <= k; r++) {
    for (let i = 0; i < P / 2 ** r; i++) orderKeys.push(W(r, i));
    const lr = r === 1 ? [1] : [2 * r - 3, 2 * r - 2].filter((x) => x >= 2 && x <= lastL);
    if (r === 1) { for (let i = 0; i < P / 4; i++) orderKeys.push(L(1, i)); }
    else for (const rr of lr) for (let i = 0; i < P / 2 ** (Math.ceil(rr / 2) + 1); i++) orderKeys.push(L(rr, i));
  }
  if (format === "crossover") orderKeys.push("F1", "F2");
  const slots: Slot[] = [];
  for (const key of orderKeys) {
    const d = drafts.get(key)!;
    const a = resolve(d.a), b = resolve(d.b);
    if (a.kind === "bye" || b.kind === "bye") {
      // not played: the real side (if any) advances; the loser is a BYE
      resolvedWinner.set(key, a.kind === "bye" ? b : a);
      resolvedLoser.set(key, { kind: "bye" });
      continue;
    }
    played.add(key);
    slots.push({ ...d, a, b });
  }
  // Drop feeds that point at unplayed slots and re-point sources already resolved.
  const playedKeys = new Set(slots.map((s) => s.key));
  for (const s of slots) {
    if (s.feedsWinnerTo && !playedKeys.has(s.feedsWinnerTo.key)) s.feedsWinnerTo = chase(s.feedsWinnerTo, drafts, playedKeys);
    if (s.feedsLoserTo && !playedKeys.has(s.feedsLoserTo.key)) s.feedsLoserTo = chase(s.feedsLoserTo, drafts, playedKeys);
  }
  return { n, P, k, format, slots };
}

// If a match feeds an UNPLAYED slot (that slot's other side was a BYE), the
// fed team is that slot's winner and really advances to wherever the slot's
// winner goes — follow the chain until a played slot, or nothing.
function chase(feed: Feed, drafts: Map<string, Draft>, playedKeys: Set<string>): Feed | null {
  let cur: Feed | null = feed;
  let guard = 0;
  while (cur && !playedKeys.has(cur.key) && guard++ < 64) {
    const d: Draft = drafts.get(cur.key)!;
    cur = d.feedsWinnerTo;
  }
  return cur && playedKeys.has(cur.key) ? cur : null;
}

export function describeSource(s: Source, slotsByKey: Map<string, Slot>): string {
  if (s.kind === "seed") return `Seed ${s.seed}`;
  if (s.kind === "bye") return "BYE";
  const t = slotsByKey.get(s.of);
  return `${s.kind === "winner" ? "Winner" : "Loser"} of ${t?.label ?? s.of}`;
}

// Round-by-round layers for time estimates: which matches can run at once.
// W1 alone, then (L1), then (W2), (L2), (W3), (L3), (L4), …, F1, F2.
export function playLayers(de: DoubleElim): Slot[][] {
  const layers = new Map<string, Slot[]>();
  const keyOf = (s: Slot) => `${s.bracket}${s.round}`;
  for (const s of de.slots) {
    const arr = layers.get(keyOf(s)) ?? [];
    arr.push(s);
    layers.set(keyOf(s), arr);
  }
  return Array.from(layers.values());
}

// Simulate a full run: `pick(slot, a, b)` returns the winning seed. Returns the
// medals and the seeds' final placings. Used by tests and the bracket preview.
export function simulate(
  de: DoubleElim,
  pick: (slot: Slot, a: number, b: number) => number,
): { gold: number; silver: number; bronze: number; playedF2: boolean } {
  const winner = new Map<string, number>();
  const loser = new Map<string, number>();
  const teamOf = (src: Source): number => {
    if (src.kind === "seed") return src.seed;
    if (src.kind === "winner") return winner.get(src.of)!;
    if (src.kind === "loser") return loser.get(src.of)!;
    throw new Error("bye in played slot");
  };
  let playedF2 = false;
  for (const s of de.slots) {
    if (s.key === "F2") {
      const f1w = winner.get("F1")!;
      const wChamp = teamOf(de.slots.find((x) => x.key === "F1")!.a);
      if (f1w === wChamp) continue; // not necessary
      playedF2 = true;
    }
    const a = teamOf(s.a), b = teamOf(s.b);
    const w = pick(s, a, b);
    winner.set(s.key, w);
    loser.set(s.key, w === a ? b : a);
  }
  const wFinal = de.slots.find((s) => s.bracket === "winners" && s.round === de.k)!;
  const lFinal = de.slots.filter((s) => s.bracket === "consolation").sort((x, y) => y.round - x.round)[0];
  if (de.format === "bronze_only") {
    return { gold: winner.get(wFinal.key)!, silver: loser.get(wFinal.key)!, bronze: winner.get(lFinal.key)!, playedF2: false };
  }
  const last = playedF2 ? "F2" : "F1";
  return { gold: winner.get(last)!, silver: loser.get(last)!, bronze: loser.get(lFinal.key)!, playedF2 };
}
