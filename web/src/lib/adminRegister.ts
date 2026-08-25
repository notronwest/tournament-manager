import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../supabase";
import type { PricingTier } from "./pricingTiers";

// `manual_payments` isn't in the generated `Database` types yet, so reads of it
// go through an untyped client (same approach as lib/orgContacts).
const untyped = supabase as unknown as SupabaseClient;

// Data + call for the admin "register a contact for an event" flow. An org admin
// picks a tournament + event(s) and either comps the entry (waives the fee) or
// records a payment collected outside the app (cash / check / venmo / other).
// The registration + money record are written server-side by the
// `admin-register-contact` edge function (payment records are server-only).

export type PickerEvent = {
  id: string;
  name: string;
  feeCents: number;
  format: string;
  gender: string;
};

export type PickerTournament = {
  id: string;
  name: string;
  startsAt: string | null;
  events: PickerEvent[];
  // The tournament's pricing tiers, so the modal can show the real amount owed
  // for a tier-priced tournament (where event_fee_cents is 0 and the price comes
  // from the active tier — same math as public checkout / compute_checkout_total).
  tiers: PricingTier[];
};

// The org's non-deleted tournaments and their non-deleted events, for the picker.
// Newest tournament first; events in creation order.
export async function fetchOrgTournamentsWithEvents(
  orgId: string,
): Promise<PickerTournament[]> {
  const { data: tourneys, error: tErr } = await supabase
    .from("tournaments")
    .select("id, name, starts_at")
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .order("starts_at", { ascending: false, nullsFirst: false });
  if (tErr) throw new Error(tErr.message);
  const tournaments = tourneys ?? [];
  if (tournaments.length === 0) return [];

  const { data: events, error: eErr } = await supabase
    .from("events")
    .select("id, tournament_id, name, event_fee_cents, format, gender")
    .in(
      "tournament_id",
      tournaments.map((t) => t.id),
    )
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (eErr) throw new Error(eErr.message);

  const byTournament = new Map<string, PickerEvent[]>();
  for (const e of events ?? []) {
    const list = byTournament.get(e.tournament_id) ?? [];
    list.push({
      id: e.id,
      name: e.name,
      feeCents: e.event_fee_cents ?? 0,
      format: e.format ?? "",
      gender: e.gender ?? "",
    });
    byTournament.set(e.tournament_id, list);
  }

  // Pricing tiers per tournament (first/additional-event fees by date window).
  const { data: tierRows, error: tierErr } = await supabase
    .from("tournament_pricing_tiers")
    .select("*")
    .in(
      "tournament_id",
      tournaments.map((t) => t.id),
    );
  if (tierErr) throw new Error(tierErr.message);
  const tiersByTournament = new Map<string, PricingTier[]>();
  for (const row of tierRows ?? []) {
    const list = tiersByTournament.get(row.tournament_id) ?? [];
    list.push(row as PricingTier);
    tiersByTournament.set(row.tournament_id, list);
  }

  return tournaments.map((t) => ({
    id: t.id,
    name: t.name,
    startsAt: t.starts_at,
    events: byTournament.get(t.id) ?? [],
    tiers: tiersByTournament.get(t.id) ?? [],
  }));
}

export type ManualPaymentMethod = "cash" | "check" | "venmo" | "other";
// comp = waive to $0 (paid); offline = payment collected outside the app (paid);
// invoice = leave a balance the player pays online themselves (pending_payment).
export type RegisterKind = "comp" | "offline" | "invoice";

export type AdminRegisterPayload = {
  organizationId: string;
  playerId: string;
  // amountCents is used only when kind === "offline"; ignored for comp/invoice
  // (comp forces $0; invoice bills the event's standard fee at checkout).
  registrations: { eventId: string; amountCents: number }[];
  kind: RegisterKind;
  method?: ManualPaymentMethod;
  note?: string;
};

