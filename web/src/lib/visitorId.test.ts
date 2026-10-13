import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getOrCreateVisitorId } from "./visitorId";

// No jsdom in this project's vitest setup (it's node-environment, pure-fn
// style tests only) — stub just enough of the Storage interface to exercise
// the real getItem/setItem/catch branches without adding a jsdom dependency.
class FakeStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe("getOrCreateVisitorId", () => {
  let original: Storage | undefined;

  beforeEach(() => {
    original = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: Storage }).localStorage =
      new FakeStorage() as unknown as Storage;
  });

  afterEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = original;
  });

  it("mints a visitor id once and reuses it on later calls", () => {
    const first = getOrCreateVisitorId();
    const second = getOrCreateVisitorId();
    expect(first).toBe(second);
    expect(localStorage.getItem("wmpc_visitor_id")).toBe(first);
  });

  it("falls back to a fresh id (no throw) when storage is unavailable", () => {
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem() {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(() => getOrCreateVisitorId()).not.toThrow();
  });
});
