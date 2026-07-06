// Environment detection for the "you're on TEST" banner (and any other
// env-aware UI). Deliberately FAIL-SAFE toward production: we only return a
// non-null label when we can *positively* identify a non-prod environment.
// If detection is ambiguous we return null, so a real production build never
// shows a scary "TEST" strip to real users.
//
// Kept structurally identical to the TSA (third-shot-academy) copy so the two
// repos stay in sync — only the ref/hostname constants differ.
//
// Signals, in priority order:
//   1. VITE_APP_ENV — explicit override, set per Cloudflare Pages project.
//   2. localhost → DEV (never the live site, whatever DB it targets).
//   3. Hostname (test.* / *-test.pages.dev) → TEST. Authoritative for deployed
//      builds — a *-test host is TEST even if it currently talks to the prod
//      Supabase project (e.g. mid-cutover), so this precedes the ref check.
//   4. Supabase project ref — disambiguates on hosts the name doesn't cover.

// Supabase project refs (see deploy-model memory / STATUS.md).
const TEST_SUPABASE_REF = "mvkhdsauaqqjehxdnbuf";
const PROD_SUPABASE_REF = "wducsjqyoksmluwfgjxc";

export type EnvLabel = "TEST" | "DEV" | string;

/**
 * Returns a short uppercase label for the current environment when it is NOT
 * production (e.g. "TEST", "DEV"), or null on production / when unknown.
 */
export function getEnvLabel(): EnvLabel | null {
  // 1. Explicit override wins. Set VITE_APP_ENV=production on the prod project
  //    to hard-disable the banner, or any other value to force a label.
  const explicit = (import.meta.env.VITE_APP_ENV as string | undefined)
    ?.trim()
    .toLowerCase();
  if (explicit) {
    if (explicit === "production" || explicit === "prod") return null;
    return explicit.toUpperCase();
  }

  const host =
    typeof window !== "undefined"
      ? window.location.hostname.toLowerCase()
      : "";

  // 2. Localhost is never the live site — regardless of which Supabase project
  //    it talks to (local .env points at PROD, so this must precede the ref
  //    check below or dev would look like production).
  if (host === "localhost" || host === "127.0.0.1") return "DEV";

  // 3. Hostname — authoritative for deployed non-prod builds.
  if (host.startsWith("test.") || host.endsWith("-test.pages.dev"))
    return "TEST";

  // 4. Supabase project ref, for deployed builds on ambiguous hosts.
  const supabaseUrl = (
    (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ""
  ).toLowerCase();
  if (supabaseUrl.includes(TEST_SUPABASE_REF)) return "TEST";
  if (supabaseUrl.includes(PROD_SUPABASE_REF)) return null;

  // Unknown → assume production, show nothing.
  return null;
}
