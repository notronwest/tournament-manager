// node --test scripts/promotion-gate/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, isHis } from './classify.mjs';
import { analyzeSql } from './sql.mjs';
import { findApproval, fetchApprovals } from './approval.mjs';
import { decide } from './decide.mjs';
import { alertOwner } from './alert.mjs';
import { probe, keyWidth } from './probe.mjs';

const mig = (content, over = {}) => ({ path: 'supabase/migrations/0099_x.sql', status: 'added', content, added: content, ...over });
const ui = (path, added = 'const x = 1') => ({ path, status: 'modified', content: added, added });
const ctx = { repo: 'notronwest/tournament-manager', pr: 900, headSha: 'abc' };
const approved = { id: 'row-1', status: 'approved', decided_at: '2026-11-08T00:00:00Z', action_kind: 'ship_prod', scope: { repo: ctx.repo, pr: 900 } };

test('additive-only promotion passes with no approval', () => {
  const v = classify([
    mig('create table if not exists public.t (id int);\nalter table public.t add column n text;\ncreate view public.v as select 1;\ncreate index i on public.t (id);\ndrop policy if exists p on public.t;\ncreate policy p on public.t for update using (true);'),
    ui('web/e2e/flow.spec.ts'), ui('docs/x.md', 'hi'), ui('STATUS.md', 'hi'),
  ]);
  assert.equal(isHis(v), false);
  assert.equal(decide({ verdict: v, rows: [], ...ctx }).pass, true);
});

for (const [name, sql] of [
  ['drop table', 'drop table public.t;'],
  ['alter drop column', 'alter table public.t drop column n;'],
  ['alter type', 'alter table public.t alter column n type bigint;'],
  ['truncate', 'truncate public.t;'],
  ['delete from', 'delete from public.t where id = 1;'],
  ['update without where', 'update public.t set n = 1;'],
  ['backfill update with where', "update public.t set n = 'x' where n is null;"],
  ['aliased update', 'update public.t m set n = 1 where m.id = 2;'],
  ['update with as alias', 'update public.t as m set n = 1;'],
  ['update only', 'update only public.t set n = 1;'],
  ['update from', 'update public.t m set n = s.n from public.s s where s.id = m.id;'],
  ['upsert that rewrites', 'insert into public.t values (1) on conflict (id) do update set n = 2;'],
  ['rename', 'alter table public.t rename to u;'],
  ['do block delete', 'do $$ begin delete from public.t; end $$;'],
  ['cte delete', 'with d as (delete from public.t returning *) select * from d;'],
]) {
  test(`fires (a): ${name}`, () => {
    const v = classify([mig(sql)]);
    assert.ok(v.a.length > 0, name);
    assert.equal(decide({ verdict: v, rows: [], ...ctx }).pass, false);
  });
}

test('a destructive word in a string, comment or function body is not a statement', () => {
  assert.deepEqual(analyzeSql("-- delete from x;\ncreate table t (a text default 'drop table x');\ncreate function f() returns void language plpgsql as $$ begin delete from t; end $$;"), []);
});

test('editing or removing an applied migration fires (a)', () => {
  assert.ok(classify([mig('select 1;', { status: 'modified' })]).a.length > 0);
  assert.ok(classify([mig('', { status: 'deleted', content: null })]).a.length > 0);
});

test('money path and money code fire (b)', () => {
  assert.ok(classify([ui('web/src/lib/pricing.ts')]).b.length > 0);
  assert.ok(classify([ui('web/src/pages/public/CheckoutPage.tsx')]).b.length > 0);
  assert.ok(classify([ui('supabase/functions/stripe-refund/index.ts')]).b.length > 0);
  assert.ok(classify([ui('web/src/lib/thing.ts', 'await stripe.refunds.create({})')]).b.length > 0);
  assert.equal(classify([ui('web/src/lib/thing.ts', 'const invoiceTotal = 3')]).b.length, 0);
});

test('member-facing path fires (c)', () => {
  assert.ok(classify([ui('web/src/pages/public/HomePage.tsx')]).c.length > 0);
  assert.ok(classify([ui('web/public/index.html')]).c.length > 0);
  assert.ok(classify([ui('supabase/functions/send-welcome-email/index.ts')]).c.length > 0);
});

