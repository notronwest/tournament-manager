# Product context

> The backlog (user stories) now lives on the **WMPC Roadmap** GitHub Project:
> https://github.com/users/notronwest/projects/1 — filtered to this repo's
> issues. This file keeps the durable reference context that isn't a story.

## Personas
- **Player** — registers and competes
- **Organizer** — runs a tournament, owns or admins an org
- **Visitor** — unauthenticated browser, may or may not become a player
- **Spectator** — watches a tournament without registering
- **Developer** — internal QA / load-testing role

## Architectural directions in play

These came out of the scenario pass (`docs/scenarios/tournament-lifecycle.md`)
and shape multiple stories. Logged here so future work doesn't relitigate them.

- **Three separate admin surfaces for a tournament's lifecycle.** Creation (the
  wizard), Editing (the Common Tasks dashboard for published-with-registrations),
  Running (Court-Manager-centric, scoreboard front-and-center). Each has its own
  URL and layout. A tournament's primary admin URL adapts based on phase; the
  others are reachable but secondary.
- **Per-event lifecycle gating is manual.** The organizer is always in the
  driver's seat for transitions (Ready to Run → Lock → Plan → Running). No global
  date-based auto-transition for the tournament. Event auto-complete IS
  automatic, but only at natural inflection points (end of pool, end of each
  playoff round).
- **A tournament can have events in different lifecycle states at once.** Running
  is per-event, not per-tournament. One event scoring its final while another
  hasn't started is the normal case.
- **Pricing locks the moment money is committed.** Once any active registration
  exists for a tournament / event, pricing fields are read-only. Refund-and-
  re-register is the only path to fix a price.
