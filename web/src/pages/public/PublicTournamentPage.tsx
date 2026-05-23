import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { eligibilityChips } from "../../lib/eligibility";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];

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
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug, tournamentSlug]);

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
}: {
  event: Event;
  registrationOpen: boolean;
  orgSlug: string;
  tournamentSlug: string;
}) {
  const chips = eligibilityChips(event);
  return (
    <div
      style={{
        padding: 16,
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        display: "flex",
        gap: 16,
        alignItems: "flex-start",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{event.name}</h3>
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
      {registrationOpen && (
        // Pre-selects this event on the register page via the ?event=
        // query param so the user lands on a screen with their pick
        // already checked. They can still add other events before
        // confirming if they want.
        <Link
          to={`/t/${orgSlug}/${tournamentSlug}/register?event=${event.id}`}
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
          }}
        >
          Register →
        </Link>
      )}
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

