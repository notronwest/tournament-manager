import { supabase } from "../supabase";
import type { Database } from "../types/supabase";

type EventStatus = Database["public"]["Enums"]["event_status"];

// Status transitions that fire automatically after a match-related
// write. Manual transitions (Start, Pause, Resume, Verify) are owned
// by the tournament-homepage controls.
//
//   draft  → ready          when RR matches are first generated
//   active → medal_round    when RR play is complete and playoff
//                           matches exist (but not all played yet)
//   active|medal_round
//          → complete       when every match in the event is completed
//
// Other statuses (on_hold, verified) are not auto-set — the organizer
// owns those.
export async function autoTransitionEventStatus(eventId: string) {
  const { data: ev } = await supabase
    .from("events")
    .select("status")
    .eq("id", eventId)
    .maybeSingle();
  if (!ev) return;

  const { data: matches } = await supabase
    .from("matches")
    .select("status, stage")
    .eq("event_id", eventId);
  if (!matches) return;

  const total = matches.length;
  const completed = matches.filter((m) => m.status === "completed").length;
  const rr = matches.filter((m) => m.stage === "round_robin");
  const playoff = matches.filter((m) => m.stage === "playoff");
  const rrComplete = rr.length > 0 && rr.every((m) => m.status === "completed");
  const allComplete = total > 0 && completed === total;

  let next: EventStatus | null = null;
  const status = ev.status as EventStatus;

  if (status === "draft" && rr.length > 0) {
    next = "ready";
  } else if (
    status === "active" &&
    rrComplete &&
    playoff.length > 0 &&
    !allComplete
  ) {
    next = "medal_round";
  } else if (
    (status === "active" || status === "medal_round") &&
    allComplete
  ) {
    next = "complete";
  }

  if (next && next !== status) {
    await supabase.from("events").update({ status: next }).eq("id", eventId);
  }
}
