// Shared attachment machinery for Resend emails that carry a PDF.
//
// Resend's /emails/batch endpoint does not accept attachments, so any email
// with one is a separate POST /emails per recipient, paced to stay under
// Resend's default 2 requests/second. Everything a function needs for that is
// here: attachment validation (PDF only, size from the encoded length, safe
// filename), the single-send helper with its one 429 retry, and the pacing
// constants. First used by send-tournament-summary; send-contact-broadcast
// takes the same path when an admin attaches files.
//
// Usage:
//   import { parseAttachments, sendOneEmail, SEND_SPACING_MS, sleep, clampInt }
//     from "../_shared/attachments.ts";
//
//   const parsed = parseAttachments(body.attachments, { maxFiles: 3, maxTotalBytes: 5 * 1024 * 1024 });
//   if (!parsed.ok) return json({ error: parsed.error }, 400);
//   const result = await sendOneEmail(apiKey, { from, to, subject, html, attachments: parsed.files });

const RESEND = "https://api.resend.com";

// Resend's default limit is 2 requests/second; ~550 ms between sends keeps a
// window under it with a little headroom for clock jitter.
export const SEND_SPACING_MS = 550;
export const RATE_LIMIT_RETRY_MS = 1100;
const MAX_FILENAME_CHARS = 120;

// Exactly the shape Resend wants in `attachments`: bare base64 in `content`.
export type Attachment = { filename: string; content: string };

export type AttachmentError = "attachment_invalid" | "attachment_too_large" | "too_many_attachments";

export type ParsedAttachments = { ok: true; files: Attachment[] } | { ok: false; error: AttachmentError };

// Validate a client-supplied `[{ filename, contentBase64 }]` list. PDF only:
// the name must end in .pdf AND the decoded bytes must start with "%PDF".
// Tolerates a data-URL prefix and line-wrapped base64 (Resend wants the bare
// string). The decoded size is computed from the encoded length so a 5 MB
// file is never decoded just to be measured; `maxTotalBytes` caps all files
// together. A non-array, a non-object entry, a missing/empty filename or
// content, malformed base64, or a non-PDF all read as `attachment_invalid` —
// callers that need to distinguish "missing" from "bad" check presence
// before calling.
export function parseAttachments(
  raw: unknown,
  opts: { maxFiles: number; maxTotalBytes: number },
): ParsedAttachments {
  if (!Array.isArray(raw)) return { ok: false, error: "attachment_invalid" };
  if (raw.length > opts.maxFiles) return { ok: false, error: "too_many_attachments" };

  const files: Attachment[] = [];
  let totalBytes = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "attachment_invalid" };
    const item = entry as { filename?: unknown; contentBase64?: unknown };

    const filename = typeof item.filename === "string" ? sanitizeFilename(item.filename) : "";
    if (!filename) return { ok: false, error: "attachment_invalid" };
    if (!/\.pdf$/i.test(filename) || filename.length <= 4) return { ok: false, error: "attachment_invalid" };

    if (typeof item.contentBase64 !== "string" || !item.contentBase64.trim()) {
      return { ok: false, error: "attachment_invalid" };
    }
    let b64 = item.contentBase64.trim();
    const comma = b64.indexOf(",");
    if (/^data:/i.test(b64) && comma !== -1) b64 = b64.slice(comma + 1);
    b64 = b64.replace(/\s+/g, "");
    if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
      return { ok: false, error: "attachment_invalid" };
    }
    // Decoded size from the encoded length — no need to decode to know it's too big.
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    const decodedBytes = (b64.length / 4) * 3 - padding;
    totalBytes += decodedBytes;
    if (totalBytes > opts.maxTotalBytes) return { ok: false, error: "attachment_too_large" };
    // Decode the first bytes to confirm this is really a PDF (every PDF starts
    // with "%PDF") and that the base64 is well-formed.
    try {
      const head = atob(b64.slice(0, 8));
      if (!head.startsWith("%PDF")) return { ok: false, error: "attachment_invalid" };
    } catch {
      return { ok: false, error: "attachment_invalid" };
    }
    files.push({ filename, content: b64 });
  }
  return { ok: true, files };
}

// Strip path separators and control characters so the name is safe as a
// mail attachment; keep it short enough for every mail client.
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  return cleaned.length > MAX_FILENAME_CHARS ? cleaned.slice(cleaned.length - MAX_FILENAME_CHARS) : cleaned;
}

// ── Resend ──────────────────────────────────────────────────────────

export type SendResult = { ok: true; id: string | null } | { ok: false; error: string };

// One POST /emails. Never throws — a failure inside a window must not lose
// the sent/failed count. A 429 gets exactly one retry after a pause.
export async function sendOneEmail(apiKey: string, email: unknown): Promise<SendResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let resp: Response;
    let bodyText: string;
    try {
      resp = await fetch(`${RESEND}/emails`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(email),
      });
      bodyText = await resp.text();
    } catch (e) {
      return { ok: false, error: `resend POST /emails network error: ${String((e as { message?: string })?.message ?? e)}` };
    }
    if (resp.ok) {
      try {
        const parsed = bodyText ? (JSON.parse(bodyText) as { id?: string }) : {};
        return { ok: true, id: typeof parsed.id === "string" ? parsed.id : null };
      } catch {
        return { ok: true, id: null };
      }
    }
    if (resp.status === 429 && attempt === 0) {
      await sleep(RATE_LIMIT_RETRY_MS);
      continue;
    }
    return { ok: false, error: `resend POST /emails → ${resp.status}: ${bodyText.slice(0, 500)}` };
  }
  return { ok: false, error: "resend POST /emails → rate limited" };
}

// ── Helpers ─────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.min(max, Math.max(min, n));
}
