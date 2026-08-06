import { useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../../supabase";
import { useCurrentOrg } from "../../../hooks/useCurrentOrg";
import { ConfirmModal } from "../../../components/ConfirmModal";
import type { Database } from "../../../types/supabase";
import {
  courtBlue,
  courtRed,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  ctaSecondaryStyle,
  inkMuted,
  inkSoft,
  pageH1Style,
  panelStyle,
  panelMutedStyle,
  sectionH2Style,
  statusPanelStyle,
} from "../../../lib/publicTheme";

// ─────────────────────────────────────────────────────────────────────
// Platform-admin-only test tool. Seeds a throwaway tournament whose
// events each sit in an exact starting state for one "Manage
// registration" editor scenario, so Ron can click "Manage" on an
// attendee and exercise reassign / assign-partner / remove-partner /
// withdraw by hand on TEST. A "Tear down" button removes the whole
// thing.
//
// All writes go through the normal supabase client — the current user
// is platform admin (implicit owner on every org), so org-admin RLS
// permits the inserts into players / events / event_registrations /
// tournaments (same gate SeedEventPage relies on).
//
// Test data markers: tournament slug `reg-scenarios-test`, every seeded
// player email ends in `@scenario.test`, and names are prefixed so they
// read as obviously fake.
// ─────────────────────────────────────────────────────────────────────

const TOURNAMENT_SLUG = "reg-scenarios-test";
const TOURNAMENT_NAME = "Registration Scenarios (test)";

type RegStatus = Database["public"]["Enums"]["registration_status"];
type PartnerStatus = Database["public"]["Enums"]["partner_status"];
type EventFormat = Database["public"]["Enums"]["event_format"];

type PlayerKey =
  | "ray"
  | "nora"
  | "cal"
  | "dara"
  | "perry"
  | "eddie"
  | "nate"
  | "cody"
  | "tom"
  | "tina"
  | "wade"
  | "pete";

type PlayerSpec = { first: string; last: string };

// Global player records these scenarios reference. Some are registered
// into an event; a couple (nora, cody) exist only as reassign / assign
// targets with no registration of their own.
const PLAYERS: Record<PlayerKey, PlayerSpec> = {
  ray: { first: "Ray", last: "Reassign" },
  nora: { first: "Nora", last: "NotInEvent" },
  cal: { first: "Cal", last: "Collide" },
  dara: { first: "Dara", last: "Duplicate" },
  perry: { first: "Perry", last: "Primary" },
  eddie: { first: "Eddie", last: "Existing" },
  nate: { first: "Nate", last: "NeedsPartner" },
  cody: { first: "Cody", last: "Comp" },
  tom: { first: "Tom", last: "Team" },
  tina: { first: "Tina", last: "Team" },
  wade: { first: "Wade", last: "Paid" },
  pete: { first: "Pete", last: "Pending" },
};

function emailFor(key: PlayerKey): string {
  const p = PLAYERS[key];
  return `${p.first}.${p.last}@scenario.test`.toLowerCase();
}
function fullName(key: PlayerKey): string {
  const p = PLAYERS[key];
  return `${p.first} ${p.last}`;
}

type RegSpec = {
  player: PlayerKey;
  status: RegStatus;
  partner_status: PartnerStatus;
  // When set, both regs are paired via partner_registration_id after
  // insert (used for the confirmed-pair "Remove partner" scenario).
  pairWith?: PlayerKey;
};

type Scenario = {
  name: string;
  format: EventFormat;
  regs: RegSpec[];
  // Extra players that must exist (as global player records) but are NOT
  // registered in this event — the reassign / assign-new targets.
  extraPlayers?: PlayerKey[];
  note: string;
};

// One event per scenario, each seeded to an exact starting state. Event
// fee is 0 (comp / test data).
const SCENARIOS: Scenario[] = [
  {
    name: "Reassign — happy path",
    format: "doubles",
    regs: [{ player: "ray", status: "paid", partner_status: "solo" }],
    extraPlayers: ["nora"],
    note: "Reassign Ray's registration to Nora (exists as a player, not yet in the event).",
  },
  {
    name: "Reassign — collision",
    format: "doubles",
    regs: [
      { player: "cal", status: "paid", partner_status: "solo" },
      { player: "dara", status: "paid", partner_status: "solo" },
    ],
    note: "Reassigning Cal to Dara must be blocked — Dara is already registered here.",
  },
  {
    name: "Assign partner — existing",
    format: "doubles",
    regs: [
      { player: "perry", status: "paid", partner_status: "seeking" },
      { player: "eddie", status: "paid", partner_status: "seeking" },
    ],
    note: "Assign Eddie as Perry's partner — reuses Eddie's existing registration.",
  },
  {
    name: "Assign partner — new",
    format: "doubles",
    regs: [{ player: "nate", status: "paid", partner_status: "seeking" }],
    extraPlayers: ["cody"],
    note: "Assign Cody as Nate's partner — creates a comp $0 registration + pairs.",
  },
  {
    name: "Remove partner",
    format: "doubles",
    regs: [
      { player: "tom", status: "paid", partner_status: "confirmed", pairWith: "tina" },
      { player: "tina", status: "paid", partner_status: "confirmed", pairWith: "tom" },
    ],
    note: "Remove the partner from this confirmed Tom + Tina pair.",
  },
  {
    name: "Withdraw — paid",
    format: "singles",
    regs: [{ player: "wade", status: "paid", partner_status: "solo" }],
    note: "Withdraw ⇒ status becomes 'withdrawn'.",
  },
  {
    name: "Withdraw — pending",
    format: "singles",
    regs: [{ player: "pete", status: "pending_payment", partner_status: "solo" }],
    note: "Withdraw ⇒ status becomes 'cancelled'.",
  },
];

// Every player key referenced anywhere (registered or extra) — the set
// we ensure exists in the global players table before seeding.
const ALL_PLAYER_KEYS: PlayerKey[] = Array.from(
  new Set<PlayerKey>(
    SCENARIOS.flatMap((s) => [
      ...s.regs.map((r) => r.player),
      ...(s.extraPlayers ?? []),
    ]),
  ),
);

type SeedResult = {
  events: Array<{ name: string; players: string[]; note: string }>;
};

// Throw the raw Postgres message so the UI surfaces the real failure
// (mirrors SeedEventPage's error handling) rather than a generic string.
function assertOk(error: { message: string } | null, ctx: string): void {
  if (error) throw new Error(`${ctx}: ${error.message}`);
}

export default function SeedScenariosPage() {
  const { org } = useCurrentOrg();

  const [seedBusy, setSeedBusy] = useState(false);
  const [tearBusy, setTearBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SeedResult | null>(null);
  const [tornDown, setTornDown] = useState(false);
  const [confirmTeardown, setConfirmTeardown] = useState(false);

  const busy = seedBusy || tearBusy;
  const attendeesPath = org
    ? `/admin/${org.slug}/tournaments/${TOURNAMENT_SLUG}/attendees`
    : "";

  // ── Seed / reset ───────────────────────────────────────────────────
  const onSeed = async () => {
    if (!org || busy) return;
    setSeedBusy(true);
    setError(null);
    setResult(null);
    setTornDown(false);
    try {
      const tournamentId = await ensureTournament(org.id);
      const playerIdByKey = await ensurePlayers();
      const eventIdByName = await ensureEvents(tournamentId);

      const events: SeedResult["events"] = [];
      for (const scenario of SCENARIOS) {
        const eventId = eventIdByName.get(scenario.name);
        if (!eventId) throw new Error(`Missing seeded event: ${scenario.name}`);
        await resetEventRegs(eventId);
        await seedScenarioRegs(eventId, scenario, playerIdByKey);
        events.push({
          name: scenario.name,
          players: scenario.regs.map((r) => fullName(r.player)),
          note: scenario.note,
        });
      }
      setResult({ events });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSeedBusy(false);
    }
  };

  // ── Tear down ──────────────────────────────────────────────────────
  const onTearDown = async () => {
    if (!org || busy) return;
    setTearBusy(true);
    setError(null);
    setResult(null);
    try {
      // Find the tournament regardless of soft-delete state.
      const { data: tRows, error: tErr } = await supabase
        .from("tournaments")
        .select("id")
        .eq("organization_id", org.id)
        .eq("slug", TOURNAMENT_SLUG)
        .limit(1);
      assertOk(tErr, "Find tournament");
      const tournamentId = tRows?.[0]?.id;
      if (!tournamentId) {
        setTornDown(true);
        return;
      }

      // All events under it (incl. already soft-deleted).
      const { data: evRows, error: evErr } = await supabase
        .from("events")
        .select("id")
        .eq("tournament_id", tournamentId);
      assertOk(evErr, "List events");
      const eventIds = (evRows ?? []).map((e) => e.id);

      if (eventIds.length > 0) {
        // Hard-delete partner_invites for these events first.
        assertOk(
          (
            await supabase
              .from("partner_invites")
              .delete()
              .in("event_id", eventIds)
          ).error,
          "Delete partner invites",
        );
        // Null the partner self-FK before deleting so paired regs don't
        // trip the constraint, then hard-delete every registration.
        assertOk(
          (
            await supabase
              .from("event_registrations")
              .update({ partner_registration_id: null })
              .in("event_id", eventIds)
          ).error,
          "Unlink partners",
        );
        assertOk(
          (
            await supabase
              .from("event_registrations")
              .delete()
              .in("event_id", eventIds)
          ).error,
          "Delete registrations",
        );
        // Soft-delete the events.
        assertOk(
          (
            await supabase
              .from("events")
              .update({ deleted_at: new Date().toISOString() })
              .in("id", eventIds)
          ).error,
          "Soft-delete events",
        );
      }

      // Soft-delete the tournament.
      assertOk(
        (
          await supabase
            .from("tournaments")
            .update({ deleted_at: new Date().toISOString() })
            .eq("id", tournamentId)
        ).error,
        "Soft-delete tournament",
      );

      setTornDown(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTearBusy(false);
      setConfirmTeardown(false);
    }
  };

  if (!org) return null;

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={pageH1Style}>Seed registration scenarios</h1>
      <p style={{ color: inkSoft, fontSize: 15, lineHeight: 1.55, margin: "0 0 24px" }}>
        Seeds a throwaway tournament with a registration in each edit scenario,
        so you can exercise the Manage-registration editor. Platform-admin only;
        test data only. All players use <code>@scenario.test</code> emails.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
        <button
          type="button"
          onClick={onSeed}
          disabled={busy}
          style={busy ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
        >
          {seedBusy ? "Seeding…" : "Seed / reset scenarios"}
        </button>
        <button
          type="button"
          onClick={() => setConfirmTeardown(true)}
          disabled={busy}
          style={busy ? dangerDisabledStyle : dangerButtonStyle}
        >
          {tearBusy ? "Tearing down…" : "Tear down"}
        </button>
        {result && (
          <Link to={attendeesPath} style={{ ...ctaSecondaryStyle, textDecoration: "none" }}>
            Open Attendees
          </Link>
        )}
      </div>

      {error && (
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 20 }}>
          {error}
        </div>
      )}

      {tornDown && (
        <div style={{ ...statusPanelStyle("success"), marginBottom: 20 }}>
          Tear-down complete. The scenario tournament and its events are
          soft-deleted and their registrations removed. Re-seed any time.
        </div>
      )}

      {result && (
        <div style={panelStyle}>
          <h2 style={sectionH2Style}>Seeded scenarios</h2>
          <p style={{ fontSize: 13, color: inkSoft, margin: "0 0 16px" }}>
            Open Attendees on{" "}
            <strong>{TOURNAMENT_NAME}</strong>, find the player below, and click
            Manage to exercise each edit.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {result.events.map((ev) => (
              <div key={ev.name} style={panelMutedStyle}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
                  {ev.name}
                </div>
                <div style={{ fontSize: 13, color: inkSoft, marginBottom: 6 }}>
                  {ev.note}
                </div>
                <div style={{ fontSize: 12, color: inkMuted }}>
                  Registered: {ev.players.join(", ") || "—"}
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 16 }}>
            <Link
              to={attendeesPath}
              style={{ color: courtBlue, fontWeight: 500, fontSize: 14 }}
            >
              Open Attendees →
            </Link>
          </div>
        </div>
      )}

      {confirmTeardown && (
        <ConfirmModal
          title="Tear down scenario tournament?"
          body={
            <>
              Hard-deletes every registration and partner invite under{" "}
              <strong>{TOURNAMENT_NAME}</strong>, then soft-deletes its events
              and the tournament itself. Seeded player records stay. You can
              re-seed afterward.
            </>
          }
          confirmLabel="Tear down"
          onCancel={() => setConfirmTeardown(false)}
          onConfirm={onTearDown}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Seed helpers — each throws (with the raw PG message) on failure so the
// caller's try/catch surfaces it.
// ─────────────────────────────────────────────────────────────────────

// Create-or-reuse the scenario tournament by (organization_id, slug).
// Selects regardless of soft-delete state and revives a soft-deleted row
// so the teardown → re-seed cycle doesn't collide with the unique
// (organization_id, slug) constraint.
async function ensureTournament(orgId: string): Promise<string> {
  const { data, error } = await supabase
    .from("tournaments")
    .select("id, deleted_at")
    .eq("organization_id", orgId)
    .eq("slug", TOURNAMENT_SLUG)
    .limit(1);
  assertOk(error, "Find tournament");
  const existing = data?.[0];
  if (existing) {
    if (existing.deleted_at) {
      assertOk(
        (
          await supabase
            .from("tournaments")
            .update({ deleted_at: null })
            .eq("id", existing.id)
        ).error,
        "Revive tournament",
      );
    }
    return existing.id;
  }
  const { data: inserted, error: insErr } = await supabase
    .from("tournaments")
    .insert({
      organization_id: orgId,
      slug: TOURNAMENT_SLUG,
      name: TOURNAMENT_NAME,
      status: "published",
      starts_at: "2099-01-01",
      ends_at: "2099-01-02",
    })
    .select("id")
    .single();
  assertOk(insErr, "Create tournament");
  return inserted!.id;
}

// Ensure every referenced player exists (by email). Batch-selects the
// existing ones, bulk-inserts the missing ones. Players carry no auth
// account (auth_user_id null) — fine for test fixtures.
async function ensurePlayers(): Promise<Map<PlayerKey, string>> {
  const emails = ALL_PLAYER_KEYS.map(emailFor);
  const { data: existing, error } = await supabase
    .from("players")
    .select("id, email")
    .in("email", emails)
    .is("deleted_at", null);
  assertOk(error, "Find players");

  const idByEmail = new Map<string, string>();
  for (const row of existing ?? []) {
    if (row.email && !idByEmail.has(row.email)) idByEmail.set(row.email, row.id);
  }

  const missing = ALL_PLAYER_KEYS.filter((k) => !idByEmail.has(emailFor(k)));
  if (missing.length > 0) {
    const { data: inserted, error: insErr } = await supabase
      .from("players")
      .insert(
        missing.map((k) => ({
          first_name: PLAYERS[k].first,
          last_name: PLAYERS[k].last,
          email: emailFor(k),
        })),
      )
      .select("id, email");
    assertOk(insErr, "Create players");
    for (const row of inserted ?? []) {
      if (row.email) idByEmail.set(row.email, row.id);
    }
  }

  const map = new Map<PlayerKey, string>();
  for (const k of ALL_PLAYER_KEYS) {
    const id = idByEmail.get(emailFor(k));
    if (!id) throw new Error(`Player not created: ${fullName(k)}`);
    map.set(k, id);
  }
  return map;
}

// Create-or-reuse one event per scenario by (tournament_id, name). Bulk
// select, insert the missing, and revive any soft-deleted matches (so
// re-seeding after a teardown reuses the same events rather than
// stacking duplicates).
async function ensureEvents(
  tournamentId: string,
): Promise<Map<string, string>> {
  const names = SCENARIOS.map((s) => s.name);
  const { data: existing, error } = await supabase
    .from("events")
    .select("id, name, deleted_at")
    .eq("tournament_id", tournamentId)
    .in("name", names);
  assertOk(error, "Find events");

  const byName = new Map<string, { id: string; deleted_at: string | null }>();
  for (const row of existing ?? []) {
    if (!byName.has(row.name)) byName.set(row.name, { id: row.id, deleted_at: row.deleted_at });
  }

  // Revive any soft-deleted reuse targets.
  const reviveIds = (existing ?? [])
    .filter((r) => r.deleted_at)
    .map((r) => r.id);
  if (reviveIds.length > 0) {
    assertOk(
      (
        await supabase
          .from("events")
          .update({ deleted_at: null })
          .in("id", reviveIds)
      ).error,
      "Revive events",
    );
  }

  const missing = SCENARIOS.filter((s) => !byName.has(s.name));
  if (missing.length > 0) {
    const { data: inserted, error: insErr } = await supabase
      .from("events")
      .insert(
        missing.map((s) => ({
          tournament_id: tournamentId,
          name: s.name,
          format: s.format,
          gender: "mixed" as const,
          event_fee_cents: 0,
        })),
      )
      .select("id, name");
    assertOk(insErr, "Create events");
    for (const row of inserted ?? []) byName.set(row.name, { id: row.id, deleted_at: null });
  }

  const map = new Map<string, string>();
  for (const s of SCENARIOS) {
    const row = byName.get(s.name);
    if (!row) throw new Error(`Event not created: ${s.name}`);
    map.set(s.name, row.id);
  }
  return map;
}

// Wipe an event back to a clean slate: hard-delete its partner_invites
// and event_registrations (nulling the partner self-FK first so paired
// rows delete cleanly). Idempotent — safe to call on a fresh event.
async function resetEventRegs(eventId: string): Promise<void> {
  assertOk(
    (await supabase.from("partner_invites").delete().eq("event_id", eventId)).error,
    "Delete partner invites",
  );
  assertOk(
    (
      await supabase
        .from("event_registrations")
        .update({ partner_registration_id: null })
        .eq("event_id", eventId)
    ).error,
    "Unlink partners",
  );
  assertOk(
    (await supabase.from("event_registrations").delete().eq("event_id", eventId)).error,
    "Delete registrations",
  );
}

// Insert the scenario's registrations, then pair up any confirmed teams
// via partner_registration_id (both directions).
async function seedScenarioRegs(
  eventId: string,
  scenario: Scenario,
  playerIdByKey: Map<PlayerKey, string>,
): Promise<void> {
  const rows = scenario.regs.map((r) => {
    const playerId = playerIdByKey.get(r.player);
    if (!playerId) throw new Error(`Missing player id for ${fullName(r.player)}`);
    return {
      event_id: eventId,
      player_id: playerId,
      status: r.status,
      partner_status: r.partner_status,
      event_fee_cents: 0,
    };
  });

  const { data: inserted, error } = await supabase
    .from("event_registrations")
    .insert(rows)
    .select("id, player_id");
  assertOk(error, `Seed regs for ${scenario.name}`);

  // regId keyed by player key (via player id).
  const regIdByPlayerId = new Map<string, string>();
  for (const row of inserted ?? []) regIdByPlayerId.set(row.player_id, row.id);

  // Pair confirmed teams. Each spec names its partner; set both sides.
  const pairWrites = [];
  for (const r of scenario.regs) {
    if (!r.pairWith) continue;
    const selfRegId = regIdByPlayerId.get(playerIdByKey.get(r.player)!);
    const partnerRegId = regIdByPlayerId.get(playerIdByKey.get(r.pairWith)!);
    if (!selfRegId || !partnerRegId) continue;
    pairWrites.push(
      supabase
        .from("event_registrations")
        .update({ partner_registration_id: partnerRegId })
        .eq("id", selfRegId),
    );
  }
  if (pairWrites.length > 0) {
    const results = await Promise.all(pairWrites);
    const firstErr = results.find((res) => res.error)?.error;
    assertOk(firstErr ?? null, `Pair up ${scenario.name}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Local danger-button styles — composed from the shared secondary CTA
// primitive with the court-red token (no bespoke button chrome).
// ─────────────────────────────────────────────────────────────────────

const dangerButtonStyle: CSSProperties = {
  ...ctaSecondaryStyle,
  color: courtRed,
  boxShadow: `inset 0 0 0 2px ${courtRed}`,
};
const dangerDisabledStyle: CSSProperties = {
  ...dangerButtonStyle,
  color: inkMuted,
  boxShadow: `inset 0 0 0 2px ${inkMuted}`,
  cursor: "not-allowed",
  opacity: 0.85,
};
