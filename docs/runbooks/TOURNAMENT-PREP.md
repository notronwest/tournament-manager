# Runbook 1 — Tournament prep (before event day)

Works for any tournament run on Bert & Erne — WMPC or an external host (e.g.
Pickleball Angels). T-minus times are targets; the Friday offline dry run is
the one that can't slip. Pair with
[Runbook 2 — Tournament day](./TOURNAMENT-DAY.md). See also
[`docs/OFFLINE.md`](../OFFLINE.md) for the full offline-mode reference and
[`docs/tournament-host-guide.md`](../tournament-host-guide.md) for the
setup-intake side of the job.

## T-7 days — field

- [ ] Registration deadline confirmed in B&E (extending it reopens an
      auto-closed tournament — #861 merged).
- [ ] Waitlist worked: promote / team spot offers / partnerless doubles teams
      resolved (Player B fix — PR #866, still open).
- [ ] Refunds + change-request queue cleared so the field is stable.
- [ ] Briefing email queued (start times + location + "Can't make it?" —
      #849/#858 merged).

## T-3 days — lock the field

- [ ] Close registration. Export the roster; eyeball every event for odd team
      counts (a 5-team pool is fine, a 2-team pool is not).
- [ ] Rosters confirmed per event: names, ratings, partner status. Fix
      profiles in the admin rating picker (#863 merged).
- [ ] Pools + seeding: distribute pools, seed by rating, sanity-check the
      spread. Know the tie-break rule you'll announce (head-to-head before
      differential — PR #872, still open; until it merges, break ties by
      hand).
- [ ] Courts assigned per event/pool on the Schedule page; medal round modeled
      as its own phase (#833 merged) so the next event starts on freed courts.
- [ ] Playoff format set per event (Top-4 today; Top-6 / Top-8 single-elim is
      PR #878, still open). Preview the bracket before generating (PR #869,
      still open).
- [ ] Pool distribution locks once games exist (#875 merged) — so this is the
      last free rearrangement. Do it deliberately.

## T-2 days — offline runner (the venue has no Internet; assume it)

- [ ] On the event laptop, **while still online**: `git pull main`; run
      `cd web && npm install` so web deps are current; make sure Docker
      Desktop is running. Then `bash scripts/offline.sh` once — it starts the
      local Supabase stack, writes `web/.env.offline.local`, and launches the
      app in offline mode (this first run also caches the local stack's
      Docker images, the only network-dependent step). Never run
      `supabase stop --no-backup` — that flag deletes the local data.
      (A follow-up PR, #865, still open, teaches `offline.sh` to run
      `npm install` for you and fixes an Inbucket port conflict — until it
      merges, run `npm install` yourself first as above.)
- [ ] Pull the live tournament down: **while still online**, open the
      tournament's **Offline field import / export** page
      (`/admin/<org-slug>/tournaments/<tournament-slug>/offline-field`) and
      click **"Download locked field (JSON)"** — this exports every event's
      confirmed teams (players + partner pairing) to a JSON file. Carry that
      file to the offline laptop (USB stick / AirDrop). Once the local stack
      is up, open the **same page** running against the local app and use
      **"Import locked field"** to upload the JSON — it matches events by
      name, players by email, and seeds each event's teams. This is a plain
      file hand-off, not a live sync (#736).
- [ ] Local director auth verified (#734 merged) — you can log in with no
      hosted session (seeded `director@offline.local` account, offline-only).
- [ ] Verify the offline build is network-clean (#735):
      1. `./scripts/offline-bundle-grep.sh` — builds the app in offline mode
         and greps the bundle for any `http://`/`https://` literal not on the
         reviewed allowlist. Must print `PASS`.
      2. With `./scripts/offline.sh` running in one terminal, run the dynamic
         check in another: `cd web && OFFLINE_BASE_URL=http://localhost:5173
         npm run test:e2e:offline` (match the port to whatever `offline.sh`
         printed). This drives a full mock event (create a tournament, seed
         teams, run the round robin, run the playoff) while intercepting
         every network request and failing on anything that isn't
         `localhost`/`127.0.0.1`.
      There is no single `offline-verify.sh --full` script — these two checks
      together are what "verify offline" means in this repo.
- [ ] First `./scripts/offline-backup.sh` snapshot → USB stick. Note the
      `.sql` filename it prints.
- [ ] Laptop: power supply + extension cord packed; plan to run lid-open on
      the table (`caffeinate`, wired into `offline.sh`, covers display/system
      sleep; a true closed-lid clamshell setup needs external power + display
      regardless of any app-level setting — don't rely on it).

## T-1 day — paper

- [ ] Print scoresheets per pool (pool label on the printed scorecard — PR
      #874, still open; until then, hand-write the pool on each sheet).
- [ ] Print pool tracking sheets (one per pool: round-robin grid, W-L, point
      diff). An in-app generator for this is PR #884, still open — until it
      merges, use a spreadsheet template or rule the grid by hand.
- [ ] Print check-in sheets per event (alphabetical by last name, partner
      column, paid Y/N, waiver Y/N). An in-app check-in screen + printable
      sheet is PR #881, still open — until it merges, this is a paper-only
      step.
- [ ] Print blank brackets for each playoff size you might need (4 / 6 / 8) +
      the schedule/results page (#737 merged — the print button fits it to a
      page).
- [ ] Clipboards, pens, tape, spare paper, a marker for the whiteboard court
      board.

## Dry run (Friday, non-negotiable)

- [ ] Wi-Fi OFF. `./scripts/offline.sh`. App loads with the OFFLINE banner.
      Log in. Open the day's events. Enter one test score, undo it, restore
      from the backup snapshot. If any step fails, you still have Internet to
      fix it — that's the whole point of doing this Friday.

## Reseed / backup plan (decide now, not at the desk)

- **No-show before pools start:** pull the team, re-distribute that pool only
  (the lock isn't hit until games exist), reprint that pool's sheets. Prefer
  byes over reseeding once games exist.
- **No-show mid-pool:** forfeit the remaining matches (#50 — a no-show/forfeit
  flow is still an open design gap; record the forfeits by hand, e.g. 11-0, on
  the tracking sheet).
- **Laptop dies:** paper is the source of truth from that moment; scores go on
  tracking sheets; playoffs run off the printed blank bracket; re-enter into
  B&E after the event from paper.
- **Data corruption:** `supabase stop` (no flags), restore the last
  `backups/*.sql` snapshot, re-enter anything since. Snapshot between every
  round to keep this window small.
- **Second laptop (if you have one):** same one-time setup, restore the same
  snapshot — it's a warm spare, not a mirror.

## Open questions for Ron

1. `backups/OFFLINE-CHEATSHEET.md` — `backups/` is gitignored and not checked
   out on the mini, so this couldn't be read while drafting this runbook. If
   it has content worth folding in here, paste it into the tracking issue or
   commit it under `docs/` and a follow-up can merge it.
2. The check-in/start-gate (#881) and in-app pool-tracking-sheet (#884) PRs
   are now open (not yet merged) — the paper-only steps above should flip to
   the in-app flow once they land.
