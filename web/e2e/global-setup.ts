import { createClient } from "@supabase/supabase-js";

// Wake the (free-tier) test Supabase project + the deployed app ONCE before the
// suite, so no individual test eats the cold start — which otherwise bounces
// the first profile-gated tests to /profile (RequireProfile query times out) and
// shows up as flaky 60s timeouts.
export default async function globalSetup() {
  const url = process.env.E2E_SUPABASE_URL;
  const key = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    const db = createClient(url, key, { auth: { persistSession: false } });
    try {
      await Promise.all([
        db.from("players").select("id").limit(1),
        db.from("tournaments").select("id").limit(1),
        db.auth.admin.listUsers({ page: 1, perPage: 1 }),
      ]);
    } catch {
      /* best-effort warmup */
    }
  }
  const base = process.env.E2E_BASE_URL;
  if (base) {
    try {
      await fetch(base);
    } catch {
      /* best-effort */
    }
  }
}
