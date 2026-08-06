/**
 * e2e/seed.ts — create a deterministic test fixture via the Supabase
 * service-role key (bypasses RLS). Idempotent: re-runs reuse existing rows.
 * Run before the Playwright suite.
 *
 *   E2E_SUPABASE_URL=… E2E_SUPABASE_SERVICE_ROLE_KEY=… E2E_TEST_PASSWORD=… npx tsx e2e/seed.ts
 *
 * Schema notes (from supabase/migrations/): `events` has NO unique
 * (tournament_id,name) constraint and `event_registrations` uniqueness is a
 * PARTIAL index (deleted_at is null) — neither is usable by upsert/onConflict,
 * so those use select-or-insert. `event_registrations.event_fee_cents` is NOT
 * NULL with no default.
 */
import { createClient } from "@supabase/supabase-js";

const url = required("E2E_SUPABASE_URL");
const key = required("E2E_SUPABASE_SERVICE_ROLE_KEY");
const password = process.env.E2E_TEST_PASSWORD || "e2e-password";
const db = createClient(url, key, { auth: { persistSession: false } });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`seed: missing env ${name}`);
  return v;
}

// Throw with the real Postgres message instead of a downstream null-deref.
function ok<T>(res: { data: T | null; error: { message: string } | null }, label: string): T {
  if (res.error) throw new Error(`seed: ${label} — ${res.error.message}`);
  if (res.data == null) throw new Error(`seed: ${label} — no data returned`);
  return res.data;
}

// For tables whose uniqueness isn't usable by onConflict (no constraint, or a
// partial index): find an active row by `match`, else insert. Returns its id.
async function selectOrInsert(
  table: string,
  match: Record<string, unknown>,
  insertRow: Record<string, unknown>,
  label: string,
): Promise<string> {
  const found = await db.from(table).select("id").match(match).is("deleted_at", null).limit(1);
  if (found.error) throw new Error(`seed: ${label} select — ${found.error.message}`);
  if (found.data && found.data.length) return (found.data[0] as { id: string }).id;
  const created = await db.from(table).insert(insertRow).select("id").single();
  return (ok(created, `${label} insert`) as { id: string }).id;
}

// Create-or-get an auth user + its players row. Returns the player id.
async function ensurePlayer(email: string, firstName: string, lastName: string): Promise<string> {
  // Fast path for an existing fixture: find the players row by its indexed
  // email and keep its name current. This avoids paginating auth.users, which
  // grows unbounded from the signup/reset specs' timestamped users — the old
  // listUsers() fallback (50/page) silently missed fixtures once it crossed 50.
  const existing = await db
    .from("players")
    .select("id")
    .eq("email", email)
    .is("deleted_at", null)
    .limit(1);
  if (!existing.error && existing.data && existing.data.length) {
    const id = (existing.data[0] as { id: string }).id;
    await db.from("players").update({ first_name: firstName, last_name: lastName }).eq("id", id);
    return id;
  }

  const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
  let authUserId = created.data?.user?.id;
  if (!authUserId) {
    // Backstop for an auth user that exists without a players row.
    const list = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    authUserId = list.data.users.find((u) => u.email === email)?.id;
  }
  if (!authUserId) throw new Error(`seed: could not create or find auth user ${email}`);
  const player = await db
    .from("players")
    .upsert(
      // email is required for a "complete" profile — without it RequireProfile
      // bounces the user to /profile and gated pages (the tournament page that
      // the specs drive) never render.
      { auth_user_id: authUserId, first_name: firstName, last_name: lastName, email },
      { onConflict: "auth_user_id" },
    )
    .select("id")
    .single();
  return (ok(player, `players upsert ${email}`) as { id: string }).id;
}

// Read a player's auth_user_id (organization_members.user_id references
// auth.users, but ensurePlayer only hands back the players.id).
async function authUserIdFor(email: string): Promise<string> {
  const res = await db
    .from("players")
    .select("auth_user_id")
    .eq("email", email)
    .is("deleted_at", null)
    .limit(1);
  const row = (res.data ?? [])[0] as { auth_user_id: string | null } | undefined;
  if (!row?.auth_user_id) throw new Error(`seed: no auth_user_id for ${email}`);
  return row.auth_user_id;
}

