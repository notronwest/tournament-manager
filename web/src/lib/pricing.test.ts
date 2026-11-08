// Checkout pricing tests for #1206 — a per-event fee must not consume the
// tournament's first-event slot.
//
// The defect: computeLineItems ranked ALL of a player's picks together, so an
// override priced ABOVE the tier's first-event fee sorted to position 0, took
// the "override" label, and left the `i === 0` branch unreachable. No pick was
// then charged the entry fee. compute_checkout_total in the database had the
// identical rule and the identical hole, so the screen and the server agreed
// on the WRONG number and nothing looked broken at checkout.
//
// Every "charged now" figure in the table below was measured against the code
// as it stood before the fix; the "should be" column is what these tests pin.
// The kids-bracket case (an override priced BELOW the first-event fee) already
// priced correctly and is here as a regression guard, not a fix.
//
// The matching proof that the database function now returns the same totals
// for these same baskets is in the migration PR; this file guards the screen.
import { describe, expect, it } from "vitest";
import { bracketsWithOwnPrice, computeLineItems, formatUsd, priceTiers } from "./pricing";

// The tier used for every case in the issue's table: $50.00 for the first
// event, $20.00 for each additional, entry covers one event.
const RATES = {
  firstEventFeeCents: 5000,
  additionalEventFeeCents: 2000,
  firstEventsIncluded: 1,
};

const ev = (id: string, ownFeeCents = 0) => ({
  id,
  event_fee_cents: ownFeeCents,
});

/** Total plus a readable `id tier $amount` breakdown, for failure messages. */
const price = (
  events: { id: string; event_fee_cents: number }[],
  rates = RATES,
  alreadyPaid = false,
) => {
  const { items, totalCents } = computeLineItems(events, rates, alreadyPaid);
  return {
    totalCents,
    breakdown: items.map((i) => `${i.event.id} ${i.tier} ${formatUsd(i.cents)}`),
    tierOf: (id: string) => items.find((i) => i.event.id === id)?.tier,
    centsOf: (id: string) => items.find((i) => i.event.id === id)?.cents,
  };
};

describe("a per-event fee does not consume the first-event slot (#1206)", () => {
  it("premium $90 + 1 adult bracket charges $140, not the $110 it used to", () => {
    const r = price([ev("premium", 9000), ev("adult")]);
    expect(r.totalCents).toBe(14000);
    expect(r.breakdown).toEqual([
      "premium override $90.00",
      "adult first $50.00",
    ]);
  });

  it("premium $90 + 2 adult brackets charges $160, not the $130 it used to", () => {
    const r = price([ev("premium", 9000), ev("a"), ev("b")]);
    expect(r.totalCents).toBe(16000);
    expect(r.tierOf("premium")).toBe("override");
    // Exactly one of the two tier-priced picks pays the entry fee.
    expect([r.tierOf("a"), r.tierOf("b")].sort()).toEqual([
      "additional",
      "first",
    ]);
  });

  it("exactly one tier-priced pick pays the entry fee, whatever the override costs", () => {
    for (const overrideCents of [1, 2500, 4999, 5000, 5001, 9000, 100000]) {
      const { items } = computeLineItems(
        [ev("override", overrideCents), ev("a"), ev("b"), ev("c")],
        RATES,
      );
      const firsts = items.filter((i) => i.tier === "first");
      expect(
        firsts.length,
        `override of ${formatUsd(overrideCents)} should leave exactly one "first"`,
      ).toBe(1);
      expect(items.find((i) => i.event.id === "override")?.cents).toBe(
        overrideCents,
      );
    }
  });

  it("two overrides still leave one entry fee on the remaining pick", () => {
    const r = price([ev("p1", 9000), ev("p2", 7000), ev("adult")]);
    expect(r.totalCents).toBe(9000 + 7000 + 5000);
    expect(r.tierOf("adult")).toBe("first");
  });

  it("premium $90 + kids $25 + 2 adult brackets charges $185, not the $155 it used to", () => {
    const r = price([ev("premium", 9000), ev("kids", 2500), ev("a"), ev("b")]);
    expect(r.totalCents).toBe(18500);
    expect(r.tierOf("premium")).toBe("override");
    expect(r.tierOf("kids")).toBe("override");
    expect([r.tierOf("a"), r.tierOf("b")].sort()).toEqual([
      "additional",
      "first",
    ]);
  });
});

