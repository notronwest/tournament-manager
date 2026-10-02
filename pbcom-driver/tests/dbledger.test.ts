import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DbPushLedger, DbPushStateSink, type SupabaseLike } from "../src/push/run.js";
import {
  bracketLedgerEntry,
  computePlan,
  matchIdentity,
  resolveTeams,
  scoreDigest,
  scoreLedgerEntry,
} from "../src/push/plan.js";
import type { DriverConfig } from "../src/config.js";
import type { BandeDraw } from "../src/types.js";
import type { PushState } from "../src/push/state.js";

// ── a fake Supabase that models upsert-on-conflict + eq filtering ─────────────
// Enough of the client surface for DbPushLedger / DbPushStateSink: one in-memory
// store per table, keyed by the onConflict columns so an upsert REPLACES (never
// duplicates) the matching row — exactly the DB uniqueness constraint's effect.
class FakeSupabase implements SupabaseLike {
  readonly tables = new Map<string, Map<string, Record<string, unknown>>>();
  readonly upsertCalls: Array<{ table: string; onConflict: string }> = [];

  private store(table: string): Map<string, Record<string, unknown>> {
    let s = this.tables.get(table);
    if (!s) {
      s = new Map();
      this.tables.set(table, s);
    }
    return s;
  }

  from(table: string) {
    const store = this.store(table);
    const upsertCalls = this.upsertCalls;
    return {
      select(_cols: string) {
        return {
          async eq(col: string, val: string) {
            const data = [...store.values()].filter((r) => String(r[col]) === String(val));
            return { data, error: null };
          },
        };
      },
      async upsert(row: Record<string, unknown>, opts: { onConflict: string }) {
        upsertCalls.push({ table, onConflict: opts.onConflict });
        const key = opts.onConflict
          .split(",")
          .map((c) => String(row[c.trim()]))
          .join("|");
        store.set(key, { ...row });
        return { error: null };
      },
    };
  }

  rows(table: string): Record<string, unknown>[] {
    return [...this.store(table).values()];
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "draws.synthetic.json");
function fixtureDraw(): BandeDraw {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as BandeDraw[])[0]!;
}

const CFG = {} as DriverConfig; // never used — the fake client is injected
const T = "t-1";

describe("DbPushLedger (durable, DB-backed reconcile)", () => {
  it("records a confirmed push and reads it back, scoped to its tournament", async () => {
    const fake = new FakeSupabase();
    const ledger = new DbPushLedger(CFG, T, fake);
    // A different tournament's row must NOT leak into this ledger's list().
    await new DbPushLedger(CFG, "other", fake).record(bracketLedgerEntry("Other Div", "t0"));

    await ledger.record(bracketLedgerEntry("Mens Doubles Skill: (3.0 To 3.49)", "t1"));
    const entries = await ledger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("bracket");
  });

  it("upserts on (tournament_id, kind, entry_key) — a re-run never double-records", async () => {
    const fake = new FakeSupabase();
    const ledger = new DbPushLedger(CFG, T, fake);
    const entry = bracketLedgerEntry("Mens Doubles Skill: (3.0 To 3.49)", "t1");

    await ledger.record(entry);
    await ledger.record(entry); // idempotent re-run of the same confirmed push

    expect(fake.upsertCalls).toHaveLength(2); // called twice
    expect(fake.upsertCalls[0]!.onConflict).toBe("tournament_id,kind,entry_key");
    expect(await ledger.list()).toHaveLength(1); // …but exactly one row
    expect(fake.rows("pbcom_push_ledger")[0]!.division_key).toBe(
      "mens doubles skill: (3.0 to 3.49)",
    );
  });

  it("a CORRECTED score re-pushes into the SAME row (updated digest), not a duplicate", async () => {
    const fake = new FakeSupabase();
    const ledger = new DbPushLedger(CFG, T, fake);
    const draw = fixtureDraw();
    const teams = resolveTeams(draw.entries);
    const completed = draw.matches.find((m) => m.status === "completed")!;
    const identity = matchIdentity(
      draw.division.sourceDivisionLabel ?? draw.division.name,
      completed,
      teams,
    );

    await ledger.record({ key: identity, kind: "score", scoreDigest: "9-11/w:b", pushedAt: "t1" });
    await ledger.record({ key: identity, kind: "score", scoreDigest: "11-6/w:a", pushedAt: "t2" });

    const entries = await ledger.list();
    const scores = entries.filter((e) => e.kind === "score");
    expect(scores).toHaveLength(1);
    expect(scores[0]!.scoreDigest).toBe("11-6/w:a");
  });

  it("closes the reconcile loop: after recording the plan, a re-plan pushes nothing", async () => {
    const fake = new FakeSupabase();
    const ledger = new DbPushLedger(CFG, T, fake);
    const draw = fixtureDraw();
    const label = draw.division.sourceDivisionLabel ?? draw.division.name;

    // First run: record the bracket + every confirmed score from the plan.
    const first = computePlan(draw, await ledger.list());
    expect(first.bracketToCreate).toBe(true);
    if (first.bracketToCreate) await ledger.record(bracketLedgerEntry(label, "t1"));
    for (const s of first.scoresToPush) await ledger.record(scoreLedgerEntry(s, "t1"));

    // Second run: the durable ledger now shows those pushes → only the delta.
    const second = computePlan(draw, await ledger.list());
    expect(second.bracketToCreate).toBe(false);
    expect(second.scoresToPush).toHaveLength(0);
    expect(second.alreadyPushed.length).toBe(first.scoresToPush.length);
  });
});

describe("DbPushStateSink (out-of-sync surface)", () => {
  it("upserts one row per (tournament, division), overwriting the prior state", async () => {
    const fake = new FakeSupabase();
    const sink = new DbPushStateSink(CFG, fake);
    const base = { tournamentId: T, divisionKey: "d", divisionLabel: "D" };

    await sink.record({ ...base, state: "running" as PushState });
    await sink.record({ ...base, state: "needs_attention" as PushState, detail: "session expired" });

    const rows = fake.rows("pbcom_push_state");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("needs_attention");
    expect(rows[0]!.detail).toBe("session expired");
  });
});
