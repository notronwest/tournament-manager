// Unit tests for quotePricing.ts — matches the two scenarios from the
// "Tournament Management — Services & Pricing" Google Doc.
//
// Scenario 1 services (from the doc's one-day package):
//   onsite_mgmt_day×1($500), registration_be×70($140), create_tournament×1($100),
//   configure_event×5($25), event_theme×1($100), flyer×1($150),
//   pa_system×1($75), ball_baskets×1($25) → WMPC $1,115
//
// Scenario 2 adds a second day and pickleballs×25, driving up
//   registration to 140 entrants (70 unique × 2 events = 140 total):
//   WMPC $1,880, gross $6,300, net $4,420

import { describe, expect, it } from "vitest";
import { computeQuote } from "./quotePricing";
import type { QuoteLineInput } from "./quotePricing";

const SCENARIO_1_LINES: QuoteLineInput[] = [
  { key: "onsite_mgmt_day", label: "On-site management", qty: 1, unitPriceCents: 50000 },
  { key: "registration_be", label: "Registration (BertAndErne)", qty: 70, unitPriceCents: 200 },
  { key: "create_tournament", label: "Create the tournament", qty: 1, unitPriceCents: 10000 },
  { key: "configure_event", label: "Configure each event/division", qty: 5, unitPriceCents: 500 },
  { key: "event_theme", label: "Event theme development", qty: 1, unitPriceCents: 10000 },
  { key: "flyer", label: "Tournament flyer", qty: 1, unitPriceCents: 15000 },
  { key: "pa_system", label: "PA system", qty: 1, unitPriceCents: 7500 },
  { key: "ball_baskets", label: "Ball baskets", qty: 1, unitPriceCents: 2500 },
];

describe("computeQuote", () => {
  it("Scenario 1 — 1 day, 70 entries, 5 events: WMPC $1,115 · gross $4,900 · net $3,785", () => {
    const result = computeQuote({
      numDays: 1,
      numEvents: 5,
      numEntries: 70,
      multiEventPlayers: 0,
      platform: "bertanderne",
      distanceMiles: 0,
      lineItems: SCENARIO_1_LINES,
    });

    // WMPC cost = $1,115
    expect(result.wmpcTotalCents).toBe(111500);
    // Organizer gross = 70 × $70 = $4,900
    expect(result.organizerRevenueCents).toBe(490000);
    // Net = $4,900 − $1,115 = $3,785
    expect(result.estimatedNetCents).toBe(378500);
    // No travel (distance ≤ 50 miles)
    expect(result.travel.totalCents).toBe(0);
    expect(result.travel.flagged).toBe(false);
  });

  it("Scenario 2 — 2 days, 140 entrants (70 unique × 2 events), BertAndErne + pickleballs×25: WMPC $1,880 · gross $6,300 · net $4,420", () => {
    // Double the day-based services and bump registration to 140 entrants.
    // Assumption: registration_be is priced per event entry, so 70 unique
    // players × 2 events = 140 entrants. multiEventPlayers=70 drives both
    // the additional-event revenue and the extra 70 entrants in registration.
    const lines: QuoteLineInput[] = [
      { key: "onsite_mgmt_day", label: "On-site management", qty: 2, unitPriceCents: 50000 },
      { key: "registration_be", label: "Registration (BertAndErne)", qty: 140, unitPriceCents: 200 },
      { key: "create_tournament", label: "Create the tournament", qty: 1, unitPriceCents: 10000 },
      { key: "configure_event", label: "Configure each event/division", qty: 5, unitPriceCents: 500 },
      { key: "event_theme", label: "Event theme development", qty: 1, unitPriceCents: 10000 },
      { key: "flyer", label: "Tournament flyer", qty: 1, unitPriceCents: 15000 },
      { key: "pa_system", label: "PA system", qty: 2, unitPriceCents: 7500 },
      { key: "ball_baskets", label: "Ball baskets", qty: 1, unitPriceCents: 2500 },
      { key: "pickleballs", label: "Pickleballs", qty: 25, unitPriceCents: 200 },
    ];

    const result = computeQuote({
      numDays: 2,
      numEvents: 5,
      numEntries: 70,
      multiEventPlayers: 70,
      platform: "bertanderne",
      distanceMiles: 0,
      lineItems: lines,
    });

    // WMPC cost = $1,880
    expect(result.wmpcTotalCents).toBe(188000);
    // Organizer gross = 70×$70 + 70×$20 = $4,900 + $1,400 = $6,300
    expect(result.organizerRevenueCents).toBe(630000);
    // Net = $6,300 − $1,880 = $4,420
    expect(result.estimatedNetCents).toBe(442000);
    expect(result.travel.totalCents).toBe(0);
  });

  it("travel cost is 0 when distanceMiles ≤ 50", () => {
    const result = computeQuote({
      numDays: 1,
      numEvents: 1,
      numEntries: 10,
      multiEventPlayers: 0,
      platform: "bertanderne",
      distanceMiles: 50,
      lineItems: [],
    });
    expect(result.travel.flagged).toBe(false);
    expect(result.travel.totalCents).toBe(0);
  });

  it("travel cost is non-zero and flagged when distanceMiles > 50", () => {
    const result = computeQuote({
      numDays: 1,
      numEvents: 1,
      numEntries: 10,
      multiEventPlayers: 0,
      platform: "bertanderne",
      distanceMiles: 100,
      lineItems: [],
    });
    expect(result.travel.flagged).toBe(true);
    expect(result.travel.totalCents).toBeGreaterThan(0);
    // Round trip mileage: 100 × 2 × $0.70 = $140 = 14000 cents
    expect(result.travel.mileageCents).toBe(14000);
  });

  it("passthrough cost is added to line total for medals", () => {
    const result = computeQuote({
      numDays: 1,
      numEvents: 1,
      numEntries: 10,
      multiEventPlayers: 0,
      platform: "bertanderne",
      distanceMiles: 0,
      lineItems: [
        { key: "medals", label: "Medals", qty: 1, unitPriceCents: 5000, passThroughCostCents: 8000 },
      ],
    });
    // $50 fee + $80 cost = $130 total
    expect(result.lines[0].lineTotalCents).toBe(13000);
    expect(result.wmpcTotalCents).toBe(13000);
  });

  it("a pass-through line (PickleballBrackets fee) is excluded from B&E's take", () => {
    const result = computeQuote({
      numDays: 1,
      numEvents: 1,
      numEntries: 70,
      multiEventPlayers: 0,
      platform: "pickleballbrackets",
      distanceMiles: 0,
      lineItems: [
        // $5 per registration × 70 = $350, pass-through to PickleballBrackets
        {
          key: "registration_pb",
          label: "Registration (PickleballBrackets)",
          qty: 70,
          unitPriceCents: 500,
          isPassthrough: true,
        },
        // $100 B&E setup fee — counts toward B&E's take
        {
          key: "create_tournament",
          label: "Create the tournament",
          qty: 1,
          unitPriceCents: 10000,
        },
      ],
    });
    // WMPC cost (what the organizer pays) is unchanged: $350 + $100 = $450
    expect(result.wmpcTotalCents).toBe(45000);
    // The $350 PB fee is a pass-through, not B&E's margin
    expect(result.passthroughTotalCents).toBe(35000);
    // B&E's take excludes the pass-through: $450 - $350 = $100
    expect(result.bertErneTakeCents).toBe(10000);
  });
});
