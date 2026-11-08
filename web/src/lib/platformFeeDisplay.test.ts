// The operator-facing half of the platform-fee screen: how a fee reads in a
// list row, and what a failed save says. Both are easy to regress into
// Postgres's own words, which is what these pin.
import { describe, expect, it } from "vitest";
import { formatFeeShort, platformFeeSaveMessage } from "./platformFeeDisplay";

describe("formatFeeShort", () => {
  it("drops a trailing .00 so a whole percent reads as one", () => {
    expect(formatFeeShort(500, 0)).toBe("5%");
    expect(formatFeeShort(1250, 0)).toBe("12.50%");
  });

  it("names the fixed part only when there is one", () => {
    expect(formatFeeShort(500, 50)).toBe("5% + $0.50");
    expect(formatFeeShort(0, 0)).toBe("0%");
  });
});

describe("platformFeeSaveMessage", () => {
  // The case that actually happens. A write the policy refuses updates zero
  // rows, and .single() turns that into PGRST116 / HTTP 406 — NOT a
  // "row-level security" string. Observed live by revoking platform-admin
  // mid-session. Matching only on the policy wording would drop the most
  // likely failure onto the generic fallback.
  it("reads a zero-rows refusal as the permission failure it is", () => {
    const msg = platformFeeSaveMessage({
      code: "PGRST116",
      message: "JSON object requested, multiple (or no) rows returned",
    });
    expect(msg).toContain("your account can't change platform fees");
    expect(msg).toContain("ask a platform admin");
  });

  it("reads an explicit policy refusal the same way", () => {
    expect(
      platformFeeSaveMessage({
        code: "42501",
        message: 'new row violates row-level security policy for table "organizations"',
      }),
    ).toContain("your account can't change platform fees");
  });

  it("names the allowed range when a constraint rejects the numbers", () => {
    expect(
      platformFeeSaveMessage({
        code: "23514",
        message: 'violates check constraint "org_platform_fee_bps_range"',
      }),
    ).toContain("between 0 and 100");
  });

  it("says to try again when the connection dropped", () => {
    expect(platformFeeSaveMessage({ message: "Failed to fetch" })).toContain(
      "the connection dropped",
    );
  });

  // The invariant that matters more than the wording: a failed save must
  // never leave the reader unsure whether the fee moved.
  it("every failure says the fee is unchanged, and none leaks the database's words", () => {
    const failures = [
      { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
      { code: "42501", message: 'new row violates row-level security policy for table "organizations"' },
      { code: "23514", message: 'violates check constraint "org_platform_fee_bps_range"' },
      { message: "Failed to fetch" },
      { code: "XX000", message: "something nobody has seen before" },
    ];
    for (const f of failures) {
      const msg = platformFeeSaveMessage(f);
      expect(msg, f.message).toMatch(/unchanged/);
      expect(msg, f.message).not.toMatch(/row-level security|constraint|PGRST|relation|table "/i);
    }
  });
});
