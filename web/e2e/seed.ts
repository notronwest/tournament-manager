/**
 * e2e/seed.ts — create a deterministic test fixture via the Supabase
 * service-role key (bypasses RLS). Idempotent: upserts a fixed `e2e-test`
 * org so re-runs are stable. Run before the Playwright suite.
 *
 *   E2E_SUPABASE_URL=… E2E_SUPABASE_SERVICE_ROLE_KEY=… E2E_TEST_PASSWORD=… npx tsx e2e/seed.ts
 *
 * NOTE: written from supabase/migrations/20260503000001_init_schema.sql. The
 * column/enum names below match that schema, but this needs ONE live run to
 * fill any NOT-NULL gaps the schema requires (see README "what's left").
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

// Create-or-get an auth user + its players row. Returns the player id.
async function ensurePlayer(email: string, firstName: string, lastName: string) {
  const { data: created } = await db.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  // If it already exists, look it up.
  let authUserId = created?.user?.id;
  if (!authUserId) {
    const { data } = await db.auth.admin.listUsers();
    authUserId = data.users.find((u) => u.email === email)?.id;
  }
  const { data: player } = await db
    .from("players")
    .upsert(
      { auth_user_id: authUserId, first_name: firstName, last_name: lastName },
      { onConflict: "auth_user_id" },
    )
    .select("id")
    .single();
  return player!.id as string;
}

async function main() {
  // 1. Org
  const { data: org } = await db
    .from("organizations")
    .upsert({ slug: "e2e-test", name: "E2E Test Org" }, { onConflict: "slug" })
    .select("id")
    .single();

  // 2. Published tournament
  const { data: t } = await db
    .from("tournaments")
    .upsert(
      {
        organization_id: org!.id,
        slug: "e2e-regression-cup",
        name: "E2E Regression Cup",
        status: "published",
        starts_at: "2099-01-01",
        ends_at: "2099-01-02",
      },
      { onConflict: "organization_id,slug" },
    )
    .select("id")
    .single();

  // 3. Doubles event
  const { data: ev } = await db
    .from("events")
    .upsert(
      {
        tournament_id: t!.id,
        name: "E2E Mixed Doubles 3.5",
        format: "doubles",
        gender: "mixed",
      },
      { onConflict: "tournament_id,name" },
    )
    .select("id")
    .single();

  // 4. Players: organizer, player, partner
  await ensurePlayer("e2e-organizer@wmpc.test", "Olive", "Organizer");
  const playerId = await ensurePlayer("e2e-player@wmpc.test", "Pam", "Player");
  const partnerId = await ensurePlayer("e2e-partner@wmpc.test", "Pat", "Partner");

  // 5. A pending_payment registration for the player, partnered with Pat.
  await db.from("event_registrations").upsert(
    {
      event_id: ev!.id,
      player_id: playerId,
      status: "pending_payment",
      partner_status: "pending",
    },
    { onConflict: "event_id,player_id" },
  );
  // (Partner link via partner_invites / partner_registration_id — wire in the
  //  live pass so Path 2 of #9 sees "Pat Partner" on the pending reg.)
  void partnerId;

  console.log("seed: e2e-test fixture ready");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
