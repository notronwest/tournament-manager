// web/src/lib/quotePricing.ts
//
// Pure pricing engine for the Quote Studio estimator. No React, no
// Supabase — takes plain inputs and returns a cost/revenue/net breakdown.
// Used by EstimatePage (public) and the admin quote builder (P2).
//
// "Entrant" means a player-event registration pair (not unique player),
// so a player who enters 2 events counts as 2 entrants for registration
// cost purposes. Total entrants = numEntries + multiEventPlayers.
// Revenue treats numEntries as unique players: first-event fee × numEntries
// + additional-event fee × multiEventPlayers.
//
// Scenario assumptions (from the pricing doc):
//   Scenario 1 — 1 day, 70 entries, 5 events, BertAndErne, distance ≤50:
//     services: onsite_mgmt_day×1, registration_be×70, create_tournament×1,
//               configure_event×5, event_theme×1, flyer×1, pa_system×1,
//               ball_baskets×1
//     WMPC cost $1,115 · gross $4,900 · net $3,785
//   Scenario 2 — 2 days, 70 unique/140 total entrants, 5 events, BertAndErne,
//               distance ≤50, + pickleballs×25:
//     WMPC cost $1,880 · gross $6,300 · net $4,420

// IRS 2025 mileage rate (cents per mile).
export const IRS_MILEAGE_RATE_CENTS = 70;
// Lodging estimate per night when travel is needed.
export const LODGING_PER_NIGHT_CENTS = 15000;
// Per diem per night when travel is needed.
export const PER_DIEM_PER_NIGHT_CENTS = 5000;
// Miles within which travel cost is waived.
export const LOCAL_RADIUS_MILES = 50;

export type QuotePlatform = "bertanderne" | "pickleballbrackets";

export interface QuoteLineInput {
  key: string;
  label: string;
  qty: number;
  unitPriceCents: number;
  passThroughCostCents?: number;
  /**
   * True when this line's charge is a PASS-THROUGH to a third party — money the
   * organizer pays through WMPC but that isn't Bert & Erne's margin (e.g. the
   * PickleballBrackets registration fee). Excluded from `bertErneTakeCents`.
   */
  isPassthrough?: boolean;
}

export interface QuoteInputs {
  numDays: number;
  numEvents: number;
  /** Unique players entering the tournament */
  numEntries: number;
  /** Players who register for more than 1 event */
  multiEventPlayers: number;
  platform: QuotePlatform;
  distanceMiles: number;
  /** Organizer's first-event price (default 7000 = $70) */
  firstEventFeeCents?: number;
  /** Organizer's additional-event price (default 2000 = $20) */
  additionalEventFeeCents?: number;
  /** Selected services with quantities */
  lineItems: QuoteLineInput[];
}

export interface QuoteLineOutput extends QuoteLineInput {
  lineTotalCents: number;
}

export interface TravelEstimate {
  lodgingCents: number;
  perDiemCents: number;
  mileageCents: number;
  totalCents: number;
  flagged: boolean;
}

export interface QuoteOutputs {
  lines: QuoteLineOutput[];
  travel: TravelEstimate;
  wmpcTotalCents: number;
  organizerRevenueCents: number;
  estimatedNetCents: number;
  /** Sum of pass-through line totals (e.g. the PickleballBrackets fee) —
   * collected from the organizer but remitted to the third party. */
  passthroughTotalCents: number;
  /** Bert & Erne's actual take: service revenue minus pass-throughs. Travel is
   * a separate reimbursed cost and isn't part of this number. */
  bertErneTakeCents: number;
}

export function computeQuote(inputs: QuoteInputs): QuoteOutputs {
  const {
    numDays,
    distanceMiles,
    numEntries,
    multiEventPlayers,
    firstEventFeeCents = 7000,
    additionalEventFeeCents = 2000,
    lineItems,
  } = inputs;

  // Per-line totals
  const lines: QuoteLineOutput[] = lineItems.map((item) => ({
    ...item,
    lineTotalCents:
      item.qty * item.unitPriceCents +
      (item.passThroughCostCents ?? 0),
  }));

  const serviceSubtotalCents = lines.reduce(
    (sum, l) => sum + l.lineTotalCents,
    0
  );

  // Pass-through lines (e.g. the PickleballBrackets registration fee) are
  // collected from the organizer but remitted to the third party — not B&E's
  // margin. Track the total and B&E's actual take (service revenue minus
  // pass-throughs).
  const passthroughTotalCents = lines.reduce(
    (sum, l) => sum + (l.isPassthrough ? l.lineTotalCents : 0),
    0
  );
  const bertErneTakeCents = serviceSubtotalCents - passthroughTotalCents;

  // Travel cost
  const flagged = distanceMiles > LOCAL_RADIUS_MILES;
  let travel: TravelEstimate;
  if (!flagged) {
    travel = {
      lodgingCents: 0,
      perDiemCents: 0,
      mileageCents: 0,
      totalCents: 0,
      flagged: false,
    };
  } else {
    const nights = numDays;
    const lodgingCents = nights * LODGING_PER_NIGHT_CENTS;
    const perDiemCents = nights * PER_DIEM_PER_NIGHT_CENTS;
    const mileageCents = distanceMiles * 2 * IRS_MILEAGE_RATE_CENTS;
    travel = {
      lodgingCents,
      perDiemCents,
      mileageCents,
      totalCents: lodgingCents + perDiemCents + mileageCents,
      flagged: true,
    };
  }

  const wmpcTotalCents = serviceSubtotalCents + travel.totalCents;

  // Organizer revenue: numEntries players pay first-event fee, multiEventPlayers pay additional fee
  const organizerRevenueCents =
    numEntries * firstEventFeeCents +
    multiEventPlayers * additionalEventFeeCents;

  const estimatedNetCents = organizerRevenueCents - wmpcTotalCents;

  return {
    lines,
    travel,
    wmpcTotalCents,
    organizerRevenueCents,
    estimatedNetCents,
    passthroughTotalCents,
    bertErneTakeCents,
  };
}
