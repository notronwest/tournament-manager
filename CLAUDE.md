# Tournament Manager — Claude context

Long-term, this is a clone of [PickleballBrackets.com](https://PickleballBrackets.com): tournament organizers create tournaments, players register and pay, brackets get generated and run. Currently we're at the foundation: schema + auth + organizer-side tournament create/list/view.

This file is the source of truth for the **decisions** made and the **path** ahead. Read it first whenever you pick the project back up.

---

## Stack

Mirrors `wmpc-rating-hub` (deliberately — see `~/.claude/CLAUDE.md` for the "wmpc stack" memory).

- **Frontend** (`web/`): Vite 7 + React 18 + TypeScript (strict) + React Router v6
- **Charts** (when we need them): Recharts
- **Auth & DB**: Supabase (Postgres + RLS + Auth + Edge Functions)
- **Deploy**: Cloudflare Pages with Git integration — auto-builds + auto-deploys on every push to `main`. SPA fallback via `web/public/_redirects` (`/* /index.html 200`).
- **Styling**: inline styles, no CSS framework. Conventions in `docs/DESIGN_PREFERENCES.md`.

---

## The six locked decisions (don't re-litigate without flagging)

1. **Multi-tenant.** Organizations are tenants. Every domain table is scoped by `organization_id` (directly or transitively via `tournament_id`).
2. **Player accounts are optional.** `players` is a **shared global table** (not org-scoped). `auth_user_id` is nullable — organizers can pre-create player records before those players claim accounts. This is also how PickleballBrackets does it; lets DUPR / PB Vision / WMPC ratings follow the player across orgs.
3. **Skill rating sources are pluggable.** `player_ratings` table with a `rating_source` enum (`dupr`, `pbvision`, `wmpc_rating_hub`). Per-event skill restrictions reference both the source and the score range.
4. **Stripe Connect** (not single-account). Each organizer connects their own Stripe account; we take a platform fee via `application_fee_amount` on the destination charge. `organizations.stripe_account_id` + `stripe_account_status` track onboarding.
5. **All auth methods enabled**: email/password, magic link, Google OAuth.
6. **Pricing**: per-event fee + tournament-level entry fee. `tournaments.entry_fee_cents` + `events.event_fee_cents`. Total = entry + sum of registered events.

### Smaller decisions baked in

- **Email is soft-unique** on players (indexed for lookup, NOT a unique constraint — supports parent + child sharing one email).
- **Doubles teams: one row per player** in `event_registrations`, paired via `partner_registration_id` self-FK. Each player pays their own event fee separately (PickleballBrackets model). Helps build per-player tournament history later.
- **Soft delete** via `deleted_at` columns on long-lived entities (organizations, tournaments, events, players, registrations, event_registrations). Hard delete is reserved for ephemeral records (partner_invites).
- **WMPC org seeded** in the init migration (slug `wmpc`); first user manually claims ownership via SQL (snippet at the bottom of the migration file).
- **Stripe writes are server-only**: `payments` table has SELECT policies but no INSERT/UPDATE policy — all mutations go through edge functions using the `service_role` key (which bypasses RLS). Prevents a malicious client from forging a "paid" status.
- **Auth state lives in `AuthProvider`** (React context), exposed via `useAuth()`. Sessions restore on mount and stay live through `supabase.auth.onAuthStateChange`.

---

## Schema overview (12 tables, see `supabase/migrations/20260503000001_init_schema.sql` for the full thing)

```
organizations              ← tenants; holds Stripe Connect account info
  └─ organization_members  ← (user_id, org_id, role: owner/admin/staff)

players                    ← shared global record per human; auth_user_id optional
  └─ player_ratings        ← (player, source, score, as_of) — historical snapshots

tournaments                ← scoped to organization
  └─ events                ← skill/age/gender/format brackets within a tournament
       └─ event_registrations    ← one row per player; pair via partner_registration_id
       └─ partner_invites        ← doubles partner accept/decline tokens
  └─ registrations         ← tournament-level (entry fee captured here)

payments                   ← Stripe payment intents (writes via edge functions only)
  └─ payment_line_items    ← entry fee + each event_registration as a line

audit_log                  ← generic admin event log
```

**Enums** (11): `org_role`, `org_stripe_status`, `player_gender`, `rating_source`, `tournament_status`, `event_format`, `event_gender`, `bracket_type`, `registration_status`, `partner_status`, `partner_invite_status`, `payment_status`.

**RLS helpers** (in `public` schema): `is_org_member(org_id)`, `has_org_role(org_id, min_role)`, `current_player_id()`. Policies should call these instead of inlining the same `exists (...)` check everywhere.

**RLS posture**: enabled on every table. Public can read published tournaments + events + players (basic info). Drafts visible only to org members. Player-owned rows readable by the player (via `current_player_id()`) and by org members of the relevant tournament's org.

---

## Routes (current)

| Path | Component | Auth |
|---|---|---|
| `/` | `App.tsx` HomePage | public |
| `/login` | `LoginPage` | public |
| `/admin` | `AdminIndexPage` | required → org picker (auto-redirects if 1 org) |
| `/admin/:orgSlug` | `AdminLayout` → `OrgOverviewPage` | required + org member |
| `/admin/:orgSlug/tournaments` | `TournamentsListPage` | required + org member |
| `/admin/:orgSlug/tournaments/new` | `CreateTournamentPage` | required + org member |
| `/admin/:orgSlug/tournaments/:tournamentSlug` | `TournamentDetailPage` | required + org member |

Future:
- `/admin/:orgSlug/tournaments/:tournamentSlug/edit`
- `/admin/:orgSlug/tournaments/:tournamentSlug/events/new`
- `/admin/:orgSlug/settings/stripe` — Connect onboarding
- `/t/:orgSlug/:tournamentSlug` — public registration page
- `/players/:playerId` — public player profile

---

## File map

```
tournament-manager/
├── CLAUDE.md                    # this file
├── README.md                    # human dev setup
├── package.json                 # top-level (minimal — react-router-dom v7)
├── .gitignore
├── docs/
│   └── DESIGN_PREFERENCES.md    # universal UI rules (no native confirms,
│                                #   fixed-width row icon slots, amber palette)
├── supabase/
│   ├── config.toml              # project_id "tournament-manager"
│   ├── migrations/
│   │   └── 20260503000001_init_schema.sql   # 12 tables, RLS, helpers, WMPC seed
│   └── functions/               # (empty; edge functions land when we add Stripe)
├── scripts/                     # (empty; ad-hoc Node .mjs utilities go here)
└── web/
    ├── package.json             # @supabase/supabase-js, react-router-dom v6, recharts
    ├── tsconfig*.json, vite.config.ts, eslint.config.js
    ├── wrangler.jsonc           # Cloudflare Worker SPA config
    ├── index.html
    ├── .env.template            # commit this; .env.local is gitignored
    └── src/
        ├── main.tsx             # AuthProvider wraps BrowserRouter wraps App
        ├── App.tsx              # routes
        ├── index.css            # global reset + system-ui font
        ├── supabase.ts          # createClient<Database>(...) — typed client
        ├── auth/
        │   ├── AuthProvider.tsx     # context + 4 sign-in methods + signOut
        │   ├── RequireAuth.tsx      # route guard
        │   └── LoginPage.tsx        # tabbed: signin/signup/magic + Google
        ├── hooks/
        │   └── useCurrentOrg.ts     # reads :orgSlug, fetches org, checks membership
        ├── pages/admin/
        │   ├── AdminLayout.tsx
        │   ├── AdminIndexPage.tsx
        │   ├── OrgOverviewPage.tsx
        │   ├── TournamentsListPage.tsx
        │   ├── CreateTournamentPage.tsx
        │   └── TournamentDetailPage.tsx
        └── types/
            └── supabase.ts          # GENERATED — never hand-edit
```

---

## Setup on a fresh machine

```bash
# 1. Clone + install
git clone git@github.com:notronwest/tournament-manager.git
cd tournament-manager/web && npm install

# 2. Env vars
cp .env.template .env.local
# Fill in:
#   VITE_SUPABASE_URL          → Supabase Dashboard → Settings → Data API → Project URL
#   VITE_SUPABASE_ANON_KEY     → Supabase Dashboard → Settings → API Keys
#                                → "Publishable key" (sb_publishable_...)

# 3. Link Supabase CLI (one-time per machine)
cd ..
supabase login                              # browser auth
supabase link --project-ref <ref-id>        # ref ID is in dashboard URL or Settings → General
                                            # prompts for DB password

# 4. (If schema is ahead of remote) push migrations
supabase db push

# 5. (If schema changed) regenerate TS types
cd web
npx supabase gen types typescript --linked > src/types/supabase.ts

# 6. Run
npm run dev          # Vite dev server on :5173
npm run typecheck    # tsc -b --noEmit
npm run build        # production build → dist/
npm run lint         # eslint
```

---

## Deployment (Cloudflare Pages)

Cloudflare Pages is connected directly to the GitHub repo. Every push
to `main` triggers a build + deploy automatically — no GitHub Actions,
no API tokens stored in the repo. Preview deploys land for every PR
branch.

**One-time setup** (Cloudflare dashboard):

1. **Workers & Pages → Create → Pages → Connect to Git** → pick
   `notronwest/tournament-manager` → Begin setup.
2. **Build configuration**:
   - Project name: `tournament-manager`
   - Production branch: `main`
   - Framework preset: **None** (Cloudflare lists VitePress, which is the docs-site generator — a different product. We're plain Vite, so skip the preset and fill the fields manually.)
   - Build command: `npm install && npm run build`
   - Build output directory: `dist`
   - Root directory: `web`  (so the build runs from `web/`, not the repo root)
3. **Environment variables → Production** (also add the same to Preview):
   - `VITE_SUPABASE_URL` = same value as `web/.env.local`
   - `VITE_SUPABASE_ANON_KEY` = same value as `web/.env.local` (the `sb_publishable_...` key)
4. **Save and deploy**. First build takes ~1-2 min and produces
   `https://tournament-manager.pages.dev`.

**SPA routing**: `web/public/_redirects` contains `/* /index.html 200`
so deep-link reloads are handled by React Router rather than
returning 404.

**After the first deploy** add the production URL to
**Supabase → Auth → URL Configuration → Redirect URLs**:
- `https://tournament-manager.pages.dev/**`
- (and any custom domain once attached)

Without this, magic links and Google OAuth on the production site
will reject the redirect.

---

## Manual Supabase dashboard config (do these once per project)

These aren't in code — Supabase CLI doesn't manage them yet:

1. **Auth → URL Configuration → Redirect URLs**: add
   - `http://localhost:5173/admin`
   - `http://localhost:5173/**` (broader, easier for dev)
   - your eventual production URL (e.g. `https://tournament-manager.<your>.workers.dev/admin`)
   Without this, magic links + Google OAuth reject the redirect.

2. **Auth → Providers → Google**: paste OAuth credentials from Google Cloud Console. Until this is configured, the "Continue with Google" button on `/login` will fail. Email/password and magic link work without this step.

3. **Auth → Email**: default magic-link template is fine; customize the look/branding before going to real users.

4. **Claim WMPC org ownership** (one-time after creating your first auth user):
   ```sql
   insert into organization_members (organization_id, user_id, role)
   select id, '<your-auth.users.id>', 'owner'
     from organizations where slug = 'wmpc';
   ```
   Run in Dashboard → SQL Editor.

---

## Current state

✅ Schema live on remote (1 migration applied)
✅ TypeScript types generated and wired into the Supabase client
✅ Auth scaffold (AuthProvider, RequireAuth, LoginPage with all 4 methods)
✅ Organizer dashboard skeleton (`/admin` and `/admin/:orgSlug` routes)
✅ Tournament create / list / view (placeholder detail page)
✅ WMPC seeded as first org

🚧 **Auth providers not yet configured in dashboard** — until you finish the manual config above, magic link + Google OAuth won't actually deliver. Email/password works.

---

## Next milestones (in priority order)

The product roadmap is "smallest end-to-end loop first," then layer on. Don't get drawn into bracket generation until registration + Stripe work.

1. **Edit tournament + change status** (draft → published → closed → completed). Small; completes the create-tournament loop.
2. **Events**: add/list/edit events under a tournament. Form fields: name, format (singles/doubles), gender, age + rating bounds, bracket type, fee, max teams.
3. **Stripe Connect onboarding**: `/admin/:orgSlug/settings/stripe` with "Connect Stripe" button → Stripe-hosted onboarding → webhook updates `organizations.stripe_account_status`. Edge function: `supabase/functions/stripe-webhook/`.
4. **Public tournament page**: `/t/:orgSlug/:tournamentSlug` shows published tournament + events list + "Register" button. Anonymous-readable thanks to existing RLS.
5. **Registration flow**: player picks events, optionally invites a partner for doubles, Stripe PaymentIntent created (with `application_fee_amount` for our cut, `transfer_data.destination` = organizer's connected account).
6. **Roster view** for organizers: see who registered for each event.
7. **Bracket generation**: round-robin first (simplest, most forgiving), single-elim second.
8. **Live scoring** (organizer or referee enters scores during play).
9. **Waitlists, refunds, organizer payouts, comms.**

---

## Conventions

- **Commits**: short imperative messages explaining "why" not "what". Co-author trailer:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Migrations**: one per feature, numbered with `YYYYMMDDHHMMSS_name.sql`. Don't edit applied migrations — write a new one.
- **Edge functions**: Deno; import via `https://esm.sh/`, not npm. Use the `service_role` key for full DB access.
- **TypeScript types**: regenerate (`supabase gen types typescript --linked`) after any migration. Never hand-edit `src/types/supabase.ts`.
- **Styling**: inline styles, system-ui font. No CSS framework, no Tailwind. See `docs/DESIGN_PREFERENCES.md`.
- **No native dialogs**: never `window.confirm/alert/prompt` — build a `ConfirmModal` component when we need our first confirmation prompt.
- **RLS on every new table** from day one. Default to permissive on read, restrictive on write, then tighten as flows materialize.
- **Server-only writes** (Stripe payments, audit logging triggered by webhooks): tables get SELECT policies but no INSERT/UPDATE policies — writes flow through edge functions using `service_role`.
- **Slugs**: `lower-kebab-case`, alphanumeric + hyphens, max 60 chars. Tournament slugs are unique per org (`unique(organization_id, slug)`); org slugs are globally unique.

---

## Common commands

```bash
# Dev server
cd web && npm run dev

# Apply migrations to remote
supabase db push

# Regenerate TS types after a schema change
cd web && npx supabase gen types typescript --linked > src/types/supabase.ts

# Deploy an edge function (when we have any)
supabase functions deploy <name>

# Lint + typecheck before committing
cd web && npm run lint && npm run typecheck

# Production build (sanity check)
cd web && npm run build
```

---

## Known gotchas

- **`gen_random_bytes` lives in the `extensions` schema.** If you `set search_path = public;` at the top of a migration, you must qualify pgcrypto calls as `extensions.gen_random_bytes(...)`. `gen_random_uuid()` is safe — it's a Postgres built-in since PG13.
- **`@supabase/supabase-js` foreign-key joins** return objects, not arrays, when the relationship is to-one. Use `.organizations` (singular access) and a type guard for the null case.
- **Magic link + OAuth redirects** require the redirect URL to be in the Supabase dashboard allow-list (Auth → URL Configuration). Localhost dev URLs need to be added explicitly.
- **`<input type="datetime-local">`** emits `YYYY-MM-DDTHH:MM` with no timezone. Treat as local; convert with `new Date(value).toISOString()` before inserting into a `timestamptz` column.
- **First auth user has no org membership.** They land on `/admin` and see "No organizations" until you run the WMPC ownership-claim SQL (see "Manual Supabase dashboard config" above).
