/**
 * e2e/seed.ts — create a deterministic test fixture via the Supabase
 * service-role key (bypasses RLS). Idempotent: re-runs reuse existing rows.
 * Run before the Playwright suite.
 *
 *   E2E_SUPABASE_URL=… E2E_SUPABASE_SERVICE_ROLE_KEY=… E2E_TEST_PASSWORD=… npx tsx e2e/seed.ts
 *
 * Schema notes (from supabase/migrations/): `events` has NO unique
 * (tournament_id,name) constraint and `event_registrations` uniqueness is a
 * PARTIAL index (deleted_at is null) — neither is usable by upsert/onConflict,
 * so those use select-or-insert. `event_registrations.event_fee_cents` is NOT
 * NULL with no default.
 */
import { createClient } from "@supabase/supabase-js";

const url = required("E2E_SUPABASE_URL");
const key = required("E2E_SUPABASE_SERVICE_ROLE_KEY");
const password = process.env.E2E_TEST_PASSWORD || "e2e-password";
const db = createClient(url, key, { auth: { persistSession: false } });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`seed: missing env ${name}`);
  return v;
}

// Throw with the real Postgres message instead of a downstream null-deref.
function ok<T>(res: { data: T | null; error: { message: string } | null }, label: string): T {
  if (res.error) throw new Error(`seed: ${label} — ${res.error.message}`);
  if (res.data == null) throw new Error(`seed: ${label} — no data returned`);
  return res.data;
}

// For tables whose uniqueness isn't usable by onConflict (no constraint, or a
// partial index): find an active row by `match`, else insert. Returns its id.
async function selectOrInsert(
  table: string,
  match: Record<string, unknown>,
  insertRow: Record<string, unknown>,
  label: string,
): Promise<string> {
  const found = await db.from(table).select("id").match(match).is("deleted_at", null).limit(1);
  if (found.error) throw new Error(`seed: ${label} select — ${found.error.message}`);
  if (found.data && found.data.length) return (found.data[0] as { id: string }).id;
  const created = await db.from(table).insert(insertRow).select("id").single();
  return (ok(created, `${label} insert`) as { id: string }).id;
}

// Create-or-get an auth user + its players row. Returns the player id.
async function ensurePlayer(email: string, firstName: string, lastName: string): Promise<string> {
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
  let authUserId = created.data?.user?.id;
  if (!authUserId) {
    const list = await db.auth.admin.listUsers();
    authUserId = list.data.users.find((u) => u.email === email)?.id;
  }
  if (!authUserId) throw new Error(`seed: could not create or find auth user ${email}`);
  const player = await db
    .from("players")
    .upsert(
      // email is required for a "complete" profile — without it RequireProfile
      // bounces the user to /profile and gated pages (the tournament page that
      // the specs drive) never render.
      { auth_user_id: authUserId, first_name: firstName, last_name: lastName, email },
      { onConflict: "auth_user_id" },
    )
    .select("id")
    .single();
  return (ok(player, `players upsert ${email}`) as { id: string }).id;
}

async function main() {
  // 1. Org (organizations.slug is unique → upsert is fine)
  const org = ok(
    await db
      .from("organizations")
      .upsert({ slug: "e2e-test", name: "E2E Test Org" }, { onConflict: "slug" })
      .select("id")
      .single(),
    "organizations upsert",
  ) as { id: string };

  // 2. Published tournament (unique (organization_id, slug) → upsert is fine)
  const t = ok(
    await db
      .from("tournaments")
      .upsert(
        {
          organization_id: org.id,
          slug: "e2e-regression-cup",
          name: "E2E Regression Cup",
          status: "published",
          starts_at: "2099-01-01",
          ends_at: "2099-01-02",
        },
        { onConflict: "organization_id,slug" },
      )
      .select("id")
      .single(),
    "tournaments upsert",
  ) as { id: string };

  // 3. Doubles event (no unique(tournament_id,name) → select-or-insert)
  const eventId = await selectOrInsert(
    "events",
    { tournament_id: t.id, name: "E2E Mixed Doubles 3.5" },
    { tournament_id: t.id, name: "E2E Mixed Doubles 3.5", format: "doubles", gender: "mixed" },
    "events",
  );

  // 4. Players: organizer, player, partner
  await ensurePlayer("e2e-organizer@wmpc.test", "Olive", "Organizer");
  const playerId = await ensurePlayer("e2e-player@wmpc.test", "Pam", "Player");
  const partnerId = await ensurePlayer("e2e-partner@wmpc.test", "Pat", "Partner");

  // 5. Cancel-flow fixture (#9): a pending reg for Pam WITH a picked partner
  //    (Pat) — cancelling then pops the "drop your partner" confirm step.
  //    Reset first (the cancel test removes the reg) so every run starts clean;
  //    hard delete sidesteps the partial-unique / soft-delete ambiguity.
  await db.from("partner_invites").delete().eq("event_id", eventId).eq("inviter_player_id", playerId);
  await db.from("event_registrations").delete().eq("event_id", eventId).eq("player_id", playerId);

  const pamReg = ok(
    await db
      .from("event_registrations")
      .insert({
        event_id: eventId,
        player_id: playerId,
        status: "pending_payment",
        partner_status: "pending",
        event_fee_cents: 0,
      })
      .select("id")
      .single(),
    "pam pending reg insert",
  ) as { id: string };
  void pamReg;

  // The picked partner is surfaced via a pending invite (inviter=Pam,
  // invitee=Pat) → myStatus.partnerLabel = "Pat Partner", which is what gates
  // the #9 cancel-confirm modal. token has a DB default.
  ok(
    await db
      .from("partner_invites")
      .insert({
        event_id: eventId,
        inviter_player_id: playerId,
        invitee_player_id: partnerId,
        // invitee_email is the fallback label when the invitee player join is
        // RLS-blocked — without it partnerLabel can be null → no #9 modal.
        invitee_email: "e2e-partner@wmpc.test",
      })
      .select("id")
      .single(),
    "partner invite insert",
  );

  console.log("seed: e2e-test fixture ready");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
