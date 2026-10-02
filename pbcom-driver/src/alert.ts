/**
 * Discord alerting for the UNATTENDED push loop.
 *
 * The auto/poll job runs on launchd every ~150s with nobody watching, so a
 * condition a human must fix (a lapsed PB.com session, a write that would not
 * verify) has to reach a human OUT OF BAND. It posts to a Discord webhook,
 * mirroring the fleet's builder-dispatch alert pattern.
 *
 * Discipline (matches builder-dispatch.sh):
 *   • Best-effort: a webhook post NEVER throws into the run loop — an alert
 *     failure must not crash-loop the job. Failures are logged and swallowed.
 *   • If PBCOM_DISCORD_WEBHOOK is unset, log LOUDLY (warn) and skip the post —
 *     the job still records needs_attention in the DB and exits cleanly.
 *   • Deduped per kind (~6h via a marker file under state/) so a session that
 *     stays lapsed for hours produces one ping, not one every 150s.
 */
import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALERT_STATE_DIR = join(REPO_ROOT, "state", "alerts");
const DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h, matching the fleet's alert cadence

export interface Alerter {
  /**
   * Post an alert. `kind` dedupes: repeated alerts of the same kind within the
   * dedup window are suppressed. Never throws.
   */
  send(kind: string, message: string): Promise<void>;
}

/** A no-op alerter for tests and dry-runs. Records what it was asked to send. */
export class NoopAlerter implements Alerter {
  public readonly sent: Array<{ kind: string; message: string }> = [];
  async send(kind: string, message: string): Promise<void> {
    this.sent.push({ kind, message });
  }
}

/**
 * True when we alerted for `kind` inside the dedup window. Best-effort: any fs
 * error is treated as "not recently alerted" so we err toward alerting.
 */
function recentlyAlerted(kind: string): boolean {
  try {
    const marker = join(ALERT_STATE_DIR, `alerted-${safe(kind)}`);
    const age = Date.now() - statSync(marker).mtimeMs;
    return age < DEDUP_WINDOW_MS;
  } catch {
    return false;
  }
}

function markAlerted(kind: string): void {
  try {
    mkdirSync(ALERT_STATE_DIR, { recursive: true });
    const marker = join(ALERT_STATE_DIR, `alerted-${safe(kind)}`);
    writeFileSync(marker, new Date().toISOString());
    const now = new Date();
    utimesSync(marker, now, now);
  } catch {
    /* best-effort — a missing marker just means we may alert again sooner */
  }
}

function safe(kind: string): string {
  return kind.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 64);
}

/** Posts to a Discord webhook. Best-effort, deduped, never throws. */
export class DiscordAlerter implements Alerter {
  constructor(private readonly webhookUrl: string | null) {}

  async send(kind: string, message: string): Promise<void> {
    if (!this.webhookUrl) {
      // Loud, so a mis-configured mini is obvious in the launchd err log.
      log.warn("PBCOM_DISCORD_WEBHOOK is unset — cannot alert; skipping post", {
        kind,
        wouldHaveSent: message,
      });
      return;
    }
    if (recentlyAlerted(kind)) {
      log.info("alert suppressed (deduped within window)", { kind });
      return;
    }
    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
      if (!res.ok) {
        log.warn("discord alert POST returned non-2xx", { kind, status: res.status });
        return; // do not mark: allow a retry next tick
      }
      markAlerted(kind);
      log.info("posted discord alert", { kind });
    } catch (err) {
      // Never let an alert failure crash the run loop.
      log.warn("discord alert POST failed", { kind, error: String((err as Error)?.message ?? err) });
    }
  }
}
