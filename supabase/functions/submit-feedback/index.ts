// supabase/functions/submit-feedback/index.ts
//
// Feedback widget backend (issue #153).
// Accepts a category + message from any visitor (auth optional),
// throttles by salted IP hash, records the submission, then opens
// a GitHub issue in notronwest/tournament-manager so the team is notified.
//
// Required Supabase secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — auto-injected at runtime.
//   GITHUB_FEEDBACK_TOKEN                    — fine-grained PAT with
//                                              issues:write on the repo.
//   FEEDBACK_IP_SALT                         — random string; salts the
//                                              IP hash so raw IPs are
//                                              never stored.
//
// Auth is optional — the JWT is read if present to include the
// user's identity in the issue body, but no token is required.
// Abuse guard: 5 submissions per IP per hour + message length cap.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_WINDOW = 5;

const MAX_MESSAGE = 3000;
const MAX_CATEGORY = 60;
const MAX_PAGE_URL = 500;

const VALID_CATEGORIES = ["bug", "feature", "improvement", "other"] as const;
type Category = (typeof VALID_CATEGORIES)[number];

type Body = {
  category: Category;
  message: string;
  pageUrl?: string;
  // Client-supplied context; server cross-checks with JWT when available.
  userName?: string;
  userEmail?: string;
};

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResp({ error: "Method not allowed" }, 405);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResp({ error: "Invalid JSON body" }, 400);
  }

  // ── Validate input ──────────────────────────────────────────────
  const category = (body.category || "").trim() as Category;
  const message = (body.message || "").trim();
  const pageUrl = (body.pageUrl || "").trim().slice(0, MAX_PAGE_URL);

  if (!category || !VALID_CATEGORIES.includes(category)) {
    return jsonResp(
      { error: "Category must be one of: bug, feature, improvement, other." },
      400,
    );
  }
  if (!message) {
    return jsonResp({ error: "Message is required." }, 400);
  }
  if (message.length > MAX_MESSAGE) {
    return jsonResp(
      { error: `Message must be ${MAX_MESSAGE} characters or fewer.` },
      400,
    );
  }
  if (category.length > MAX_CATEGORY) {
    return jsonResp({ error: "Category value too long." }, 400);
  }

  // ── Secrets ─────────────────────────────────────────────────────
  // @ts-expect-error Deno global
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  // @ts-expect-error Deno global
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // @ts-expect-error Deno global
  const githubToken = Deno.env.get("GITHUB_FEEDBACK_TOKEN");
  // @ts-expect-error Deno global
  const ipSalt = Deno.env.get("FEEDBACK_IP_SALT");

  if (!supabaseUrl || !serviceRole) {
    return jsonResp({ error: "Server missing Supabase config" }, 500);
  }
  if (!ipSalt) {
    return jsonResp({ error: "Server missing FEEDBACK_IP_SALT" }, 500);
  }
  if (!githubToken) {
    return jsonResp({ error: "Server missing GITHUB_FEEDBACK_TOKEN" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRole);

  // ── Salted IP hash ───────────────────────────────────────────────
  const rawIp =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const ipHash = await sha256Hex(`${ipSalt}:${rawIp}`);

  // ── Throttle ─────────────────────────────────────────────────────
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  const { count, error: countErr } = await admin
    .from("feedback_submissions")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash)
    .gte("created_at", cutoff);

  if (countErr) {
    return jsonResp({ error: "Failed to check rate limit." }, 500);
  }
  if ((count ?? 0) >= MAX_PER_WINDOW) {
    return jsonResp(
      {
        error:
          "You've submitted a lot of feedback recently. Please wait an hour and try again.",
      },
      429,
    );
  }

  // ── Resolve auth user (optional) ────────────────────────────────
  let authUserId: string | null = null;
  let authUserEmail: string | null = null;
  let authUserName: string | null = null;

  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    const jwt = authHeader.replace("Bearer ", "");
    const { data: userData } = await admin.auth.getUser(jwt);
    if (userData?.user) {
      authUserId = userData.user.id;
      authUserEmail = userData.user.email ?? null;
      // Look up the player record for the name
      if (authUserId) {
        const { data: player } = await admin
          .from("players")
          .select("full_name")
          .eq("auth_user_id", authUserId)
          .maybeSingle();
        authUserName = player?.full_name ?? null;
      }
    }
  }

  // ── Record the submission ────────────────────────────────────────
  const { error: insErr } = await admin
    .from("feedback_submissions")
    .insert({
      ip_hash: ipHash,
      category,
      message,
      page_url: pageUrl || null,
      auth_user_id: authUserId ?? null,
    });

  if (insErr) {
    return jsonResp({ error: "Failed to record submission." }, 500);
  }

  // ── Build GitHub issue body ─────────────────────────────────────
  const userSection = authUserId
    ? [
        `**User:** ${authUserName ?? "(no name)"} · ${authUserEmail ?? "(no email)"} · \`${authUserId}\``,
      ]
    : body.userName || body.userEmail
      ? [
          `**User:** ${body.userName ?? "(no name)"} · ${body.userEmail ?? "(no email)"} · anonymous (not signed in)`,
        ]
      : ["**User:** anonymous (not signed in)"];

  const issueBody = [
    `**Category:** ${category}`,
    "",
    "**Message:**",
    message,
    "",
    "---",
    ...userSection,
    `**Page:** ${pageUrl || "(unknown)"}`,
    `**User-Agent:** ${req.headers.get("user-agent") ?? "(unknown)"}`,
    `**Submitted:** ${new Date().toISOString()}`,
    "",
    "*(Filed automatically by the feedback widget.)*",
  ].join("\n");

  const categoryLabel: Record<Category, string> = {
    bug: "Bug report",
    feature: "Feature idea",
    improvement: "Improvement",
    other: "Feedback",
  };
  const issueTitle = `[Feedback] ${categoryLabel[category]}: ${message.slice(0, 60)}${message.length > 60 ? "…" : ""}`;

  // ── Create GitHub issue ─────────────────────────────────────────
  const ghResp = await fetch(
    "https://api.github.com/repos/notronwest/tournament-manager/issues",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bert-erne-feedback-widget/1.0",
      },
      body: JSON.stringify({
        title: issueTitle,
        body: issueBody,
        labels: ["feedback"],
      }),
    },
  );

  if (!ghResp.ok) {
    const errText = await ghResp.text();
    // Submission is already recorded; report the GitHub failure.
    // The feedback isn't lost — it's in feedback_submissions.
    return jsonResp(
      {
        error: `Your feedback was saved but we couldn't file the issue automatically (${ghResp.status}). The team will still see it.`,
        saved: true,
      },
      502,
    );
  }

  const ghData = (await ghResp.json()) as { html_url?: string; number?: number };

  return jsonResp({
    ok: true,
    issueUrl: ghData.html_url,
    issueNumber: ghData.number,
  });
});

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  // @ts-expect-error Web Crypto available in Deno runtime
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
