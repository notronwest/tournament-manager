import { useState } from "react";
import { ConfirmModal } from "./ConfirmModal";
import {
  pairAndResolveInvites,
  notifyRegistrationChange,
} from "../lib/registrations";
import {
  ink,
  inkMuted,
  inkSoft,
  courtBlue,
  infoBg,
  warnBg,
  warnFg,
  dangerFg,
  rule,
  bodyFontStack,
} from "../lib/publicTheme";

import {
  isMixedCompatible,
  genderLabel,
  seekerRating,
  seekerFullName as fullName,
  type Seeker,
  type PairableEvent,
} from "../lib/partnerPairing";

// Organizer pairs one partner-seeker with another seeker in the SAME
// division. Wraps ConfirmModal (the app's one modal primitive) around a
// single-select list; confirming writes the pairing through
// pairAndResolveInvites (both regs → confirmed, any pending invite between
// the two removed) — the same call the Manage editor uses.
export function PairSeekersModal({
  event,
  seeker,
  candidates,
  onClose,
  onPaired,
}: {
  event: PairableEvent;
  seeker: Seeker;
  candidates: Seeker[];
  onClose: () => void;
  onPaired: () => void | Promise<void>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set once the pairing is saved. If the follow-up email couldn't reach
  // everyone we stay open to say so; the primary button then just closes.
  const [paired, setPaired] = useState(false);

  const sorted = [...candidates].sort((a, b) => {
    const okA = isMixedCompatible(event, seeker.player, a.player) ? 0 : 1;
    const okB = isMixedCompatible(event, seeker.player, b.player) ? 0 : 1;
    if (okA !== okB) return okA - okB;
    return fullName(a.player).localeCompare(fullName(b.player));
  });

  const onConfirm = async () => {
    if (paired) {
      onClose();
      return;
    }
    const pick = sorted.find((c) => c.regId === selected);
    if (!pick) {
      setError("Choose who to pair them with.");
      return;
    }
    setError(null);
    try {
      await pairAndResolveInvites(
        seeker.regId,
        pick.regId,
        event.id,
        seeker.playerId,
        pick.playerId,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setPaired(true);
    await onPaired();

    // Same email the Manage editor sends after an organizer pairing
    // (notify-registration-change, "partner_assigned" → both players). The
    // pairing is already saved; a mail problem only changes what we say.
    try {
      const res = await notifyRegistrationChange({
        registrationId: seeker.regId,
        change: "partner_assigned",
      });
      if (res.skipped.length > 0) {
        setError(
          `Paired. Emailed ${res.emailed.length ? res.emailed.join(", ") : "nobody"}; couldn't email the ${res.skipped
            .map((s) => `${s.who} (${s.reason})`)
            .join(", ")}. Let them know another way.`,
        );
        return;
      }
    } catch (e) {
      setError(
        `Paired, but the email didn't go out: ${e instanceof Error ? e.message : String(e)}. Let them know another way.`,
      );
      return;
    }
    onClose();
  };

  return (
    <ConfirmModal
      title={`Pair ${fullName(seeker.player)} in ${event.name}`}
      destructive={false}
      confirmLabel={paired ? "Done" : "Pair these two"}
      onCancel={onClose}
      onConfirm={onConfirm}
      body={
        <div style={{ fontFamily: bodyFontStack }}>
          <p style={{ margin: "0 0 10px", fontSize: 13, color: inkSoft }}>
            Other players looking for a partner in this division. Both will
            show as a confirmed team right away and get an email naming their
            new partner.
            {event.gender === "mixed" && (
              <> Mixed doubles needs one man and one woman.</>
            )}
          </p>
          {sorted.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: inkMuted }}>
              Nobody else is looking for a partner in {event.name} yet.
            </p>
          ) : (
            <div
              role="radiogroup"
              aria-label="Choose a partner"
              style={{ display: "flex", flexDirection: "column", gap: 6 }}
            >
              {sorted.map((c) => {
                const ok = isMixedCompatible(event, seeker.player, c.player);
                const active = selected === c.regId;
                const g = genderLabel(c.player.gender);
                const rating = seekerRating(event, c.player);
                return (
                  <button
                    key={c.regId}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={!ok}
                    onClick={() => {
                      setSelected(c.regId);
                      setError(null);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      width: "100%",
                      minHeight: 44,
                      padding: "8px 12px",
                      textAlign: "left",
                      background: active ? infoBg : "var(--surface)",
                      border: `1px solid ${active ? courtBlue : rule}`,
                      borderRadius: 6,
                      color: ok ? ink : inkMuted,
                      cursor: ok ? "pointer" : "not-allowed",
                      opacity: ok ? 1 : 0.7,
                      fontFamily: bodyFontStack,
                      fontSize: 14,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: "50%",
                        border: `2px solid ${active ? courtBlue : rule}`,
                        background: active ? courtBlue : "transparent",
                        flex: "0 0 auto",
                      }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 600 }}>{fullName(c.player)}</span>
                      <span style={{ color: inkMuted, fontSize: 12, marginLeft: 8 }}>
                        {[g, rating].filter(Boolean).join(" · ")}
                      </span>
                      {!ok && (
                        <span
                          style={{
                            display: "block",
                            marginTop: 2,
                            fontSize: 12,
                            color: warnFg,
                            background: warnBg,
                            padding: "1px 6px",
                            borderRadius: 4,
                            width: "fit-content",
                          }}
                        >
                          Same gender — not a mixed pairing
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {error && (
            <p style={{ margin: "10px 0 0", fontSize: 13, color: dangerFg }}>
              {error}
            </p>
          )}
        </div>
      }
    />
  );
}
