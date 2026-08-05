import { supabase } from "../supabase";

// Platform-admin list of people who created a login account and have signed in,
// but never registered for anything. Served by the admin-unregistered-users
// edge function (needs auth.users → service_role, platform-admin gated).

export type UnregisteredUser = {
  playerId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  createdAt: string | null;
  lastSignInAt: string | null;
};

export async function fetchUnregisteredUsers(): Promise<UnregisteredUser[]> {
  const { data, error } = await supabase.functions.invoke("admin-unregistered-users", {
    body: {},
  });
  if (error) {
    let detail = error.message;
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.text === "function") {
      try {
        const raw = await ctx.text();
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as { error?: string };
            if (parsed?.error) detail = parsed.error;
          } catch {
            detail = raw;
          }
        }
      } catch {
        /* keep transport message */
      }
    }
    throw new Error(detail);
  }
  return (data as { users?: UnregisteredUser[] })?.users ?? [];
}
