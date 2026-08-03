import { supabase } from "../supabase";

// Client helpers for the admin-onboard-player edge function: send a player a
// branded magic login link, or re-send the welcome email. The function enforces
// authorization (platform admin, or org-staff who owns the attendee).

export type OnboardResult = { ok: true; createdAccount?: boolean } | { ok: false; error: string };

type LoginLinkOpts = { organizationId?: string; next?: string };

export async function sendLoginLink(playerId: string, opts: LoginLinkOpts = {}): Promise<OnboardResult> {
  return invoke({ playerId, action: "login_link", ...opts });
}

export async function resendWelcome(playerId: string, opts: { organizationId?: string } = {}): Promise<OnboardResult> {
  return invoke({ playerId, action: "welcome", ...opts });
}

async function invoke(body: Record<string, unknown>): Promise<OnboardResult> {
  try {
    const { data, error: fnErr } = await supabase.functions.invoke("admin-onboard-player", { body });
    if (fnErr) return { ok: false, error: await readFnError(fnErr) };
    const d = data as { ok?: boolean; createdAccount?: boolean } | null;
    if (!d?.ok) return { ok: false, error: "Something went wrong." };
    return { ok: true, createdAccount: d.createdAccount };
  } catch (e) {
    return { ok: false, error: (e as { message?: string })?.message ?? "Request failed." };
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