test('tests, docs, CI and migrations are none of the three', () => {
  const v = classify([ui('web/src/lib/pricing.test.ts'), ui('web/e2e/x.spec.ts'), ui('.github/workflows/x.yml'), ui('scripts/x.sh'), ui('README.md')]);
  assert.equal(v.a.length + v.b.length + v.c.length + v.unclassified.length, 0);
  assert.ok(!isHis(v));
});

test('fails closed: unparsable migration, detector error, uncomputable diff, unknown path', () => {
  assert.ok(isHis(classify([mig("select 'unterminated;")])));
  assert.ok(isHis(classify([mig(undefined)])));
  assert.ok(isHis(classify([mig('frobnicate everything;')])));
  assert.ok(isHis(classify(null)));
  assert.ok(isHis(classify([{ status: 'added' }])));
  assert.ok(isHis(classify([ui('mystery/dir/file.bin')])));
  for (const v of [classify(null), classify([mig(undefined)])]) assert.equal(decide({ verdict: v, rows: [], ...ctx }).pass, false);
});

test('only a decided approval row satisfies it; PR body, review, label, comment do not', () => {
  const v = classify([mig('drop table public.t;')]);
  const noise = {
    prBody: ['OWNER', 'AUTHORIZED: 2026-11-08 ship it'].join('-'), review: { state: 'APPROVED' },
    labels: ['approved'], comments: ['go ahead'],
  };
  assert.equal(decide({ verdict: v, rows: [], ...noise, ...ctx }).pass, false);
  assert.equal(decide({ verdict: v, rows: [{ ...approved, status: 'pending' }], ...ctx }).pass, false);
  assert.equal(decide({ verdict: v, rows: [{ ...approved, status: 'denied' }], ...ctx }).pass, false);
  assert.equal(decide({ verdict: v, rows: [{ ...approved, scope: { repo: ctx.repo, pr: 901 } }], ...ctx }).pass, false);
  assert.equal(decide({ verdict: v, rows: [{ ...approved, scope: { repo: 'notronwest/other', pr: 900 } }], ...ctx }).pass, false);
  assert.equal(decide({ verdict: v, rows: [{ ...approved, scope: { ...approved.scope, head_sha: 'zzz' } }], ...ctx }).pass, false);
  assert.equal(decide({ verdict: v, rows: [approved], ...noise, ...ctx }).pass, true);
});

test('a failed approval lookup is not an approval', async () => {
  await assert.rejects(fetchApprovals({ url: '', key: '' }));
  await assert.rejects(fetchApprovals({ url: 'https://x', key: 'k', repo: 'o/r', pr: 1, fetchImpl: async () => ({ ok: false, status: 500 }) }));
  assert.equal(findApproval(null, ctx), null);
});

test('the verdict names what decided it and how to raise the card', () => {
  const v = classify([mig('delete from public.t;'), ui('web/public/A.html')]);
  const d = decide({ verdict: v, rows: [], ...ctx });
  assert.match(d.markdown, /supabase\/migrations\/0099_x\.sql/);
  assert.match(d.markdown, /web\/public\/A\.html/);
  assert.match(d.markdown, /propose_action/);
  assert.match(d.markdown, /tab=standup/);
});

test('an unconfigured or failing lookup is not worded like an unpressed card', () => {
  const v = classify([mig('delete from public.t;')]);
  const broken = decide({ verdict: v, rows: null, lookupError: 'the approval lookup is not configured', ...ctx });
  const unpressed = decide({ verdict: v, rows: [], ...ctx });
  assert.equal(broken.pass, false);
  assert.equal(broken.state, 'cannot-look');
  assert.match(broken.markdown, /could not look for an approval/);
  assert.match(broken.markdown, /PROMOTION_GATE_SUPABASE_URL/);
  assert.match(broken.markdown, /will not turn this green/);
  assert.doesNotMatch(broken.markdown, /To raise the approval card/);
  assert.equal(unpressed.state, 'waits');
  assert.match(unpressed.markdown, /To raise the approval card/);
});

