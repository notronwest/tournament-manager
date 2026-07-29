import { supabase } from "../supabase";

// Admin-side helpers for the "pending partner invites" tool: list partners who
// were invited to a doubles event but haven't accepted (invite still 'pending'),
// and resend the invitation email. The primary register flow defers the invite
// email to payment time, so partners of un-paid / changed / failed-send
// registrations can be left uninvited — this lets an org admin push it manually.

export type PendingInvite = {
  inviteId: string;
  eventId: string;
  eventName: string;
  inviterName: string;
  inviteeName: string;
  inviteeEmail: string | null;
  createdAt: string;
  /** The inviter's own registration status for this event, e.g. 'paid',
   * 'pending_payment', 'waitlisted', or null if they have no reg row. */
  inviterStatus: string | null;
  inviterPaid: boolean;
};

// Fetch pending (un-accepted) partner invites across a tournament's events,
// with inviter/invitee names, the invitee's email, and the inviter's payment
// status. Oldest first (the ones most likely to have been missed).
export async function fetchPendingPartnerInvites(tournamentId: string): Promise<PendingInvite[]> {
  const { data: events, error: eErr } = await supabase
    .from("events")
    .select("id, name")
    .eq("tournament_id", tournamentId)
    .is("deleted_at", null);
  if (eErr) throw new Error(eErr.message);
  const eventName = new Map((events ?? []).map((e) => [e.id, e.name]));
  const eventIds = [...eventName.keys()];
  if (eventIds.length === 0) return [];

  const { data: invites, error: iErr } = await supabase
    .from("partner_invites")
    .select("id, event_id, inviter_player_id, invitee_player_id, invitee_email, created_at")
    .in("event_id", eventIds)
    .eq("status", "pending");
  if (iErr) throw new Error(iErr.message);
  const rows = invites ?? [];
  if (rows.length === 0) return [];

  // Names for both parties.
  const playerIds = new Set<string>();
  for (const r of rows) {
    playerIds.add(r.inviter_player_id);
    playerIds.add(r.invitee_player_id);
  }
  const { data: players, error: pErr } = await supabase
    .from("players")
    .select("id, first_name, last_name")
    .in("id", [...playerIds]);
  if (pErr) throw new Error(pErr.message);
  const nameById = new Map(
    (players ?? []).map((p) => [p.id, `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim()]),
  );

  // Inviter payment status per (event, inviter).
  const inviterIds = [...new Set(rows.map((r) => r.inviter_player_id))];
  const { data: regs, error: rErr } = await supabase
    .from("event_registrations")
    .select("event_id, player_id, status")
    .in("event_id", eventIds)
    .in("player_id", inviterIds)
    .is("deleted_at", null);
  if (rErr) throw new Error(rErr.message);
  const regStatus = new Map((regs ?? []).map((r) => [`${r.event_id}:${r.player_id}`, r.status]));

  const out: PendingInvite[] = rows.map((r) => {
    const status = regStatus.get(`${r.event_id}:${r.inviter_player_id}`) ?? null;
    return {
      inviteId: r.id,
      eventId: r.event_id,
      eventName: eventName.get(r.event_id) ?? "—",
      inviterName: nameById.get(r.inviter_player_id) || "Unknown",
      inviteeName: nameById.get(r.invitee_player_id) || "Unknown",
      inviteeEmail: r.invitee_email,
      createdAt: r.created_at,
      inviterStatus: status,
      inviterPaid: status === "paid",
    };
  });
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

// Resend one invite's email via the existing send-partner-invite function (which
// has no idempotency guard — invoking it re-sends). Throws on failure.
export async function resendPartnerInvite(inviteId: string, baseUrl: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke("send-partner-invite", {
    body: { inviteId, baseUrl },
  });
  if (error) {
    let detail = error.message;
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const b = (await ctx.json()) as { error?: string };
        if (b?.error) detail = b.error;
      } catch {
        /* keep transport message */
      }
    }
    throw new Error(detail);
  }
  const err = (data as { error?: string } | null)?.error;
  if (err) throw new Error(err);
}
