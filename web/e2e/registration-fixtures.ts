/**
 * e2e/registration-fixtures.ts — self-seeding data for the registration
 * (#253) and issue-09 "discard" flows.
 *
 * Each call to `seedRegistration(kind)` creates its OWN tournament, event,
 * and player(s), keyed by a fresh id generated at call time. That makes the
 * fixture single-test-scoped: two tests, two runs, or a CI retry of the same
 * test can never read or mutate the same row (the recurring #936 flake —
 * shared single-use seed state from e2e/seed.ts). Torn down after the test
 * via the Playwright fixture below; unique naming also means any teardown
 * that doesn't run (e.g. a killed worker) leaves inert rows, never a
 * collision.
 */
import { test as base } from "@playwright/test";
import { admin } from "./fixtures";

const PASSWORD = process.env.E2E_TEST_PASSWORD || "e2e-password";
const ORG_SLUG = "e2e-test";

function uid(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function ok<T>(res: { data: T | null; error: { message: string } | null }, label: string): T {
  if (res.error) throw new Error(`registration-fixtures: ${label} — ${res.error.message}`);
  if (res.data == null) throw new Error(`registration-fixtures: ${label} — no data returned`);
  return res.data;
}

type Db = ReturnType<typeof admin>;

async function ensureOrg(db: Db): Promise<string> {
  // Reused across every test/run — cheap and not single-use, unlike the
  // tournament/event/player rows below, so an upsert is fine here.
  const org = ok(
    await db
      .from("organizations")
      .upsert({ slug: ORG_SLUG, name: "E2E Test Org" }, { onConflict: "slug" })
      .select("id")
      .single(),
    "org upsert",
  ) as { id: string };
  return org.id;
}

async function createPlayer(
  db: Db,
  email: string,
  first: string,
  last: string,
): Promise<{ playerId: string; authUserId: string }> {
  const created = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  const authUserId = created.data?.user?.id;
  if (!authUserId) throw new Error(`registration-fixtures: could not create auth user ${email}`);
  const player = ok(
    await db
      .from("players")
      .upsert(
        { auth_user_id: authUserId, first_name: first, last_name: last, email },
        { onConflict: "auth_user_id" },
      )
      .select("id")
      .single(),
    `player upsert ${email}`,
  ) as { id: string };
  return { playerId: player.id, authUserId };
}

export type ScenarioKind = "existingPartner" | "newPartner" | "seeker" | "singles" | "discard";

export interface ScenarioData {
  orgSlug: string;
  tournamentSlug: string;
  registrantEmail: string;
  /** Unique substring that matches only the pre-seeded partner (existingPartner / discard). */
  partnerQuery?: string;
  /** Fields to type into the "add new player" form (newPartner only). */
  newPartner?: { first: string; last: string; email: string };
}

interface CreatedFixture {
  tournamentId: string;
  eventId: string;
  players: { playerId: string; authUserId: string }[];
  // Emails of players the TEST itself creates through the UI (e.g. the "add
  // new player" form) — we don't have their ids until teardown looks them up.
  extraEmails: string[];
}

async function seedScenario(kind: ScenarioKind): Promise<{ data: ScenarioData; created: CreatedFixture }> {
  const db = admin();
  const id = uid();
  const orgId = await ensureOrg(db);

  const slug = `e2e-${kind.toLowerCase()}-${id}`;
  const tournament = ok(
    await db
      .from("tournaments")
      .insert({
        organization_id: orgId,
        slug,
        name: `E2E ${kind} ${id}`,
        status: "published",
        starts_at: "2099-01-01",
        ends_at: "2099-01-02",
      })
      .select("id")
      .single(),
    `tournament insert ${slug}`,
  ) as { id: string };

  const format = kind === "singles" ? "singles" : "doubles";
  const event = ok(
    await db
      .from("events")
      .insert({
        tournament_id: tournament.id,
        name: `E2E ${kind} event ${id}`,
        format,
        gender: "mixed",
      })
      .select("id")
      .single(),
    `event insert ${kind} ${id}`,
  ) as { id: string };

  const registrantEmail = `e2e-${kind}-${id}@wmpc.test`;
  const registrant = await createPlayer(db, registrantEmail, "E2E", `Reg${id}`);
  const players = [registrant];
  const extraEmails: string[] = [];

  const data: ScenarioData = { orgSlug: ORG_SLUG, tournamentSlug: slug, registrantEmail };

  if (kind === "existingPartner" || kind === "discard") {
    // A run-unique last name so the search finds exactly this player, never
    // a leftover "Pat Partner" from e2e/seed.ts or another run's fixture.
    const partnerLast = `Partner${id}`;
    const partner = await createPlayer(db, `e2e-${kind}-partner-${id}@wmpc.test`, "Pat", partnerLast);
    players.push(partner);
    data.partnerQuery = partnerLast;
  }

  if (kind === "newPartner") {
    // The test creates this player through the UI "add new player" form —
    // we only need a run-unique email so it can never collide with another
    // run's leftover (the old fixed "e2e-newpartner@wmpc.test" was #546).
    data.newPartner = { first: "Nina", last: `Newcomer${id}`, email: `e2e-newpartner-${id}@wmpc.test` };
    extraEmails.push(data.newPartner.email);
  }

  return { data, created: { tournamentId: tournament.id, eventId: event.id, players, extraEmails } };
}

async function teardown(created: CreatedFixture): Promise<void> {
  const db = admin();
  // event_registrations / partner_invites reference events and players with
  // ON DELETE RESTRICT — clear those first, or the events/players deletes
  // below fail.
  await db.from("partner_invites").delete().eq("event_id", created.eventId);
  await db.from("event_registrations").delete().eq("event_id", created.eventId);
  await db.from("events").delete().eq("id", created.eventId);
  await db.from("tournaments").delete().eq("id", created.tournamentId);

  const players = [...created.players];
  for (const email of created.extraEmails) {
    const found = await db.from("players").select("id, auth_user_id").eq("email", email).limit(1);
    const row = (found.data ?? [])[0] as { id: string; auth_user_id: string | null } | undefined;
    if (row?.auth_user_id) players.push({ playerId: row.id, authUserId: row.auth_user_id });
  }

  if (players.length) {
    await db.from("players").delete().in("id", players.map((p) => p.playerId));
  }
  for (const p of players) {
    await db.auth.admin.deleteUser(p.authUserId).catch(() => {});
  }
}

export const test = base.extend<{
  seedRegistration: (kind: ScenarioKind) => Promise<ScenarioData>;
}>({
  // Playwright fixture factory. The callback param is conventionally named
  // `use` in their docs, but that trips eslint-plugin-react-hooks (it treats
  // any `use…` identifier as a Hook call) — `runTest` is the same callback,
  // just spelled to avoid the false positive.
  //
  // First param must be an OBJECT-DESTRUCTURING pattern — Playwright's own
  // fixture-dependency parser statically scans the source for that shape, so
  // a plain named param (e.g. `fixtures`) throws "First argument must use
  // the object destructuring pattern" at test-list/run time even though it
  // type-checks and lints fine as ordinary TS. This fixture has no fixture
  // dependencies, hence the empty pattern.
  // eslint-disable-next-line no-empty-pattern
  seedRegistration: async ({}, runTest) => {
    const createdList: CreatedFixture[] = [];
    await runTest(async (kind) => {
      const { data, created } = await seedScenario(kind);
      createdList.push(created);
      return data;
    });
    for (const created of createdList) {
      try {
        await teardown(created);
      } catch (err) {
        // Best-effort: the fixture is uniquely named, so a failed teardown
        // leaves an inert leftover, not a future collision.
        console.warn("registration-fixtures: teardown failed", err);
      }
    }
  },
});

export { expect } from "@playwright/test";