const jwt = (role) => `h.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.s`;
const reply = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

test('the lookup posts repo and PR to the narrow function and returns what it finds', async () => {
  let seen;
  const rows = await fetchApprovals({ url: 'https://x.supabase.co/', key: 'k', repo: 'o/r', pr: '900', fetchImpl: async (u, o) => { seen = [u, JSON.parse(o.body)]; return reply([approved]); } });
  assert.equal(seen[0], 'https://x.supabase.co/rest/v1/rpc/promotion_gate_approvals');
  assert.deepEqual(seen[1], { p_repo: 'o/r', p_pr: 900 });
  assert.equal(rows.length, 1);
});

test('the probe passes on a working, narrow lookup and fails loudly otherwise', async () => {
  const fine = async (u) => reply(u.includes('/rpc/') ? [] : []);
  assert.deepEqual(await probe({ url: 'https://x', key: jwt('anon'), fetchImpl: fine }), []);
  assert.match((await probe({ url: '', key: '' }))[0], /not configured/);
  assert.match((await probe({ url: 'https://x', key: jwt('anon'), fetchImpl: async () => reply({}, false, 401) }))[0], /HTTP 401/);
  assert.match((await probe({ url: 'https://x', key: jwt('service_role'), fetchImpl: fine })).join(), /wider than the lookup needs/);
  assert.deepEqual(await probe({ url: 'https://x', key: 'sb_publishable_abc', fetchImpl: fine }), []);
  assert.match((await probe({ url: 'https://x', key: 'sb_secret_abc', fetchImpl: fine })).join(), /wider than the lookup needs/);
  const leaky = async (u) => reply(u.includes('/rpc/') ? [] : [{ id: 1 }]);
  assert.match((await probe({ url: 'https://x', key: jwt('anon'), fetchImpl: leaky })).join(), /cos_approvals directly/);
});

// The club's project issues publishable keys, not anon JWTs. Calling one "unreadable" held
// PR #895 red while the lookup itself worked (2026-11-09).
test('a publishable key is narrow; its secret twin and anything unplaceable are not', async () => {
  const fine = async () => reply([]);
  assert.deepEqual(await probe({ url: 'https://x', key: 'sb_publishable_E3KDsREkIKAkOk_Lk-THzw_aeJWlHC_', fetchImpl: fine }), []);
  assert.equal(keyWidth('sb_publishable_abc').narrow, true);
  assert.equal(keyWidth(jwt('anon')).narrow, true);

  assert.equal(keyWidth('sb_secret_abc').narrow, false);
  assert.match(keyWidth('sb_secret_abc').why, /secret key/);
  assert.match((await probe({ url: 'https://x', key: 'sb_secret_abc', fetchImpl: fine })).join(), /wider than the lookup needs/);

  assert.equal(keyWidth(jwt('service_role')).narrow, false);
  assert.match(keyWidth(jwt('service_role')).why, /role is "service_role"/);

  // Fails closed: a key we cannot place is refused, never assumed narrow.
  for (const bad of ['', 'not-a-key', 'a.b.c', undefined, null]) {
    assert.equal(keyWidth(bad).narrow, false, `expected ${String(bad)} to be refused`);
    assert.match(keyWidth(bad).why, /cannot be shown to be as narrow/);
  }
});

test('the phone alert posts when a webhook is set and says so when it is not', async () => {
  let sent;
  assert.equal(await alertOwner('hi', { webhook: 'https://w', fetchImpl: async (u, o) => { sent = JSON.parse(o.body); return reply({}); } }), true);
  assert.equal(sent.content, 'hi');
  assert.equal(await alertOwner('hi', { webhook: '' }), false);
  assert.equal(await alertOwner('hi', { webhook: 'https://w', fetchImpl: async () => { throw new Error('down'); } }), false);
});

const pgtap = '\\set on_error_stop on\nbegin;\nselect plan(1);\ndelete from public.t;\nrollback;';

