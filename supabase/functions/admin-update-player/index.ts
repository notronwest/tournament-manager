// supabase/functions/admin-update-player/index.ts
//
// Platform-admin-only endpoint to manage a single player: profile fields
// (name / phone / gender / city / state / contact email), the login (auth)
// email, and password resets. Supersedes admin-update-player-email — the
// login-email path is carried over verbatim.
//
// ⚠️  Deploy with: supabase functions deploy admin-update-player
//
// POST {
//   playerId: string,
//   profile?: {
//     firstName?: string, lastName?: string, phone?: string,
//     gender?: "M" | "F" | "X" | null, city?: string, state?: string,
//     contactEmail?: string,         // players.email; "" clears it
//   },
//   loginEmail?: string,             // auth.users.email; requires linked account
//   passwordAction?:
//     | { type: "send_reset_email", redirectTo?: string }
//     | { type: "set_temp_password" },
// }
//
// Returns { ok: true, tempPassword?: string } or { error: string }.
// tempPassword is only present for a successful set_temp_password action and
// is the ONLY time it's ever returned — show it once, it can't be re-read.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ProfilePatch = {
  firstName?: string;
  lastName?: string;
  phone?: string;
  gender?: "M" | "F" | "X" | null;
  city?: string;
  state?: string;
  contactEmail?: string;
};
type PasswordAction =
  | { type: "send_reset_email"; redirectTo?: string }
  | { type: "set_temp_password" };
