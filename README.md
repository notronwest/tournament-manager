# Tournament Manager

A multi-tenant tournament management platform for pickleball — organizers create tournaments and events, players register and pay, brackets get run. Inspired by [PickleballBrackets.com](https://PickleballBrackets.com).

**Stack**: Vite + React + TypeScript · Supabase (Postgres + Auth + Edge Functions) · Stripe Connect · Cloudflare Workers.

For the full architecture, decisions log, and roadmap, see [`CLAUDE.md`](./CLAUDE.md).

---

## Quick start

```bash
# Clone + install
git clone git@github.com:notronwest/tournament-manager.git
cd tournament-manager/web && npm install

# Env vars
cp .env.template .env.local
# Fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from
# Supabase Dashboard → Settings → Data API + Settings → API Keys

# Link Supabase CLI (one-time)
cd ..
supabase login
supabase link --project-ref <ref-id>

# Push schema (if schema is ahead of your linked project)
supabase db push

# Generate TypeScript types from the live schema
cd web
npx supabase gen types typescript --linked > src/types/supabase.ts

# Run
npm run dev
```

Visit http://localhost:5173 → `/login` to sign in.

---

## First-time Supabase setup

1. **Auth → URL Configuration**: add `http://localhost:5173/**` to Redirect URLs.
2. **Auth → Providers**: enable Email/Password (default), Magic Link, and optionally Google (requires Google Cloud OAuth credentials).
3. **Create your first auth user** via Dashboard → Authentication → Users → Add user.
4. **Claim WMPC ownership** in Dashboard → SQL Editor:
   ```sql
   insert into organization_members (organization_id, user_id, role)
   select id, '<your-auth-user-id>', 'owner'
     from organizations where slug = 'wmpc';
   ```

---

## Layout

```
tournament-manager/
├── CLAUDE.md                # full architecture, decisions, roadmap
├── docs/
│   └── DESIGN_PREFERENCES.md  # UI conventions
├── supabase/                # migrations + edge functions
├── scripts/                 # ad-hoc Node utilities
└── web/                     # Vite + React frontend
```

---

## Scripts

| Command | What it does |
|---|---|
| `cd web && npm run dev` | Vite dev server on :5173 |
| `cd web && npm run typecheck` | TypeScript check, no emit |
| `cd web && npm run build` | Production build → `dist/` |
| `cd web && npm run lint` | ESLint |
| `supabase db push` | Apply pending migrations to remote |
| `supabase gen types typescript --linked` | Regenerate `web/src/types/supabase.ts` after schema changes |
