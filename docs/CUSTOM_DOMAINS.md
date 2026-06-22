# Custom domains → tournaments (#408)

Let an organizer point their own domain (e.g. `pickleballangels.com`) at a
tournament, served at the clean root of that domain.

## Two tiers

**Tier 1 — bespoke (shipped).** One domain at a time, wired by hand. The
Cloudflare side is a **Pages custom domain** (Cloudflare provisions the TLS
cert; no API); the app side is the `custom_domains` table + host routing
below. This is what `pickleballangels.com` uses.

**Tier 2 — self-serve (future).** Organizers add their own domains through
the admin UI; we register them as **Cloudflare for SaaS custom hostnames**
via API, drive DNS (CNAME/TXT) verification, and provision certs
per-host. Same `custom_domains` table, plus admin writes + a provisioning
worker. Not built yet — Tier 1 generalizes into it.

## How it works (app side)

- **`custom_domains`** maps `host → tournament_id` (migration
  `20260619140000_custom_domains.sql`). Publicly readable (needed at page
  load, pre-auth; nothing sensitive). Writes are server-only for now.
- **Host resolution** (`web/src/lib/customDomain.tsx`): on boot, if
  `window.location.hostname` isn't a canonical host
  (`*.bertanderne.com`, `*.pages.dev`, `localhost`), we look it up in
  `custom_domains` and resolve `{orgSlug, tournamentSlug}`.
- **Root serving** (`RootRoute` in `App.tsx`): on a mapped custom host, `/`
  renders `PublicTournamentPage` for the mapped tournament (the page takes
  `orgSlugOverride`/`tournamentSlugOverride`). Every other path works
  unchanged on the custom host. Canonical hosts render the normal HomePage.

So `pickleballangels.com/` shows the Seacoast tournament at the clean root,
while `pickleballangels.com/t/...`, `/login`, etc. all still work.

## Infra-intake (Tier 1)

- **Unattended / self-heal:** the mapping is a committed migration row;
  resolution is a stateless read. Nothing to babysit. If the lookup fails
  (DB down / no row), `RootRoute` falls back to the HomePage — **fail-open
  to a working page**, never a hard error.
- **Singleton:** none needed — it's a read path, safe on every machine /
  every request.
- **Propagation:** the host map is in Postgres (one source of truth); the
  cert + DNS live in Cloudflare. No per-machine state.
- **Observability while away:** a misconfigured domain shows the HomePage
  (visible, not broken). Cloudflare surfaces cert/DNS status in its
  dashboard.
- **Not covered yet (Tier 2):** automated DNS verification, cert
  provisioning via API, admin self-serve writes, per-org branding (the
  global SiteHeader still renders on custom hosts).

## Runbook — add a domain (Tier 1)

For `pickleballangels.com` (client-owned domain; we have DNS access):

1. **Seed the map** — add the row (the migration does this for
   `pickleballangels.com`; for another domain, add a `custom_domains` row
   for its `host` + `tournament_id`).
2. **Cloudflare Pages → tournament-manager (prod) → Custom domains →
   Set up a custom domain** → `pickleballangels.com`. Cloudflare shows the
   DNS target + provisions the cert.
3. **DNS** — at the domain's DNS, add the record Cloudflare asks for
   (usually a `CNAME` to the Pages target; for an apex, Cloudflare's
   flattening or an `A`/`ALIAS`). Add `www` too if desired.
4. Wait for the cert to go active, then load `https://pickleballangels.com`
   — it should render the Seacoast tournament at the root.

Repeat 1–4 per domain until Tier 2 automates it.
