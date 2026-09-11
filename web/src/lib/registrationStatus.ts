// Single source of truth for what an event_registrations.status MEANS in the
// UI. Before this file every view re-derived it (My Tournaments, the admin
// Teams tab, the public roster, the player detail page) and three of the four
// disagreed — a waitlisted player read as a green "Paid" on one screen and
// "Waitlist — pay to claim" on another (PROD, 2026-09-10).
//
// The status model (see supabase/migrations/2026062206* waitlists):
//   pending_payment            registered, spot reserved, not yet paid
//   paid                       registered + paid
//   waitlisted                 FREE waitlist entry — holds NO spot
//   waitlisted_pending_payment promoted off the waitlist — spot reserved,
//                              pay to claim (same standing as pending_payment)
//   cancelled / withdrawn / refunded   out of the event
//
// Server mirrors: is_event_full + event_roster count SPOT_HOLDING_STATUSES;
// compute_checkout_total + create-payment-intent + stripe-webhook use
// PAYABLE_STATUSES. Keep them in step.

import type { Database } from "../types/supabase";

export type RegistrationStatus =
  Database["public"]["Enums"]["registration_status"];
export type PartnerStatus = Database["public"]["Enums"]["partner_status"];

// Holds a spot in the event (counts toward capacity, appears on the roster,
// becomes a bracket team).
export const SPOT_HOLDING_STATUSES: RegistrationStatus[] = [
  "pending_payment",
  "paid",
  "waitlisted_pending_payment",
];

// Owes money — what checkout, the pending-payments bar and the Stripe edge
// functions operate on.
export const PAYABLE_STATUSES: RegistrationStatus[] = [
  "pending_payment",
  "waitlisted_pending_payment",
];

// Out of the event. Mirrors INACTIVE_STATUSES in lib/registrations.
export const INACTIVE_STATUSES: RegistrationStatus[] = [
  "cancelled",
  "withdrawn",
  "refunded",
];

export const isPayable = (s: RegistrationStatus): boolean =>
  PAYABLE_STATUSES.includes(s);

export const holdsSpot = (s: RegistrationStatus): boolean =>
  SPOT_HOLDING_STATUSES.includes(s);

export type StatusTone = "success" | "warn" | "info" | "muted";

// Player-facing label. `partnerStatus` only refines the PAID case (a paid
// player still looking for a partner); every unpaid / inactive state is
// labelled by status alone so the money truth is never hidden.
export function regStatusLabel(
  status: RegistrationStatus,
  partnerStatus?: PartnerStatus | null,
): string {
  switch (status) {
    case "cancelled":
      return "Cancelled";
    case "withdrawn":
      return "Withdrawn";
    case "refunded":
      return "Refunded";
    case "pending_payment":
      return "Pending payment";
    case "waitlisted":
      return "Waitlisted";
    case "waitlisted_pending_payment":
      return "Spot opened — pay to claim";
    case "paid":
      if (partnerStatus === "seeking") return "Paid · Seeking partner";
      if (partnerStatus === "pending") return "Paid · Awaiting partner";
      return "Paid";
  }
}

export function regStatusTone(
  status: RegistrationStatus,
  partnerStatus?: PartnerStatus | null,
): StatusTone {
  switch (status) {
    case "cancelled":
    case "withdrawn":
    case "refunded":
      return "muted";
    case "pending_payment":
    case "waitlisted":
    case "waitlisted_pending_payment":
      return "warn";
    case "paid":
      return partnerStatus === "seeking" || partnerStatus === "pending"
        ? "info"
        : "success";
  }
}

// How many TEAMS a set of registrations amounts to — the way the roster and
// is_event_full count: only spot-holding rows; in doubles a confirmed pair is
// one team and every other spot-holder (seeking / invited / an odd confirmed
// half) is a team still forming. Singles: one team per player.
export function teamCountFor(
  format: string,
  regs: { status: RegistrationStatus; partner_status: PartnerStatus }[],
): number {
  const holding = regs.filter((r) => holdsSpot(r.status));
  if (format !== "doubles") return holding.length;
  const confirmed = holding.filter((r) => r.partner_status === "confirmed").length;
  return Math.floor(confirmed / 2) + (confirmed % 2) + (holding.length - confirmed);
}
