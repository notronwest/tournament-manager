import { supabase } from "../supabase";

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

  return tournaments.map((t) => ({
    id: t.id,
    name: t.name,
    startsAt: t.starts_at,
    events: byTournament.get(t.id) ?? [],
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
