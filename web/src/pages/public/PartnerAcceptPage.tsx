import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import {
  contentColStyle,
  courtBlue,
  courtRed,
  cream,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  ctaSecondaryStyle,
  displayFontStack,
  headingFontStack,
  ink,
  inkSoft,
  pageH1Style,
  pageWrapStyle,
  rule,
  ruleSoft,
  statusPanelStyle,
} from "../../lib/publicTheme";
import type { Database } from "../../types/supabase";

type PartnerInviteStatus =
  Database["public"]["Enums"]["partner_invite_status"];
type Player = Database["public"]["Tables"]["players"]["Row"];

// Shape returned by the get_invite_context RPC. Anon-readable —
// enough context to render the pre-auth "you've been invited" page
// without exposing the full invite row to the public.
type InviteContext = {
  invite_id: string;
  invite_status: PartnerInviteStatus;
  invitee_email: string | null;
  inviter_first_name: string;
  inviter_last_name: string;
  // Inviter contact info — exposed so the invitee can verify
  // they actually know the person who picked them before
  // accepting. Names alone collide in busy tournaments.
  inviter_email: string | null;
  inviter_phone: string | null;
  event_id: string;
  event_name: string;
  event_format: Database["public"]["Enums"]["event_format"];
  event_fee_cents: number;
  tournament_id: string;
  tournament_name: string;
  tournament_slug: string;
  org_slug: string;
};

