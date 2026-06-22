/**
 * e2e/record-history.ts — ingest the Playwright JSON report into the
 * `e2e_test_results` table (TEST Supabase project) so each test's pass/fail
 * trend over time is queryable in the Supabase dashboard (see the
 * `e2e_test_history` view). Run AFTER the suite, in CI:
 *
 *   E2E_SUPABASE_URL=… E2E_SUPABASE_SERVICE_ROLE_KEY=… npx tsx e2e/record-history.ts
 *
 * Auxiliary + best-effort: any problem logs and exits 0 — recording history
 * must never fail the regression job.
 */
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

type Row = {
  run_id: string;
  sha: string | null;
  test_id: string;
  title: string;
  file: string;
  status: string;
  expected: string | null;
  duration_ms: number | null;
  retries: number;
};

async function main() {
  const url = process.env.E2E_SUPABASE_URL;
  const key = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;
  const runId = process.env.GITHUB_RUN_ID || "local";
  const sha = process.env.GITHUB_SHA || null;
  const reportPath = process.env.E2E_JSON_REPORT || "playwright-report/results.json";

  if (!url || !key) return done("no E2E_SUPABASE_* creds — skip");
  if (!existsSync(reportPath)) return done(`${reportPath} not found — skip`);

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const rows: Row[] = [];

  // Playwright JSON: suites nest (file → describe → …); each spec has tests[],
  // each test has results[] (one per attempt). Final outcome = last result.
  const walk = (suite: any, file: string, titles: string[]) => {
    const f = suite.file || file;
    const t = suite.title && suite.title !== f ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      const fileRel = spec.file || f;
      const fullTitle = [...t, spec.title].filter(Boolean).join(" › ");
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        const last = results[results.length - 1] ?? {};
        rows.push({
          run_id: runId,
          sha,
          test_id: `${fileRel} :: ${fullTitle}`,
          title: spec.title,
          file: fileRel,
          status: last.status || test.status || "unknown",
          expected: test.expectedStatus || null,
          duration_ms: typeof last.duration === "number" ? last.duration : null,
          retries: Math.max(0, results.length - 1),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, f, t);
  };
  for (const s of report.suites ?? []) walk(s, "", []);

  if (!rows.length) return done("no test rows in report — skip");

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { error } = await db.from("e2e_test_results").insert(rows);
  if (error) return done(`insert failed — ${error.message}`);
  console.log(`record-history: recorded ${rows.length} test result(s) for run ${runId}`);
}

function done(msg: string) {
  console.log(`record-history: ${msg}`);
}

main().catch((e) => {
  // Best-effort: never fail the job.
  console.log(`record-history: ${e?.message ?? e}`);
});
