/**
 * Environment / secret binding. Mirrors courtreserve-api's config discipline:
 * a missing credential is a clean "no-credential skip" (exit 2), never a crash,
 * so the unattended launchd job is inert until the mini's `.env` is filled.
 */
import "dotenv/config";

export const NO_CREDENTIALS = 2;

export interface DriverConfig {
  pbcomBaseUrl: string;
  pbcomUsername: string;
  pbcomPassword: string;
  dbUrl: string | null;
  /** Supabase project URL + service-role key for the DbDrawSource (read-only use). */
  supabaseUrl: string | null;
  supabaseServiceRoleKey: string | null;
  browserChannel: "chrome" | "chromium";
  headless: boolean;
  bindingPath: string;
  /**
   * A persistent Chrome profile dir. When set, the logged-in PB.com session survives
   * across runs, so a SUPERVISED operator completes the email-code login once. Unset →
   * a throwaway profile each run (login must be completed every run).
   */
  profileDir: string | null;
  /** How long login() waits for a supervised operator to finish the email-code step. */
  loginTimeoutMs: number;
}

export class MissingCredentials extends Error {
  constructor(what: string) {
    super(`pbcom-driver: ${what} — no-credential skip`);
    this.name = "MissingCredentials";
  }
}

/**
 * Load runtime config from the environment.
 *
 * With `requireCreds` (the default, used for a real push) a missing PB.com login
 * throws MissingCredentials, which the CLI turns into exit ${NO_CREDENTIALS} — so
 * the unattended job stays inert on a host that shouldn't drive. A dry-run / verify
 * passes `requireCreds: false`: it plans without a browser and needs no login.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  requireCreds = true,
): DriverConfig {
  const pbcomUsername = env.PBCOM_USERNAME?.trim() ?? "";
  const pbcomPassword = env.PBCOM_PASSWORD ?? "";
  if (requireCreds && (!pbcomUsername || !pbcomPassword)) {
    throw new MissingCredentials("PBCOM_USERNAME / PBCOM_PASSWORD not set");
  }
  const channelRaw = (env.PBCOM_BROWSER_CHANNEL ?? "chrome").toLowerCase();
  return {
    pbcomBaseUrl: (env.PBCOM_BASE_URL ?? "https://pickleballbrackets.com").replace(/\/+$/, ""),
    pbcomUsername,
    pbcomPassword,
    dbUrl: env.PBCOM_DB_URL?.trim() || null,
    supabaseUrl: env.SUPABASE_URL?.trim() || null,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null,
    browserChannel: channelRaw === "chromium" ? "chromium" : "chrome",
    // Default headed: headless breaks bot-management on WebForms sites (Court
    // Reserve lesson). Opt into headless only for local DOM debugging.
    headless: (env.PBCOM_HEADLESS ?? "0") === "1",
    bindingPath: env.PBCOM_BINDING_PATH ?? "./binding.json",
    profileDir: env.PBCOM_PROFILE_DIR?.trim() || null,
    loginTimeoutMs: Number(env.PBCOM_LOGIN_TIMEOUT_MS ?? "180000") || 180_000,
  };
}
