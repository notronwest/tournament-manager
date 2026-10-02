# AUTO doubles partner-linkage — PR notes

Pairs doubles registrations automatically after a PickleballBrackets.com import — no
manual `raS.aspx` script. Closes the last gap from the PB.com import work (D-0045 /
#984): the attendees flat-file carries no `TeamID`, so doubles land
`partner_status='seeking'`; the partnership lives only on PB.com's authenticated
**director Attendees page (`raS.aspx`)**, with full unmasked partner phones. This
scrapes that, joins by normalized phone, and confirms the pairing — folded into the
standing `poll` loop and exposed as a supervised `link-partners <tid>` command.

## What changed

### pbcom-driver (new)
- **`src/pbcom/attendees.ts`** — the LIVE fetch that fills pbPartners' trace seam.
  - `PlaywrightAttendeesBrowser` adapts the driver's `PbcomSession.page` to
    pbPartners' structural `PbcomBrowserSession` (goto / pageText / clickNext). It is
    DOM-only: navigate, dump the page's rendered **text**, click the WebForms "Next"
    pager. No parse logic here — pbPartners parses the text.
  - `collectAttendeesPages(browser, baseUrl, eid)` — pure of Playwright (drives the
    structural interface, so it's unit-tested with a fake). Paginates until
    `parsePaginationTotal` reports the last attendee (`to >= total`), or "Next" is
    absent/disabled, or the `to` counter stops advancing (infinite-loop guard), or
    `MAX_PAGES`. Returns one `RawAttendeeBlock` per page (full page text).
  - `parsePages(pages)` — joins the page texts and runs the PURE
    `parseAttendeesPartners` **string path**, so pbPartners' own header-anchor
    `splitAttendeeBlocks` delimits attendees correctly **across page boundaries**.
  - `fetchAttendeesPartnersPages(session, baseUrl, eid)` — the driver-side seam that
    wires the adapter + loop. URL is built from the **configured base** (`pbcomBaseUrl`),
    never hardcoded; path `…/a5_u/pbt/raS.aspx?eid=…` follows the `eDB.aspx` console
    convention in `pbcom/driver.ts`. The exact query is a **trace seam** — verified in
    the supervised first run (see below).
- **`src/push/linkPartners.ts`** — orchestration + the service-role store adapter.
  - `DbPartnerData` implements pbPartners' `PartnerLinkStore` **plus** the two reads
    linkage needs (`players()`, `unpairedDoublesCount()`). On first use it loads the
    tournament's pbcom events → registrations → players (service-role, read-only) and
    builds a `(divisionKey :: normalized-last-10-phone) → registration` index.
    - `resolveRegistration(divisionKey, normPhone)` → O(1) index lookup.
    - `setPartner(a, b)` → the **exact** write the import's TeamID pairing uses:
      `partner_registration_id` + `partner_status='confirmed'` on the row; the loop
      calls it both ways. It also refreshes the in-memory index so a later resolve in
      the same run sees the new state. It only ever writes a *confirm* — never clears.
    - Injectable DB client (`PartnerDb`) exactly like `DbPushLedger`, so it's tested
      against a mock Supabase; production builds the service-role client lazily.
  - `applyScrapedPartners(data, entries)` — the per-tournament core, pure of the
    browser: `buildPartnerLinks` → `applyPartnerLinks` over the store. Reuses
    pbPartners end-to-end; returns `{ linked, unchanged, unlinked, skipped }`.
  - `runAutoLinkPartners(opts, deps)` — the standing pass (mirrors `runAutoPush`).

### pbcom-driver (changed)
- **`src/cli.ts`** — `makeOpenScraper` (one `PbcomSession` per tick → scrape per eid
  via the seam + `parsePages`), `runLinkPartners(cfg, tids, dryRun)` (shared by both
  entry points), the **`link-partners <tournamentId>`** command, and the **poll
  fold-in** (linkage runs before the push each tick; DB-only, skipped for `--fixture`).

### web (changed — enables clean reuse, no logic reimplemented)
- **`src/lib/pbDivision.ts`** (new) — `divisionKey` extracted into a dependency-free
  module. **Why:** pbPartners needed only `divisionKey` from `pbImport`, but `pbImport`
  imports `xlsx`; importing pbPartners into the Node driver would have transitively
  pulled `xlsx` (absent from the driver and from the mini, which never installs web
  deps), breaking both typecheck and the mini runtime. pbPartners now imports
  `divisionKey` from here and is genuinely dependency-free, as its header promises.
- **`src/lib/pbImport.ts`** — `divisionKey` is now **re-exported** from `./pbDivision`,
  so every existing `import { divisionKey } from "./pbImport"` is unchanged.
- **`src/lib/pbPartners.ts`** — import `divisionKey` from `./pbDivision`; plus **six
  behavior-neutral non-null assertions** (`m[2]!`, a `sort() as [string,string]`,
  etc.) so the module also typechecks under the driver's stricter
  `noUncheckedIndexedAccess` (web's tsconfig doesn't set it). No parse/join logic
  changed. Web tests (47) and `tsc -b` stay green.

## How linkage folds into the standing loop
`poll` (the launchd tick) now runs **partner-linkage first, then the push**, so
doubles are paired before brackets are built. Linkage is its own pass with its own
`state/pbcom-link.lock` (distinct from the push lock, so the two never block each
other) and the **same singleton host gate** (`PBCOM-PUSH-HOST`). It is best-effort
around the push: a linkage error is caught and logged, and the push still runs.

**Cheap unpaired-doubles pre-check** (mirrors the push skipping a session with no
delta): before any browser opens, `unpairedDoublesCount()` is read per tournament; a
tournament with zero `seeking` doubles is skipped, and if **nothing** anywhere needs
linking, **no browser opens at all**.

## Idempotency
- The pre-check skips already-paired tournaments.
- `applyPartnerLinks` (pbPartners) no-ops a pair already confirmed to each other, so a
  re-run pairs **only** what is still unlinked and issues **zero** writes otherwise.
- An existing confirmed pairing is **never** deleted or overwritten.

## Fail-closed / self-healing (reuses the push loop's safety, `run.ts`)
- Host gate + same-machine lock; an unset `PBCOM-PUSH-HOST` drives nowhere.
- A lapsed PB.com session (`PbcomLoginError` via `isSessionLapse`) records nothing,
  posts **one** deduped Discord `session-lapse` alert, and exits cleanly (no
  crash-loop) — identical to the push loop; a human re-auths headed once and it resumes.
- **Unlinked** partners (phone mismatch, waitlisted-but-absent, placeholder like
  `+93 …`, partner-needed, owner-not-found) are **logged** and summarized to Discord
  (deduped, informational) — **never guessed**, never a hard failure.

## Reuse (D-0049 — name the reuse)
- **pbPartners** (web/src/lib): `parseAttendeesPartners`, `parsePaginationTotal`,
  `buildPartnerLinks` (normalized last-10-phone join + name fallback),
  `applyPartnerLinks` over the `PartnerLinkStore` port, and all its types. No
  parse/phone-join/apply logic is reimplemented in the driver. `divisionKey` via the
  new `pbDivision` module.
- **Driver helpers**: `PbcomSession` (persistent-profile auth, `PbcomLoginError`),
  `run.ts`'s `FileLock` / `isPushHost` / `isSessionLapse`, the service-role Supabase
  access pattern (as `DbPushLedger` / `DbDrawSource`), `alert.ts` (deduped Discord),
  `binding.ts` (tournament↔eid), `config.ts` (`pbcomBaseUrl`), `log.ts`.

## CLI
```
cli.ts link-partners <tournamentId> [--dry-run] [--force-host]   # supervised
cli.ts poll [--dry-run] [--force-host]                           # links partners, then pushes
```

## Verify (real output)
- `npm run typecheck` → clean (tsc, no errors), incl. the cross-package import of
  pbPartners under the driver's stricter config.
- `npm test` → **8 files, 85 tests passed** (14 new in `tests/partners.test.ts`:
  store adapter resolve/count/players/setPartner, apply-both-ways + idempotent no-op +
  no-write-on-unmatched, the loop's link/report/pre-check-skip/session-lapse/host-gate/
  dry-run, and pagination incl. across-page parsing + URL building). Fixture-based; no
  live browser, no real member data.
- web: `npx vitest run src/lib/*` → 47 passed; `tsc -b --noEmit` → clean.

## Supervised first live run (owner)
1. On the club mini (the `PBCOM-PUSH-HOST`), with `.env` filled and the persistent
   PB.com profile authenticated, run **watched**:
   `npx tsx src/cli.ts link-partners <tournamentId> --force-host`
   Confirm it navigates the real `raS.aspx` director Attendees page, paginates, and
   that the linked/unchanged/unlinked counts match reality before trusting the loop.
2. **Verify-after the trace seam.** Two role/text selectors meet the live DOM for the
   first time here and may need a one-line tweak against the capture:
   - the `raS.aspx` **query string** (`attendees.ts` `ATTENDEES_PATH` / `attendeesUrl`),
   - the pager **"Next"** control (`PlaywrightAttendeesBrowser.clickNext`).
   The block/entry/phone **grammar** is already proven (pbPartners unit tests), so only
   navigation + pagination are unproven.
3. Once the watched run looks right, the standing `poll` picks it up automatically
   (cheap pre-check → links only when there are `seeking` doubles).

## Left for the owner
- Verify + ship (this branch is committed, **not pushed**; no PR opened).
- Confirm/adjust the two trace-seam selectors above in the supervised run.
- Optional: fold a one-paragraph summary of this pass into `pbcom-driver/DESIGN.md`
  (kept out of this change to stay scoped to the ask).
- No new secrets or DB migration: reuses `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
  and writes existing `event_registrations` columns.
