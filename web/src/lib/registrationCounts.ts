import { supabase } from "../supabase";

// Public per-tournament "registered players" counts.
//
// Backed by the SECURITY DEFINER RPC `tournament_registration_counts`
// (migration 20260715000000): the browse + public tournament pages are
// anonymous, and RLS on `registrations` hides rows from anon, so a direct
// count returns 0. The RPC returns an aggregate count only (no PII).
//
// The RPC name isn't in the generated `Database` types until it reaches the
// linked (prod) project and types are regenerated, so the call is cast here
// — the single place that knows about this until the next `gen types`. On
// ANY failure (RPC missing, network) this resolves to an empty map, so the
// UI just omits the stat rather than erroring.

export type TournamentRegCount = {
  tournament_id: string;
  registered_count: number;
};

type RegCountRpc = (
  fn: "tournament_registration_counts",
  args: { p_tournament_ids: string[] },
) => Promise<{ data: TournamentRegCount[] | null; error: unknown }>;

export async function fetchTournamentRegCounts(
  tournamentIds: string[],
): Promise<Map<string, number>> {
  if (tournamentIds.length === 0) return new Map();
  try {
    const rpc = supabase.rpc as unknown as RegCountRpc;
    const { data, error } = await rpc("tournament_registration_counts", {
      p_tournament_ids: tournamentIds,
    });
    if (error || !data) return new Map();
    return new Map(data.map((r) => [r.tournament_id, r.registered_count]));
  } catch {
    return new Map();
  }
}
