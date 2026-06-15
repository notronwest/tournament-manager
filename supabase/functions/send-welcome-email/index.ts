// supabase/functions/send-welcome-email/index.ts
//
// Sends a branded welcome email after a user confirms their email address.
// Called by a Postgres trigger (handle_user_email_confirmed) via pg_net,
// NOT by the browser — no CORS needed, no JWT from the caller side.
//
// Deploy WITHOUT JWT verification so the trigger can call it with no auth:
//   supabase functions deploy send-welcome-email --no-verify-jwt
//
// Required Supabase secrets (already set):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — auto-injected at runtime.
//   RESEND_API_KEY, RESEND_FROM_ADDRESS      — shared with partner-invite.
//
// Idempotency: before sending, the function reads the user's
// raw_app_meta_data for a "welcomed_at" key. If present, it skips the send.
// After sending, it stamps welcomed_at on the user record so a retry or
// duplicate trigger invocation is a no-op.
//
// Failure is non-fatal by design (AC#4). The function always returns 200
// so the pg_net call that fires it never sees a network-level error that
// could interfere with the auth confirmation flow.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return ok({ skipped: "not POST" });
  }

  let body: { userId?: string };
  try {
    body = (await req.json()) as { userId?: string };
  } catch {
    return ok({ skipped: "invalid JSON" });
  }

  const userId = (body.userId ?? "").trim();
  if (!userId) {
    return ok({ skipped: "missing userId" });
  }

  // @ts-expect-error Deno global
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  // @ts-expect-error Deno global
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // @ts-expect-error Deno global
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  // @ts-expect-error Deno global
  const fromAddress = Deno.env.get("RESEND_FROM_ADDRESS");

  if (!supabaseUrl || !serviceRole || !resendApiKey || !fromAddress) {
    console.error("send-welcome-email: missing required env vars");
    return ok({ skipped: "server misconfigured" });
  }

  const admin = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false },
  });

  // Fetch the user record to validate they exist and are confirmed.
  const { data: userData, error: userErr } =
    await admin.auth.admin.getUserById(userId);
  if (userErr || !userData.user) {
    console.error("send-welcome-email: user lookup failed", userErr?.message);
    return ok({ skipped: "user not found" });
  }

  const user = userData.user;

  // Only send after email is confirmed.
  if (!user.email_confirmed_at) {
    return ok({ skipped: "email not confirmed" });
  }

  // Idempotency: check raw_app_meta_data for a prior send.
  const meta = (user.app_metadata ?? {}) as Record<string, unknown>;
  if (meta["welcomed_at"]) {
    return ok({ skipped: "already welcomed" });
  }

  const email = user.email;
  if (!email) {
    return ok({ skipped: "no email address" });
  }

  // Send the welcome email via Resend.
  try {
    const resendResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress,
        to: email,
        subject: "Welcome to bert & erne — you're in!",
        html: renderHtml(),
        text: renderText(),
      }),
    });

    if (!resendResp.ok) {
      const errText = await resendResp.text();
      console.error("send-welcome-email: Resend rejected send:", errText);
      return ok({ skipped: "resend error, will not retry" });
    }
  } catch (err) {
    console.error("send-welcome-email: fetch to Resend threw:", err);
    return ok({ skipped: "send failed" });
  }

  // Stamp welcomed_at on the user's app_metadata so this is idempotent.
  const { error: updateErr } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: { ...meta, welcomed_at: new Date().toISOString() },
  });
  if (updateErr) {
    // Non-fatal: email was sent; the stamp failing means a duplicate send
    // is possible on a retry, but that's an extremely unlikely scenario.
    console.warn(
      "send-welcome-email: welcomed_at stamp failed:",
      updateErr.message,
    );
  }

  return ok({ sent: true });
});

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function renderHtml(): string {
  const getStartedUrl = "https://bertanderne.com/getting-started";
  return `<!doctype html>
<html>
<body style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background: #fdf6ec; margin: 0; padding: 0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: #fdf6ec; padding: 40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background: #1a1a1a; border-radius: 8px; overflow: hidden; max-width: 560px; width: 100%;">
          <!-- Header wordmark -->
          <tr>
            <td style="padding: 28px 32px 20px; border-bottom: 1px solid #333;">
              <span style="font-family: Georgia, 'Times New Roman', serif; font-size: 22px; font-weight: 700; color: #fdf6ec; letter-spacing: 0.02em;">bert &amp; erne</span>
              <span style="font-size: 18px; color: #f5c842; margin-left: 6px;">&amp;</span>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding: 32px 32px 24px;">
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #fdf6ec; line-height: 1.3;">
                You're in. Welcome!
              </h1>
              <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #c8c8c8;">
                Your account is confirmed and ready to go. You can now register for
                pickleball tournaments, track your events, and manage your player
                profile — all in one place.
              </p>
              <p style="margin: 0 0 28px; font-size: 15px; line-height: 1.6; color: #c8c8c8;">
                Not sure where to start? We've put together a quick guide:
              </p>
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius: 4px; background: #f5c842;">
                    <a href="${getStartedUrl}"
                       style="display: inline-block; padding: 13px 28px; font-family: system-ui, sans-serif; font-size: 15px; font-weight: 700; color: #1a1a1a; text-decoration: none; letter-spacing: 0.03em; text-transform: uppercase;">
                      Get started &rarr;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding: 20px 32px 28px; border-top: 1px solid #333;">
              <p style="margin: 0; font-size: 12px; color: #777; line-height: 1.5;">
                You received this because you created an account at bertanderne.com.
                If that wasn't you, you can safely ignore this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderText(): string {
  return `Welcome to bert & erne!

Your account is confirmed and ready to go. You can now register for
pickleball tournaments, track your events, and manage your player profile.

Get started: https://bertanderne.com/getting-started

—
You received this because you created an account at bertanderne.com.
If that wasn't you, you can safely ignore this email.
`;
}
