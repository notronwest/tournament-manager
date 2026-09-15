import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { CheckInPrintModal } from "../../components/CheckInPrintModal";
import {
  buildCheckInRoster,
  filterCheckInRoster,
  type CheckInReg,
  type CheckInEventLite,
  type CheckInPlayerLite,
} from "../../lib/checkin";
import { SPOT_HOLDING_STATUSES } from "../../lib/registrationStatus";
import { displayHeading } from "./contactsUi";
import {
  ink,
  inkSoft,
  inkMuted,
  cream,
  rule,
  ruleSoft,
  courtGreen,
  successBg,
  successFg,
  bodyFontStack,
  ctaPrimaryStyle,
  ctaSecondaryStyle,
  inputStyle,
  statusPanelStyle,
  panelStyle,
} from "../../lib/publicTheme";

// Day-of front-desk check-in for ONE tournament. A player walks up, the desk
// searches their name, and one click marks them present for EVERY event
// they're in. See lib/checkin.ts for the (unit-tested) logic; this page is the
// data loading + the fast, keyboard-first desk UI on top of it.

// checked_in_at (migration 20260912120000) is newer than the generated types,
// so it's read via "*" (returned at runtime, cast to LoadedReg) and written
// through this untyped client — the repo's convention for a lagged column.
const untyped = supabase as unknown as SupabaseClient;

type Tournament = { id: string; name: string; slug: string; starts_at: string };

type LoadedReg = CheckInReg & {
  players: CheckInPlayerLite | null;
};

