import { supabase } from "../supabase";

// Admin "log in as" (impersonation) — shared client helper.
//
// Flow: stash the admin's own session in sessionStorage, ask the
// platform-admin-only `admin-impersonate` edge function to mint a single-use
// magic-link token for the target player's auth account, then verifyOtp it so
// the supabase session becomes that player. The SiteHeader reads the stash to
// show a "Switch back" banner and restores the admin via setSession.
//
// No password and no email are involved — the token is generated server-side
// (generateLink) and consumed immediately here.

// sessionStorage key holding the admin's stashed session while impersonating.
// SiteHeader (Switch back) reads the same key.
export const IMPERSONATION_KEY = "tm:admin-session";

export type StashedSession = {
  access_token: string;
  refresh_token: string;
  email: string | null | undefined;
};

export function readStashedSession(): StashedSession | null {
  try {
    const raw = sessionStorage.getItem(IMPERSONATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StashedSession;
    if (!parsed?.access_token || !parsed?.refresh_token) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function stashAdminSession(): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) return;
  try {
    sessionStorage.setItem(
      IMPERSONATION_KEY,
      JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        email: session.user.email,
      }),
    );
  } catch {
    // sessionStorage rarely unavailable; without it we just can't auto-restore.
  }
}

// Log in as the given player. On success the active supabase session becomes
// that player (the caller then navigates). Returns an error message on failure,
// with the admin's session left intact. Requires the caller to be a platform
// admin — the edge function enforces that.
export async function impersonatePlayer(playerId: string): Promise<string | null> {
  await stashAdminSession();
  try {
    const { data, error: fnErr } = await supabase.functions.invoke(
      "admin-impersonate",
      { body: { playerId } },
    );
    if (fnErr) {
      sessionStorage.removeItem(IMPERSONATION_KEY);
      return await readFnError(fnErr);
    }
    const tokenHash = (data as { tokenHash?: string } | null)?.tokenHash;
    if (!tokenHash) {
      sessionStorage.removeItem(IMPERSONATION_KEY);
      return "Could not start the session.";
    }
    const { error: otpErr } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: "magiclink",
    });
    if (otpErr) {
      sessionStorage.removeItem(IMPERSONATION_KEY);
      return otpErr.message;
    }
    return null;
  } catch (e) {
    sessionStorage.removeItem(IMPERSONATION_KEY);
    return (e as { message?: string })?.message ?? "Log in as failed.";
  }
}

// Unwrap a supabase FunctionsError — the edge function's JSON body is on
// err.context as a Response (same idiom used across the admin pages).
async function readFnError(err: unknown): Promise<string> {
  const ctx = (err as { context?: Response })?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const b = (await ctx.json()) as { error?: string };
      if (b?.error) return b.error;
    } catch {
      /* fall through */
    }
  }
  return (err as { message?: string })?.message ?? "Something went wrong.";
}
