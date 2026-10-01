import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../supabase";
import { divisionKey, type PbAttendee } from "./pbImport";
import type { ExistingEntry } from "./pbReconcile";

// Client-side orchestration for the PB.com registration import (#981):
//   • read the tournament's existing pbcom-sourced state so the preview can show
//     the idempotent diff (adds / unchanged / drops) BEFORE anything is written;
//   • post the parsed attendees to the import-pb-registrations edge function,
//     which is the authoritative writer.
//
// The pbcom source columns aren't in the generated Database types yet, so these
// reads go through an untyped client (same approach as lib/adminRegister /
// lib/orgContacts).
const untyped = supabase as unknown as SupabaseClient;

export type ExistingPbState = {
  divisionKeys: string[];
  entries: ExistingEntry[];
};

// Read the divisions already created for this tournament (by source label) and
// the pbcom entries already imported, mapped into the shape buildPlan wants.
export async function fetchExistingPbState(
  tournamentId: string,
): Promise<ExistingPbState> {
  const { data: events, error: evErr } = await untyped
    .from("events")
    .select("id, name, source_system, source_division_label")
    .eq("tournament_id", tournamentId)
    .is("deleted_at", null);
  if (evErr) throw new Error(evErr.message);

  const eventRows = (events ?? []) as {
    id: string;
    name: string;
    source_system: string | null;
    source_division_label: string | null;
  }[];
  // A division "exists" for reconcile purposes if a B&E event already carries its
  // source label, OR a same-named B&E event exists (the import adopts it).
  const divisionKeys = new Set<string>();
  const eventIdToDivKey = new Map<string, string>();
  for (const e of eventRows) {
    const key = e.source_division_label ? divisionKey(e.source_division_label) : divisionKey(e.name);
    divisionKeys.add(key);
    eventIdToDivKey.set(e.id, key);
  }

  const eventIds = eventRows.map((e) => e.id);
  let entries: ExistingEntry[] = [];
  if (eventIds.length > 0) {
    const { data: regs, error: regErr } = await untyped
      .from("event_registrations")
      .select("event_id, player_id, source_system, source_activity_id")
      .in("event_id", eventIds)
      .is("deleted_at", null);
    if (regErr) throw new Error(regErr.message);
    entries = ((regs ?? []) as {
      event_id: string;
      player_id: string;
      source_system: string | null;
      source_activity_id: string | null;
    }[])
      // Only pbcom-sourced entries participate in the import reconcile (a
      // native B&E registration is never treated as a "drop").
      .filter((r) => r.source_system === "pbcom")
      .map((r) => ({
        activityId: r.source_activity_id,
        divisionKey: eventIdToDivKey.get(r.event_id) ?? "",
        playerKey: `player:${r.player_id}`, // opaque; the drop diff is by ActivityID
      }));
  }

  return { divisionKeys: [...divisionKeys], entries };
}

export type PbImportSummary = {
  divisions: { created: number; matched: number; total: number };
  players: { created: number; matched: number; duprRefreshed: number };
  entries: { added: number; unchanged: number };
  partnersPaired: number;
  drops: { regId: string; eventId: string; playerId: string; activityId: string | null }[];
  attendees: number;
  warnings?: string[];
  errors?: string[];
};

// Post the parsed attendees to the edge function (the authoritative writer).
export async function runPbImport(payload: {
  organizationId: string;
  tournamentId: string;
  attendees: PbAttendee[];
}): Promise<PbImportSummary> {
  const { data, error } = await supabase.functions.invoke("import-pb-registrations", {
    body: payload,
  });
  if (error) throw new Error(await fnErrorMessage(error));
  return data as PbImportSummary;
}

async function fnErrorMessage(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response }).context;
  if (ctx && typeof ctx.text === "function") {
    try {
      const body = await ctx.text();
      if (body) return body;
    } catch {
      /* fall through */
    }
  }
  return (error as { message?: string }).message ?? "Import failed.";
}
