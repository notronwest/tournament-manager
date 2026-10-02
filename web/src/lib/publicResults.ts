import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../supabase";
import type { EventRegistration, Match, Player } from "./bracketTeams";

// The public_tournament_results RPC (migration 20261001130000): a curated,
// money-free snapshot of a published tournament's events, spot-holding
// registrations (with pool_index / seed), player names and matches. Shared by
// the live results page and the public page's Brackets tab so both compute
// standings and medals from the same payload the console uses.

export type PublicEvent = {
  id: string;
  name: string;
  format: string;
  gender: string;
  bracket_type: string | null;
  pool_count: number;
  teams_advancing_to_playoff: number;
  playoff_rounds: number;
  double_elim_final: "crossover" | "bronze_only" | null;
  status: string;
  scheduled_start_at: string | null;
  schedule_order: number | null;
};

// Double-elim columns landed after the generated types; the RPC returns them.
export type PublicMatch = Match & {
  bracket?: "winners" | "consolation" | "final" | null;
  label?: string | null;
  if_necessary?: boolean | null;
};

export type PublicResultsPayload = {
  tournament: { name: string; slug: string; starts_at: string; ends_at: string; status: string };
  events: PublicEvent[];
  registrations: EventRegistration[];
  players: Player[];
  matches: PublicMatch[];
};

// Hand-written RPC, not in the generated types — call through an untyped
// client like the other bespoke RPCs in this app.
const untyped = supabase as unknown as SupabaseClient;

export async function fetchPublicResults(
  orgSlug: string,
  tournamentSlug: string,
): Promise<{ data: PublicResultsPayload | null; error: string | null }> {
  const { data, error } = await untyped.rpc("public_tournament_results", {
    p_org_slug: orgSlug,
    p_tournament_slug: tournamentSlug,
  });
  if (error) return { data: null, error: error.message };
  return { data: (data as PublicResultsPayload | null) ?? null, error: null };
}
