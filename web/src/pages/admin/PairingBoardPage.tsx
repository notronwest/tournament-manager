import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { ConfirmModal } from "../../components/ConfirmModal";
import type { Database } from "../../types/supabase";
import {
  ink,
  inkMuted,
  bg,
  rule,
  ruleSoft,
  courtBlue,
  courtRed,
  successBg,
  successFg,
  dangerBg,
  dangerFg,
  warnBg,
  warnFg,
  infoBg,
  infoBorder,
  infoFg,
  bodyFontStack,
} from "../../lib/publicTheme";

type Event = Database["public"]["Tables"]["events"]["Row"];
type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Player = Database["public"]["Tables"]["players"]["Row"];
type EventRegistration = Database["public"]["Tables"]["event_registrations"]["Row"];
type PartnerInvite = Database["public"]["Tables"]["partner_invites"]["Row"];

type Reg = EventRegistration & { player: Player };

type ConfirmedPair = {
  regA: Reg;
  regB: Reg;
  viaInvite: boolean;
};

export default function PairingBoardPage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug, eventId } = useParams<{
    tournamentSlug: string;
    eventId: string;
  }>();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [event, setEvent] = useState<Event | null>(null);
  const [regs, setRegs] = useState<Reg[]>([]);
  const [invites, setInvites] = useState<PartnerInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [selectedSideA, setSelectedSideA] = useState<string | null>(null);
  const [undoPair, setUndoPair] = useState<ConfirmedPair | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [autoMatchOpen, setAutoMatchOpen] = useState(false);
  const [autoMatching, setAutoMatching] = useState(false);

  const reload = useCallback(async () => {
    if (!org || !eventId || !tournamentSlug) return;
    setError(null);

    const { data: ev, error: evErr } = await supabase
      .from("events")
      .select("*, tournaments!inner(*)")
      .eq("id", eventId)
      .is("deleted_at", null)
      .maybeSingle();
    if (evErr) {
      setError(evErr.message);
      setLoading(false);
      return;
    }
    if (!ev) {
      setError("Event not found.");
      setLoading(false);
      return;
    }
    const t = (ev as { tournaments: Tournament | null }).tournaments;
    if (!t || t.organization_id !== org.id || t.slug !== tournamentSlug) {
      setError("Event not found in this tournament.");
      setLoading(false);
      return;
    }
    if (!ev.is_paired_roles) {
      setError("This event does not use paired roles.");
      setLoading(false);
      return;
    }
    setTournament(t);
    setEvent(ev as Event);

    const { data: regsData, error: regsErr } = await supabase
      .from("event_registrations")
      .select("*")
      .eq("event_id", eventId)
      .is("deleted_at", null)
      .not("status", "in", "(cancelled,refunded)")
      .order("registered_at", { ascending: true });
    if (regsErr) {
      setError(regsErr.message);
      setLoading(false);
      return;
    }

    const playerIds = Array.from(
      new Set((regsData ?? []).map((r) => r.player_id)),
    );
    let playersData: Player[] = [];
    if (playerIds.length > 0) {
      const { data, error: pErr } = await supabase
        .from("players")
        .select("*")
        .in("id", playerIds);
      if (pErr) {
        setError(pErr.message);
        setLoading(false);
        return;
      }
      playersData = data ?? [];
    }

    const { data: invitesData } = await supabase
      .from("partner_invites")
      .select("*")
      .eq("event_id", eventId)
      .eq("status", "accepted");

    const playerById = new Map(playersData.map((p) => [p.id, p]));
    const enriched: Reg[] = (regsData ?? [])
      .map((r) => ({ ...r, player: playerById.get(r.player_id)! }))
      .filter((r) => r.player != null);

    setRegs(enriched);
    setInvites(invitesData ?? []);
    setLoading(false);
  }, [org, eventId, tournamentSlug]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const acceptedInvitePairs = useMemo(() => {
    const pairs = new Set<string>();
    for (const inv of invites) {
      if (inv.inviter_player_id && inv.invitee_player_id) {
        pairs.add(`${inv.inviter_player_id}:${inv.invitee_player_id}`);
        pairs.add(`${inv.invitee_player_id}:${inv.inviter_player_id}`);
      }
    }
    return pairs;
  }, [invites]);

  const { confirmedPairs, unpairedA, unpairedB } = useMemo(() => {
    const regById = new Map(regs.map((r) => [r.id, r]));
    const seen = new Set<string>();
    const confirmedPairs: ConfirmedPair[] = [];
    const unpairedA: Reg[] = [];
    const unpairedB: Reg[] = [];

    for (const r of regs) {
      if (seen.has(r.id)) continue;
      if (r.partner_registration_id) {
        const partner = regById.get(r.partner_registration_id);
        if (partner && !seen.has(partner.id)) {
          seen.add(r.id);
          seen.add(partner.id);
          const sideA =
            r.registration_side === "a"
              ? r
              : partner.registration_side === "a"
                ? partner
                : r;
          const sideB =
            r.registration_side === "b"
              ? r
              : partner.registration_side === "b"
                ? partner
                : partner;
          const viaInvite = acceptedInvitePairs.has(
            `${sideA.player_id}:${sideB.player_id}`,
          );
          confirmedPairs.push({ regA: sideA, regB: sideB, viaInvite });
        } else if (!partner) {
          seen.add(r.id);
          if (r.registration_side === "a") unpairedA.push(r);
          else if (r.registration_side === "b") unpairedB.push(r);
        }
      } else {
        seen.add(r.id);
        if (r.registration_side === "a") unpairedA.push(r);
        else if (r.registration_side === "b") unpairedB.push(r);
      }
    }

    return { confirmedPairs, unpairedA, unpairedB };
  }, [regs, acceptedInvitePairs]);

  const totalPairable = Math.min(unpairedA.length, unpairedB.length);

  const onPair = async (sideAReg: Reg, sideBReg: Reg) => {
    setBusy(true);
    setError(null);
    const [resA, resB] = await Promise.all([
      supabase
        .from("event_registrations")
        .update({
          partner_registration_id: sideBReg.id,
          partner_status: "confirmed",
        })
        .eq("id", sideAReg.id),
      supabase
        .from("event_registrations")
        .update({
          partner_registration_id: sideAReg.id,
          partner_status: "confirmed",
        })
        .eq("id", sideBReg.id),
    ]);
    const firstErr = [resA, resB].find((r) => r.error)?.error;
    setBusy(false);
    if (firstErr) {
      setError(firstErr.message);
      return;
    }
    setSelectedSideA(null);
    await reload();
  };

  const onUndo = async (pair: ConfirmedPair) => {
    setUndoing(true);
    setError(null);
    const [resA, resB] = await Promise.all([
      supabase
        .from("event_registrations")
        .update({ partner_registration_id: null, partner_status: "seeking" })
        .eq("id", pair.regA.id),
      supabase
        .from("event_registrations")
        .update({ partner_registration_id: null, partner_status: "seeking" })
        .eq("id", pair.regB.id),
    ]);
    const firstErr = [resA, resB].find((r) => r.error)?.error;
    setUndoing(false);
    if (firstErr) {
      setError(firstErr.message);
      setUndoPair(null);
      return;
    }
    setUndoPair(null);
    await reload();
  };

  const onAutoMatch = async () => {
    setAutoMatching(true);
    setError(null);
    const pairs: [Reg, Reg][] = unpairedA
      .slice(0, unpairedB.length)
      .map((a, i) => [a, unpairedB[i]]);
    for (const [sideA, sideB] of pairs) {
      const [resA, resB] = await Promise.all([
        supabase
          .from("event_registrations")
          .update({
            partner_registration_id: sideB.id,
            partner_status: "confirmed",
          })
          .eq("id", sideA.id),
        supabase
          .from("event_registrations")
          .update({
            partner_registration_id: sideA.id,
            partner_status: "confirmed",
          })
          .eq("id", sideB.id),
      ]);
      const err = [resA, resB].find((r) => r.error)?.error;
      if (err) {
        setError(err.message);
        setAutoMatching(false);
        setAutoMatchOpen(false);
        await reload();
        return;
      }
    }
    setAutoMatching(false);
    setAutoMatchOpen(false);
    await reload();
  };

  if (!org) return null;
  if (loading)
    return <div style={{ color: inkMuted, fontSize: 14 }}>Loading…</div>;
  if (!event || !tournament) {
    return (
      <div
        style={{
          padding: 12,
          background: dangerBg,
          border: `1px solid ${courtRed}`,
          borderRadius: 6,
          color: dangerFg,
          fontSize: 13,
        }}
      >
        {error ?? "Event not found."}
      </div>
    );
  }

  const sideALabel = event.side_a_label;
  const sideBLabel = event.side_b_label;

  const selectedReg = regs.find((r) => r.id === selectedSideA) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <div>
        <Link
          to={`/admin/${org.slug}/tournaments/${tournament.slug}/events/${event.id}`}
          style={{ color: courtBlue, textDecoration: "none", fontSize: 13 }}
        >
          ← {event.name}
        </Link>
        <h1 style={{ margin: "12px 0 4px", fontSize: 22, color: ink }}>
          Pair teams
        </h1>
        <p style={{ margin: 0, fontSize: 13, color: inkMuted }}>
          {sideALabel} + {sideBLabel}
        </p>
      </div>

      {/* Summary */}
      <div
        style={{
          display: "flex",
          gap: 24,
          padding: "12px 16px",
          background: bg,
          border: `1px solid ${rule}`,
          borderRadius: 6,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <Stat
          label="Teams confirmed"
          value={`${confirmedPairs.length} of ${confirmedPairs.length + Math.max(unpairedA.length, unpairedB.length)}`}
        />
        <Stat
          label={`Unpaired ${sideALabel}`}
          value={String(unpairedA.length)}
          highlight={unpairedA.length > 0}
        />
        <Stat
          label={`Unpaired ${sideBLabel}`}
          value={String(unpairedB.length)}
          highlight={unpairedB.length > 0}
        />
        {unpairedA.length !== unpairedB.length &&
          (unpairedA.length > 0 || unpairedB.length > 0) && (
            <div
              style={{
                padding: "4px 10px",
                background: warnBg,
                color: warnFg,
                borderRadius: 4,
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              {Math.abs(unpairedA.length - unpairedB.length)} more{" "}
              {unpairedA.length > unpairedB.length ? sideALabel : sideBLabel}{" "}
              than{" "}
              {unpairedA.length > unpairedB.length ? sideBLabel : sideALabel}
            </div>
          )}
      </div>

      {error && (
        <div
          style={{
            padding: 10,
            background: dangerBg,
            border: `1px solid ${courtRed}`,
            borderRadius: 6,
            color: dangerFg,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {/* Unpaired columns */}
      <section>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: ink }}>
            Unpaired registrants
          </h2>
          {totalPairable > 0 && (
            <button
              onClick={() => setAutoMatchOpen(true)}
              disabled={busy}
              style={secondaryBtnStyle}
            >
              Auto-match {totalPairable} pair
              {totalPairable === 1 ? "" : "s"}
            </button>
          )}
        </div>

        {selectedReg && (
          <div
            style={{
              padding: "8px 12px",
              background: infoBg,
              border: `1px solid ${infoBorder}`,
              borderRadius: 6,
              fontSize: 13,
              color: infoFg,
              marginBottom: 12,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span>
              <strong>
                {selectedReg.player.first_name} {selectedReg.player.last_name}
              </strong>{" "}
              selected — click a {sideBLabel} below to pair them.
            </span>
            <button
              onClick={() => setSelectedSideA(null)}
              style={cancelBtnStyle}
            >
              Cancel
            </button>
          </div>
        )}

        {unpairedA.length === 0 && unpairedB.length === 0 ? (
          <div style={emptyStyle}>All registrants are paired.</div>
        ) : (
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}
          >
            {/* Side A */}
            <div>
              <div style={colHeaderStyle}>{sideALabel}</div>
              {unpairedA.length === 0 ? (
                <div style={emptyStyle}>No unpaired {sideALabel}.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {unpairedA.map((r) => {
                    const isSelected = selectedSideA === r.id;
                    return (
                      <button
                        key={r.id}
                        onClick={() =>
                          setSelectedSideA(isSelected ? null : r.id)
                        }
                        disabled={busy}
                        style={registrantTileStyle(isSelected, false)}
                      >
                        <span style={{ fontWeight: 500 }}>
                          {r.player.first_name} {r.player.last_name}
                        </span>
                        {isSelected && (
                          <span
                            style={{ fontSize: 11, color: courtBlue, flexShrink: 0 }}
                          >
                            selected
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Side B */}
            <div>
              <div style={colHeaderStyle}>{sideBLabel}</div>
              {unpairedB.length === 0 ? (
                <div style={emptyStyle}>No unpaired {sideBLabel}.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {unpairedB.map((r) => {
                    const canPair = selectedSideA !== null && !busy;
                    return (
                      <button
                        key={r.id}
                        onClick={() => {
                          if (!selectedSideA) return;
                          const sideA = regs.find(
                            (a) => a.id === selectedSideA,
                          );
                          if (sideA) void onPair(sideA, r);
                        }}
                        disabled={!canPair}
                        title={
                          selectedSideA
                            ? `Pair with ${selectedReg?.player.first_name ?? "selected"}`
                            : `Select a ${sideALabel} first`
                        }
                        style={registrantTileStyle(false, canPair)}
                      >
                        <span style={{ fontWeight: 500 }}>
                          {r.player.first_name} {r.player.last_name}
                        </span>
                        {canPair && (
                          <span
                            style={{
                              fontSize: 11,
                              color: successFg,
                              flexShrink: 0,
                            }}
                          >
                            click to pair
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Confirmed teams */}
      <section>
        <h2 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 600, color: ink }}>
          Confirmed teams ({confirmedPairs.length})
        </h2>
        {confirmedPairs.length === 0 ? (
          <div style={emptyStyle}>
            No confirmed teams yet — pair registrants above.
          </div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={tableHeadRow}>
                <th style={thStyle}>{sideALabel}</th>
                <th style={thStyle}>{sideBLabel}</th>
                <th style={{ ...thStyle, width: 110 }}>Formed by</th>
                <th style={{ ...thStyle, width: 70 }} />
              </tr>
            </thead>
            <tbody>
              {confirmedPairs.map((pair) => (
                <tr
                  key={`${pair.regA.id}-${pair.regB.id}`}
                  style={tableRow}
                >
                  <td style={tdStyle}>
                    <span style={{ fontWeight: 500 }}>
                      {pair.regA.player.first_name} {pair.regA.player.last_name}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={{ fontWeight: 500 }}>
                      {pair.regB.player.first_name} {pair.regB.player.last_name}
                    </span>
                  </td>
                  <td style={{ ...tdStyle, color: inkMuted, fontSize: 12 }}>
                    {pair.viaInvite ? "Invite" : "Organizer"}
                  </td>
                  <td style={tdStyle}>
                    <button
                      onClick={() => setUndoPair(pair)}
                      style={tinyDangerBtnStyle}
                    >
                      Undo
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {undoPair && (
        <ConfirmModal
          title="Undo this pairing?"
          body={
            <div>
              <strong>
                {undoPair.regA.player.first_name}{" "}
                {undoPair.regA.player.last_name}
              </strong>{" "}
              and{" "}
              <strong>
                {undoPair.regB.player.first_name}{" "}
                {undoPair.regB.player.last_name}
              </strong>{" "}
              will return to the unpaired queue.
              {undoPair.viaInvite && (
                <div
                  style={{
                    marginTop: 8,
                    padding: "6px 10px",
                    background: warnBg,
                    borderRadius: 4,
                    fontSize: 12,
                    color: warnFg,
                  }}
                >
                  This team was formed via the partner-invite flow. Breaking it
                  means they will need to re-invite each other.
                </div>
              )}
            </div>
          }
          confirmLabel={undoing ? "Undoing…" : "Undo pairing"}
          onCancel={() => setUndoPair(null)}
          onConfirm={() => void onUndo(undoPair)}
        />
      )}

      {autoMatchOpen && (
        <ConfirmModal
          title={`Auto-match ${totalPairable} pair${totalPairable === 1 ? "" : "s"}?`}
          body={
            <div>
              The first {totalPairable} unpaired {sideALabel} and {sideBLabel}{" "}
              registrants will be paired in sign-up order. You can undo
              individual matches afterward.
              {unpairedA.length !== unpairedB.length && (
                <div
                  style={{ marginTop: 8, color: inkMuted, fontSize: 12 }}
                >
                  {Math.abs(unpairedA.length - unpairedB.length)}{" "}
                  {unpairedA.length > unpairedB.length
                    ? sideALabel
                    : sideBLabel}{" "}
                  registrant
                  {Math.abs(unpairedA.length - unpairedB.length) === 1
                    ? ""
                    : "s"}{" "}
                  will remain unpaired.
                </div>
              )}
            </div>
          }
          confirmLabel={
            autoMatching ? "Matching…" : `Auto-match ${totalPairable}`
          }
          onCancel={() => setAutoMatchOpen(false)}
          onConfirm={() => void onAutoMatch()}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          color: inkMuted,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: highlight ? courtRed : ink,
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────

const colHeaderStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: inkMuted,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  marginBottom: 6,
  padding: "0 4px",
};

const emptyStyle: CSSProperties = {
  padding: 16,
  textAlign: "center",
  background: bg,
  border: `1px dashed ${rule}`,
  borderRadius: 6,
  color: inkMuted,
  fontSize: 13,
};

function registrantTileStyle(
  isSelected: boolean,
  readyToPair: boolean,
): CSSProperties {
  return {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 12px",
    borderRadius: 6,
    border: `1px solid ${isSelected ? courtBlue : readyToPair ? successFg : rule}`,
    background: isSelected ? "#eff6ff" : readyToPair ? successBg : "#ffffff",
    cursor: isSelected || readyToPair ? "pointer" : "default",
    textAlign: "left",
    width: "100%",
    fontSize: 14,
    fontFamily: bodyFontStack,
    color: ink,
    transition: "border-color 0.1s, background 0.1s",
  };
}

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 14,
};

const tableHeadRow: CSSProperties = {
  background: bg,
  borderBottom: `1px solid ${rule}`,
};

const tableRow: CSSProperties = {
  borderBottom: `1px solid ${ruleSoft}`,
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  fontSize: 11,
  color: inkMuted,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  fontWeight: 500,
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
};

const secondaryBtnStyle: CSSProperties = {
  padding: "8px 16px",
  background: "#ffffff",
  color: ink,
  border: `1px solid ${rule}`,
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: bodyFontStack,
};

const cancelBtnStyle: CSSProperties = {
  padding: "4px 10px",
  background: "transparent",
  color: inkMuted,
  border: `1px solid ${rule}`,
  borderRadius: 4,
  fontSize: 12,
  cursor: "pointer",
  fontFamily: bodyFontStack,
  flexShrink: 0,
};

const tinyDangerBtnStyle: CSSProperties = {
  padding: "4px 10px",
  background: "#ffffff",
  color: dangerFg,
  border: `1px solid ${courtRed}`,
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: bodyFontStack,
};

