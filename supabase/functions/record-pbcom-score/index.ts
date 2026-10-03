// supabase/functions/record-pbcom-score/index.ts
//
// REVERSE sync (PB.com → B&E), the WRITE side. The pbcom-driver's reverse poller
// reads completed scores from PickleballBrackets.com's PUBLIC results API, matches
// each onto a B&E match by player last-name sets, and POSTs the resolved score here.
// This function is the single, server-side home for the write so B&E's own
// downstream logic stays correct and in ONE place:
//   1. write the match score + winner + status='completed' (idempotently)
//   2. autoTransitionEventStatus — the SAME rules as web/src/lib/eventStatus.ts,
//      ported here (edge fns are Deno; they can't import the web client).
//
// SCOPE (v1): round-robin pool scores. Playoff feed-forward (advancing the winner /
// dropping a semifinal loser to bronze — web/src/lib/playoffFeedForward.ts) and
// seeding B&E's playoff bracket from standings are a documented follow-up; this
// function writes a playoff score if sent, but does NOT yet feed it forward.
//
// AUTH: service-to-service. The caller must present the project SERVICE-ROLE key as
// the Bearer token (the driver already holds it; no new secret to provision). The
// gateway's JWT check plus this equality check keep anon callers out of a
// privileged writer.
//
// Body: { tournamentId, eventId, matchId, teamAScore, teamBScore, winnerRegId,
//         source?: { system: "pbcom", matchUuid: string } }
// Returns: { ok, updated, status }  (updated=false when already in sync)
//
// Required secrets (auto-injected): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface Body {
  tournamentId?: string;
  eventId?: string;
  matchId?: string;
  teamAScore?: number;
  teamBScore?: number;
  winnerRegId?: string;
  source?: { system?: string; matchUuid?: string } | null;
}

type EventStatus =
  | "draft"
  | "ready"
  | "active"
  | "medal_round"
  | "complete"
  | "on_hold"
  | "verified";

/**
 * Ported verbatim from web/src/lib/eventStatus.ts. Fires the automatic status
 * transitions after a match write; manual transitions (Start/Pause/Verify) are the
 * organizer's and are never touched here. Returns the resulting status.
 */
// deno-lint-ignore no-explicit-any
async function autoTransitionEventStatus(admin: any, eventId: string): Promise<EventStatus | null> {
  const { data: ev } = await admin
    .from("events")
    .select("status, teams_advancing_to_playoff")
    .eq("id", eventId)
    .maybeSingle();
  if (!ev) return null;

  const { data: matches } = await admin
    .from("matches")
    .select("status, stage")
    .eq("event_id", eventId);
  if (!matches) return ev.status as EventStatus;

  const total = matches.length;
  // deno-lint-ignore no-explicit-any
  const completed = matches.filter((m: any) => m.status === "completed").length;
  // deno-lint-ignore no-explicit-any
  const rr = matches.filter((m: any) => m.stage === "round_robin");
  // deno-lint-ignore no-explicit-any
  const playoff = matches.filter((m: any) => m.stage === "playoff");
  // deno-lint-ignore no-explicit-any
  const rrComplete = rr.length > 0 && rr.every((m: any) => m.status === "completed");
  const allComplete = total > 0 && completed === total;

  const playoffConfigured = (ev.teams_advancing_to_playoff ?? 0) > 0;
  const playoffPending = playoffConfigured && playoff.length === 0;

  let next: EventStatus | null = null;
  const status = ev.status as EventStatus;
  if (status === "draft" && total > 0) {
    next = "ready";
  } else if (status === "active" && rrComplete && playoff.length > 0 && !allComplete) {
    next = "medal_round";
  } else if ((status === "active" || status === "medal_round") && allComplete && !playoffPending) {
    next = "complete";
  }

  if (next && next !== status) {
    await admin.from("events").update({ status: next }).eq("id", eventId);
    return next;
  }
  return status;
}

// @ts-expect-error Deno global
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // @ts-expect-error Deno global
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  // @ts-expect-error Deno global
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Auth: the Bearer token must be the service-role key (service-to-service).
  const bearer = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!bearer || bearer !== SERVICE_ROLE) return json({ error: "unauthorized" }, 401);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const { tournamentId, eventId, matchId, teamAScore, teamBScore, winnerRegId } = body;
  if (!tournamentId) return json({ error: "tournamentId is required" }, 400);
  if (!eventId) return json({ error: "eventId is required" }, 400);
  if (!matchId) return json({ error: "matchId is required" }, 400);
  if (!Number.isInteger(teamAScore) || !Number.isInteger(teamBScore)) {
    return json({ error: "teamAScore / teamBScore must be integers" }, 400);
  }
  if (!winnerRegId) return json({ error: "winnerRegId is required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // Load + validate the match belongs to this event and tournament.
  const { data: match, error: mErr } = await admin
    .from("matches")
    .select("id, event_id, stage, team_a_reg_id, team_b_reg_id, status, team_a_score, team_b_score, winner_reg_id")
    .eq("id", matchId)
    .maybeSingle();
  if (mErr) return json({ error: mErr.message }, 500);
  if (!match) return json({ error: "match_not_found" }, 404);
  if (match.event_id !== eventId) return json({ error: "match_not_in_event" }, 409);

  const { data: ev, error: eErr } = await admin
    .from("events")
    .select("id, tournament_id")
    .eq("id", eventId)
    .maybeSingle();
  if (eErr) return json({ error: eErr.message }, 500);
  if (!ev || ev.tournament_id !== tournamentId) return json({ error: "event_not_in_tournament" }, 409);

  if (winnerRegId !== match.team_a_reg_id && winnerRegId !== match.team_b_reg_id) {
    return json({ error: "winner_not_on_match" }, 409);
  }

  // Idempotent: already in sync → no write.
  if (
    match.status === "completed" &&
    match.team_a_score === teamAScore &&
    match.team_b_score === teamBScore &&
    match.winner_reg_id === winnerRegId
  ) {
    return json({ ok: true, updated: false, status: "completed" });
  }

  const { error: uErr } = await admin
    .from("matches")
    .update({
      team_a_score: teamAScore,
      team_b_score: teamBScore,
      winner_reg_id: winnerRegId,
      status: "completed",
    })
    .eq("id", matchId);
  if (uErr) return json({ error: uErr.message }, 500);

  // NOTE (v1): playoff feed-forward is intentionally NOT applied here. The driver
  // sends round-robin pool scores only; a playoff write would record the score but
  // not advance the bracket. See DESIGN.md §reverse for the v2 plan.
  const newStatus = await autoTransitionEventStatus(admin, eventId);

  return json({ ok: true, updated: true, status: newStatus ?? "completed" });
});