describe("cases that already priced correctly must not regress (#1206)", () => {
  it("kids $25 + adult still charges $75 — the override is below the entry fee", () => {
    const r = price([ev("kids", 2500), ev("adult")]);
    expect(r.totalCents).toBe(7500);
    expect(r.breakdown).toEqual(["kids override $25.00", "adult first $50.00"]);
  });

  it("an override on its own is charged its own fee and nothing else", () => {
    expect(price([ev("kids", 2500)]).totalCents).toBe(2500);
    expect(price([ev("premium", 9000)]).totalCents).toBe(9000);
    expect(price([ev("premium", 9000)]).tierOf("premium")).toBe("override");
  });

  it("adult + adult, no override, is unchanged at $70", () => {
    const r = price([ev("a"), ev("b")]);
    expect(r.totalCents).toBe(7000);
    expect(r.breakdown).toEqual(["a first $50.00", "b additional $20.00"]);
  });

  it("a single tier-priced pick is the entry fee", () => {
    expect(price([ev("a")]).totalCents).toBe(5000);
  });

  it("no picks is zero", () => {
    expect(price([]).totalCents).toBe(0);
  });
});

describe("the other pricing rules still hold with an override present (#1206)", () => {
  it("alreadyHasPaidEvent suppresses first/included, overrides still charge flat", () => {
    const r = price([ev("premium", 9000), ev("a"), ev("b")], RATES, true);
    // Entry fee was collected in an earlier session: every tier-priced pick
    // is at the additional rate, the override is untouched.
    expect(r.totalCents).toBe(9000 + 2000 + 2000);
    expect(r.tierOf("premium")).toBe("override");
    expect(r.tierOf("a")).toBe("additional");
    expect(r.tierOf("b")).toBe("additional");
  });

  it("an entry fee covering 3 events gives $0 'included' picks, and the override is outside the count", () => {
    const rates = { ...RATES, firstEventsIncluded: 3 };
    const r = price([ev("premium", 9000), ev("a"), ev("b"), ev("c")], rates);
    // premium flat + first + two included at $0 — the override must not eat
    // one of the three included slots.
    expect(r.totalCents).toBe(9000 + 5000);
    expect(r.tierOf("premium")).toBe("override");
    const tiers = ["a", "b", "c"].map(r.tierOf).sort();
    expect(tiers).toEqual(["first", "included", "included"]);
  });

  it("beyond the included count, picks fall to the additional rate", () => {
    const rates = { ...RATES, firstEventsIncluded: 2 };
    const r = price([ev("premium", 9000), ev("a"), ev("b"), ev("c")], rates);
    expect(r.totalCents).toBe(9000 + 5000 + 0 + 2000);
  });

  it("line items come back in the caller's order, not the internal ranking", () => {
    const r = price([ev("adult"), ev("premium", 9000), ev("b")]);
    expect(r.breakdown.map((s) => s.split(" ")[0])).toEqual([
      "adult",
      "premium",
      "b",
    ]);
  });
});

describe("priceTiers indicative prices (#1206)", () => {
  it("an override shows the same price whether picked first or later", () => {
    expect(priceTiers(ev("premium", 9000), RATES)).toEqual({
      fullPrice: 9000,
      additionalPrice: 9000,
    });
  });

  it("a tier-priced event shows the first-event and additional rates", () => {
    expect(priceTiers(ev("adult"), RATES)).toEqual({
      fullPrice: 5000,
      additionalPrice: 2000,
    });
  });
});

describe("brackets that carry their own price are surfaced for display", () => {
  const named = (id: string, ownFeeCents = 0) => ({ ...ev(id, ownFeeCents), name: id });

  it("no bracket prices: nothing to show", () => {
    expect(bracketsWithOwnPrice([named("a"), named("b")])).toEqual([]);
  });

  it("a bracket priced below the tier is listed, tier brackets are not", () => {
    const out = bracketsWithOwnPrice([named("adult"), named("kids", 3500)]);
    expect(out.map((e) => [e.id, e.event_fee_cents])).toEqual([["kids", 3500]]);
    expect(3500).toBeLessThan(RATES.firstEventFeeCents);
  });

  it("a bracket priced above the tier is listed too", () => {
    const out = bracketsWithOwnPrice([named("premium", 9000), named("adult")]);
    expect(out.map((e) => e.id)).toEqual(["premium"]);
    expect(9000).toBeGreaterThan(RATES.firstEventFeeCents);
  });

  it("the charged line item for such a bracket is the 'override' tier", () => {
    expect(price([ev("kids", 3500)]).tierOf("kids")).toBe("override");
  });
});
