// web/src/lib/refunds.ts
//
// Organizer-initiated refunds (#704). Thin client over the `stripe-refund`
// edge function's `admin_refund` mode — the UI carries NO money logic; every
// amount (the policy default, the cap) comes from the server. We always
// dry-run first to fetch the preview (policy default + max refundable), then
// execute with the organizer's chosen amount + remove/keep decision.

import { supabase } from "../supabase";

export type AdminRefundPreview = {
  mode: "admin_refund";
  // The cancellation policy's decision for this reg (full/partial/none/…).
  policyDecision: string;
  // Suggested default amount from the policy, clamped to what's refundable.
  policyDefaultCents: number;
  // Hard cap: net paid minus anything already refunded.
  maxRefundableCents: number;
  alreadyRefundedCents: number;
  amountCents: number;
  removeFromEvent: boolean;
  currency: string;
  partner: { name: string; willUnpair: boolean } | null;
  applied?: boolean;
  newStatus?: string | null;
};

// Pull the server's { error } message out of a functions.invoke failure
// (mirrors the helper in TournamentDetailPage).
export async function extractRefundError(fnErr: unknown): Promise<string> {
  const ctx = (fnErr as { context?: Response }).context;
  if (ctx) {
    try {
      const body = (await ctx.json()) as { error?: string };
      if (body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return (fnErr as { message?: string }).message ?? "Unknown error.";
}

// Dry run — fetch the policy default + max refundable for a paid reg. Does not
// move any money.
export async function previewAdminRefund(
  regId: string,
): Promise<{ preview: AdminRefundPreview | null; error: string | null }> {
  const { data, error } = await supabase.functions.invoke("stripe-refund", {
    body: { eventRegistrationId: regId, mode: "admin_refund", dryRun: true },
  });
  if (error) return { preview: null, error: await extractRefundError(error) };
  return { preview: data as AdminRefundPreview, error: null };
}

// Execute — issue the refund. amountCents is the organizer's final amount (in
// cents); removeFromEvent decides whether the player is also withdrawn.
export async function executeAdminRefund(args: {
  regId: string;
  amountCents: number;
  removeFromEvent: boolean;
  reason?: string;
}): Promise<{ result: AdminRefundPreview | null; error: string | null }> {
  const { data, error } = await supabase.functions.invoke("stripe-refund", {
    body: {
      eventRegistrationId: args.regId,
      mode: "admin_refund",
      amountCents: args.amountCents,
      removeFromEvent: args.removeFromEvent,
      reason: args.reason,
      dryRun: false,
    },
  });
  if (error) return { result: null, error: await extractRefundError(error) };
  return { result: data as AdminRefundPreview, error: null };
}