// Partner accept page at /t/:orgSlug/:tournamentSlug/invites/:token.
//
// Reached two ways:
//   * From the invite email — the most common path. Bob clicks the
//     link, lands here. May be signed in already (if he previously
//     registered for something) or may need to sign up.
//   * Manually pasted by the inviter ("Alice copied the link from
//     the done screen and texted it to Bob").
//
// The page handles every state internally rather than wrapping in
// RequireAuth / RequireProfile, because the pre-auth view still
// needs to render the "you've been invited" context banner so Bob
// understands why he's being asked to sign in.
//
// State machine:
//
//   loading              — fetching the invite context.
//   context-error        — token not found / DB error. Dead-end.
//   already-responded    — invite.status is accepted / declined /
//                          expired / cancelled. Shows the state and
//                          links back to the tournament.
//   unauth               — user not signed in. Context banner + "Sign
//                          in to accept" button.
//   need-profile         — user signed in but no profile yet. Hard
//                          redirect to /profile?return=current.
//   ready                — user signed in + profile complete. Accept
//                          / Decline buttons.
//   accepting / declining — in-flight.
//   accepted / declined  — confirmation screens.
//
// On accept: insert the invitee's event_registration if it doesn't
// already exist, then call accept_partner_invite which links both
// registrations atomically.
export default function PartnerAcceptPage() {
  const { user, loading: authLoading } = useAuth();
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const [context, setContext] = useState<InviteContext | null>(null);
  const [me, setMe] = useState<Player | null>(null);
  const [meChecked, setMeChecked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<
    "ready" | "accepting" | "declining" | "accepted" | "declined"
  >("ready");

  // ─── Load invite context (anon-callable RPC) ──────────────────────
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: rpcErr } = await supabase.rpc(
        "get_invite_context",
        { p_token: token },
      );
      if (cancelled) return;
      if (rpcErr) {
        setError(rpcErr.message);
        setLoading(false);
        return;
      }
      const rows = (data ?? []) as InviteContext[];
      if (rows.length === 0) {
        setError(
          "This invite link doesn't match any invite. It may have been revoked, or the URL is mistyped.",
        );
        setLoading(false);
        return;
      }
      setContext(rows[0]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // ─── Resolve the auth user's player row (post-signin only) ────────
  useEffect(() => {
    if (authLoading || !user) {
      setMeChecked(true);
      setMe(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("players")
        .select("*")
        .eq("auth_user_id", user.id)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      setMe(data ?? null);
      setMeChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, authLoading]);

  if (loading || authLoading || !meChecked) {
    return (
      <Shell>
        <p style={{ color: inkSoft, fontSize: 14, margin: 0 }}>Loading…</p>
      </Shell>
    );
  }

  if (error || !context) {
    return (
      <Shell>
        <h1 style={pageH1Style}>Invite unavailable</h1>
        <p style={{ color: inkSoft, fontSize: 14, margin: 0 }}>
          {error ?? "Unknown error."}
        </p>
      </Shell>
    );
  }

  // Invite already responded to — short-circuit with an explanation.
  if (context.invite_status !== "pending") {
    return (
      <Shell>
        <InviteContextHeader context={context} />
        <div
          style={{
            ...statusPanelStyle("info"),
            marginTop: 16,
          }}
        >
          <strong>This invite was already {context.invite_status}.</strong>
          {context.invite_status === "accepted" && (
            <p style={{ margin: "6px 0 0", fontSize: 13 }}>
              You're already locked in as a partner. See you on the courts!
            </p>
          )}
        </div>
        <BackToTournament context={context} />
      </Shell>
    );
  }

  // Pre-auth: show the context banner + a "Sign in" button that
  // round-trips through /login back to this same URL.
  if (!user) {
    return (
      <Shell>
        <InviteContextHeader context={context} highlight />
        <div
          style={{
            ...statusPanelStyle("info"),
            marginTop: 16,
          }}
        >
          <strong>Sign in to confirm you'll play with them.</strong>
          {context.invitee_email && (
            <p style={{ margin: "6px 0 0", fontSize: 13 }}>
              Use the email we sent this invite to:{" "}
              <strong>{context.invitee_email}</strong>
            </p>
          )}
        </div>
        <button
          onClick={() =>
            navigate("/login", { state: { from: location } })
          }
          style={{
            ...primaryBtnLarge,
            marginTop: 20,
            width: "100%",
            textAlign: "center",
          }}
        >
          Sign in to accept →
        </button>
      </Shell>
    );
  }

  // Auth'd but no profile yet — bounce to /profile with this page
  // as the return.
  const hasCompleteProfile = !!(me && me.first_name && me.last_name);
  if (!hasCompleteProfile) {
    const returnTo = location.pathname + location.search;
    return (
      <Navigate
        to={`/profile?return=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }

  // ─── Accept / decline ─────────────────────────────────────────────
  const onAccept = async () => {
    if (!me) return;
    setError(null);
    setPhase("accepting");

    // 1. Ensure the invitee has an event_registration for this event.
    //    If they already registered themselves independently, reuse
    //    it; otherwise insert a fresh one with partner_status='solo'
    //    — accept_partner_invite will bump it to 'confirmed'.
    const { data: existing } = await supabase
      .from("event_registrations")
      .select("id")
      .eq("event_id", context.event_id)
      .eq("player_id", me.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!existing) {
      const { error: insErr } = await supabase
        .from("event_registrations")
        .insert({
          event_id: context.event_id,
          player_id: me.id,
          event_fee_cents: context.event_fee_cents,
          status: "paid",
          partner_status: "solo",
        });
      if (insErr) {
        setError(insErr.message);
        setPhase("ready");
        return;
      }
    }

    // 2. Link the two regs + mark the invite accepted, atomically.
    const { error: rpcErr } = await supabase.rpc(
      "accept_partner_invite",
      { p_invite_id: context.invite_id },
    );
    if (rpcErr) {
      setError(rpcErr.message);
      setPhase("ready");
      return;
    }

    setPhase("accepted");
  };

  const onDecline = async () => {
    setError(null);
    setPhase("declining");
    const { error: rpcErr } = await supabase.rpc(
      "decline_partner_invite",
      { p_invite_id: context.invite_id },
    );
    if (rpcErr) {
      setError(rpcErr.message);
      setPhase("ready");
      return;
    }
    setPhase("declined");
  };

  if (phase === "accepted") {
    return (
      <Shell>
        <div style={successStyle}>
          <h1
            style={{
              ...pageH1Style,
              margin: "0 0 6px",
              fontSize: "clamp(22px, 3.4vw, 28px)",
              color: "inherit",
            }}
          >
            🎉 You're in!
          </h1>
          <p style={{ margin: 0, fontSize: 14 }}>
            You're confirmed for <strong>{context.event_name}</strong> with{" "}
            <strong>
              {context.inviter_first_name} {context.inviter_last_name}
            </strong>
            .
          </p>
        </div>
        <div style={whatsNextCard}>
          <h3
            style={{
              margin: "0 0 10px",
              fontFamily: headingFontStack,
              fontSize: 13,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            What's next
          </h3>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 13,
              color: inkSoft,
              lineHeight: 1.7,
            }}
          >
            <li>Schedule will be posted closer to the event.</li>
            <li>
              You can register for more events in{" "}
              <strong>{context.tournament_name}</strong> from the
              tournament page.
            </li>
          </ul>
        </div>
        <BackToTournament context={context} />
      </Shell>
    );
  }

  if (phase === "declined") {
    return (
      <Shell>
        <div style={statusPanelStyle("info")}>
          <strong>Declined.</strong>
          <p style={{ margin: "6px 0 0", fontSize: 13 }}>
            We let {context.inviter_first_name} know. They'll need to find
            another partner or play solo if the event allows.
          </p>
        </div>
        <BackToTournament context={context} />
      </Shell>
    );
  }

  // ─── Ready: accept / decline buttons ──────────────────────────────
  const inviterFull = `${context.inviter_first_name} ${context.inviter_last_name}`;
  const isBusy = phase === "accepting" || phase === "declining";
  return (
    <Shell>
      <h1 style={pageH1Style}>
        Join {context.inviter_first_name}'s team?
      </h1>

      <div style={contextCard}>
        <div style={metaGrid}>
          <Meta label="Event" value={context.event_name} bold />
          <Meta label="Tournament" value={context.tournament_name} />
          {context.event_fee_cents > 0 && (
            <Meta
              label="Entry fee"
              value={`$${(context.event_fee_cents / 100).toFixed(2)}`}
            />
          )}
        </div>
        <div style={{ height: 1, background: ruleSoft, margin: "16px 0" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Avatar
            first={context.inviter_first_name}
            last={context.inviter_last_name}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: ink }}>
              {inviterFull}
            </div>
            <div style={{ fontSize: 12, color: inkSoft }}>
              invited you to be their partner
            </div>
            {/* Contact info — surfaced so the invitee can verify it's
                someone they actually know before committing. Hidden
                gracefully when the inviter hasn't put any contact on
                file (uncommon but possible for admin-pre-created
                players). */}
            {(context.inviter_email || context.inviter_phone) && (
              <div
                style={{
                  marginTop: 6,
                  display: "flex",
                  gap: 12,
                  fontSize: 12,
                  color: inkSoft,
                  flexWrap: "wrap",
                }}
              >
                {context.inviter_email && (
                  <a
                    href={`mailto:${context.inviter_email}`}
                    style={contactLinkStyle}
                  >
                    ✉ {context.inviter_email}
                  </a>
                )}
                {context.inviter_phone && (
                  <a
                    href={`tel:${context.inviter_phone}`}
                    style={contactLinkStyle}
                  >
                    ☎ {context.inviter_phone}
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div style={{ ...statusPanelStyle("danger"), marginTop: 16 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
        <button
          onClick={() => void onAccept()}
          disabled={isBusy}
          style={{
            ...(isBusy ? primaryBtnLargeDisabled : primaryBtnLarge),
            flex: 1,
            textAlign: "center",
          }}
        >
          {phase === "accepting"
            ? "Accepting…"
            : `Accept — I'll be ${context.inviter_first_name}'s partner`}
        </button>
        <button
          onClick={() => void onDecline()}
          disabled={isBusy}
          style={{
            ...secondaryBtn,
            cursor: isBusy ? "not-allowed" : "pointer",
            opacity: isBusy ? 0.6 : 1,
          }}
        >
          {phase === "declining" ? "…" : "Decline"}
        </button>
      </div>
    </Shell>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bits
// ─────────────────────────────────────────────────────────────────────

function Shell({ children }: { children: ReactNode }) {
  return (
    <div style={pageWrapStyle}>
      <main style={contentColStyle(560)}>{children}</main>
    </div>
  );
}

function InviteContextHeader({
  context,
  highlight,
}: {
  context: InviteContext;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        padding: 18,
        borderRadius: 10,
        background: highlight ? cream : "#ffffff",
        border: `1px solid ${highlight ? ruleSoft : rule}`,
      }}
    >
      <div
        style={{
          fontFamily: headingFontStack,
          fontSize: 11,
          color: courtRed,
          textTransform: "uppercase",
          letterSpacing: "0.14em",
        }}
      >
        You've been invited
      </div>
      <div
        style={{
          fontFamily: displayFontStack,
          fontSize: 20,
          marginTop: 8,
          lineHeight: 1.2,
        }}
      >
        {context.inviter_first_name} {context.inviter_last_name} wants you
        as their partner
      </div>
      <div style={{ fontSize: 14, color: inkSoft, marginTop: 6 }}>
        In <strong>{context.event_name}</strong> at{" "}
        <strong>{context.tournament_name}</strong>.
      </div>
    </div>
  );
}

function BackToTournament({ context }: { context: InviteContext }) {
  return (
    <div style={{ marginTop: 20, display: "flex", gap: 8 }}>
      <Link
        to={`/t/${context.org_slug}/${context.tournament_slug}`}
        style={{
          ...secondaryBtn,
          textDecoration: "none",
          display: "inline-block",
        }}
      >
        ← Back to {context.tournament_name}
      </Link>
    </div>
  );
}

function Meta({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div>
      <div
        style={{
          fontFamily: headingFontStack,
          fontSize: 10,
          color: courtRed,
          textTransform: "uppercase",
          letterSpacing: "0.16em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 14,
          marginTop: 4,
          fontWeight: bold ? 600 : 400,
          color: ink,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Avatar({ first, last }: { first: string; last: string }) {
  const initials = `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase() || "?";
  return (
    <div
      style={{
        width: 40,
        height: 40,
        background: ink,
        color: cream,
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: headingFontStack,
        fontWeight: 600,
        fontSize: 14,
        letterSpacing: "0.04em",
        flexShrink: 0,
      }}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}

// ─── Styles — V5 palette ──────────────────────────────────────────────
// All sourced from publicTheme.ts. Only page-specific layout
// adjustments live here; colors / typography / button shape come from
// the shared module so this page stays in sync with the rest of the
// public flow.

const primaryBtnLarge: CSSProperties = {
  ...ctaPrimaryStyle,
  padding: "14px 22px",
  fontSize: 13,
};

const primaryBtnLargeDisabled: CSSProperties = {
  ...ctaPrimaryDisabledStyle,
  padding: "14px 22px",
  fontSize: 13,
};

const secondaryBtn: CSSProperties = {
  ...ctaSecondaryStyle,
  padding: "12px 18px",
  fontSize: 13,
};

const successStyle: CSSProperties = {
  ...statusPanelStyle("success"),
  padding: "16px 18px",
};

const whatsNextCard: CSSProperties = {
  marginTop: 16,
  padding: 18,
  background: cream,
  border: `1px solid ${ruleSoft}`,
  borderRadius: 10,
};

const contextCard: CSSProperties = {
  padding: 18,
  background: cream,
  border: `1px solid ${ruleSoft}`,
  borderRadius: 10,
};

const metaGrid: CSSProperties = {
  display: "flex",
  gap: 16,
  flexWrap: "wrap",
};

const contactLinkStyle: CSSProperties = {
  color: courtBlue,
  textDecoration: "none",
  fontWeight: 500,
};
