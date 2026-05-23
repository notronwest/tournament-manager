import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import { eligibilityChips } from "../../lib/eligibility";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];

// Per-event registration status for the currently signed-in user.
// Only computed when the user is logged in; for anon visitors the
// map is empty and event cards render the normal "Register" CTA.
type MyRegStatus = {
  // 'registered' means a confirmed event_registration row. For
  // doubles, partnerLabel is the partner's display name once
  // they've accepted, or null/the-invitee-email while pending.
  // 'pending' means I created the reg but my partner hasn't
  // accepted yet (the partner_status is still 'pending').
  // 'invited' means someone ELSE invited me to be their partner
  // here and I haven't responded yet. inviteToken is set in this
  // case and links to the partner-accept page.
  state: "registered" | "pending" | "invited";
  partnerLabel: string | null;
  inviteToken: string | null;
  inviterName: string | null;
};

// Top-of-page banner content for a pending inbound invite.
type InboundInvite = {
  eventId: string;
  eventName: string;
  inviterName: string;
  token: string;
};

// Public tournament page at /t/:orgSlug/:tournamentSlug. Anonymous-
// readable thanks to existing RLS: tournaments + events with status
// in ('published', 'closed', 'completed') are readable by anyone.
// Draft tournaments are invisible here; the only way to reach a
// draft is through the admin UI.
//
// This page is intentionally read-only — the Register CTA links to
// /t/:orgSlug/:tournamentSlug/register which is auth-gated (built
// in the next commit on this branch).
export default function PublicTournamentPage() {
  const { orgSlug, tournamentSlug } = useParams<{
    orgSlug: string;
    tournamentSlug: string;
  }>();
  const { user } = useAuth();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Per-event registration status for the signed-in user, keyed by
  // event_id. Empty when nobody's signed in.
  const [myStatus, setMyStatus] = useState<Map<string, MyRegStatus>>(
    new Map(),
  );
  // Pending invites where the signed-in user is the invitee. We
  // render these as a banner at the top so a player who got picked
  // sees the invite the moment they hit the tournament page.
  const [inboundInvites, setInboundInvites] = useState<InboundInvite[]>([]);

  useEffect(() => {
    if (!orgSlug || !tournamentSlug) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);

      // Fetch org → tournament → events. Anon-keyed Supabase client
      // hits the same RLS as a logged-in non-member: published-only.
      const { data: org, error: orgErr } = await supabase
        .from("organizations")
        .select("id, name, slug")
        .eq("slug", orgSlug)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (orgErr) {
        setError(orgErr.message);
        setLoading(false);
        return;
      }
      if (!org) {
        setError("Organization not found.");
        setLoading(false);
        return;
      }

      const { data: t, error: tErr } = await supabase
        .from("tournaments")
        .select("*")
        .eq("organization_id", org.id)
        .eq("slug", tournamentSlug)
        .in("status", ["published", "closed", "completed"])
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (tErr) {
        setError(tErr.message);
        setLoading(false);
        return;
      }
      if (!t) {
        setError("Tournament not found or not yet published.");
        setLoading(false);
        return;
      }
      setTournament(t);

      const { data: evs, error: evErr } = await supabase
        .from("events")
        .select("*")
        .eq("tournament_id", t.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: true });
      if (cancelled) return;
      if (evErr) {
        setError(evErr.message);
        setLoading(false);
        return;
      }
      setEvents(evs ?? []);

      // When the user is signed in, pull their existing registrations
      // for any of these events plus any outbound pending partner
      // invites they sent — that's enough to label each card as
      // "Registered" or "Waiting for partner" with a partner name
      // where we have one.
      if (user && evs && evs.length > 0) {
        const eventIds = evs.map((e) => e.id);

        // We need the user's player id to scope queries. The
        // players row may not exist yet (fresh signup); that's fine,
        // we'll just leave the status map empty.
        const { data: me } = await supabase
          .from("players")
          .select("id")
          .eq("auth_user_id", user.id)
          .is("deleted_at", null)
          .maybeSingle();
        if (cancelled) return;

        if (me) {
          // Three reads in parallel:
          //  * my registrations (with partner-reg join for confirmed pairs)
          //  * my OUTBOUND pending invites (I picked someone, awaiting them)
          //  * my INBOUND pending invites (someone picked me, I haven't
          //    responded) — surfaces as a top-of-page banner + per-card pill
          const [regsRes, outboundRes, inboundRes] = await Promise.all([
            supabase
              .from("event_registrations")
              .select(
                `event_id, partner_status,
                 partner_registration:event_registrations!partner_registration_id (
                   player:players!player_id (first_name, last_name)
                 )`,
              )
              .eq("player_id", me.id)
              .in("event_id", eventIds)
              .is("deleted_at", null),
            supabase
              .from("partner_invites")
              .select(
                `event_id, invitee_email,
                 invitee:players!invitee_player_id (first_name, last_name)`,
              )
              .eq("inviter_player_id", me.id)
              .eq("status", "pending")
              .in("event_id", eventIds),
            supabase
              .from("partner_invites")
              .select(
                `event_id, token,
                 inviter:players!inviter_player_id (first_name, last_name)`,
              )
              .eq("invitee_player_id", me.id)
              .eq("status", "pending")
              .in("event_id", eventIds),
          ]);
          if (cancelled) return;

          const map = new Map<string, MyRegStatus>();
          type RegRow = {
            event_id: string;
            partner_status: Database["public"]["Enums"]["partner_status"];
            partner_registration:
              | { player: { first_name: string; last_name: string } | null }
              | null;
          };
          type OutboundRow = {
            event_id: string;
            invitee_email: string | null;
            invitee: { first_name: string; last_name: string } | null;
          };
          type InboundRow = {
            event_id: string;
            token: string;
            inviter: { first_name: string; last_name: string } | null;
          };

          for (const r of (regsRes.data ?? []) as unknown as RegRow[]) {
            const partner = r.partner_registration?.player;
            const partnerLabel = partner
              ? `${partner.first_name} ${partner.last_name}`
              : null;
            map.set(r.event_id, {
              state:
                r.partner_status === "pending" ? "pending" : "registered",
              partnerLabel,
              inviteToken: null,
              inviterName: null,
            });
          }
          // Outbound invites: fill in invitee names for pending state
          // where we didn't already have a partnerLabel from the reg
          // join.
          for (const inv of (outboundRes.data ?? []) as unknown as OutboundRow[]) {
            const cur = map.get(inv.event_id);
            const label = inv.invitee
              ? `${inv.invitee.first_name} ${inv.invitee.last_name}`
              : inv.invitee_email ?? null;
            if (cur && !cur.partnerLabel) {
              map.set(inv.event_id, { ...cur, partnerLabel: label });
            }
          }
          // Inbound invites: any event I was picked for and haven't
          // accepted/declined yet. Overrides the "no status" default
          // and sits alongside any existing reg (e.g. I registered
          // solo, then someone picked me — both states matter, but
          // the invite is the more actionable one).
          const inbound: InboundInvite[] = [];
          for (const inv of (inboundRes.data ?? []) as unknown as InboundRow[]) {
            const inviterName = inv.inviter
              ? `${inv.inviter.first_name} ${inv.inviter.last_name}`
              : "Someone";
            const ev = evs.find((e) => e.id === inv.event_id);
            if (ev) {
              inbound.push({
                eventId: inv.event_id,
                eventName: ev.name,
                inviterName,
                token: inv.token,
              });
            }
            // Override the per-card status so the pill on that card
            // makes the invite obvious. If I'm already registered
            // for this event, the partnerLabel from above stays so
            // both bits of info show.
            const cur = map.get(inv.event_id);
            map.set(inv.event_id, {
              state: "invited",
              partnerLabel: cur?.partnerLabel ?? null,
              inviteToken: inv.token,
              inviterName,
            });
          }
          setMyStatus(map);
          setInboundInvites(inbound);
        }
      } else {
        // Signed out → clear any stale state from a previous session.
        setMyStatus(new Map());
        setInboundInvites([]);
      }

      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug, tournamentSlug, user]);

  if (loading) {
    return (
      <Shell>
        <p style={{ color: "#666", fontSize: 14 }}>Loading…</p>
      </Shell>
    );
  }
  if (error || !tournament) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 8px", fontSize: 22 }}>Not available</h1>
        <p style={{ color: "#666", fontSize: 14, margin: 0 }}>
          {error ?? "Tournament not found."}
        </p>
      </Shell>
    );
  }

  const registrationOpen =
    tournament.status === "published" &&
    (!tournament.registration_closes_at ||
      new Date(tournament.registration_closes_at) > new Date()) &&
    (!tournament.registration_opens_at ||
      new Date(tournament.registration_opens_at) <= new Date());

  return (
    <Shell>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 26 }}>{tournament.name}</h1>
        {tournament.description && (
          <p
            style={{
              color: "#444",
              margin: "8px 0 0",
              fontSize: 15,
              lineHeight: 1.5,
            }}
          >
            {tournament.description}
          </p>
        )}
        <div
          style={{
            display: "flex",
            gap: 16,
            marginTop: 16,
            flexWrap: "wrap",
            fontSize: 14,
            color: "#444",
          }}
        >
          <Meta
            label="When"
            value={`${fmtDate(tournament.starts_at)} – ${fmtDate(tournament.ends_at)}`}
          />
          {tournament.location_name && (
            <Meta
              label="Where"
              value={
                tournament.location_address
                  ? `${tournament.location_name} · ${tournament.location_address}`
                  : tournament.location_name
              }
            />
          )}
          {tournament.entry_fee_cents > 0 && (
            <Meta
              label="Entry fee"
              value={`$${(tournament.entry_fee_cents / 100).toFixed(2)}`}
            />
          )}
          <Meta
            label="Status"
            value={capitalize(tournament.status)}
          />
        </div>
      </header>

      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          padding: 16,
          background: registrationOpen ? "#eff6ff" : "#fafafa",
          border: `1px solid ${registrationOpen ? "#bfdbfe" : "#e5e7eb"}`,
          borderRadius: 8,
          marginBottom: 24,
        }}
      >
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: registrationOpen ? "#1e40af" : "#666",
            }}
          >
            {registrationOpen
              ? "Registration is open"
              : tournament.status === "published" &&
                  tournament.registration_opens_at &&
                  new Date(tournament.registration_opens_at) > new Date()
                ? `Registration opens ${fmtDateTime(tournament.registration_opens_at)}`
                : "Registration is closed"}
          </div>
          {tournament.registration_closes_at && registrationOpen && (
            <div style={{ fontSize: 12, color: "#1e40af", marginTop: 2 }}>
              Closes {fmtDateTime(tournament.registration_closes_at)}
            </div>
          )}
        </div>
        {/* No global Register button here on purpose — the per-event
            Register buttons on each card below let the user pick what
            they're registering for first, instead of registering and
            then picking. */}
      </div>

      {/* Pending-invite banner — the most actionable thing on the
          page for a player who just got picked, so it lives above
          the events list. One row per inbound invite; each row has
          its own Accept button that drops the user on the existing
          partner-accept page. */}
      {inboundInvites.length > 0 && (
        <section
          style={{
            padding: 16,
            background: "#fef3c7",
            border: "1px solid #fde68a",
            borderRadius: 8,
            marginBottom: 24,
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "#7a5d00",
              marginBottom: 8,
            }}
          >
            You've been invited to be someone's partner
            {inboundInvites.length > 1 ? ` (${inboundInvites.length})` : ""}
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {inboundInvites.map((inv) => (
              <div
                key={inv.token}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: 10,
                  background: "#fff",
                  borderRadius: 6,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ fontSize: 13, color: "#444" }}>
                  <strong>{inv.inviterName}</strong> invited you for{" "}
                  <strong>{inv.eventName}</strong>
                </div>
                <Link
                  to={`/t/${orgSlug}/${tournamentSlug}/invites/${inv.token}`}
                  style={{
                    padding: "6px 14px",
                    background: "#2563eb",
                    color: "#fff",
                    textDecoration: "none",
                    borderRadius: 6,
                    fontSize: 13,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  Review invite →
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>
          Events ({events.length})
        </h2>
        {events.length === 0 ? (
          <Empty>No events have been added yet.</Empty>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {events.map((ev) => (
              <EventCard
                key={ev.id}
                event={ev}
                registrationOpen={registrationOpen}
                orgSlug={orgSlug ?? ""}
                tournamentSlug={tournamentSlug ?? ""}
                myStatus={myStatus.get(ev.id)}
              />
            ))}
          </div>
        )}
      </section>
    </Shell>
  );
}

function EventCard({
  event,
  registrationOpen,
  orgSlug,
  tournamentSlug,
  myStatus,
}: {
  event: Event;
  registrationOpen: boolean;
  orgSlug: string;
  tournamentSlug: string;
  myStatus: MyRegStatus | undefined;
}) {
  const chips = eligibilityChips(event);
  return (
    <div
      style={{
        padding: 16,
        background: "#fff",
        border: `1px solid ${myStatus ? "#bbf7d0" : "#e5e7eb"}`,
        borderRadius: 8,
        display: "flex",
        gap: 16,
        alignItems: "flex-start",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {event.name}
          </h3>
          {myStatus?.state === "registered" && (
            <span
              style={{
                padding: "2px 8px",
                background: "#dcfce7",
                color: "#166534",
                borderRadius: 3,
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: 0.3,
              }}
            >
              Registered
            </span>
          )}
          {myStatus?.state === "pending" && (
            <span
              style={{
                padding: "2px 8px",
                background: "#fffbeb",
                color: "#92400e",
                borderRadius: 3,
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: 0.3,
              }}
            >
              Awaiting partner
            </span>
          )}
          {myStatus?.state === "invited" && (
            <span
              style={{
                padding: "2px 8px",
                background: "#fef3c7",
                color: "#7a5d00",
                borderRadius: 3,
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: 0.3,
              }}
            >
              You're invited
            </span>
          )}
        </div>
        {myStatus?.state === "invited" && myStatus.inviterName ? (
          <div style={{ color: "#7a5d00", fontSize: 12, marginTop: 4 }}>
            <strong>{myStatus.inviterName}</strong> picked you as their
            partner
          </div>
        ) : myStatus?.partnerLabel ? (
          <div style={{ color: "#166534", fontSize: 12, marginTop: 4 }}>
            {myStatus.state === "registered" ? "Partnered with " : "Invited "}
            <strong>{myStatus.partnerLabel}</strong>
          </div>
        ) : null}
        <div style={{ color: "#666", fontSize: 13, marginTop: 4 }}>
          {capitalize(event.format)} · {capitalize(event.gender)} ·{" "}
          {event.points_to_win} win by {event.win_by}
          {event.teams_advancing_to_playoff > 0
            ? ` · top ${event.teams_advancing_to_playoff} to playoffs`
            : ""}
          {event.max_teams ? ` · max ${event.max_teams} teams` : ""}
        </div>
        {chips.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 4,
              marginTop: 8,
            }}
          >
            {chips.map((c) => (
              <span
                key={c}
                style={{
                  padding: "2px 8px",
                  background: "#eff6ff",
                  color: "#1e40af",
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: 500,
                }}
              >
                {c}
              </span>
            ))}
          </div>
        )}
        {event.event_fee_cents > 0 && (
          <div
            style={{
              color: "#444",
              fontSize: 13,
              marginTop: 8,
            }}
          >
            Event fee:{" "}
            <strong>${(event.event_fee_cents / 100).toFixed(2)}</strong>
          </div>
        )}
      </div>
      {registrationOpen &&
        (myStatus?.state === "invited" && myStatus.inviteToken ? (
          // Invited state's primary action is "Review invite" → drops
          // the user on the existing partner-accept page where they
          // can accept or decline. This takes priority over the
          // normal Register / Edit flow because the inbound invite
          // is the most actionable thing.
          <Link
            to={`/t/${orgSlug}/${tournamentSlug}/invites/${myStatus.inviteToken}`}
            style={{
              padding: "8px 16px",
              background: "#2563eb",
              color: "#fff",
              textDecoration: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              whiteSpace: "nowrap",
              alignSelf: "center",
              border: "1px solid #2563eb",
            }}
          >
            Review invite →
          </Link>
        ) : (
          // Pre-selects this event on the register page via the ?event=
          // query param so the user lands on a screen with their pick
          // already checked. They can still add other events before
          // confirming if they want. Already-registered users see the
          // same button as "Edit" so they understand it'll let them
          // change partners / withdraw.
          <Link
            to={`/t/${orgSlug}/${tournamentSlug}/register?event=${event.id}`}
            style={{
              padding: "8px 16px",
              background: myStatus ? "#fff" : "#2563eb",
              color: myStatus ? "#2563eb" : "#fff",
              border: "1px solid #2563eb",
              textDecoration: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              whiteSpace: "nowrap",
              alignSelf: "center",
            }}
          >
            {myStatus ? "Edit" : "Register →"}
          </Link>
        ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bits
// ─────────────────────────────────────────────────────────────────────

function Shell({ children }: { children: ReactNode }) {
  return (
    <main
      style={{
        padding: "32px 24px",
        maxWidth: 760,
        margin: "0 auto",
      }}
    >
      {children}
    </main>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          color: "#888",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div style={{ marginTop: 2 }}>{value}</div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: 24,
        textAlign: "center",
        background: "#fafafa",
        border: "1px dashed #d1d5db",
        borderRadius: 6,
        color: "#666",
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