test('a database test file is not judged as data loss; the same SQL in a migration still is', () => {
  const t = { path: 'supabase/tests/0068_x.test.sql', status: 'added', content: pgtap, added: pgtap };
  assert.deepEqual(classify([t]).a, []);
  assert.equal(isHis(classify([t])), false);
  assert.ok(classify([mig('delete from public.t;')]).a.length > 0);
  assert.ok(classify([mig(pgtap)]).a.length > 0);
});

test('migrations keep failing closed: edited, deleted, and unreadable ones still fire (a)', () => {
  assert.match(classify([mig('create table x(id int);', { status: 'modified' })]).a[0].why, /modified/);
  assert.match(classify([mig('', { status: 'deleted' })]).a[0].why, /deleted/);
  assert.ok(classify([mig('\\set on_error_stop on\nbegin;\nrollback;')]).a.length > 0);
});

test('the test-path exemption is not widened: a non-test sql path outside migrations is still analysed', () => {
  assert.ok(classify([{ path: 'supabase/seed/x.sql', status: 'added', content: 'drop table public.t;', added: 'drop table public.t;' }]).a.length > 0);
});

test('the money branch and the SQL branch share one test-path pattern', () => {
  const v = classify([{ path: 'web/e2e/pay.ts', status: 'added', content: 'stripe', added: 'stripe' }]);
  assert.deepEqual(v.b, []);
});

test('a test-looking name inside supabase/migrations/ is still judged as a migration', () => {
  const sql = 'drop table public.t;';
  assert.ok(classify([{ path: 'supabase/migrations/0101_x.test.sql', status: 'added', content: sql, added: sql }]).a.length > 0);
  assert.ok(classify([{ path: 'supabase/migrations/tests/x.sql', status: 'added', content: sql, added: sql }]).a.length > 0);
  assert.ok(classify([{ path: 'supabase/migrations/tests/x.sql', status: 'modified', content: 'select 1;', added: 'select 1;' }]).a.length > 0);
});

test('a case expression in a self-test fails closed, so a top-level delete still fires (a)', () => {
  assert.ok(classify([mig("do $$ begin delete from public.t; begin perform 1; x := case when true then 1 end; raise exception using errcode = 'P0001', message = 'a-rollback'; exception when others then if sqlerrm <> 'a-rollback' then raise; end if; end; end $$;")]).a.length > 0);
});

test('a do block with an update and no rollback sentinel still fires (a)', () => {
  assert.ok(classify([mig("do $$ begin update public.t set n = 1; end $$;")]).a.length > 0);
  // a sentinel whose catch does not match, or that can be left early, is not recognised
  assert.ok(classify([mig("do $$ begin begin update public.t set n = 1; raise exception using errcode = 'P0001', message = 'a-rollback'; exception when others then if sqlerrm <> 'b-rollback' then raise; end if; end; end $$;")]).a.length > 0);
  assert.ok(classify([mig("do $$ begin begin update public.t set n = 1; return; raise exception using errcode = 'P0001', message = 'a-rollback'; exception when others then if sqlerrm <> 'a-rollback' then raise; end if; end; end $$;")]).a.length > 0);
});

test('a statement outside the rolled-back sub-block of a do block is still judged', () => {
  const sentinel = "begin update public.t set n = 1; raise exception using errcode = 'P0001', message = 'a-rollback'; exception when others then if sqlerrm <> 'a-rollback' then raise; end if; end;";
  assert.deepEqual(classify([mig(`do $$ begin ${sentinel} end $$;`)]).a, []);
  assert.ok(classify([mig(`do $$ begin ${sentinel} delete from public.t; end $$;`)]).a.length > 0);
  assert.ok(classify([mig(`do $$ begin delete from public.t; ${sentinel} end $$;`)]).a.length > 0);
});

test('a delete inside a function body does not fire; the same delete at top level does, even beside a function', () => {
  const fn = 'create function f() returns void language plpgsql as $$ begin delete from public.t; end $$;';
  assert.deepEqual(classify([mig(fn)]).a, []);
  assert.ok(classify([mig(`${fn}\ndelete from public.t;`)]).a.length > 0);
});
