import type { CSSProperties, ReactNode } from "react";
import {
  contentColStyle,
  ink,
  inkSoft,
  pageH1Style,
  pageWrapStyle,
  rule,
  sectionH2Style,
} from "../../lib/publicTheme";
import SiteFooter from "../../components/SiteFooter";

export default function PrivacyPage() {
  return (
    <div style={pageWrapStyle}>
      <div style={contentColStyle(760)}>
        <h1 style={pageH1Style}>Privacy Policy</h1>
        <p style={metaStyle}>Last updated: June 9, 2026 — placeholder text pending final legal review.</p>

        <Section title="1. Information We Collect">
          <p>We collect information you provide directly, including:</p>
          <ul>
            <li><strong>Account information</strong> — name, email address, and password when you register.</li>
            <li><strong>Player profile</strong> — display name, phone number, gender, and skill ratings (DUPR, PB Vision, or WMPC) that you enter.</li>
            <li><strong>Payment information</strong> — tournament entry fees are processed by Stripe on behalf of tournament organizers via Stripe Connect. We do not store raw card numbers; Stripe handles PCI compliance.</li>
            <li><strong>Usage data</strong> — pages visited, tournament registrations, bracket results, and similar activity within the app.</li>
          </ul>
        </Section>

        <Divider />

        <Section title="2. How We Use Your Information">
          <ul>
            <li>To operate the platform: create accounts, process registrations, generate brackets, and send confirmations.</li>
            <li>To facilitate communication between players and tournament organizers.</li>
            <li>To improve and secure the service.</li>
            <li>To comply with legal obligations.</li>
          </ul>
          <p>We do not sell your personal information to third parties.</p>
        </Section>

        <Divider />

        <Section title="3. Sharing Your Information">
          <p>We share information only as necessary:</p>
          <ul>
            <li><strong>Tournament organizers</strong> — can see registration details (name, contact info, skill rating) for their events.</li>
            <li><strong>Stripe</strong> — payment processing. Subject to <a href="https://stripe.com/privacy" style={externalLinkStyle} target="_blank" rel="noreferrer">Stripe's Privacy Policy</a>.</li>
            <li><strong>Supabase</strong> — database and authentication infrastructure.</li>
            <li><strong>Legal requirements</strong> — if required by law or to protect rights and safety.</li>
          </ul>
        </Section>

        <Divider />

        <Section title="4. Data Retention">
          <p>We retain your account and player profile as long as your account is active. Tournament and registration records are kept for the duration of the tournament and a reasonable period afterward for record-keeping. You may request deletion of your account by contacting us.</p>
        </Section>

        <Divider />

        <Section title="5. Security">
          <p>We use industry-standard measures (TLS in transit, row-level security in the database, Stripe for payments) to protect your data. No system is perfectly secure; please use a strong, unique password and notify us of any suspected breach.</p>
        </Section>

        <Divider />

        <Section title="6. Your Rights">
          <p>Depending on your jurisdiction you may have rights to access, correct, or delete your personal data. To exercise these rights, contact us at the address below.</p>
        </Section>

        <Divider />

        <Section title="7. Cookies and Tracking">
          <p>We use cookies and browser storage to maintain your login session. We do not use third-party advertising trackers.</p>
        </Section>

        <Divider />

        <Section title="8. Children">
          <p>This service is not directed at children under 13. We do not knowingly collect personal information from children under 13.</p>
        </Section>

        <Divider />

        <Section title="9. Changes to This Policy">
          <p>We may update this policy. Material changes will be noted with a revised "Last updated" date at the top of this page.</p>
        </Section>

        <Divider />

        <Section title="10. Contact">
          <p>Questions about this policy? Reach us at <a href="mailto:privacy@wmpc.app" style={externalLinkStyle}>privacy@wmpc.app</a>.</p>
        </Section>
      </div>
      <SiteFooter />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={sectionStyle}>
      <h2 style={sectionH2Style}>{title}</h2>
      <div style={sectionBodyStyle}>{children}</div>
    </section>
  );
}

function Divider() {
  return <hr style={dividerStyle} />;
}

const sectionStyle: CSSProperties = {
  marginBottom: 8,
};

const sectionBodyStyle: CSSProperties = {
  fontSize: 15,
  lineHeight: 1.65,
  color: inkSoft,
};

const dividerStyle: CSSProperties = {
  border: "none",
  borderTop: `1px solid ${rule}`,
  margin: "24px 0",
};

const metaStyle: CSSProperties = {
  fontSize: 13,
  color: inkSoft,
  marginBottom: 32,
  fontStyle: "italic",
};

const externalLinkStyle: CSSProperties = {
  color: ink,
  fontWeight: 500,
};