export default function CheckInPage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [events, setEvents] = useState<CheckInEventLite[]>([]);
  const [regs, setRegs] = useState<LoadedReg[]>([]);
  const [players, setPlayers] = useState<CheckInPlayerLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [busyPlayerId, setBusyPlayerId] = useState<string | null>(null);
  const [missingOnly, setMissingOnly] = useState(false);
  const [showPrint, setShowPrint] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!org || !tournamentSlug) return;
    let cancelled = false;
    (async () => {
      const { data: t, error: tErr } = await supabase
        .from("tournaments")
        .select("id, name, slug, starts_at")
        .eq("organization_id", org.id)
        .eq("slug", tournamentSlug)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (tErr || !t) {
        setError(tErr?.message ?? "Tournament not found.");
        setLoading(false);
        return;
      }
      const [evRes, regRes] = await Promise.all([
        supabase
          .from("events")
          .select("id, name")
          .eq("tournament_id", t.id)
          .is("deleted_at", null)
          .order("name"),
        supabase
          .from("event_registrations")
          .select(
            "*, players(id, first_name, last_name, email, phone), events!inner(tournament_id)",
          )
          .eq("events.tournament_id", t.id)
          .is("deleted_at", null)
          .in("status", SPOT_HOLDING_STATUSES),
      ]);
      if (cancelled) return;
      if (evRes.error || regRes.error) {
        setError(
          evRes.error?.message ??
            regRes.error?.message ??
            "Could not load check-in.",
        );
        setLoading(false);
        return;
      }
      const loaded = (regRes.data ?? []) as unknown as LoadedReg[];
      setTournament(t as Tournament);
      setEvents((evRes.data ?? []) as CheckInEventLite[]);
      setRegs(loaded);
      // One CheckInPlayerLite per distinct player_id.
      const byId = new Map<string, CheckInPlayerLite>();
      for (const r of loaded) if (r.players) byId.set(r.players.id, r.players);
      setPlayers([...byId.values()]);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [org, tournamentSlug, reloadKey]);

  const roster = useMemo(
    () => buildCheckInRoster(players, regs, events),
    [players, regs, events],
  );
  const checkedInCount = useMemo(
    () => roster.filter((e) => e.checkedIn).length,
    [roster],
  );
  const missing = useMemo(
    () => roster.filter((e) => !e.checkedIn),
    [roster],
  );

  const visible = useMemo(() => {
    const base = missingOnly ? missing : roster;
    return filterCheckInRoster(base, query);
  }, [roster, missing, missingOnly, query]);

  async function setCheckedIn(regIds: string[], value: string | null) {
    if (regIds.length === 0) return;
    const { error: updErr } = await untyped
      .from("event_registrations")
      .update({ checked_in_at: value })
      .in("id", regIds);
    if (updErr) throw updErr;
  }

  const onCheckIn = async (playerId: string, regIds: string[]) => {
    setBusyPlayerId(playerId);
    setError(null);
    try {
      await setCheckedIn(regIds, new Date().toISOString());
      // Optimistic local update so the desk sees it instantly.
      const now = new Date().toISOString();
      setRegs((prev) =>
        prev.map((r) =>
          regIds.includes(r.id) ? { ...r, checked_in_at: now } : r,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check-in failed.");
      setReloadKey((k) => k + 1);
    } finally {
      setBusyPlayerId(null);
    }
  };

  const onUndo = async (playerId: string, regIds: string[]) => {
    setBusyPlayerId(playerId);
    setError(null);
    try {
      await setCheckedIn(regIds, null);
      setRegs((prev) =>
        prev.map((r) =>
          regIds.includes(r.id) ? { ...r, checked_in_at: null } : r,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Undo failed.");
      setReloadKey((k) => k + 1);
    } finally {
      setBusyPlayerId(null);
    }
  };

  // Enter in the search box checks in the top not-yet-checked-in match — the
  // fast desk path: type a few letters, hit Enter, next player.
  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    const target = visible.find((r) => !r.checkedIn) ?? visible[0];
    if (target && !target.checkedIn && busyPlayerId === null) {
      void onCheckIn(target.playerId, target.regIds);
      setQuery("");
    }
  };

  if (!org) return null;
  if (error && !tournament) {
    return (
      <div style={{ fontFamily: bodyFontStack, color: ink }}>
        <div style={statusPanelStyle("danger")} role="alert">
          {error}
        </div>
      </div>
    );
  }
  if (loading || !tournament)
    return <div style={{ color: inkMuted }}>Loading…</div>;

  const base = `/admin/${org.slug}/tournaments/${tournament.slug}`;
  const total = roster.length;

  return (
    <div style={{ fontFamily: bodyFontStack, color: ink }}>
      <p style={{ margin: "0 0 6px", fontSize: 13 }}>
        <Link to={base} style={{ color: inkSoft }}>
          ← {tournament.name}
        </Link>
      </p>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={displayHeading}>Check-in</h1>
          <p
            style={{
              color: inkSoft,
              fontSize: 15,
              margin: "0 0 4px",
              maxWidth: 620,
              lineHeight: 1.55,
            }}
          >
            Find a player and check them in — it marks them present for every
            event they're registered in.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowPrint(true)}
          style={ctaSecondaryStyle}
        >
          Print check-in sheet
        </button>
      </div>

      {/* Running count */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          margin: "14px 0 16px",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: checkedInCount === total && total > 0 ? courtGreen : ink,
          }}
        >
          {checkedInCount}
          <span style={{ color: inkMuted, fontWeight: 500 }}> / {total} checked in</span>
        </div>
        {total > 0 && (
          <button
            type="button"
            onClick={() => setMissingOnly((v) => !v)}
            style={{
              ...ctaSecondaryStyle,
              padding: "6px 12px",
              fontSize: 13,
              ...(missingOnly
                ? { background: cream, borderColor: ruleSoft }
                : {}),
            }}
          >
            {missingOnly
              ? "Showing missing only"
              : `Show still missing (${missing.length})`}
          </button>
        )}
      </div>

      {error && (
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 14 }} role="alert">
          {error}
        </div>
      )}

      <input
        ref={searchRef}
        type="search"
        placeholder="Search name, email, or phone…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onSearchKeyDown}
        autoFocus
        aria-label="Search players to check in"
        style={{ ...inputStyle, maxWidth: 460, marginBottom: 16, fontSize: 16 }}
      />

      {total === 0 ? (
        <div
          style={{
            border: `1px dashed ${rule}`,
            borderRadius: 10,
            padding: 28,
            textAlign: "center",
            color: inkMuted,
            background: cream,
          }}
        >
          Nobody is registered for this tournament yet.
        </div>
      ) : visible.length === 0 ? (
        <p style={{ color: inkMuted }}>
          {missingOnly && !query
            ? "Everyone is checked in. 🎉"
            : "No players match that search."}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {visible.map((entry) => (
            <div
              key={entry.playerId}
              style={{
                ...panelStyle,
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 14px",
                background: entry.checkedIn ? successBg : "#fff",
                borderColor: entry.checkedIn ? successFg : rule,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>
                  {entry.fullName}
                  {entry.checkedIn && (
                    <span style={{ color: successFg, marginLeft: 8, fontSize: 13 }}>
                      ✓ checked in
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12.5, color: inkMuted, marginTop: 2 }}>
                  {entry.events.map((e) => e.name).join(" · ")}
                </div>
                {(entry.email || entry.phone) && (
                  <div style={{ fontSize: 11.5, color: inkMuted, marginTop: 1 }}>
                    {[entry.email, entry.phone].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
              {entry.checkedIn ? (
                <button
                  type="button"
                  onClick={() => onUndo(entry.playerId, entry.regIds)}
                  disabled={busyPlayerId !== null}
                  style={{ ...ctaSecondaryStyle, padding: "8px 14px" }}
                >
                  {busyPlayerId === entry.playerId ? "…" : "Undo"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onCheckIn(entry.playerId, entry.regIds)}
                  disabled={busyPlayerId !== null}
                  style={{ ...ctaPrimaryStyle, padding: "8px 18px" }}
                >
                  {busyPlayerId === entry.playerId ? "…" : "Check in"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {showPrint && (
        <CheckInPrintModal
          tournamentName={tournament.name}
          startsAt={tournament.starts_at}
          entries={roster}
          onClose={() => setShowPrint(false)}
        />
      )}
    </div>
  );
}
