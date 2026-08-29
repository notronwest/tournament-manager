import type { Database } from "../types/supabase";
import type { PendingInvite } from "./partnerInvites";

// Shapes the attendee list into the three questions an organizer actually asks
// at the desk — who's coming, who still needs a partner, and who's waiting to
// hear back — and turns that into a printable model plus a spreadsheet.
//
// Kept free of React so the grouping rules are testable and the modal stays
// presentational.

type PartnerStatus = Database["public"]["Enums"]["partner_status"];
type RegistrationStatus = Database["public"]["Enums"]["registration_status"];
type EventFormat = Database["public"]["Enums"]["event_format"];
type EventGender = Database["public"]["Enums"]["event_gender"];

// Structural inputs — the DB rows AttendeesPage already holds satisfy these,
// so nothing extra is fetched for the roster itself.
export type RosterPlayer = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
};

export type RosterReg = {
  id: string;
  partner_registration_id: string | null;
  partner_status: PartnerStatus;
  status: RegistrationStatus;
  player: RosterPlayer;
};

export type RosterEventGroup = {
  event: { id: string; name: string; format: EventFormat; gender: EventGender };
  regs: RosterReg[];
};

// A registration in one of these states is off the roster: the player is out.
// Mirrors INACTIVE_STATUSES in lib/registrations.
const INACTIVE: RegistrationStatus[] = ["cancelled", "refunded", "withdrawn"];

// Plain-language payment wording — no enum names on a sheet handed to someone
// at a check-in table.
const PAYMENT_LABEL: Record<RegistrationStatus, string> = {
  paid: "Paid",
  pending_payment: "Not paid yet",
  waitlisted: "Waitlist",
  waitlisted_pending_payment: "Waitlist — not paid",
  cancelled: "Cancelled",
  refunded: "Refunded",
  withdrawn: "Withdrew",
};

export type RosterEventEntry = {
  eventId: string;
  eventName: string;
  partnerStatus: PartnerStatus;
  paymentLabel: string;
  /** Confirmed team-mate, when there is one. */
  partnerName: string | null;
  /** Who they invited and are still waiting on (partnerStatus 'pending'). */
  invitedName: string | null;
};

export type RosterEntry = {
  playerId: string;
  firstName: string;
  lastName: string;
  /** "First Last", already trimmed. */
  fullName: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  events: RosterEventEntry[];
};

export type Roster = {
  tournamentName: string;
  /** Everyone with at least one live registration, by last name. */
  everyone: RosterEntry[];
  /** Signed up for a doubles event with nobody lined up at all. */
  needsPartner: RosterEntry[];
  /** Asked a specific person to partner and hasn't heard back. */
  awaitingReply: RosterEntry[];
};