export type AdminRegisterResult = {
  registered: number;
  skipped: { eventId: string; reason: string }[];
  errors?: string[];
};

// Register the contact into the chosen events via the edge function. Throws on a
// transport/function error; returns the per-event summary otherwise.
export async function adminRegisterContact(
  payload: AdminRegisterPayload,
): Promise<AdminRegisterResult> {
  const { data, error } = await supabase.functions.invoke(
    "admin-register-contact",
    { body: payload },
  );
  if (error) {
    // Surface the function's JSON error body when present.
    let detail = error.message;
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.text === "function") {
      try {
        const body = await ctx.text();
        if (body) detail = body;
      } catch {
        /* keep the transport message */
      }
    }
    throw new Error(detail);
  }
  return data as AdminRegisterResult;
}

// ─────────────────────────────────────────────────────────────────────
// Settling an EXISTING unpaid registration (the post-hoc comp / offline).
// ─────────────────────────────────────────────────────────────────────

// Only the two treatments that end at status='paid'. There is no post-hoc
// "invoice at $X": compute_checkout_total prices from events.event_fee_cents +
// the tournament tier and never reads event_registrations.event_fee_cents, so a
// custom balance written here would not change what the player is charged.
export type SettleKind = "comp" | "offline";

export type SettleRegistrationPayload = {
  regId: string;
  kind: SettleKind;
  // Required (and used) only when kind === "offline"; comp forces $0.
  amountCents?: number;
  method?: ManualPaymentMethod;
  note?: string;
};

// What was actually recorded against a registration outside Stripe. One row per
// settlement; the newest is the one the editor shows.
export type ManualPaymentRecord = {
  id: string;
  kind: SettleKind;
  amountCents: number;
  method: ManualPaymentMethod | null;
  note: string | null;
  createdAt: string;
};

// Close an open balance as comped or offline-collected. Throws on failure.
export async function settleRegistrationPayment(
  payload: SettleRegistrationPayload,
): Promise<void> {
  const { error } = await supabase.functions.invoke(
    "admin-set-registration-payment",
    { body: payload },
  );
  if (error) throw new Error(await fnErrorMessage(error));
}

type ManualPaymentRow = {
  id: string;
  kind: string;
  amount_cents: number;
  method: string | null;
  note: string | null;
  created_at: string;
};

// The manual (non-Stripe) payments recorded against one registration, newest
// first. Readable by org members via RLS; [] when the reg was paid online.
// `manual_payments` isn't in the generated Database types yet, so this one call
// goes through the untyped client (same approach as lib/orgContacts).
export async function fetchManualPayments(
  regId: string,
): Promise<ManualPaymentRecord[]> {
  const { data, error } = await untyped
    .from("manual_payments")
    .select("id, kind, amount_cents, method, note, created_at")
    .eq("event_registration_id", regId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as ManualPaymentRow[]).map((r) => ({
    id: r.id,
    kind: r.kind as SettleKind,
    amountCents: r.amount_cents,
    method: r.method as ManualPaymentMethod | null,
    note: r.note,
    createdAt: r.created_at,
  }));
}

// Pull the edge function's JSON { error } out of an invoke failure, falling
// back to the transport message.
async function fnErrorMessage(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response }).context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const body = (await ctx.json()) as { error?: string; detail?: string };
      if (body?.error) return SETTLE_ERRORS[body.error] ?? body.detail ?? body.error;
    } catch {
      /* fall through to the transport message */
    }
  }
  return (error as { message?: string }).message ?? "Something went wrong.";
}

// Server error codes → organizer-readable copy.
const SETTLE_ERRORS: Record<string, string> = {
  already_paid_use_refund:
    "This registration is already paid — use Issue refund to give money back.",
  forbidden_org_staff_only:
    "You don't have permission to record payments for this organization.",
  registration_not_found: "That registration no longer exists.",
  manual_payment_insert_failed:
    "The registration was marked paid but the payment record failed to save. Check the registration before recording it again.",
};
