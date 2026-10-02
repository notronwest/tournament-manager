import { describe, it, expect } from "vitest";
import { resolvePartnerBAction } from "./teamEdit";

describe("resolvePartnerBAction", () => {
  it("singles events never touch Player B", () => {
    expect(
      resolvePartnerBAction({
        isDoubles: false,
        partnerRegId: null,
        currentPartnerPlayerId: null,
        selectedPlayerBId: "player-b",
      }),
    ).toEqual({ kind: "none" });
  });

  // The regression: a solo / partner-seeker (partner_status 'seeking',
  // partner_registration_id null) gets a Player B assigned on save. The
  // old code had no CREATE path, so this selection was silently dropped.
  it("creates a partner when the team has no partner yet", () => {
    expect(
      resolvePartnerBAction({
        isDoubles: true,
        partnerRegId: null,
        currentPartnerPlayerId: null,
        selectedPlayerBId: "laurie",
      }),
    ).toEqual({ kind: "create-partner" });
  });

  it("updates player_id when an existing partner is swapped", () => {
    expect(
      resolvePartnerBAction({
        isDoubles: true,
        partnerRegId: "reg-b",
        currentPartnerPlayerId: "old-partner",
        selectedPlayerBId: "new-partner",
      }),
    ).toEqual({ kind: "update-player", partnerRegId: "reg-b" });
  });

  it("does nothing when the existing partner is unchanged", () => {
    expect(
      resolvePartnerBAction({
        isDoubles: true,
        partnerRegId: "reg-b",
        currentPartnerPlayerId: "same-partner",
        selectedPlayerBId: "same-partner",
      }),
    ).toEqual({ kind: "none" });
  });

  // A dangling partner reg id with no resolvable partner player is
  // treated as partnerless (create) — mirrors the component's original
  // `team.partnerRegId && team.partner` gate, now with a create path.
  it("treats a reg id without a resolved partner player as partnerless", () => {
    expect(
      resolvePartnerBAction({
        isDoubles: true,
        partnerRegId: "reg-b",
        currentPartnerPlayerId: null,
        selectedPlayerBId: "laurie",
      }),
    ).toEqual({ kind: "create-partner" });
  });
});
