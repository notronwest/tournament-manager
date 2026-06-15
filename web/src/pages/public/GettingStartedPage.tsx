import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  contentColStyle,
  ink,
  inkSoft,
  pageH1Style,
  pageSubStyle,
  pageWrapStyle,
  panelStyle,
  rule,
  sectionH2Style,
} from "../../lib/publicTheme";
import SiteFooter from "../../components/SiteFooter";

export default function GettingStartedPage() {
  return (
    <div style={pageWrapStyle}>
      <div style={contentColStyle(760)}>
        <h1 style={pageH1Style}>Getting Started</h1>
        <p style={pageSubStyle}>
          bert &amp; erne is the pickleball tournament platform — find events,
          register, pay, and track your results, all in one place.
        </p>

        <Section title="For Players">
          <p style={bodyStyle}>
            Here&rsquo;s how a typical tournament registration works:
          </p>
          <ol style={listStyle}>
            <li>
              <strong>Browse tournaments</strong> — the{" "}
              <Link to="/" style={inlineLinkStyle}>homepage</Link>{" "}
              lists upcoming events open for registration.
            </li>
            <li>
              <strong>Register for events</strong> — open a tournament, pick
              the event brackets you want to play (singles, doubles, mixed,
              etc.), and add them to your cart.
            </li>
            <li>
              <strong>Pay</strong> — review your entry fees and complete payment
              securely via Stripe. You&rsquo;ll get a confirmation email once
              you&rsquo;re registered.
            </li>
            <li>
              <strong>Find a partner</strong> — for doubles events, invite a
              partner by name or email directly from your registration. They
              receive an invite link to accept and pay their own fee.
            </li>
            <li>
              <strong>See your schedule &amp; results</strong> — log in any time
              to view your upcoming matches, court assignments, and final bracket
              results in My Tournaments.
            </li>
          </ol>
        </Section>

        <Divider />

        <Section title="For Organizers">
          <p style={bodyStyle}>
            Tournament organizers use the Admin dashboard to create and run
            events: build the tournament structure, set up event brackets (skill
            level, format, pricing), publish for registration, manage the
            draw, print scorecards, and record results as matches are played.
            Contact your platform administrator to get started with an organizer
            account.
          </p>
        </Section>

        <Divider />

        <Section title="Your Account">
          <div style={panelStyle}>
            <p style={{ ...bodyStyle, margin: 0 }}>
              You need a free account to register for tournaments.{" "}
              <Link to="/login" style={inlineLinkStyle}>
                Sign up or sign in
              </Link>{" "}
              with your email, a magic link, or Google. After signing in
              you&rsquo;ll be prompted to complete a short player profile
              (name, phone, gender) — this is what organizers see on the
              registration list.
            </p>
          </div>
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
      {children}
    </section>
  );
}

function Divider() {
  return <hr style={dividerStyle} />;
}

const sectionStyle: CSSProperties = {
  marginBottom: 8,
};

const bodyStyle: CSSProperties = {
  fontSize: 15,
  lineHeight: 1.65,
  color: inkSoft,
  margin: "0 0 16px",
};

const listStyle: CSSProperties = {
  fontSize: 15,
  lineHeight: 1.65,
  color: inkSoft,
  paddingLeft: 24,
  margin: "0 0 8px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const dividerStyle: CSSProperties = {
  border: "none",
  borderTop: `1px solid ${rule}`,
  margin: "24px 0",
};

const inlineLinkStyle: CSSProperties = {
  color: ink,
  fontWeight: 600,
  textDecoration: "underline",
};

