import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Player = Database["public"]["Tables"]["players"]["Row"];
type PartnerStatus = Database["public"]["Enums"]["partner_status"];

type EventForPlayer = {
  id: string;
  name: string;
  // F1/F2: tracks whether THIS player's registration in THIS event is
  // partner_status='seeking' — they signed up needing a partner.
  partnerStatus: PartnerStatus;
};

type Row = {
  player: Player;
  events: EventForPlayer[];
};

// All-attendees view for a tournament: one row per distinct player
// across every event they're registered in. Useful for organizers
// running check-in / contacting late drops / pulling a roster the
// morning of the event.
//
// Fetches:
//   1. The tournament (for the header)
//   2. Every event_registration for events in this tournament, with a
//      relational pull of the player + the event name.
// Then groups in JS by player_id.
export default function AttendeesPage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!org || !tournamentSlug) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);

      const { data: t, error: tErr } = await supabase
        .from("tournaments")
        .select("*")
        .eq("organization_id", org.id)
        .eq("slug", tournamentSlug)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (tErr) {
        setError(tErr.message);
        setLoading(false);
        return;
      }
      if (!t) {
        setError("Tournament not found.");
        setLoading(false);
        return;
      }
      setTournament(t);

      const { data, error: regErr } = await supabase
        .from("event_registrations")
        .select(
          "player_id, partner_status, players(*), events!inner(id, name, tournament_id, deleted_at)",
        )
        .eq("events.tournament_id", t.id)
        .is("deleted_at", null)
        .is("events.deleted_at", null);
      if (cancelled) return;
      if (regErr) {
        setError(regErr.message);
        setLoading(false);
        return;
      }

      type RegRow = {
        player_id: string;
        partner_status: PartnerStatus;
        players: Player | null;
        events: { id: string; name: string } | null;
      };
      const regRows = (data ?? []) as unknown as RegRow[];

      // Group by player. A player in two events appears once with both
      // events listed; deduped by player.id. partner_status is per-
      // event_registration, so it travels with each event entry.
      const byPlayer = new Map<string, Row>();
      for (const r of regRows) {
        if (!r.players || !r.events) continue;
        const eventEntry: EventForPlayer = {
          id: r.events.id,
          name: r.events.name,
          partnerStatus: r.partner_status,
        };
        const existing = byPlayer.get(r.players.id);
        if (existing) {
          if (!existing.events.some((e) => e.id === r.events!.id)) {
            existing.events.push(eventEntry);
          }
        } else {
          byPlayer.set(r.players.id, {
            player: r.players,
            events: [eventEntry],
          });
        }
      }
      const grouped = Array.from(byPlayer.values()).sort((a, b) => {
        const al = `${a.player.last_name} ${a.player.first_name}`.toLowerCase();
        const bl = `${b.player.last_name} ${b.player.first_name}`.toLowerCase();
        return al.localeCompare(bl);
      });
      // Sort each row's events alphabetically for stable display.
      for (const row of grouped) {
        row.events.sort((a, b) => a.name.localeCompare(b.name));
      }
      setRows(grouped);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [org, tournamentSlug]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay = [
        r.player.first_name,
        r.player.last_name,
        r.player.email ?? "",
        r.player.phone ?? "",
        ...r.events.map((e) => e.name),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, filter]);

  // F2: players with at least one event registration in 'seeking'
  // state — they signed up needing a partner. Each entry carries
  // the subset of events they're seeking in (a player can be seeking
  // in one event and confirmed in another).
  const seekers = useMemo(() => {
    return rows
      .map((r) => ({
        player: r.player,
        events: r.events.filter((e) => e.partnerStatus === "seeking"),
      }))
      .filter((s) => s.events.length > 0)
      .sort((a, b) => {
        const al = `${a.player.last_name} ${a.player.first_name}`.toLowerCase();
        const bl = `${b.player.last_name} ${b.player.first_name}`.toLowerCase();
        return al.localeCompare(bl);
      });
  }, [rows]);

  if (!org) return null;
  if (loading)
    return <div style={{ color: "#666", fontSize: 14 }}>Loading…</div>;
  if (error) {
    return (
      <div
        style={{
          padding: 12,
          background: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: 6,
          color: "#991b1b",
          fontSize: 13,
        }}
      >
        {error}
      </div>
    );
  }
  if (!tournament) return null;

  return (
    <div>
      <Link
        to={`/admin/${org.slug}/tournaments/${tournament.slug}`}
        style={{ color: "#2563eb", textDecoration: "none", fontSize: 13 }}
      >
        ← {tournament.name}
      </Link>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "end",
          gap: 16,
          flexWrap: "wrap",
          marginTop: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Attendees</h1>
          <p style={{ color: "#666", margin: "4px 0 0", fontSize: 13 }}>
            {rows.length} {rows.length === 1 ? "player" : "players"} across all
            events
            {filter && ` · ${visible.length} matching "${filter}"`}
          </p>
        </div>
        <input
          type="search"
          placeholder="Filter by name, email, phone, or event…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{
            padding: "6px 12px",
            border: "1px solid #e2e2e2",
            borderRadius: 6,
            fontSize: 13,
            fontFamily: "inherit",
            minWidth: 280,
          }}
        />
      </div>

      {/* F2: Partner seekers section — appears whenever any player
          registered as 'seeking' in at least one event. Lets the
          organizer match people up offline using their contact info. */}
      {seekers.length > 0 && (
        <section
          style={{
            marginBottom: 20,
            padding: 16,
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            borderRadius: 8,
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "#1e40af",
              marginBottom: 4,
            }}
          >
            🤝 Looking for a partner ({seekers.length})
          </div>
          <div
            style={{
              fontSize: 12,
              color: "#1e40af",
              marginBottom: 12,
              lineHeight: 1.5,
            }}
          >
            Players who registered without a partner. Reach out to match
            them up — they're already paid (or pending) and just need a
            partner to be confirmed.
          </div>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
              background: "#fff",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            <thead>
              <tr style={{ background: "#dbeafe" }}>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Email</th>
                <th style={thStyle}>Phone</th>
                <th style={thStyle}>Seeking in</th>
              </tr>
            </thead>
            <tbody>
              {seekers.map((s) => (
                <tr
                  key={s.player.id}
                  style={{ borderTop: "1px solid #dbeafe" }}
                >
                  <td style={{ ...tdStyle, fontWeight: 500 }}>
                    {s.player.first_name} {s.player.last_name}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      color: s.player.email ? "#444" : "#bbb",
                    }}
                  >
                    {s.player.email ? (
                      <a
                        href={`mailto:${s.player.email}`}
                        style={{ color: "#2563eb", textDecoration: "none" }}
                      >
                        {s.player.email}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      color: s.player.phone ? "#444" : "#bbb",
                    }}
                  >
                    {s.player.phone ? (
                      <a
                        href={`tel:${s.player.phone}`}
                        style={{ color: "#2563eb", textDecoration: "none" }}
                      >
                        {s.player.phone}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={tdStyle}>
                    <div
                      style={{ display: "flex", gap: 4, flexWrap: "wrap" }}
                    >
                      {s.events.map((e) => (
                        <span
                          key={e.id}
                          style={{
                            padding: "2px 8px",
                            background: "#dbeafe",
                            color: "#1e40af",
                            borderRadius: 4,
                            fontSize: 11,
                            fontWeight: 500,
                          }}
                        >
                          {e.name}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {visible.length === 0 ? (
        <div
          style={{
            padding: 32,
            textAlign: "center",
            background: "#fafafa",
            border: "1px dashed #d1d5db",
            borderRadius: 6,
            color: "#666",
            fontSize: 13,
          }}
        >
          {rows.length === 0
            ? "No attendees yet — register teams to events first."
            : "No attendees match the filter."}
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr
              style={{
                background: "#fafafa",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Email</th>
              <th style={thStyle}>Phone</th>
              <th style={thStyle}>Events</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr
                key={row.player.id}
                style={{ borderBottom: "1px solid #f3f4f6" }}
              >
                <td style={{ ...tdStyle, fontWeight: 500 }}>
                  {row.player.first_name} {row.player.last_name}
                </td>
                <td style={{ ...tdStyle, color: row.player.email ? "#444" : "#bbb" }}>
                  {row.player.email ?? "—"}
                </td>
                <td style={{ ...tdStyle, color: row.player.phone ? "#444" : "#bbb" }}>
                  {row.player.phone ?? "—"}
                </td>
                <td style={tdStyle}>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {row.events.map((e) => (
                      <span
                        key={e.id}
                        style={{
                          padding: "2px 8px",
                          background: "#eff6ff",
                          color: "#1e40af",
                          borderRadius: 4,
                          fontSize: 11,
                          fontWeight: 500,
                        }}
                      >
                        {e.name}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  fontSize: 11,
  color: "#888",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  fontWeight: 500,
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
};
