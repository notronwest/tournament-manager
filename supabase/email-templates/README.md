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

## Supabase template variables used

All three templates use `{{ .ConfirmationURL }}` — the signed URL
Supabase generates for each auth action. That is the only variable
needed; Supabase substitutes it at send time.

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
- The wordmark is rendered as styled text rather than an SVG image;
  email clients have inconsistent SVG support.
- All critical styles are inline; the `<style>` block covers only the
  responsive media query (which degrades gracefully if stripped).
