import { describe, expect, it } from "vitest";
// Vite's ?raw (same pattern as pbImport.test.ts's CSV fixture) — avoids
// pulling node:fs into src/'s browser-only tsconfig (no "node" types there).
import migrationSql from "../../../supabase/migrations/20261008140000_public_tournament_recap_rpc.sql?raw";

// There's no DB to run the RPC against in this sandbox, so this asserts the
// money/refund/withdrawal/payout/contact-free guarantee the same way a
// migration's own RLS self-check does (20261008130000_campaign_events.sql) —
// a static assertion on the migration's SQL text itself, since that text IS
// the full definition of what the RPC returns.

describe("public_tournament_recap RPC payload", () => {
  const raw = migrationSql.toLowerCase();

  // The function body itself — what the RPC actually executes and returns.
  // (The migration's surrounding prose and its `comment on function` both
  // describe, in English, what the payload deliberately excludes, using the
  // same words this test forbids — so only the body between `as $$ ... $$;`
  // is in scope for this check.)
  const bodyMatch = raw.match(/as \$\$([\s\S]*?)\$\$;/);
  if (!bodyMatch) throw new Error("couldn't locate the function body in the migration");
  const body = bodyMatch[1];

  it("is gated to completed tournaments only", () => {
    expect(body).toContain("tr.status = 'completed'");
  });

  it("never selects a fee, refund, withdrawal, payout, or contact field", () => {
    const forbidden = ["fee_cents", "refund", "withdraw", "payout", "email", "phone", "stripe"];
    for (const term of forbidden) {
      expect(body).not.toContain(term);
    }
  });

  it("is security definer with a pinned search_path", () => {
    expect(raw).toContain("security definer");
    expect(raw).toContain("set search_path = public");
  });
});
