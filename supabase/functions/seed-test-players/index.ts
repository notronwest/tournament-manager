// supabase/functions/seed-test-players/index.ts
//
// Dev-only helper: creates 20 fake players the admin can sign in as
// to test the public registration flow without juggling real accounts.
//
// Each test player is a real Supabase auth user with:
//   email     test.player.{1..20}@example.test
//   password  testpass123  (constant; these are test accounts only)
//   email_confirm = true   so they can sign in immediately without
//                          clicking a confirmation link
//
// We additionally insert a `players` row paired by auth_user_id so
// the user has a complete profile (name + gender + ratings) and
// passes RequireProfile without having to fill anything in.
//
// Idempotent: if a test slot already exists (by email), we leave it
// alone and just count it as existing. Safe to re-run any time —
// the only way it does anything is if a slot is missing.
//
// The function uses the service_role key (auto-injected by the
// Edge Functions runtime) for both auth.admin and the players
// insert. The admin UI gates calls to this function; the function
// itself doesn't authorize the caller because the worst it can do
// is create the same 20 well-known test accounts.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Constants exposed so the admin UI can show the password (and so
// the seed list stays in sync if we ever bump TEST_COUNT).
const TEST_PASSWORD = "testpass123";
const TEST_EMAIL_DOMAIN = "example.test";

// 20 seed identities. Genders distributed roughly 9/9/2 (M/F/X) so
// both same-gender events and mixed doubles have plenty to draw
// from. Ratings spread 2.5–4.5 so age/rating-restricted events
// still have eligible players.
const TEST_PLAYERS: {
  first: string;
  last: string;
  gender: "M" | "F" | "X";
  rating: number;
}[] = [
  { first: "Bob",   last: "Anderson", gender: "M", rating: 3.5 },
  { first: "Sue",   last: "Brown",    gender: "F", rating: 4.0 },
  { first: "Mark",  last: "Carter",   gender: "M", rating: 3.0 },
  { first: "Jane",  last: "Davis",    gender: "F", rating: 3.5 },
  { first: "Tom",   last: "Edwards",  gender: "M", rating: 4.5 },
  { first: "Lisa",  last: "Foster",   gender: "F", rating: 3.0 },
  { first: "Mike",  last: "Garcia",   gender: "M", rating: 4.0 },
  { first: "Karen", last: "Hall",     gender: "F", rating: 3.5 },
  { first: "Steve", last: "Irving",   gender: "M", rating: 3.5 },
  { first: "Anne",  last: "Jones",    gender: "F", rating: 4.0 },
  { first: "Dave",  last: "Kim",      gender: "M", rating: 3.0 },
  { first: "Pat",   last: "Lee",      gender: "X", rating: 4.0 },
  { first: "Chris", last: "Miller",   gender: "X", rating: 3.5 },
  { first: "Mary",  last: "Nelson",   gender: "F", rating: 2.5 },
  { first: "Tim",   last: "Owens",    gender: "M", rating: 4.5 },
  { first: "Beth",  last: "Patel",    gender: "F", rating: 4.5 },
  { first: "John",  last: "Quinn",    gender: "M", rating: 2.5 },
  { first: "Ellen", last: "Reyes",    gender: "F", rating: 3.5 },
  { first: "Paul",  last: "Stone",    gender: "M", rating: 4.0 },
  { first: "Joan",  last: "Thomas",   gender: "F", rating: 3.0 },
];

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResp({ error: "Method not allowed" }, 405);
  }

  // @ts-expect-error Deno global
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  // @ts-expect-error Deno global
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) {
    return jsonResp({ error: "Server missing Supabase config" }, 500);
  }
  const admin = createClient(supabaseUrl, serviceRole);

  // Cache the auth.users list once — we may need it to look up users
  // when createUser tells us "email already exists" without giving
  // us the existing user back. 1000 perPage is plenty for the test
  // accounts we care about; we just need them to land on page 1.
  let authUsersIndex: Map<string, string> | null = null;
  const loadAuthIndex = async () => {
    if (authUsersIndex) return authUsersIndex;
    const { data, error } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (error || !data) {
      authUsersIndex = new Map();
      return authUsersIndex;
    }
    authUsersIndex = new Map(
      data.users
        .filter((u) => u.email)
        .map((u) => [u.email!.toLowerCase(), u.id]),
    );
    return authUsersIndex;
  };

  let created = 0;
  let alreadyExisted = 0;
  const errors: { email: string; error: string }[] = [];

  for (let i = 0; i < TEST_PLAYERS.length; i++) {
    const slot = TEST_PLAYERS[i];
    const email = `test.player.${i + 1}@${TEST_EMAIL_DOMAIN}`;

    // Step 1. Is there already a players row for this email?
    const { data: existingPlayer } = await admin
      .from("players")
      .select("id, auth_user_id")
      .eq("email", email)
      .is("deleted_at", null)
      .maybeSingle();

    if (existingPlayer && existingPlayer.auth_user_id) {
      // Fully provisioned already — nothing to do.
      alreadyExisted++;
      continue;
    }

    // Step 2. Ensure the auth user exists. Try to create first
    // because that's the common path; on duplicate-email error fall
    // back to looking it up.
    let authUserId: string | null = null;
    const { data: createData, error: createErr } =
      await admin.auth.admin.createUser({
        email,
        password: TEST_PASSWORD,
        email_confirm: true,
      });
    if (createData?.user) {
      authUserId = createData.user.id;
    } else if (createErr) {
      // Almost certainly an "already exists" error — look it up.
      const index = await loadAuthIndex();
      authUserId = index.get(email.toLowerCase()) ?? null;
      if (!authUserId) {
        errors.push({ email, error: createErr.message });
        continue;
      }
    }

    if (!authUserId) {
      errors.push({ email, error: "could not resolve auth user id" });
      continue;
    }

    // Step 3. Insert or claim the players row.
    if (existingPlayer) {
      // The row exists but isn't linked to an auth user. Claim it.
      const { error: updErr } = await admin
        .from("players")
        .update({ auth_user_id: authUserId })
        .eq("id", existingPlayer.id);
      if (updErr) {
        errors.push({ email, error: updErr.message });
        continue;
      }
    } else {
      const { error: insErr } = await admin.from("players").insert({
        auth_user_id: authUserId,
        first_name: slot.first,
        last_name: slot.last,
        email,
        gender: slot.gender,
        self_rating_doubles: slot.rating,
        self_rating_mixed: slot.rating,
        self_rating_singles: slot.rating,
      });
      if (insErr) {
        errors.push({ email, error: insErr.message });
        continue;
      }
    }

    created++;
  }

  return jsonResp({
    ok: true,
    created,
    alreadyExisted,
    total: TEST_PLAYERS.length,
    password: TEST_PASSWORD,
    emailDomain: TEST_EMAIL_DOMAIN,
    errors,
  });
});

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
