/**
 * Sync PREFLIGHT — a read-only "sync doctor" for the B&E ⇄ PB.com bridge.
 *
 * The push writes to the LIVE PB.com during a real tournament, and there is no
 * second chance to run the event. The biggest risk is the one that bit the
 * TEST→PROD cutover: something that worked against test data / the training
 * site diverges on the real one (a wrong binding, a different live surface, a
 * division whose roster doesn't line up). This module PROVES the whole map
 * before the first write, and writes nothing.
 *
 * It is a PURE report builder: the CLI gathers the facts (config, the DB-side
 * divisions/rosters, and the PB.com attendees scrape) and hands them here, so
 * every check is unit-testable with no DB and no browser. The CLI prints the
 * report and exits non-zero if anything FAILS, so it can gate "are we clear to
 * push?" at a glance.
 */

export type CheckStatus = "pass" | "warn" | "fail";

export type Check = {
  /** Short stable name, e.g. "config", "roster:Mens Doubles 3.0". */
  name: string;
  status: CheckStatus;
  detail: string;
};

/** One B&E division (pbcom-sourced event) as the preflight sees it. */
export type BeDivision = {
  /** events.source_division_label — the PB.com division string (the join key). */
  label: string;
  /** event_registrations holding a spot in this division (both halves of a pair). */
  regCount: number;
  /** Distinct teams (a doubles pair counts once). */
  teamCount: number;
  /** Doubles registrations still partner_status='seeking' (linkage not yet applied). */
  seekingDoubles: number;
};

export type PreflightInput = {
  /** PBCOM_BASE_URL in effect. The director surfaces live on pickleballbrackets.com. */
  baseUrl: string | undefined;
  hasServiceRole: boolean;
  hasUsername: boolean;
  /** binding.json parsed without error. */
  bindingOk: boolean;
  /** The PB.com event id bound to this tournament (from binding.json). */
  eid: string | null;
  /** B&E's pbcom divisions for this tournament. */
  beDivisions: BeDivision[];
  /**
   * PB.com attendee ENTRY counts per division label, from the raS.aspx scrape
   * (one entry = one registration in that division). Empty map = scrape not run
   * (DB-only preflight); the roster-match checks then report "not checked".
   */
  pbcomEntryCounts: Map<string, number> | null;
  /** The live PB.com session authenticated (null = not checked / DB-only run). */
  sessionAuthenticated: boolean | null;
  /**
   * Divisions whose bracket contains matches PB.com can't tell apart by surname
   * alone (two games with the same last-name pairing). `matches` is how many games
   * are involved. Empty array = checked, none found. null = not computed.
   */
  surnameCollisions: { label: string; matches: number }[] | null;
  /**
   * READ-ONLY probes of each division's LIVE score page (ptsrr.aspx): can we open
   * it and parse the match rows, and do they line up with B&E's match count. The
   * score surface is traced but never driven live, so this proves it parses before
   * we trust the write path. `reachable:false`/`rows:0` = the division isn't Running
   * yet (normal before it starts) — never a failure. null = not probed (DB-only run).
   */
  bracketProbes: { label: string; reachable: boolean; rows: number; expectedMatches: number }[] | null;
};

const LIVE_HOST = "pickleballbrackets.com";

