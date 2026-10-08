// Pure math for the org-scoped $20 account credit (issue #1102, D-0077 §2).
//
// This pins the contract the server implements authoritatively in SQL
// (account_credit_balance / redeem_account_credit, see
// supabase/migrations/20261008150000_account_credits.sql): balance is the
// sum of unexpired grants net of redemptions and refund_restores, scoped to
// one organization, and credit stacks AFTER a coupon, floored at zero, with
// any unspent remainder staying on the ledger. The server is still the
// authority at actual payment time (it re-reads the ledger itself) — this
// is what the client uses to show a live preview from the account_credits
// rows it's already allowed to read (RLS limits a player to their own).
//
// Never cash: there is no function in this module that withdraws credit,
// transfers it between players, or converts it to a refund-to-card. Adding
// one would be the second rail D-0077 explicitly forbids.

export type AccountCreditKind = "grant" | "redemption" | "refund_restore";

export type AccountCreditRow = {
  organization_id: string;
  amount_cents: number;
  kind: AccountCreditKind;
  expires_at: string | null;
};

/**
 * Current balance for ONE organization: unexpired grants, net of
 * redemptions and refund_restores. Rows from any other organization_id are
 * ignored entirely — credit never crosses the org boundary (D-0077's core
 * rule: this organization's tournaments only).
 */
export function computeAccountCreditBalance(
  rows: readonly AccountCreditRow[],
  organizationId: string,
  now: Date = new Date(),
): number {
  return rows
    .filter((r) => r.organization_id === organizationId)
    .filter(
      (r) => r.kind !== "grant" || !r.expires_at || new Date(r.expires_at) > now,
    )
    .reduce((sum, r) => sum + r.amount_cents, 0);
}

export type CreditStackResult = {
  /** Subtotal after the coupon, before credit. Never negative. */
  afterCouponCents: number;
  /** How much credit actually applies — never more than what's owed, never more than the balance. */
  creditAppliedCents: number;
  /** What's still owed after coupon + credit. Never negative. */
  dueCents: number;
  /** Unspent credit — stays on the ledger, not lost. */
  leftoverCreditCents: number;
};

/**
 * Stacks a coupon discount then account credit against a subtotal, per
 * D-0077 §2: coupon first, credit against the remainder, floored at zero,
 * partial spend allowed.
 */
export function stackCouponThenCredit(
  subtotalCents: number,
  couponDiscountCents: number,
  availableCreditCents: number,
): CreditStackResult {
  const afterCouponCents = Math.max(
    0,
    subtotalCents - Math.max(0, couponDiscountCents),
  );
  const creditAppliedCents = Math.max(
    0,
    Math.min(afterCouponCents, availableCreditCents),
  );
  const dueCents = afterCouponCents - creditAppliedCents;
  const leftoverCreditCents = availableCreditCents - creditAppliedCents;
  return { afterCouponCents, creditAppliedCents, dueCents, leftoverCreditCents };
}
