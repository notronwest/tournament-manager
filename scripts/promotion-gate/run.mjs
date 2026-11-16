// Promotion gate CLI. Env: BASE_SHA HEAD_SHA PR_NUMBER REPO, and for the approval lookup
// PROMOTION_GATE_SUPABASE_URL / PROMOTION_GATE_SUPABASE_KEY. Optional: GITHUB_STEP_SUMMARY, GH_TOKEN.
// Any failure anywhere makes the promotion his: this process exits 1 on every path but a verdict.
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { classify, isHis } from './classify.mjs';
import { fetchApprovals } from './approval.mjs';
import { decide } from './decide.mjs';
import { alertOwner } from './alert.mjs';

const MARK = '<!-- wmpc-promotion-gate -->';
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const STATUS = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified' };

function diffFiles(base, head) {
  const raw = git('diff', '--name-status', '-z', '--find-renames', `${base}...${head}`).split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < raw.length;) {
    const s = raw[i][0];
    const status = STATUS[s];
    if (!status) throw new Error(`unknown change status "${raw[i]}"`);
    const path = s === 'R' || s === 'C' ? raw[i + 2] : raw[i + 1];
    i += s === 'R' || s === 'C' ? 3 : 2;
    const content = status === 'deleted' ? null : git('show', `${head}:${path}`);
    const added = status === 'deleted' ? '' : git('diff', '-U0', `${base}...${head}`, '--', path)
      .split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
    files.push({ path, status, content, added });
  }
  if (files.length === 0) throw new Error('the diff is empty — nothing to classify, so it cannot be cleared');
  return files;
}

function post(repo, pr, markdown) {
  if (!process.env.GH_TOKEN) return;
  const body = `${MARK}\n${markdown}`;
  const list = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/issues/${pr}/comments`, '--paginate'], { encoding: 'utf8' }));
  const mine = list.find((c) => c.body?.startsWith(MARK));
  writeFileSync('/tmp/promotion-gate-body.json', JSON.stringify({ body }));
  const args = mine
    ? ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${mine.id}`, '--input', '/tmp/promotion-gate-body.json']
    : ['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '--input', '/tmp/promotion-gate-body.json'];
  execFileSync('gh', args, { encoding: 'utf8' });
}

const { BASE_SHA, HEAD_SHA, PR_NUMBER, REPO } = process.env;
let result;
try {
  if (!BASE_SHA || !HEAD_SHA || !PR_NUMBER || !REPO) throw new Error('missing BASE_SHA / HEAD_SHA / PR_NUMBER / REPO');
  const verdict = classify(diffFiles(BASE_SHA, HEAD_SHA));
  let rows = null; let lookupError = null;
  if (isHis(verdict)) {
    try {
      rows = await fetchApprovals({ url: process.env.PROMOTION_GATE_SUPABASE_URL, key: process.env.PROMOTION_GATE_SUPABASE_KEY, repo: REPO, pr: PR_NUMBER });
    } catch (e) {
      lookupError = e.message;
      await alertOwner(`The promotion gate could not look for your approval on ${REPO} #${PR_NUMBER}: ${e.message}. It cannot verify any approval until this is fixed.`);
    }
  }
  result = decide({ verdict, rows, lookupError, repo: REPO, pr: PR_NUMBER, headSha: HEAD_SHA });
} catch (e) {
  result = { pass: false, state: 'waits', markdown: `### Promotion gate: waits for you\n\nThe gate could not decide (${e.message}), and a gate that is unsure fails closed: this promotion is yours.\n\nTo raise the approval card, call the club MCP's \`propose_action\` with kind \`ship_prod\` and scope \`{"repo": "${REPO}", "pr": ${PR_NUMBER}}\`; it appears at https://dashboard.wmpc.app/?tab=standup.\n` };
}
console.log(result.markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.markdown);
try { post(REPO, PR_NUMBER, result.markdown); } catch (e) { console.error(`could not post the verdict comment: ${e.message}`); }
process.exit(result.pass ? 0 : 1);
