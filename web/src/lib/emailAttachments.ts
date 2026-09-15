import { bytesToBase64 } from "./summaryPdf";

// Attachment rules for the admin email broadcast. Resend can't attach files
// on its batch endpoint, so a broadcast with attachments is mailed one
// recipient at a time — the caps here keep each request (and the whole run)
// a sane size. The edge function enforces the same limits server-side; this
// is the friendly, pre-flight copy.

export const MAX_ATTACHMENT_FILES = 3;
export const MAX_ATTACHMENT_TOTAL_BYTES = 5 * 1024 * 1024;

export type AttachmentMeta = { name: string; size: number };
export type IncomingAttachment = AttachmentMeta & { type: string };
export type AttachmentRejection = { name: string; reason: string };

export function isPdf(file: { name: string; type: string }): boolean {
  if (file.type === "application/pdf") return true;
  return /\.pdf$/i.test(file.name.trim());
}

/**
 * Decide which of the newly picked files may join the already-attached set.
 * Rules, in order per file: PDF only · no duplicate names · at most
 * MAX_ATTACHMENT_FILES · at most MAX_ATTACHMENT_TOTAL_BYTES across all.
 * Accepted items are returned as the same objects that came in (so a caller
 * passing `File`s gets `File`s back).
 */
export function validateAttachmentSelection<T extends IncomingAttachment>(
  existing: AttachmentMeta[],
  incoming: T[],
): { accepted: T[]; rejected: AttachmentRejection[] } {
  const accepted: T[] = [];
  const rejected: AttachmentRejection[] = [];
  const names = new Set(existing.map((f) => f.name));
  let count = existing.length;
  let bytes = existing.reduce((sum, f) => sum + f.size, 0);

  for (const file of incoming) {
    if (!isPdf(file)) {
      rejected.push({ name: file.name, reason: "Only PDF files can be attached." });
      continue;
    }
    if (file.size <= 0) {
      rejected.push({ name: file.name, reason: "This file is empty." });
      continue;
    }
    if (names.has(file.name)) {
      rejected.push({ name: file.name, reason: "Already attached." });
      continue;
    }
    if (count >= MAX_ATTACHMENT_FILES) {
      rejected.push({
        name: file.name,
        reason: `Up to ${MAX_ATTACHMENT_FILES} PDFs per email.`,
      });
      continue;
    }
    if (bytes + file.size > MAX_ATTACHMENT_TOTAL_BYTES) {
      rejected.push({
        name: file.name,
        reason: `Attachments can total ${formatBytes(MAX_ATTACHMENT_TOTAL_BYTES)} at most (this one is ${formatBytes(file.size)}).`,
      });
      continue;
    }
    accepted.push(file);
    names.add(file.name);
    count += 1;
    bytes += file.size;
  }

  return { accepted, rejected };
}

/** "512 B" · "24 KB" · "1.2 MB" — for chips and helper copy. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const mb = n / (1024 * 1024);
  const s = mb >= 10 ? Math.round(mb).toString() : mb.toFixed(1).replace(/\.0$/, "");
  return `${s} MB`;
}

/** Base64-encode a picked File for the edge function's `contentBase64`. */
export async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}
