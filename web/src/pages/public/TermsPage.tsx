import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
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

export default function TermsPage() {
  return (
    <div style={pageWrapStyle}>
      <div style={contentColStyle(760)}>
        <h1 style={pageH1Style}>Terms of Service</h1>
        <p style={metaStyle}>Last updated: June 13, 2026 — placeholder text pending final legal review.</p>

        <Section title="1. Acceptance of Terms">
          <p>By creating an account or registering for a tournament through this platform, you agree to these Terms of Service and to our <Link to="/privacy" style={externalLinkStyle}>Privacy Policy</Link>. If you do not agree, please do not use the service.</p>
        </Section>

        <Divider />

        <Section title="2. Eligibility & Accounts">
          <ul>
            <li>You must be at least 13 years old to create an account.</li>
            <li>You are responsible for the accuracy of your profile information and for keeping your password secure.</li>
            <li>You are responsible for all activity under your account. Notify us promptly of any unauthorized use.</li>
          </ul>
        </Section>

        <Divider />

        <Section title="3. Tournament Registration & Payment">
          <ul>
            <li>Tournaments are created and run by independent <strong>organizers</strong>; this platform provides the registration and management software.</li>
            <li>Entry fees are set by the organizer and processed by <strong>Stripe</strong> on the organizer's behalf via Stripe Connect. We do not store raw card numbers.</li>
            <li>Registering for an event is an agreement to pay the listed fee. A registration is confirmed only once payment is completed.</li>
            <li>Events may have eligibility requirements (skill rating, gender, capacity); the organizer's posted rules govern participation.</li>
          </ul>
        </Section>

        <Divider />

        <Section title="4. Withdrawals, Refunds & Cancellations">
          <p>Refunds are governed by <strong>each tournament's cancellation policy</strong>, shown at registration. In general:</p>
          <ul>
            <li>You may withdraw from an event and then request a refund; the amount you are entitled to is determined by the tournament's policy and the date you withdraw.</li>
            <li>Refund decisions are made by the <strong>organizer</strong>. Platform and payment-processing fees may be non-refundable.</li>
            <li>If an organizer cancels a tournament, affected registrations are refunded per that tournament's policy.</li>
          </ul>
        </Section>

        <Divider />

        <Section title="5. Code of Conduct">
          <p>You agree to treat organizers, staff, and other players with respect. Harassment, abuse, cheating, or unsafe conduct may result in removal from an event and/or termination of your account. Organizers may enforce their own event rules.</p>
        </Section>

        <Divider />

        <Section title="6. Assumption of Risk">
          <p>Pickleball and related activities involve inherent physical risks, including the risk of injury. By registering for and participating in an event, you acknowledge and assume those risks. You are responsible for ensuring you are physically fit to participate. This platform is the software provider, not the event operator, and does not supervise play.</p>
        </Section>

        <Divider />

        <Section title="7. Role of the Platform">
          <p>We provide software that connects players and organizers. We are not a party to the agreement between you and an organizer, are not responsible for how an event is run, and do not guarantee that any event will take place. Disputes about an event should be raised with the organizer.</p>
        </Section>

        <Divider />

        <Section title="8. Intellectual Property">
          <p>The platform, its software, and its branding are owned by bert &amp; erne and its licensors. You may not copy, modify, or reverse-engineer the service. Content you submit (e.g., your profile) remains yours; you grant us a limited license to use it to operate the service.</p>
        </Section>

        <Divider />

        <Section title="9. Disclaimers & Limitation of Liability">
          <p>The service is provided "as is," without warranties of any kind. To the maximum extent permitted by law, we are not liable for indirect, incidental, or consequential damages, or for the conduct of organizers or other users. Our total liability for any claim relating to the service is limited to the fees you paid through the platform in the 12 months before the claim.</p>
        </Section>

        <Divider />

        <Section title="10. Changes to These Terms">
          <p>We may update these Terms. Material changes will be noted with a revised "Last updated" date at the top of this page. Continued use after a change means you accept the updated Terms.</p>
        </Section>

        <Divider />

        <Section title="11. Contact">
          <p>Questions about these Terms? Reach us at <a href="mailto:terms@wmpc.app" style={externalLinkStyle}>terms@wmpc.app</a>.</p>
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
