# Runbook 2 — Tournament day (on-site, day-of run)

Pair with [Runbook 1 — Tournament prep](./TOURNAMENT-PREP.md). Nothing here
assumes Internet — see [`docs/OFFLINE.md`](../OFFLINE.md) for the full
offline-mode reference.

## Arrive (T-90 min)

- [ ] Laptop on power, lid open. Docker Desktop up. `./scripts/offline.sh`.
      OFFLINE banner showing. Log in (local director auth — seeded
      `director@offline.local` account, no hosted session needed).
- [ ] Open today's tournament; confirm every event, pool, and court
      assignment matches the printed sheets. If they don't, the printouts win
      until you've fixed the app.
- [ ] Snapshot: `./scripts/offline-backup.sh` → USB. Write the printed
      filename on the tracking-sheet clipboard.
- [ ] Court board (whiteboard): court numbers, event on each, "next up"
      column.

## Player check-in (T-60 to T-15)

- [ ] Check-in sheet per event at the desk; initial each player, confirm
      partner, paid, waiver.
- [ ] In-app check-in when PR #881 lands (still open as of this writing);
      until then, mark check-in on paper and reconcile before Start.
- [ ] 15 min before start: read the no-show list. Apply the reseed plan from
      Runbook 1 (pull + redistribute only if no games exist yet; otherwise
      forfeit).
- [ ] Rules announcement: format, scoring, tie-break (head-to-head then point
      differential), where scores get reported, and the paper backstop.

## Start events

- [ ] Start each event; generate matches (round robin per pool). Confirm the
      match count equals what the tracking sheet expects
      (`n·(n-1)/2` per pool).
- [ ] Snapshot.

## Court manager (continuous)

- [ ] Assign matches to courts from the Court Manager; call them from the
      board; keep one match queued per court.
- [ ] Enter scores as sheets come in. Valid-score enforcement + a confirmation
      step is PR #870, still open — until it merges, have a second person
      read back every score before Save.
- [ ] After every completed round: snapshot, and tick the tracking sheet so
      paper stays in sync with the app.
- [ ] Watch standings after each round; if the head-to-head tie-break fix
      (#872, still open) isn't merged yet, check ties by hand before you
      announce seeds.

## Playoffs

- [ ] Pool play complete → verify standings against the tracking sheet →
      announce seeds.
- [ ] Preview the bracket (PR #869, still open) → generate playoffs (Top-4
      today; Top-6/Top-8 once PR #878 merges) → print brackets, post one at
      the desk.
- [ ] Run the medal round as its own phase (#833 merged) so the freed courts
      go straight to the next event.
- [ ] Enter final scores; medals awarded; snapshot.

## Paper backstop (if the laptop is gone)

- [ ] Tracking sheets become the record. Fill the printed blank bracket by
      hand from the sheet standings. Take a phone photo of every sheet at the
      end of each round.
- [ ] After the event, re-enter results into B&E from paper (or restore the
      last snapshot and add the delta), then export results per the step
      below.

## Wrap

- [ ] Final snapshot to USB + phone photos of all sheets.
- [ ] Export each event's results while still on the offline laptop: open
      that event in the Event Console and click **"Export results (CSV)"**
      (Standings tab) — one CSV per event, gitignored/local, no network call.
- [ ] Once back online on the hosted project, re-enter or re-import the field
      as needed (roster changes made offline aren't synced automatically —
      there is no live sync, #736) and keep the exported CSVs as the
      point-in-time record of final standings.
- [ ] Ten-minute retro: what broke, what was slow, which PR would have saved
      it — capture it as a tracking issue while it's fresh.
