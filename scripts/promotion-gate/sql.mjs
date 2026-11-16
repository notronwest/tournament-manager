// Is this migration destructive? Reads the file's text, never its name or the PR title.
// Throws on anything it cannot read — the caller treats a throw as "his" (fail closed).

const VERBS = new Set([
  'create', 'alter', 'comment', 'grant', 'revoke', 'insert', 'select', 'begin', 'commit',
  'do', 'notify', 'set', 'reset', 'with', 'drop', 'delete', 'update', 'truncate',
]);
// Dropping these loses no rows. Every other `drop` (table, column, schema, type, …) does.
const SAFE_DROP = /\bdrop\s+(policy|trigger|function|procedure|view|index|constraint|rule|default|not\s+null|identity|expression)\b/g;

// Strip comments and literals; pull dollar-quoted bodies out so a function body is not read
// as a migration step but a DO block still is. Throws on an unterminated token.
function tokenise(sql, keepLiterals = false) {
  let out = '';
  const bodies = [];
  const literals = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') { const e = sql.indexOf('\n', i); i = e === -1 ? sql.length : e; out += ' '; continue; }
    if (two === '/*') { const e = sql.indexOf('*/', i + 2); if (e === -1) throw new Error('unterminated block comment'); i = e + 2; out += ' '; continue; }
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new Error('unterminated string literal');
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") break;
        j++;
      }
      if (keepLiterals) { literals.push(sql.slice(i + 1, j)); out += ` 's${literals.length - 1}' `; } else out += " '' ";
      i = j + 1; continue;
    }
    if (c === '"') {
      const e = sql.indexOf('"', i + 1); if (e === -1) throw new Error('unterminated quoted identifier');
      out += 'ident'; i = e + 1; continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
      if (m) {
        const e = sql.indexOf(m[0], i + m[0].length);
        if (e === -1) throw new Error('unterminated dollar-quoted body');
        bodies.push({ before: out, text: sql.slice(i + m[0].length, e) });
        out += ` $body${bodies.length - 1}$ `; i = e + m[0].length; continue;
      }
    }
    out += c; i++;
  }
  return { text: out, bodies, literals };
}

function reasonsFor(stmt, enforceVerb) {
  const s = stmt.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!s) return [];
  const r = [];
  const verb = /^[a-z_]+/.exec(s)?.[0];
  if (enforceVerb && !VERBS.has(verb)) r.push(`unclassifiable statement starting "${s.slice(0, 30)}"`);
  const noSafe = s.replace(SAFE_DROP, ' ');
  if (/\bdrop\b/.test(noSafe)) r.push('DROP of something that holds rows');
  if (/\btruncate\b/.test(s)) r.push('TRUNCATE');
  if (/\bdelete\s+from\b/.test(s)) r.push('DELETE FROM');
  if (/\bupdate\s+(only\s+)?[\w."]+(\s+(as\s+)?\w+)?\s+set\b/.test(s)) r.push('UPDATE of existing rows (a backfill)');
  if (/\bon\s+conflict\b.*\bdo\s+update\b/.test(s)) r.push('INSERT … ON CONFLICT DO UPDATE (rewrites existing rows)');
  if (/\balter\s+column\s+\S+\s+(set\s+data\s+)?type\b/.test(s)) r.push('column type change');
  if (/\brename\b/.test(s)) r.push('RENAME');
  return r;
}

// A DO block that does its work inside a sub-block ending in `raise exception using errcode =
// 'P0001', message = '<name>-rollback'` and catches that same message as its sentinel rewrites
// nothing: the sub-block's changes are undone. Returns the text with that sub-block cut out and the
// number of statements cut, or null when the pattern is not recognised with certainty (fail closed).
const SENTINEL = /raise\s+exception\s+using\s+errcode\s*=\s*'s(\d+)'\s*,\s*message\s*=\s*'s(\d+)'\s*;\s*exception\s+when\s+others\s+then\s+if\s+sqlerrm\s*<>\s*'s(\d+)'\s+then\s+raise\s*;\s*end\s+if\s*;\s*end\s*;/g;
const BLOCK_TOKEN = /\bbegin\b|\bend\s*;/g;

function withoutRollbackBlock(raw) {
  const { text, literals } = tokenise(raw, true);
  const hits = [...text.matchAll(SENTINEL)].filter((m) => (
    literals[m[1]] === 'P0001' && literals[m[2]] === literals[m[3]] && /-rollback$/.test(literals[m[2]])
  ));
  if (hits.length !== 1) return null;
  // `case … end;` ends in `end;` too, which the begin/end walk below would miscount.
  if (/\bcase\b/.test(text)) return null;
  const m = hits[0];
  // Walk back from the sentinel to the `begin` that opens its own block.
  let depth = 0; let start = -1;
  for (const t of [...text.slice(0, m.index).matchAll(BLOCK_TOKEN)].reverse()) {
    if (t[0] === 'begin') { if (depth === 0) { start = t.index; break; } depth--; } else depth++;
  }
  if (start === -1) return null;
  const cut = text.slice(start, m.index + m[0].length);
  // Anything that can leave the block before the sentinel means the rollback may never run.
  if (/\b(return|exit|continue|goto)\b/.test(cut)) return null;
  const statements = cut.split(';').filter((x) => x.trim()).length;
  return { rest: text.slice(0, start) + ' ' + text.slice(m.index + m[0].length), statements };
}

// Same judgement as analyzeSql, plus what was set aside and why, so the verdict can say so.
export function analyzeSqlDetailed(sql) {
  if (typeof sql !== 'string') throw new Error('migration text is not readable');
  const { text, bodies } = tokenise(sql);
  const reasons = [];
  const skipped = [];
  for (const stmt of text.split(';')) reasons.push(...reasonsFor(stmt, true));
  for (const b of bodies) {
    // A function/procedure body is not run by the migration; anything else (DO …) is.
    if (/create\s+(or\s+replace\s+)?(function|procedure)\b[^;]*$/i.test(b.before.slice(-4000))) {
      skipped.push({ kind: 'function body', statements: tokenise(b.text).text.split(';').filter((x) => x.trim()).length });
      continue;
    }
    const cut = withoutRollbackBlock(b.text);
    if (cut) skipped.push({ kind: 'self-test that rolls back', statements: cut.statements });
    const inner = tokenise(cut ? cut.rest : b.text);
    for (const stmt of inner.text.split(';')) reasons.push(...reasonsFor(stmt, false));
  }
  return { reasons: [...new Set(reasons)], skipped };
}

export function analyzeSql(sql) {
  return analyzeSqlDetailed(sql).reasons;
}
