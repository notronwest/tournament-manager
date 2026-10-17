import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "../supabase";

// Which players belong to an organization's home club (table
// player_club_affiliations, migration 20261006120000). Drives the ⭐ on
// home-club teams in the tournament summary.
//
// The table is newer than the generated types, so it's read through a
// narrow untyped view of the client. Drop this cast once
// `supabase gen types` has been re-run.
type AffiliationQuery = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        in(
          column: string,
          values: readonly string[],
        ): PromiseLike<{ data: { player_id: string }[] | null; error: PostgrestError | null }>;
      };
    };
  };
};

// Player ids are sent in chunks so a big tournament stays under URL limits.
const CHUNK = 200;

export async function fetchHomeClubPlayerIds(
  organizationId: string,
  playerIds: readonly string[],
): Promise<{ ids: Set<string>; error: PostgrestError | null }> {
  const ids = new Set<string>();
  const client = supabase as unknown as AffiliationQuery;
  for (let i = 0; i < playerIds.length; i += CHUNK) {
    const { data, error } = await client
      .from("player_club_affiliations")
      .select("player_id")
      .eq("organization_id", organizationId)
      .in("player_id", playerIds.slice(i, i + CHUNK));
    if (error) return { ids: new Set(), error };
    for (const r of data ?? []) ids.add(r.player_id);
  }
  return { ids, error: null };
}