export function fullName(p: { first_name: string; last_name: string }): string {
  return `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim();
}

export function buildRoster(
  tournamentName: string,
  groups: RosterEventGroup[],
  invites: PendingInvite[],
): Roster {
  // Who each person invited, keyed by event + inviter name. partner_invites
  // has no registration id, so the inviter's name within an event is the join.
  const invitedBy = new Map<string, string>();
  for (const i of invites) {
    invitedBy.set(`${i.eventId}::${i.inviterName.toLowerCase()}`, i.inviteeName);
  }

  const byPlayer = new Map<string, RosterEntry>();

  for (const g of groups) {
    // Resolve confirmed team-mates within the event.
    const regById = new Map(g.regs.map((r) => [r.id, r]));

    for (const r of g.regs) {
      if (INACTIVE.includes(r.status)) continue;
      const p = r.player;

      const partnerReg = r.partner_registration_id
        ? (regById.get(r.partner_registration_id) ?? null)
        : null;

      const entry: RosterEventEntry = {
        eventId: g.event.id,
        eventName: g.event.name,
        partnerStatus: r.partner_status,
        paymentLabel: PAYMENT_LABEL[r.status] ?? r.status,
        partnerName: partnerReg ? fullName(partnerReg.player) : null,
        invitedName:
          r.partner_status === "pending"
            ? (invitedBy.get(`${g.event.id}::${fullName(p).toLowerCase()}`) ?? null)
            : null,
      };

      const existing = byPlayer.get(p.id);
      if (existing) {
        existing.events.push(entry);
      } else {
        byPlayer.set(p.id, {
          playerId: p.id,
          firstName: p.first_name ?? "",
          lastName: p.last_name ?? "",
          fullName: fullName(p),
          email: p.email,
          phone: p.phone,
          city: p.city,
          state: p.state,
          events: [entry],
        });
      }
    }
  }

  const byLastName = (a: RosterEntry, b: RosterEntry) =>
    `${a.lastName} ${a.firstName}`
      .toLowerCase()
      .localeCompare(`${b.lastName} ${b.firstName}`.toLowerCase());

  const everyone = [...byPlayer.values()].sort(byLastName);
  for (const e of everyone) {
    e.events.sort((a, b) => a.eventName.localeCompare(b.eventName));
  }

  return {
    tournamentName,
    everyone,
    needsPartner: everyone.filter((e) =>
      e.events.some((ev) => ev.partnerStatus === "seeking"),
    ),
    awaitingReply: everyone.filter((e) =>
      e.events.some((ev) => ev.partnerStatus === "pending"),
    ),
  };
}

// Events where this person is in the given partner state, for the focused
// sections ("needs a partner in: Mixed 3.5, Men's 4.0").
export function eventsWhere(
  entry: RosterEntry,
  status: PartnerStatus,
): RosterEventEntry[] {
  return entry.events.filter((e) => e.partnerStatus === status);
}

// ─────────────────────────────────────────────────────────────────────
// Spreadsheet
// ─────────────────────────────────────────────────────────────────────

// One row per person, not per registration: this is a contact list first. The
// first six headers match lib/parseContactsFile's labels, so the file drops
// straight back into Import contacts without remapping.
const CSV_HEADERS = [
  "First name",
  "Last name",
  "Email",
  "Phone",
  "City",
  "State",
  "Events",
  "Needs a partner in",
  "Waiting to hear back from",
  "Partners",
  "Payment",
];

export function rosterToCsv(roster: Roster): string {
  const lines = [CSV_HEADERS.map(csvCell).join(",")];

  for (const e of roster.everyone) {
    const seeking = eventsWhere(e, "seeking").map((ev) => ev.eventName);
    const waiting = eventsWhere(e, "pending").map((ev) =>
      ev.invitedName ? `${ev.invitedName} (${ev.eventName})` : ev.eventName,
    );
    const partners = e.events
      .filter((ev) => ev.partnerName)
      .map((ev) => `${ev.partnerName} (${ev.eventName})`);
    // Collapse to the distinct payment states across their events, so a person
    // who is paid for one event and not another still reads correctly.
    const payments = [...new Set(e.events.map((ev) => ev.paymentLabel))];

    lines.push(
      [
        e.firstName,
        e.lastName,
        e.email ?? "",
        e.phone ?? "",
        e.city ?? "",
        e.state ?? "",
        e.events.map((ev) => ev.eventName).join("; "),
        seeking.join("; "),
        waiting.join("; "),
        partners.join("; "),
        payments.join("; "),
      ]
        .map(csvCell)
        .join(","),
    );
  }

  return lines.join("\r\n");
}

// RFC 4180 quoting. Also guards against a leading =/+/-/@ being run as a
// formula when the file is opened in Excel or Sheets.
function csvCell(value: string): string {
  const s = String(value ?? "");
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

// Trigger a browser download of `content`. The BOM makes Excel read the file
// as UTF-8, so accented names don't arrive mangled.
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob(["﻿", content], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick — revoking synchronously can cancel the download
  // in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// "attendees-summer-slam-2026-08-27.csv"
export function rosterFilename(tournamentName: string, today: Date): string {
  const slug =
    tournamentName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "tournament";
  const date = today.toISOString().slice(0, 10);
  return `attendees-${slug}-${date}.csv`;
}
