// Classify a promotion's diff into (a) data loss, (b) money, (c) member-facing.
// Pure: takes files, returns a verdict. FAILS CLOSED — see `errors` and `unclassified`.
import { analyzeSqlDetailed } from './sql.mjs';
import { MONEY_PATHS, MONEY_CONTENT, MEMBER_PATHS, INTERNAL_PATHS, TEST_PATH } from './rules.mjs';

const any = (list, p) => list.some((re) => re.test(p));

// file: { path, status: 'added'|'modified'|'deleted'|'renamed'|…, content: string|null, added: string }
export function classify(files) {
  const v = { a: [], b: [], c: [], skipped: [], unclassified: [], errors: [] };
  if (!Array.isArray(files)) { v.errors.push({ path: '(diff)', why: 'the diff could not be computed' }); return v; }
  for (const f of files) {
    try {
      const p = f?.path;
      if (typeof p !== 'string' || !p) throw new Error('a changed file has no readable path');

      const isMigration = p.startsWith('supabase/migrations/');
      // Anything under supabase/migrations/ is judged first, whatever its name — Supabase applies every .sql there.
      if (p.endsWith('.sql') && (isMigration || !TEST_PATH.test(p))) {
        // An applied migration that is edited or removed is a rewrite of history, not an addition.
        if (isMigration && f.status !== 'added') v.a.push({ path: p, why: `an existing migration was ${f.status}` });
        else if (f.status !== 'deleted') {
          const r = analyzeSqlDetailed(f.content);
          for (const w of r.reasons) v.a.push({ path: p, why: w });
          for (const k of r.skipped) v.skipped.push({ path: p, ...k });
        }
      }

      const moneyPath = any(MONEY_PATHS, p);
      if (moneyPath) v.b.push({ path: p, why: 'money path' });
      else if (!/\.(md|sql)$/.test(p) && !TEST_PATH.test(p) && typeof f.added === 'string') {
        const m = MONEY_CONTENT.exec(f.added);
        if (m) v.b.push({ path: p, why: `adds money-moving code (${m[0]})` });
      }
      const memberPath = any(MEMBER_PATHS, p);
      if (memberPath) v.c.push({ path: p, why: 'renders or sends to members' });

      if (!moneyPath && !memberPath && !any(INTERNAL_PATHS, p)) {
        v.unclassified.push({ path: p, why: 'matches no known path group' });
      }
    } catch (e) {
      v.errors.push({ path: f?.path ?? '(unknown)', why: `could not classify: ${e.message}` });
    }
  }
  return v;
}

// His = any of the three fired, or anything was unclassifiable / errored.
export function isHis(v) {
  return v.a.length + v.b.length + v.c.length + v.unclassified.length + v.errors.length > 0;
}
