import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  contentColStyle,
  ctaPrimaryStyle,
  ink,
  inkSoft,
  pageH1Style,
  pageSubStyle,
  pageWrapStyle,
  panelStyle,
  rule,
  sectionH2Style,
} from "../../lib/publicTheme";
import { useAuth } from "../../auth/AuthProvider";
import SiteFooter from "../../components/SiteFooter";

export default function GettingStartedPage() {
  const { user } = useAuth();
  return (
    <div style={pageWrapStyle}>
      <div style={contentColStyle(760)}>
        <h1 style={pageH1Style}>Getting Started</h1>
        <p style={pageSubStyle}>
          bert &amp; erne is the pickleball tournament platform — find events,
          register, pay, and track your results, all in one place.
        </p>

        {/* Top sign-up CTA. The fastest path to an account for a first-time
            visitor; deep-links to /login's signup form (the single source of
            auth truth — no duplicated auth UI here). Swaps to a "you're signed
            in" note once authenticated. */}
        {user ? (
          <div style={ctaCardStyle}>
            <p style={{ ...bodyStyle, margin: 0 }}>
              You&rsquo;re signed in.{" "}
              <Link to="/" style={inlineLinkStyle}>
                Browse tournaments &rarr;
              </Link>
            </p>
          </div>
        ) : (
          <div style={ctaCardStyle}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <h2 style={{ ...sectionH2Style, margin: "0 0 6px" }}>
                Create your free account
              </h2>
              <p style={{ ...bodyStyle, margin: 0 }}>
                Sign up in seconds to register for tournaments, invite a
                partner, and track your results.
              </p>
            </div>
            <div style={ctaActionsStyle}>
              <Link
                to="/login"
                state={{ mode: "magic" }}
                style={ctaPrimaryStyle}
              >
                Create account
              </Link>
              <Link
                to="/login"
                state={{ mode: "signin" }}
                style={ctaSignInStyle}
              >
                Already have an account? Sign in
              </Link>
            </div>
          </div>
        )}

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

const ctaCardStyle: CSSProperties = {
  ...panelStyle,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 20,
  flexWrap: "wrap",
  marginBottom: 28,
};

const ctaActionsStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 8,
};

const ctaSignInStyle: CSSProperties = {
  fontSize: 13,
  color: inkSoft,
  textDecoration: "underline",
};

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

