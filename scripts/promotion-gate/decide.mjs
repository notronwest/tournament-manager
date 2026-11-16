// Turn a classification + the approval lookup into the gate's verdict and the text that goes
// on the promotion PR. Takes ONLY the classification and approval rows — nothing a person can
// type into GitHub (PR body, review, label, comment) is an input, by construction (D-0236).
import { isHis } from './classify.mjs';
import { findApproval } from './approval.mjs';

const line = (list) => list.map((f) => `  - \`${f.path}\` — ${f.why}`).join('\n');

export function decide({ verdict, rows, lookupError, repo, pr, headSha }) {
  const sections = [
    ['(a) Deletes or rewrites existing club data', verdict.a],
    ['(b) Touches money', verdict.b],
    ['(c) Changes what a member sees or receives', verdict.c],
    ['Could not be classified (treated as his)', [...verdict.unclassified, ...verdict.errors]],
  ];
  const skipped = (verdict.skipped ?? []).map((k) => `  - skipped in \`${k.path}\`: ${k.statements} statement${k.statements === 1 ? '' : 's'} in a ${k.kind} (not run as a data change)`).join('\n');
  const body = sections.map(([t, l], i) => `- **${t}:** ${l.length ? `FIRED\n${line(l)}` : 'no'}${i === 0 && skipped ? `\n${skipped}` : ''}`).join('\n');

  if (!isHis(verdict)) {
    return { pass: true, state: 'clear', markdown: `### Promotion gate: clear\n\nNone of the three fired, so this promotes once reviewed and green. No owner approval needed.\n\n${body}\n` };
  }
  const approval = findApproval(rows, { repo, pr, headSha });
  if (approval) {
    return { pass: true, state: 'approved', markdown: `### Promotion gate: waits for you, and you approved it\n\nApproval row \`${approval.id}\` (decided ${approval.decided_at}).\n\n${body}\n` };
  }
  if (lookupError) {
    return {
      pass: false, state: 'cannot-look',
      markdown: `### Promotion gate: cannot check for your approval\n\nThis promotion carries at least one of the three things that wait for you, but the gate **could not look for an approval**: ${lookupError}.\n\nSo it cannot currently verify ANY approval, including one you already pressed. **Pressing the card and re-running will not turn this green.** The fix is configuration: set the repository secrets \`PROMOTION_GATE_SUPABASE_URL\` and \`PROMOTION_GATE_SUPABASE_KEY\` (the project URL and its public anon key), then re-run. Your phone was pinged about this if the alert webhook is set.\n\n${body}\n`,
    };
  }
  return {
    pass: false, state: 'waits',
    markdown: `### Promotion gate: waits for you\n\nThis promotion carries at least one of the three things that wait for you, and no approved row exists for it.\n\n${body}\n\n**To raise the approval card:** call the club MCP's \`propose_action\` with kind \`ship_prod\` and scope \`{"repo": "${repo}", "pr": ${pr}}\` (add \`"head_sha"\` to pin it to this exact commit). The card appears on the Standup tab at https://dashboard.wmpc.app/?tab=standup — press it, then re-run this check. A PR body line, a review approval, a label or a comment does not satisfy this check; only the pressed row does.\n`,
  };
}