// Make an auth user an org member (idempotent). The admin attendees surfaces
// (unlike the public/self-service flows) require membership — without this the
// organizer can't load /admin/<org>/…/attendees.
async function ensureOrgMember(orgId: string, userId: string, role: string): Promise<void> {
  const found = await db
    .from("organization_members")
    .select("id")
    .match({ organization_id: orgId, user_id: userId })
    .limit(1);
  if (found.error) throw new Error(`seed: org member select — ${found.error.message}`);
  if (found.data && found.data.length) return;
  const ins = await db
    .from("organization_members")
    .insert({ organization_id: orgId, user_id: userId, role });
  if (ins.error) throw new Error(`seed: org member insert — ${ins.error.message}`);
}

async function main() {
  // 1. Org (organizations.slug is unique → upsert is fine)
  const org = ok(
    await db
      .from("organizations")
      .upsert({ slug: "e2e-test", name: "E2E Test Org" }, { onConflict: "slug" })
      .select("id")
      .single(),
    "organizations upsert",
  ) as { id: string };

  // 2. Published tournament (unique (organization_id, slug) → upsert is fine)
  const t = ok(
    await db
      .from("tournaments")
      .upsert(
        {
          organization_id: org.id,
          slug: "e2e-regression-cup",
          name: "E2E Regression Cup",
          status: "published",
          starts_at: "2099-01-01",
          ends_at: "2099-01-02",
        },
        { onConflict: "organization_id,slug" },
      )
      .select("id")
      .single(),
    "tournaments upsert",
  ) as { id: string };

  // 3. Doubles event (no unique(tournament_id,name) → select-or-insert)
  const eventId = await selectOrInsert(
    "events",
    { tournament_id: t.id, name: "E2E Mixed Doubles 3.5" },
    { tournament_id: t.id, name: "E2E Mixed Doubles 3.5", format: "doubles", gender: "mixed" },
    "events",
  );

  // 4. Players: organizer, player, partner
  await ensurePlayer("e2e-organizer@wmpc.test", "Olive", "Organizer");
  const playerId = await ensurePlayer("e2e-player@wmpc.test", "Pam", "Player");
  const partnerId = await ensurePlayer("e2e-partner@wmpc.test", "Pat", "Partner");

  // Olive owns the org so the admin attendees surfaces (manage-registration
  // specs) load for her. Public/self-service flows don't need this.
  await ensureOrgMember(org.id, await authUserIdFor("e2e-organizer@wmpc.test"), "owner");

  // 5. Cancel-flow fixture (#9): a pending reg for Pam WITH a picked partner
  //    (Pat) — cancelling then pops the "drop your partner" confirm step.
  //    Reset first (the cancel test removes the reg) so every run starts clean;
  //    hard delete sidesteps the partial-unique / soft-delete ambiguity.
  await db.from("partner_invites").delete().eq("event_id", eventId).eq("inviter_player_id", playerId);
  await db.from("event_registrations").delete().eq("event_id", eventId).eq("player_id", playerId);

  const pamReg = ok(
    await db
      .from("event_registrations")
      .insert({
        event_id: eventId,
        player_id: playerId,
        status: "pending_payment",
        partner_status: "pending",
        event_fee_cents: 0,
      })
      .select("id")
      .single(),
    "pam pending reg insert",
  ) as { id: string };
  void pamReg;

  // The picked partner is surfaced via a pending invite (inviter=Pam,
  // invitee=Pat) → myStatus.partnerLabel = "Pat Partner", which is what gates
  // the #9 cancel-confirm modal. token has a DB default.
  ok(
    await db
      .from("partner_invites")
      .insert({
        event_id: eventId,
        inviter_player_id: playerId,
        invitee_player_id: partnerId,
        // invitee_email is the fallback label when the invitee player join is
        // RLS-blocked — without it partnerLabel can be null → no #9 modal.
        invitee_email: "e2e-partner@wmpc.test",
      })
      .select("id")
      .single(),
    "partner invite insert",
  );

  // 6. Registration-flow fixtures (#253). Each flow gets its OWN single-event
  //    tournament, so the Register tab shows exactly one card — the spec needs
  //    no card-scoping. Regs/invites on these events are wiped each run so the
  //    registering user always starts unregistered (the tests create the regs).
  await ensurePlayer("e2e-rex@wmpc.test", "Rex", "Register");
  await ensurePlayer("e2e-sam@wmpc.test", "Sam", "Seeker");
  // (Olive + Pat already exist above: Olive registers in the existing-partner
  //  flow; Pat is the existing partner she searches for and picks.)

  for (const flow of [
    { slug: "e2e-existing-partner", tname: "E2E Existing-Partner Cup", ename: "E2E Existing Doubles" },
    { slug: "e2e-new-partner", tname: "E2E New-Partner Cup", ename: "E2E New Doubles" },
    { slug: "e2e-seeker", tname: "E2E Seeker Cup", ename: "E2E Seeker Doubles" },
  ]) {
    const ft = ok(
      await db
        .from("tournaments")
        .upsert(
          {
            organization_id: org.id,
            slug: flow.slug,
            name: flow.tname,
            status: "published",
            starts_at: "2099-01-01",
            ends_at: "2099-01-02",
          },
          { onConflict: "organization_id,slug" },
        )
        .select("id")
        .single(),
      `tournament ${flow.slug}`,
    ) as { id: string };
    const fe = await selectOrInsert(
      "events",
      { tournament_id: ft.id, name: flow.ename },
      { tournament_id: ft.id, name: flow.ename, format: "doubles", gender: "mixed" },
      `event ${flow.ename}`,
    );
    await db.from("partner_invites").delete().eq("event_id", fe);
    await db.from("event_registrations").delete().eq("event_id", fe);
  }

  // Purge the test-created invitee. The "invite someone not in the system" spec
  // creates a brand-new player (e2e-newpartner@wmpc.test) through the UI every
  // run; nothing else recreates it, so without this it accumulates unbounded
  // (58 duplicate rows had piled up — #546). Clear any references first, then
  // hard-delete, so each run starts with that person genuinely "not in the
  // system" and the players table stays clean.
  const stale = await db
    .from("players")
    .select("id")
    .eq("email", "e2e-newpartner@wmpc.test");
  const staleIds = (stale.data ?? []).map((r) => (r as { id: string }).id);
  if (staleIds.length) {
    await db.from("partner_invites").delete().in("invitee_player_id", staleIds);
    await db.from("event_registrations").delete().in("player_id", staleIds);
    await db.from("players").delete().in("id", staleIds);
  }

  // 7. Registration-remainder fixtures (#253): singles, discard-form (#9 P1),
  //    change-partner, invite-accept. One tournament per flow (single card).
  const mkTournament = async (slug: string, name: string) =>
    (ok(
      await db
        .from("tournaments")
        .upsert(
          { organization_id: org.id, slug, name, status: "published", starts_at: "2099-01-01", ends_at: "2099-01-02" },
          { onConflict: "organization_id,slug" },
        )
        .select("id")
        .single(),
      `tournament ${slug}`,
    ) as { id: string }).id;
  const resetEvent = async (eventId: string) => {
    await db.from("partner_invites").delete().eq("event_id", eventId);
    await db.from("event_registrations").delete().eq("event_id", eventId);
  };
  const doublesEvent = async (tid: string, name: string) =>
    selectOrInsert(
      "events",
      { tournament_id: tid, name },
      { tournament_id: tid, name, format: "doubles", gender: "mixed" },
      `event ${name}`,
    );

  // Singles — registrant has no partner picker, just Save.
  const singlesT = await mkTournament("e2e-singles", "E2E Singles Cup");
  const singlesE = await selectOrInsert(
    "events",
    { tournament_id: singlesT, name: "E2E Singles 3.5" },
    { tournament_id: singlesT, name: "E2E Singles 3.5", format: "singles", gender: "mixed" },
    "singles event",
  );
  await resetEvent(singlesE);
  await ensurePlayer("e2e-sid@wmpc.test", "Sid", "Singles");

  // Discard-form (#9 Path 1) — registrant starts with NO reg, picks then backs out.
  const discardT = await mkTournament("e2e-discard", "E2E Discard Cup");
  const discardE = await doublesEvent(discardT, "E2E Discard Doubles");
  await resetEvent(discardE);
  await ensurePlayer("e2e-dana@wmpc.test", "Dana", "Discard");

  // Change-partner — registrant has a pending doubles reg (+ Pat invite) so the
  // "Change partner" button shows; the test switches the pick to Quinn.
  const changeT = await mkTournament("e2e-change-partner", "E2E Change-Partner Cup");
  const changeE = await doublesEvent(changeT, "E2E Change Doubles");
  await resetEvent(changeE);
  const camId = await ensurePlayer("e2e-cam@wmpc.test", "Cam", "Changer");
  await ensurePlayer("e2e-quinn@wmpc.test", "Quinn", "Quick");
  ok(
    await db.from("event_registrations").insert({ event_id: changeE, player_id: camId, status: "pending_payment", partner_status: "pending", event_fee_cents: 0 }).select("id").single(),
    "cam reg",
  );
  await db.from("partner_invites").insert({ event_id: changeE, inviter_player_id: camId, invitee_player_id: partnerId, invitee_email: "e2e-partner@wmpc.test" });

  // Invite-accept — inviter (Ivan) has a pending reg + a pending invite (fixed
  // token) to the invitee (Ava), who logs in and accepts.
  const inviteT = await mkTournament("e2e-invite", "E2E Invite Cup");
  const inviteE = await doublesEvent(inviteT, "E2E Invite Doubles");
  await resetEvent(inviteE);
  const ivanId = await ensurePlayer("e2e-ivan@wmpc.test", "Ivan", "Inviter");
  const avaId = await ensurePlayer("e2e-ava@wmpc.test", "Ava", "Acceptor");
  ok(
    await db.from("event_registrations").insert({ event_id: inviteE, player_id: ivanId, status: "pending_payment", partner_status: "pending", event_fee_cents: 0 }).select("id").single(),
    "ivan reg",
  );
  ok(
    await db.from("partner_invites").insert({ event_id: inviteE, inviter_player_id: ivanId, invitee_player_id: avaId, invitee_email: "e2e-ava@wmpc.test", token: "e2e-accept-token" }).select("id").single(),
    "invite-accept invite",
  );
  // A SECOND inbound invite to a dedicated viewer (Vic) for the invites-view
  // test — separate from Ava's so the accept test (which consumes Ava's) can't
  // empty the viewer's list.
  const vicId = await ensurePlayer("e2e-vic@wmpc.test", "Vic", "Viewer");
  await db.from("partner_invites").insert({ event_id: inviteE, inviter_player_id: ivanId, invitee_player_id: vicId, invitee_email: "e2e-vic@wmpc.test", token: "e2e-view-token" });

  // 8. Self-service fixtures: my-tournaments view + withdraw. Two players with
  //    pending regs on a dedicated event — Mona (read-only view) and Will (the
  //    withdraw test cancels his; reset recreates it each run). Invites-view
  //    reuses Ava's seeded inbound invite (invite-accept is skipped).
  const selfT = await mkTournament("e2e-self-service", "E2E Self-Service Cup");
  const selfE = await doublesEvent(selfT, "E2E Self Doubles");
  await resetEvent(selfE);
  const monaId = await ensurePlayer("e2e-mona@wmpc.test", "Mona", "Viewer");
  const willId = await ensurePlayer("e2e-will@wmpc.test", "Will", "Withdraw");
  await db.from("event_registrations").insert([
    { event_id: selfE, player_id: monaId, status: "pending_payment", partner_status: "solo", event_fee_cents: 0 },
    { event_id: selfE, player_id: willId, status: "pending_payment", partner_status: "solo", event_fee_cents: 0 },
  ]);

  // 9. Manage-registration fixtures — one tournament, one event per edit
  //    scenario, each pre-seeded to an exact starting state. The organizer
  //    (Olive, an org owner via ensureOrgMember above) opens the admin
  //    Attendees page and drives the "Manage registration" editor. Every event
  //    is reset each run so the mutating specs (reassign / withdraw / pair)
  //    start clean and deterministic. Each scenario uses uniquely-named players
  //    so the By-Player filter box narrows to exactly one row.
  const mrT = await mkTournament("e2e-manage-reg", "E2E Manage-Registration Cup");
  const singlesEvent = async (tid: string, name: string) =>
    selectOrInsert(
      "events",
      { tournament_id: tid, name },
      { tournament_id: tid, name, format: "singles", gender: "mixed" },
      `event ${name}`,
    );
  const insertReg = async (
    eventId: string,
    pid: string,
    status: string,
    partnerStatus = "solo",
  ): Promise<string> =>
    (ok(
      await db
        .from("event_registrations")
        .insert({ event_id: eventId, player_id: pid, status, partner_status: partnerStatus, event_fee_cents: 0 })
        .select("id")
        .single(),
      `mr reg ${pid}`,
    ) as { id: string }).id;

  // (1) Reassign — happy path: Ray is registered; Nora exists but isn't in the
  //     event, so the reg can be moved to her.
  const mrReassign = await doublesEvent(mrT, "MR Reassign Happy");
  await resetEvent(mrReassign);
  await insertReg(mrReassign, await ensurePlayer("mr-ray@wmpc.test", "Ray", "Reassign"), "paid");
  await ensurePlayer("mr-nora@wmpc.test", "Nora", "NotInEvent");

  // (2) Reassign — collision: Cal and Dara are both active in the event, so
  //     moving Cal's reg onto Dara must be blocked by the active-unique guard.
  const mrCollision = await doublesEvent(mrT, "MR Reassign Collision");
  await resetEvent(mrCollision);
  await insertReg(mrCollision, await ensurePlayer("mr-cal@wmpc.test", "Cal", "Collide"), "paid");
  await insertReg(mrCollision, await ensurePlayer("mr-dara@wmpc.test", "Dara", "Duplicate"), "paid");

  // (3) Assign partner — existing: Eddie is already registered (seeking), so
  //     assigning him as Perry's partner reuses his reg (no new reg created).
  const mrPartnerExisting = await doublesEvent(mrT, "MR Partner Existing");
  await resetEvent(mrPartnerExisting);
  await insertReg(mrPartnerExisting, await ensurePlayer("mr-perry@wmpc.test", "Perry", "Primary"), "paid", "seeking");
  await insertReg(mrPartnerExisting, await ensurePlayer("mr-eddie@wmpc.test", "Eddie", "Existing"), "paid", "seeking");

  // (4) Assign partner — new: Nate is seeking; Cody exists but has no reg here,
  //     so assigning him comp-creates a $0 reg and pairs the two.
  const mrPartnerNew = await doublesEvent(mrT, "MR Partner New");
  await resetEvent(mrPartnerNew);
  await insertReg(mrPartnerNew, await ensurePlayer("mr-nate@wmpc.test", "Nate", "NeedsPartner"), "paid", "seeking");
  await ensurePlayer("mr-cody@wmpc.test", "Cody", "Comp");

  // (5) Remove partner: Tom + Tina are a confirmed team.
  const mrRemove = await doublesEvent(mrT, "MR Remove Partner");
  await resetEvent(mrRemove);
  const tomReg = await insertReg(mrRemove, await ensurePlayer("mr-tom@wmpc.test", "Tom", "Team"), "paid", "confirmed");
  const tinaReg = await insertReg(mrRemove, await ensurePlayer("mr-tina@wmpc.test", "Tina", "Team"), "paid", "confirmed");
  await db.from("event_registrations").update({ partner_registration_id: tinaReg }).eq("id", tomReg);
  await db.from("event_registrations").update({ partner_registration_id: tomReg }).eq("id", tinaReg);

  // (6) Withdraw — paid: Wade's paid reg becomes 'withdrawn'.
  const mrWithdrawPaid = await singlesEvent(mrT, "MR Withdraw Paid");
  await resetEvent(mrWithdrawPaid);
  await insertReg(mrWithdrawPaid, await ensurePlayer("mr-wade@wmpc.test", "Wade", "Paid"), "paid");

  // (7) Withdraw — pending: Pete's unpaid reg becomes 'cancelled'.
  const mrWithdrawPending = await singlesEvent(mrT, "MR Withdraw Pending");
  await resetEvent(mrWithdrawPending);
  await insertReg(mrWithdrawPending, await ensurePlayer("mr-pete@wmpc.test", "Pete", "Pending"), "pending_payment");

  console.log("seed: e2e-test fixture ready");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