function norm(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

export function buildPreflightReport(input: PreflightInput): Check[] {
  const checks: Check[] = [];

  // 1) Config + binding — the env that drifts between machines/envs.
  const missing: string[] = [];
  if (!input.hasServiceRole) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!input.hasUsername) missing.push("PBCOM_USERNAME");
  if (!input.bindingOk) missing.push("binding.json");
  if (!input.eid) missing.push("tournament→eid binding");
  checks.push(
    missing.length === 0
      ? { name: "config", status: "pass", detail: "service-role key, PB.com user, and binding (tournament→eid) all present" }
      : { name: "config", status: "fail", detail: `missing: ${missing.join(", ")}` },
  );

  // 2) Base URL — must point at the LIVE director host. A stray training/other
  //    host is exactly how the attendees scrape silently returned nothing.
  const base = input.baseUrl ?? "";
  if (base.includes(LIVE_HOST)) {
    checks.push({ name: "base-url", status: "pass", detail: `PB.com base is the live host (${base})` });
  } else if (!base) {
    checks.push({ name: "base-url", status: "warn", detail: `PBCOM_BASE_URL unset — defaults to https://${LIVE_HOST}` });
  } else {
    checks.push({ name: "base-url", status: "fail", detail: `PBCOM_BASE_URL is "${base}", not the live ${LIVE_HOST} — the director surfaces won't load` });
  }

  // 3) Auth — only when the live session was actually opened.
  if (input.sessionAuthenticated === true) {
    checks.push({ name: "auth", status: "pass", detail: "reused an authenticated PB.com session (no re-login needed)" });
  } else if (input.sessionAuthenticated === false) {
    checks.push({ name: "auth", status: "fail", detail: "PB.com session is not authenticated — run the driver headed once and complete the emailed code" });
  } else {
    checks.push({ name: "auth", status: "warn", detail: "not checked (DB-only preflight — add the live scrape to verify auth + the live surfaces)" });
  }

  // 4) Every B&E division has a label and at least one team.
  for (const d of input.beDivisions) {
    if (!d.label.trim()) {
      checks.push({ name: "division:(unlabeled)", status: "fail", detail: "a pbcom event has no source_division_label — it can't be matched to PB.com" });
    } else if (d.teamCount < 1) {
      checks.push({ name: `division:${d.label}`, status: "warn", detail: "no teams yet — nothing to push for this division" });
    }
  }

  // 5) ROSTER MATCH — the heart of the preflight: does each B&E division's
  //    roster line up with PB.com's? A count mismatch (or a division present on
  //    only one side) means the binding/label is wrong or the import is stale —
  //    the push would otherwise write scores to the wrong place.
  if (input.pbcomEntryCounts && input.pbcomEntryCounts.size > 0) {
    const pbByNorm = new Map<string, { label: string; count: number }>();
    for (const [label, count] of input.pbcomEntryCounts) {
      const k = norm(label);
      const prev = pbByNorm.get(k);
      pbByNorm.set(k, { label, count: (prev?.count ?? 0) + count });
    }
    const matchedPb = new Set<string>();
    for (const d of input.beDivisions) {
      const k = norm(d.label);
      const pb = pbByNorm.get(k);
      if (!pb) {
        checks.push({ name: `roster:${d.label}`, status: "fail", detail: `B&E has ${d.regCount} registration(s) but PB.com has NO division matching this label — binding/label mismatch` });
        continue;
      }
      matchedPb.add(k);
      if (pb.count === d.regCount) {
        checks.push({ name: `roster:${d.label}`, status: "pass", detail: `${d.regCount} registration(s) match PB.com` });
      } else {
        checks.push({ name: `roster:${d.label}`, status: "fail", detail: `B&E ${d.regCount} vs PB.com ${pb.count} registration(s) — rosters differ; re-import before pushing` });
      }
    }
    // PB.com divisions with no B&E match — not imported (or a label drift).
    for (const [k, pb] of pbByNorm) {
      if (!matchedPb.has(k)) {
        checks.push({ name: `roster:${pb.label}`, status: "warn", detail: `PB.com has ${pb.count} registration(s) in "${pb.label}" but B&E has no matching division — not imported` });
      }
    }
  } else {
    checks.push({ name: "roster", status: "warn", detail: "not checked (no PB.com attendees scrape) — run preflight with the live session to prove the division map" });
  }

  // 5b) SURNAME COLLISIONS — matches PB.com can't tell apart by last names alone.
  //     The push's first-name tiebreak resolves most, and it NEVER mis-writes (it
  //     flags ambiguous rows), but a human should know which games to watch.
  if (input.surnameCollisions) {
    if (input.surnameCollisions.length === 0) {
      checks.push({ name: "surname-collisions", status: "pass", detail: "every match is uniquely named — no surname clashes" });
    } else {
      for (const c of input.surnameCollisions) {
        checks.push({
          name: `surname-collision:${c.label}`,
          status: "warn",
          detail: `${c.matches} match(es) share identical surnames with another — the push uses first names to tell them apart and flags any it can't (never mis-writes); watch these games`,
        });
      }
    }
  }

  // 5c) LIVE SCORE SURFACE — can we open each division's score page and parse its
  //     match rows? This is the write surface we're least sure of (traced, never
  //     driven live). A division that hasn't started isn't Running yet → rows:0,
  //     reported as info, NEVER a fail (nothing to push there yet anyway).
  if (input.bracketProbes) {
    for (const p of input.bracketProbes) {
      if (!p.reachable || p.rows === 0) {
        checks.push({ name: `score-page:${p.label}`, status: "warn", detail: "live score page not reachable yet — normal before the division starts; re-run once it's Running to confirm the surface" });
      } else if (p.expectedMatches > 0 && p.rows !== p.expectedMatches) {
        checks.push({ name: `score-page:${p.label}`, status: "warn", detail: `PB.com shows ${p.rows} match row(s), B&E has ${p.expectedMatches} — the bracket may differ; scores could mis-locate` });
      } else {
        checks.push({ name: `score-page:${p.label}`, status: "pass", detail: `live score page parses ${p.rows} match row(s) — the write surface is reachable` });
      }
    }
  }

  // 6) Partner linkage — seeking doubles means the raS.aspx linkage hasn't been
  //    applied yet, so doubles brackets would seed on unpaired teams.
  const totalSeeking = input.beDivisions.reduce((n, d) => n + d.seekingDoubles, 0);
  if (totalSeeking === 0) {
    checks.push({ name: "partner-linkage", status: "pass", detail: "no doubles registrations are still seeking a partner" });
  } else {
    checks.push({ name: "partner-linkage", status: "warn", detail: `${totalSeeking} doubles registration(s) still 'seeking' — run link-partners so doubles seed on the right teams` });
  }

  return checks;
}

/** True when nothing FAILED (warnings are allowed — they inform, not block). */
export function preflightClear(checks: Check[]): boolean {
  return !checks.some((c) => c.status === "fail");
}

export function countByStatus(checks: Check[]): Record<CheckStatus, number> {
  const out: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) out[c.status]++;
  return out;
}
