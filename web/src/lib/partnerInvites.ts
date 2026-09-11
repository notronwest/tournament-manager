import { supabase } from "../supabase";
import { pairAndResolveInvites } from "./registrations";

// Admin-side helpers for the "pending partner invites" tool: list partners who
// were invited to a doubles event but haven't accepted (invite still 'pending'),
// work out which of those are actually settled or already registered under a
// different player record, resend the invitation email, pair a matched
// registrant, and remove invites that are no longer wanted.
//
// Why the extra detection: an invite stays 'pending' forever unless the invitee
// clicks Accept. In practice people register themselves (often with a different
// email than the one they were invited at), the inviter withdraws, or the two
// get paired at the desk — and the list fills with rows that look actionable
// but aren't. Each row now carries a `resolution` so the panel can say so.

export type InviteResolution =
  /** Nothing has happened yet — resend is the useful action. */
  | { kind: "open" }
  /** The invitee is registered in this event (same player, or a duplicate
   * record matched by email or name) and NOT yet paired with the inviter. */
  | {
      kind: "registered";
      regId: string;
      playerId: string;
      name: string;
      email: string | null;
      matchedBy: "player" | "email" | "name";
      /** They already have a confirmed partner — pairing would need a swap. */
      alreadyPaired: boolean;
    }
  /** Done: the inviter and invitee are paired, or the inviter is out. */
  | { kind: "settled"; reason: "paired" | "inviter_out" | "inviter_paired_elsewhere" };

export type PendingInvite = {
  inviteId: string;
  eventId: string;
  eventName: string;
  inviterPlayerId: string;
  inviterRegId: string | null;
  inviterName: string;
  inviteePlayerId: string;
  inviteeName: string;
  inviteeEmail: string | null;
  createdAt: string;
  /** Most recent time the invite email went out (initial send or Resend).
   * Falls back to createdAt for invites that predate the column. */
  lastSentAt: string;
  /** The inviter's own registration status for this event, e.g. 'paid',
   * 'pending_payment', 'waitlisted', or null if they have no reg row. */
  inviterStatus: string | null;
  inviterPaid: boolean;
  resolution: InviteResolution;
};

const OUT_STATUSES = new Set(["withdrawn", "cancelled", "refunded"]);

type RegRow = {
  id: string;
  event_id: string;
  player_id: string;
  status: string;
  partner_status: string;
  partner_registration_id: string | null;
  players: { first_name: string | null; last_name: string | null; email: string | null } | null;
};

const normName = (first: string | null | undefined, last: string | null | undefined) =>
  `${first ?? ""} ${last ?? ""}`.trim().toLowerCase().replace(/\s+/g, " ");
const normEmail = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();

