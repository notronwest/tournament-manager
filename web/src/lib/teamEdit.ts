// teamEdit.ts — decision logic for the event-console Teams editor.
//
// Extracted from EventConsolePage's `saveEdit` so the branch selection
// for Player B can be unit-tested. The component still owns the actual
// DB writes; this module only decides *which* write a doubles-team edit
// must perform for Player B given the team's current partner state and
// the newly-chosen player.
//
// Regression it guards (see resolvePartnerBAction "create-partner"):
// editing a partnerless team (a solo / partner-seeker: partner_status
// 'seeking', partner_registration_id null), picking a Player B, and
// saving used to silently no-op — the old code only had an UPDATE path
// for an *existing* partner registration and no CREATE path when none
// existed, so the selection was dropped with no write and no error.

export type PartnerBAction =
  // Nothing to write: singles event, or the chosen Player B is already
  // the team's partner (unchanged).
  | { kind: "none" }
  // Team already has a partner registration; only its player_id changed.
  | { kind: "update-player"; partnerRegId: string }
  // Team has no partner yet (solo / partner-seeker): create the partner
  // registration and link both directions, mirroring the Add Team flow.
  | { kind: "create-partner" };

export interface ResolvePartnerBInput {
  /** Whether the event is a doubles format (singles has no Player B). */
  isDoubles: boolean;
  /** The team's existing partner registration id, or null if none yet. */
  partnerRegId: string | null;
  /** The player id currently linked as the partner, or null if none. */
  currentPartnerPlayerId: string | null;
  /** The player id selected for Player B in the edit form. */
  selectedPlayerBId: string;
}

/**
 * Decide what write (if any) Player B needs on save.
 *
 * A team counts as having an existing partner only when BOTH the partner
 * registration id and its current player id are known — mirroring the
 * component's original `team.partnerRegId && team.partner` gate. A row
 * with a dangling partnerRegId but no resolvable partner player is
 * treated as partnerless (create), which is the safe reproduction of the
 * previous behaviour once the create path exists.
 */
export function resolvePartnerBAction(
  input: ResolvePartnerBInput,
): PartnerBAction {
  const {
    isDoubles,
    partnerRegId,
    currentPartnerPlayerId,
    selectedPlayerBId,
  } = input;

  if (!isDoubles) return { kind: "none" };

  const hasExistingPartner =
    partnerRegId !== null && currentPartnerPlayerId !== null;

  if (hasExistingPartner) {
    return selectedPlayerBId === currentPartnerPlayerId
      ? { kind: "none" }
      : { kind: "update-player", partnerRegId };
  }

  return { kind: "create-partner" };
}