type Body = {
  playerId: string;
  profile?: ProfilePatch;
  loginEmail?: string;
  passwordAction?: PasswordAction;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResp({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResp({ error: "Unauthenticated" }, 401);

  // @ts-expect-error Deno global
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  // @ts-expect-error Deno global
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // @ts-expect-error Deno global
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user: callerUser },
    error: userErr,
  } = await caller.auth.getUser();
  if (userErr || !callerUser) {
    return jsonResp({ error: "Unauthenticated" }, 401);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  const { data: padmin } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", callerUser.id)
    .maybeSingle();
  if (!padmin) {
    return jsonResp({ error: "Not a platform admin" }, 403);
  }

  // ── Parse body ──────────────────────────────────────────────────
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResp({ error: "Invalid JSON body" }, 400);
  }
  const playerId = (body.playerId || "").trim();
  if (!playerId) return jsonResp({ error: "playerId is required." }, 400);

  const profile = body.profile;
  const loginEmail =
    body.loginEmail !== undefined ? body.loginEmail.trim() : undefined;
  const passwordAction = body.passwordAction;

  if (!profile && loginEmail === undefined && !passwordAction) {
    return jsonResp({ error: "Nothing to update." }, 400);
  }

  // ── Load the player ─────────────────────────────────────────────
  const { data: player, error: playerErr } = await admin
    .from("players")
    .select("id, auth_user_id, email")
    .eq("id", playerId)
    .is("deleted_at", null)
    .single();
  if (playerErr || !player) {
    return jsonResp({ error: "Player not found." }, 404);
  }

  // ── Profile patch ───────────────────────────────────────────────
  if (profile) {
    const patch: Record<string, unknown> = {};

    if (profile.firstName !== undefined) {
      const v = profile.firstName.trim();
      if (!v) return jsonResp({ error: "First name can't be empty." }, 400);
      if (v.length > 100) return jsonResp({ error: "First name is too long." }, 400);
      patch.first_name = v;
    }
    if (profile.lastName !== undefined) {
      const v = profile.lastName.trim();
      if (!v) return jsonResp({ error: "Last name can't be empty." }, 400);
      if (v.length > 100) return jsonResp({ error: "Last name is too long." }, 400);
      patch.last_name = v;
    }
    if (profile.phone !== undefined) {
      const v = profile.phone.trim();
      if (v.length > 40) return jsonResp({ error: "Phone is too long." }, 400);
      patch.phone = v || null;
    }
    if (profile.gender !== undefined) {
      if (profile.gender !== null && !["M", "F", "X"].includes(profile.gender)) {
        return jsonResp({ error: "Invalid gender value." }, 400);
      }
      patch.gender = profile.gender;
    }
    if (profile.city !== undefined) {
      const v = profile.city.trim();
      if (v.length > 100) return jsonResp({ error: "City is too long." }, 400);
      patch.city = v || null;
    }
    if (profile.state !== undefined) {
      const v = profile.state.trim();
      if (v.length > 100) return jsonResp({ error: "State is too long." }, 400);
      patch.state = v || null;
    }
    if (profile.contactEmail !== undefined) {
      const v = profile.contactEmail.trim();
      if (v && v.length > 200) {
        return jsonResp({ error: "Email address is too long." }, 400);
      }
      if (v && !EMAIL_RE.test(v)) {
        return jsonResp({ error: "Contact email address is not valid." }, 400);
      }
      patch.email = v || null;
    }

    if (Object.keys(patch).length > 0) {
      const { error: updErr } = await admin
        .from("players")
        .update(patch)
        .eq("id", playerId);
      if (updErr) {
        return jsonResp(
          { error: `Failed to update profile: ${updErr.message}` },
          500,
        );
      }
    }
  }

  // ── Login (auth) email ──────────────────────────────────────────
  if (loginEmail) {
    if (!EMAIL_RE.test(loginEmail)) {
      return jsonResp({ error: "Login email address is not valid." }, 400);
    }
    if (!player.auth_user_id) {
      return jsonResp(
        { error: "This player has no linked account — cannot change login email." },
        400,
      );
    }
    const { error: authErr } = await admin.auth.admin.updateUserById(
      player.auth_user_id,
      { email: loginEmail },
    );
    if (authErr) {
      const msg = authErr.message.toLowerCase().includes("already registered")
        ? "That email address is already in use by another account."
        : `Failed to update login email: ${authErr.message}`;
      return jsonResp({ error: msg }, 400);
    }
  }

  // ── Password action ─────────────────────────────────────────────
  let tempPassword: string | undefined;
  if (passwordAction) {
    if (!player.auth_user_id) {
      return jsonResp(
        { error: "This player has no linked account — there's no password to reset." },
        400,
      );
    }

    if (passwordAction.type === "send_reset_email") {
      // Pull the current login email to address the recovery mail.
      const { data: au } = await admin.auth.admin.getUserById(
        player.auth_user_id,
      );
      const targetEmail = au?.user?.email;
      if (!targetEmail) {
        return jsonResp(
          { error: "This account has no login email to send a reset to." },
          400,
        );
      }
      const redirectTo = passwordAction.redirectTo?.trim() || undefined;
      const { error: resetErr } = await admin.auth.resetPasswordForEmail(
        targetEmail,
        redirectTo ? { redirectTo } : undefined,
      );
      if (resetErr) {
        return jsonResp(
          { error: `Failed to send reset email: ${resetErr.message}` },
          500,
        );
      }
    } else if (passwordAction.type === "set_temp_password") {
      tempPassword = generateTempPassword();
      const { error: pwErr } = await admin.auth.admin.updateUserById(
        player.auth_user_id,
        { password: tempPassword },
      );
      if (pwErr) {
        return jsonResp(
          { error: `Failed to set temporary password: ${pwErr.message}` },
          500,
        );
      }
    } else {
      return jsonResp({ error: "Unknown password action." }, 400);
    }
  }

  return jsonResp({ ok: true, ...(tempPassword ? { tempPassword } : {}) });
});

// A readable but strong temporary password: 4 groups of 4 from an
// unambiguous alphabet (no 0/O/1/l/I), e.g. "K9HM-pX7q-R3FT-mn6K".
function generateTempPassword(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [
    chars.slice(0, 4).join(""),
    chars.slice(4, 8).join(""),
    chars.slice(8, 12).join(""),
    chars.slice(12, 16).join(""),
  ].join("-");
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
