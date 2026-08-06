import { supabase } from "../supabase";

// Client for the platform-admin "merge duplicate players" flow. The server
// (the `admin-merge-players` edge function) does all the work and enforces
// platform-admin authz; the UI just previews the impact and commits the merge.
//
// The WINNER is the record we keep; the LOSER is the duplicate that gets its
// rows re-pointed at the winner and is then soft-deleted.

// Profile fields the admin can pick between the two records. Keep in sync with
// the edge function's PICK_FIELDS and the field-picker UI.
export const PICK_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "gender",
  "dob",
  "city",
  "state",
  "self_rating_doubles",
  "self_rating_mixed",
  "self_rating_singles",
] as const;
export type PickField = (typeof PICK_FIELDS)[number];

// One party in the merge — full profile so the UI can compare field-by-field.
export type MergeParty = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  gender: string | null;
  dob: string | null;
  city: string | null;
  state: string | null;
  self_rating_doubles: number | null;
  self_rating_mixed: number | null;
  self_rating_singles: number | null;
  has_account: boolean;
  deleted: boolean;
};

// One registration row shown per party (informational — regs are consolidated
// onto the winner automatically; this just shows each side's history).
export type MergeRegistration = {
  event_name: string;
  format: string | null;
  tournament: string;
  status: string;
  ends_at: string | null;
  is_current: boolean;
};

// Counts of rows that will be re-pointed from loser → winner, by table.
export type MergeMoves = {
  player_ratings: number;
  registrations: number;
  event_registrations: number;
  partner_invites: number;
  payments: number;
  manual_payments: number;
  tournament_change_requests: number;
  organization_contacts: number;
  contact_broadcast_recipients: number;
};

export type MergeConflicts = {
  // Both records have a login account — the loser's login will be detached.
  both_have_accounts: boolean;
  // Events both are registered in — the loser's registration is dropped.
  same_event_registrations: {
    event_id: string;
    event_name: string;
    tournament: string;
  }[];
  // Tournaments both have a tournament-level registration in.
  same_tournament_registrations: { tournament: string }[];
  // Orgs where both appear as a contact.
  same_org_contacts: { organization: string }[];
  // Partner invites that exist directly between the two of them.
  invites_between_them: number;
  // Events where they are each other's doubles partner — the pairing breaks.
  partners_with_each_other: { event_id: string; event_name: string }[];
};

export type MergePreview = {
  winner: MergeParty;
  loser: MergeParty;
  moves: MergeMoves;
  conflicts: MergeConflicts;
  winner_registrations: MergeRegistration[];
  loser_registrations: MergeRegistration[];
};

// The admin's field picks: a subset of PICK_FIELDS → the value to force onto the
// kept record (only fields where the pick differs from the winner's own value).
export type MergeOverrides = Partial<Record<PickField, string | number | null>>;

export type MergeResult = {
  ok: true;
  summary: {
    winner_id: string;
    loser_id: string;
    dropped_duplicate_event_registrations: number;
  };
};

// Pull a server-sent { error } message out of a functions.invoke failure. The
// edge function's JSON error body rides on err.context as a Response (same
// idiom as adminRegister.ts / contactsUi.readFnError).
async function mergeFnError(err: unknown): Promise<string> {
  const ctx = (err as { context?: Response })?.context;
  if (ctx && typeof ctx.text === "function") {
    try {
      const raw = await ctx.text();
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { error?: string };
          if (parsed?.error) return parsed.error;
        } catch {
          // Not JSON — surface the raw body.
        }
        return raw;
      }
    } catch {
      // fall through to the transport message
    }
  }
  return (err as { message?: string })?.message ?? "Merge request failed.";
}

// Dry-run: show what merging `loserId` into `winnerId` would move + which
// conflicts exist. Throws with the server's message on failure.
export async function previewMerge(
  winnerId: string,
  loserId: string,
): Promise<MergePreview> {
  const { data, error } = await supabase.functions.invoke("admin-merge-players", {
    body: { action: "preview", winnerId, loserId },
  });
  if (error) throw new Error(await mergeFnError(error));
  const res = data as MergePreview & { error?: string };
  if ((res as { error?: string })?.error) {
    throw new Error((res as { error?: string }).error);
  }
  return res;
}

// Commit the merge: re-point the loser's rows onto the winner, drop duplicate
// event registrations, apply the admin's field picks to the winner, and
// soft-delete the loser. Throws on failure.
export async function commitMerge(
  winnerId: string,
  loserId: string,
  overrides?: MergeOverrides,
): Promise<MergeResult> {
  const { data, error } = await supabase.functions.invoke("admin-merge-players", {
    body: { action: "commit", winnerId, loserId, overrides: overrides ?? {} },
  });
  if (error) throw new Error(await mergeFnError(error));
  const res = data as MergeResult & { error?: string; ok?: boolean };
  if (!res?.ok) {
    throw new Error(res?.error ?? "Merge failed.");
  }
  return res as MergeResult;
}