// Fetch pending (un-accepted) partner invites across a tournament's events,
// with inviter/invitee names, the invitee's email, the inviter's payment
// status, and what has actually happened since. Oldest first.
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
    .select("id, event_id, inviter_player_id, invitee_player_id, invitee_email, created_at, last_sent_at")
    .in("event_id", eventIds)
    .eq("status", "pending");
  if (iErr) throw new Error(iErr.message);
  const rows = invites ?? [];
  if (rows.length === 0) return [];

  // Names + emails for both parties.
  const playerIds = new Set<string>();
  for (const r of rows) {
    playerIds.add(r.inviter_player_id);
    playerIds.add(r.invitee_player_id);
  }
  const { data: players, error: pErr } = await supabase
    .from("players")
    .select("id, first_name, last_name, email")
    .in("id", [...playerIds]);
  if (pErr) throw new Error(pErr.message);
  const playerById = new Map((players ?? []).map((p) => [p.id, p]));
  const nameOf = (id: string) => {
    const p = playerById.get(id);
    return p ? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() : "";
  };

  // Every live registration in the affected events, with player contact, so
  // we can spot an invitee who registered under another player record.
  const affectedEventIds = [...new Set(rows.map((r) => r.event_id))];
  const { data: regData, error: rErr } = await supabase
    .from("event_registrations")
    .select("id, event_id, player_id, status, partner_status, partner_registration_id, players(first_name, last_name, email)")
    .in("event_id", affectedEventIds)
    .is("deleted_at", null);
  if (rErr) throw new Error(rErr.message);
  const regs = (regData ?? []) as unknown as RegRow[];
  const regsByEvent = new Map<string, RegRow[]>();
  for (const r of regs) {
    const list = regsByEvent.get(r.event_id) ?? [];
    list.push(r);
    regsByEvent.set(r.event_id, list);
  }
  const isLive = (r: RegRow) => !OUT_STATUSES.has(r.status);

  const out: PendingInvite[] = rows.map((r) => {
    const evRegs = regsByEvent.get(r.event_id) ?? [];
    const inviterReg = evRegs.find((x) => x.player_id === r.inviter_player_id) ?? null;
    const status = inviterReg?.status ?? null;
    const invitee = playerById.get(r.invitee_player_id);

    // Who, among this event's live registrants, is the invitee? Exact player
    // first, then the invite's email / the invitee record's email, then name.
    const wantEmails = new Set([normEmail(r.invitee_email), normEmail(invitee?.email)].filter(Boolean));
    const wantName = normName(invitee?.first_name, invitee?.last_name);
    let match: { reg: RegRow; by: "player" | "email" | "name" } | null = null;
    for (const cand of evRegs) {
      if (!isLive(cand) || cand.player_id === r.inviter_player_id) continue;
      if (cand.player_id === r.invitee_player_id) {
        match = { reg: cand, by: "player" };
        break;
      }
    }
    if (!match) {
      for (const cand of evRegs) {
        if (!isLive(cand) || cand.player_id === r.inviter_player_id) continue;
        const e = normEmail(cand.players?.email);
        if (e && wantEmails.has(e)) {
          match = { reg: cand, by: "email" };
          break;
        }
      }
    }
    if (!match && wantName) {
      for (const cand of evRegs) {
        if (!isLive(cand) || cand.player_id === r.inviter_player_id) continue;
        if (normName(cand.players?.first_name, cand.players?.last_name) === wantName) {
          match = { reg: cand, by: "name" };
          break;
        }
      }
    }

    let resolution: InviteResolution;
    if (!inviterReg || !isLive(inviterReg)) {
      resolution = { kind: "settled", reason: "inviter_out" };
    } else if (match && inviterReg.partner_registration_id === match.reg.id && inviterReg.partner_status === "confirmed") {
      resolution = { kind: "settled", reason: "paired" };
    } else if (inviterReg.partner_status === "confirmed" && inviterReg.partner_registration_id) {
      resolution = { kind: "settled", reason: "inviter_paired_elsewhere" };
    } else if (match) {
      const mp = match.reg.players;
      resolution = {
        kind: "registered",
        regId: match.reg.id,
        playerId: match.reg.player_id,
        name: `${mp?.first_name ?? ""} ${mp?.last_name ?? ""}`.trim() || "Unnamed player",
        email: mp?.email ?? null,
        matchedBy: match.by,
        alreadyPaired: match.reg.partner_status === "confirmed" && !!match.reg.partner_registration_id,
      };
    } else {
      resolution = { kind: "open" };
    }

    return {
      inviteId: r.id,
      eventId: r.event_id,
      eventName: eventName.get(r.event_id) ?? "—",
      inviterPlayerId: r.inviter_player_id,
      inviterRegId: inviterReg?.id ?? null,
      inviterName: nameOf(r.inviter_player_id) || "Unknown",
      inviteePlayerId: r.invitee_player_id,
      inviteeName: nameOf(r.invitee_player_id) || "Unknown",
      inviteeEmail: r.invitee_email,
      createdAt: r.created_at,
      lastSentAt:
        (r as unknown as { last_sent_at?: string | null }).last_sent_at ?? r.created_at,
      inviterStatus: status,
      inviterPaid: status === "paid",
      resolution,
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

// Remove invites outright. Invites are ephemeral (hard-deleted); the delete
// policy allows sender, recipient, or org members. Throws on failure.
export async function deletePartnerInvites(inviteIds: string[]): Promise<void> {
  if (inviteIds.length === 0) return;
  const { error } = await supabase.from("partner_invites").delete().in("id", inviteIds);
  if (error) throw new Error(error.message);
}

// Pair the inviter with the registrant we matched (possibly a duplicate player
// record), then clear every pending invite between the two — the invite that
// pointed at the OLD player record included. Both registrations must be
// unpaired; the caller checks `alreadyPaired` first.
export async function pairInviteWithRegistration(inv: PendingInvite): Promise<void> {
  if (inv.resolution.kind !== "registered") throw new Error("Nothing to pair.");
  if (!inv.inviterRegId) throw new Error("The inviter has no registration in this event.");
  await pairAndResolveInvites(
    inv.inviterRegId,
    inv.resolution.regId,
    inv.eventId,
    inv.inviterPlayerId,
    inv.resolution.playerId,
  );
  // The invite may reference the duplicate (old) player id rather than the
  // matched registrant, so pairAndResolveInvites' cleanup can miss it.
  await deletePartnerInvites([inv.inviteId]);
}
