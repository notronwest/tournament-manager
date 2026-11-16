// Proves the gate's approval lookup works against the live table, from where the gate runs (#875).
// Fails loudly (exit 1 + a phone alert) when the lookup is unconfigured, errors, answers wrongly,
// or is using a key wider than the lookup needs. Env: PROMOTION_GATE_SUPABASE_URL / _KEY,
// optional PROMOTION_GATE_ALERT_WEBHOOK. Run on a schedule and before each gate decision.
import { fetchApprovals } from './approval.mjs';
import { alertOwner } from './alert.mjs';

// How narrow the key is. The club's Supabase project issues PUBLISHABLE keys
// (`sb_publishable_…`), which are NOT JWTs — there is no `role` claim to decode, so the older
// `role(key) !== 'anon'` test called every one of them "unreadable" and held every promotion
// that needed an approval red. Measured on PR #895, 2026-11-09: the lookup itself worked, the
// key could not read `cos_approvals` directly, and this check alone failed it. A publishable
// key IS the anon-equivalent public key and carries no more reach than the lookup needs, so it
// is accepted by prefix. Its secret twin (`sb_secret_…`) is refused for exactly the reason
// `service_role` is. A legacy JWT still has to decode to `anon`. Anything we cannot place is
// refused rather than assumed narrow — this check fails closed.
export const keyWidth = (key) => {
  const k = String(key ?? '');
  if (k.startsWith('sb_publishable_')) return { narrow: true };
  if (k.startsWith('sb_secret_')) {
    return { narrow: false, why: 'the key is a secret key ("sb_secret_…"), which is wider than the lookup needs (it bypasses row-level security on payments and account credits)' };
  }
  let role = null;
  try { role = JSON.parse(Buffer.from(k.split('.')[1], 'base64url').toString()).role ?? null; } catch { role = null; }
  if (role === 'anon') return { narrow: true };
  if (role) {
    return { narrow: false, why: `the key's role is "${role}", not "anon": it is wider than the lookup needs (a service-role key bypasses row-level security on payments and account credits)` };
  }
  return { narrow: false, why: 'the key is neither a publishable key ("sb_publishable_…") nor a token whose role can be read, so it cannot be shown to be as narrow as the lookup needs' };
};

export async function probe({ url, key, fetchImpl = fetch }) {
  const problems = [];
  try {
    const rows = await fetchApprovals({ url, key, repo: 'probe/none', pr: 0, fetchImpl });
    if (rows.length !== 0) problems.push('the lookup returned rows for a repo and PR that cannot have an approval');
  } catch (e) { problems.push(e.message); return problems; }
  const width = keyWidth(key);
  if (!width.narrow) problems.push(width.why);
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/rest/v1/cos_approvals?select=id&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (res.ok) { const rows = await res.json(); if (Array.isArray(rows) && rows.length) problems.push('the key can read cos_approvals directly: it is wider than the lookup needs'); }
  } catch (e) { problems.push(`the narrowness check could not run: ${e.message}`); }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = await probe({ url: process.env.PROMOTION_GATE_SUPABASE_URL, key: process.env.PROMOTION_GATE_SUPABASE_KEY });
  if (problems.length === 0) { console.log('promotion gate probe: the approval lookup works against the live table, with a narrow key'); process.exit(0); }
  const msg = `The promotion gate cannot check approvals (${process.env.GITHUB_REPOSITORY ?? 'tournament-manager'}): ${problems.join('; ')}. Until this is fixed every promotion that needs your approval stays red.`;
  console.error(msg);
  await alertOwner(msg);
  process.exit(1);
}
