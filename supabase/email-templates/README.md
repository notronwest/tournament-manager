# Auth email templates

Branded HTML email templates for Supabase auth emails. These are the
source of truth — copy them into the Supabase dashboard by hand; they
are not deployable via CI.

## Files

| File | Supabase template | Purpose |
|---|---|---|
| `magic-link.html` | **Magic Link** | Sign-in link (passwordless flow) |
| `reset-password.html` | **Reset Password** | Password-reset link sent by the "forgot password" flow |
| `confirm-signup.html` | **Confirm Signup** | Email-address confirmation for new accounts |

## Branded confirmation links (do NOT revert to `{{ .ConfirmationURL }}`)

Supabase's default `{{ .ConfirmationURL }}` points the button at
`https://<project-ref>.supabase.co/auth/v1/verify?…` — a stranger's
domain that reads as phishing/spam. Instead each template links to our
own domain and we verify the token client-side:

```
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=<type>&next={{ .RedirectTo }}
```

- `<type>` is per template: `signup` (confirm-signup), `magiclink`
  (magic-link), `recovery` (reset-password).
- `{{ .SiteURL }}` resolves to **each project's** Auth → URL Configuration
  **Site URL** — so prod links use `bertanderne.com`, test uses
  `test.bertanderne.com`. **Keep each project's Site URL correct** or the
  links break.
- The app route `web/src/pages/public/AuthConfirmPage.tsx` (`/auth/confirm`)
  calls `supabase.auth.verifyOtp({ type, token_hash })`, then forwards to
  `next` (recovery → `/reset-password?recovery=1`).
- `{{ .RedirectTo }}` is the original destination (from `emailRedirectTo`);
  it's same-origin, so app redirect paths stay clean (no `&` to break the
  query). If a redirect target ever needs query params, URL-encode here.

## How to apply (do this for both projects)

1. Open the Supabase dashboard for the project.
2. Go to **Authentication → Email Templates**.
3. For each template in the table above, select the matching template
   type from the left sidebar.
4. Replace the entire body with the contents of the corresponding
   `.html` file here.
5. Click **Save**.
6. Repeat for the other project.

### Project references

| Environment | Project ref |
|---|---|
| Production | `wducsjqyoksmluwfgjxc` |
| Test | `mvkhdsauaqqjehxdnbuf` |

## Design notes

- Palette follows `publicTheme.ts`: `#fafaf7` page background, `#ffffff`
  card background, `#14181f` ink, `#f3d111` court-yellow ampersand,
  `#6b7280` muted text, `#1e6cd6` link color.
- Table-based layout for broad email-client compatibility.
- System font stack (web fonts do not load reliably in email clients).
- The header is the **site brush wordmark** on a dark `#14181f` band —
  the same cream-on-dark lockup the site navbar uses. Email clients don't
  render SVG, so it's a hosted **PNG**, not the SVG.
- All critical styles are inline; the `<style>` block covers only the
  responsive media query (which degrades gracefully if stripped).

## Logo asset

- Source: `web/src/assets/bert-and-erne-brush-mark.svg` (cream + yellow,
  built for dark surfaces — hence the dark band in the email).
- Rendered to `web/public/email/logo@2x.png` (480×74, displayed at 240×37)
  by `scripts/render-email-logo.mjs`. Re-run after any logo change:
  `node scripts/render-email-logo.mjs` (needs `@resvg/resvg-js`, a
  devDependency of `web/`).
- Served as a static asset at **`https://bertanderne.com/email/logo@2x.png`**
  once `web/public/` is deployed to prod. The templates reference that
  absolute prod URL so both the test and prod projects load the same
  always-available image. **The asset must be live in prod before pasting
  the updated templates**, or the logo 404s in sent mail.
