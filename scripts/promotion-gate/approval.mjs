// The only evidence the gate accepts: a public.cos_approvals row Ron decided (D-0236).
// This function takes ROWS and nothing else. It has no parameter for a PR body, a review, a
// label or a comment, so none of them can satisfy it — the test passes them anyway.
import { PROMOTION_APPROVAL_KIND } from './rules.mjs';

export function findApproval(rows, { repo, pr, headSha }) {
  if (!Array.isArray(rows)) return null;
  return rows.find((r) =>
    r && r.status === 'approved' && r.decided_at &&
    r.action_kind === PROMOTION_APPROVAL_KIND &&
    r.scope && r.scope.repo === repo && Number(r.scope.pr) === Number(pr) &&
    (!r.scope.head_sha || r.scope.head_sha === headSha)) ?? null;
}

// Reads the approved rows for ONE repo + PR through public.promotion_gate_approvals (migration 0068),
// which the public anon key can call and which returns nothing else. Throws on any failure (the
// caller fails closed and says the LOOKUP failed, which is not the same as an unpressed card).
export async function fetchApprovals({ url, key, repo, pr, fetchImpl = fetch }) {
  if (!url || !key) throw new Error('the approval lookup is not configured (PROMOTION_GATE_SUPABASE_URL / PROMOTION_GATE_SUPABASE_KEY unset)');
  const res = await fetchImpl(`${url.replace(/\/$/, '')}/rest/v1/rpc/promotion_gate_approvals`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_repo: repo, p_pr: Number(pr) }),
  });
  if (!res.ok) throw new Error(`approval lookup failed: HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('approval lookup failed: the answer was not a list of rows');
  return rows;
}
