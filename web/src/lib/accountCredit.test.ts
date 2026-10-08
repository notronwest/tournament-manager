import { describe, expect, it } from "vitest";
import * as accountCredit from "./accountCredit";
import {
  computeAccountCreditBalance,
  stackCouponThenCredit,
  type AccountCreditRow,
} from "./accountCredit";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

function grant(
  amountCents: number,
  expiresAt: string | null,
  organizationId: string = ORG_A,
): AccountCreditRow {
  return { organization_id: organizationId, amount_cents: amountCents, kind: "grant", expires_at: expiresAt };
}

function redemption(amountCents: number, organizationId: string = ORG_A): AccountCreditRow {
  return { organization_id: organizationId, amount_cents: amountCents, kind: "redemption", expires_at: null };
}

function refundRestore(amountCents: number, organizationId: string = ORG_A): AccountCreditRow {
  return { organization_id: organizationId, amount_cents: amountCents, kind: "refund_restore", expires_at: null };
}

describe("computeAccountCreditBalance", () => {
  const now = new Date("2026-10-08T00:00:00Z");

  it("sums an unexpired grant", () => {
    const rows = [grant(2000, "2027-10-08T00:00:00Z")];
    expect(computeAccountCreditBalance(rows, ORG_A, now)).toBe(2000);
  });

  it("an expired grant contributes zero", () => {
    const rows = [grant(2000, "2026-01-01T00:00:00Z")];
    expect(computeAccountCreditBalance(rows, ORG_A, now)).toBe(0);
  });

  it("a grant with no expiry never expires", () => {
    const rows = [grant(2000, null)];
    expect(computeAccountCreditBalance(rows, ORG_A, now)).toBe(2000);
  });

  it("nets a redemption against a grant", () => {
    const rows = [grant(2000, null), redemption(-1500)];
    expect(computeAccountCreditBalance(rows, ORG_A, now)).toBe(500);
  });

  it("a refund_restore returns exactly what was consumed", () => {
    const rows = [grant(2000, null), redemption(-2000), refundRestore(2000)];
    expect(computeAccountCreditBalance(rows, ORG_A, now)).toBe(2000);
  });

  it("credit from org A cannot be applied to an org B tournament — org B's rows are ignored", () => {
    const rows = [grant(2000, null, ORG_A), grant(5000, null, ORG_B)];
    expect(computeAccountCreditBalance(rows, ORG_A, now)).toBe(2000);
    expect(computeAccountCreditBalance(rows, ORG_B, now)).toBe(5000);
  });
});

describe("stackCouponThenCredit", () => {
  it("applies the coupon before credit", () => {
    const result = stackCouponThenCredit(10000, 2000, 2000);
    expect(result.afterCouponCents).toBe(8000);
    expect(result.creditAppliedCents).toBe(2000);
    expect(result.dueCents).toBe(6000);
  });

  it("credit larger than the remainder spends only the remainder and leaves the rest on the ledger", () => {
    const result = stackCouponThenCredit(1000, 0, 2000);
    expect(result.creditAppliedCents).toBe(1000);
    expect(result.dueCents).toBe(0);
    expect(result.leftoverCreditCents).toBe(1000);
  });

  it("credit smaller than the remainder leaves a balance due", () => {
    const result = stackCouponThenCredit(5000, 0, 2000);
    expect(result.creditAppliedCents).toBe(2000);
    expect(result.dueCents).toBe(3000);
    expect(result.leftoverCreditCents).toBe(0);
  });

  it("the total never goes below zero even if the coupon alone exceeds the subtotal", () => {
    const result = stackCouponThenCredit(1000, 5000, 2000);
    expect(result.afterCouponCents).toBe(0);
    expect(result.creditAppliedCents).toBe(0);
    expect(result.dueCents).toBe(0);
    expect(result.leftoverCreditCents).toBe(2000);
  });

  it("zero available credit leaves the full post-coupon amount due", () => {
    const result = stackCouponThenCredit(10000, 2000, 0);
    expect(result.creditAppliedCents).toBe(0);
    expect(result.dueCents).toBe(8000);
  });
});

describe("never cash", () => {
  it("exposes no function that withdraws, transfers, or cashes out credit", () => {
    const exportNames = Object.keys(accountCredit);
    const forbidden = /cash|withdraw|transfer|payout|refundToCard/i;
    for (const name of exportNames) {
      expect(name).not.toMatch(forbidden);
    }
  });
});
