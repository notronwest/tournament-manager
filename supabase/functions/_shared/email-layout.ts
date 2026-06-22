// Shared branded email layout for all Resend transactional emails.
//
// Matches the visual tokens of the auth templates in
// supabase/email-templates/ (cream background, dark wordmark header
// band, 560px card, system-ui font, mobile-responsive). Any new
// transactional email should use renderEmailHtml() rather than
// hand-rolling its own HTML shell.
//
// Usage:
//   import { renderEmailHtml, escapeHtml } from "../_shared/email-layout.ts";
//
//   const html = renderEmailHtml({
//     heading: "Hi " + firstName + " —",
//     bodyHtml: `<p>Your invite details…</p>`,
//     ctaLabel: "Accept the invite",
//     ctaUrl: acceptUrl,
//   });

const LOGO_URL = "https://bertanderne.com/email/logo@2x.png";
const SITE_URL = "https://bertanderne.com";

export type EmailLayoutParams = {
  headingLabel?: string;  // small all-caps eyebrow above the h1 (plain text)
  heading: string;        // h1 text (plain text — escaped by this function)
  bodyHtml: string;       // content HTML before the CTA button (callers escape values)
  ctaLabel?: string;      // button text (plain text — escaped)
  ctaUrl?: string;        // button href (html-attribute escaped)
  postBodyHtml?: string;  // optional content after the CTA button (callers escape)
  footer?: string;        // footer HTML; defaults to site tagline
};

export function renderEmailHtml(p: EmailLayoutParams): string {
  const eyebrow = p.headingLabel
    ? `<p style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:#6b7280;">${escapeHtml(p.headingLabel)}</p>`
    : "";

  const cta =
    p.ctaLabel && p.ctaUrl
      ? `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:28px 0 0;">
          <tr>
            <td style="border-radius:8px;background-color:#14181f;">
              <a href="${escapeHtml(p.ctaUrl)}"
                 style="display:inline-block;padding:14px 28px;font-size:14px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#fafaf7;text-decoration:none;border-radius:8px;">
                ${escapeHtml(p.ctaLabel)}
              </a>
            </td>
          </tr>
        </table>`
      : "";

  const postBody = p.postBodyHtml ?? "";

  const footer =
    p.footer ??
    `bert &amp; erne &mdash; pickleball tournaments`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <style>
    body { margin: 0; padding: 0; background-color: #fafaf7; }
    table { border-spacing: 0; }
    td { padding: 0; }
    img { border: 0; display: block; }
    @media only screen and (max-width: 600px) {
      .email-wrapper { width: 100% !important; }
      .email-body { padding: 32px 20px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#fafaf7;font-family:system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#fafaf7;padding:40px 20px;">
    <tr>
      <td align="center">
        <table class="email-wrapper" width="560" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;width:100%;">

          <!-- Wordmark header — dark band with the brush logo PNG -->
          <tr>
            <td align="center" style="padding:0 0 28px 0;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#14181f;border-radius:12px;">
                <tr>
                  <td align="center" style="padding:22px 20px;">
                    <a href="${SITE_URL}" style="text-decoration:none;">
                      <img src="${LOGO_URL}"
                           alt="bert &amp; erne — pickleball tournaments"
                           width="240" height="37"
                           style="display:block;width:240px;height:37px;border:0;" />
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td class="email-body" style="background-color:#ffffff;border:1px solid #e3dec8;border-radius:12px;padding:40px 40px 36px;">
              ${eyebrow}
              <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#14181f;line-height:1.2;">${escapeHtml(p.heading)}</h1>
              ${p.bodyHtml}
              ${cta}
              ${postBody}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 0 0;text-align:center;">
              <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.6;">${footer}</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
