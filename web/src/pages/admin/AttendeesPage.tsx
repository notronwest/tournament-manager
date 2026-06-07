import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Player = Database["public"]["Tables"]["players"]["Row"];
type PartnerStatus = Database["public"]["Enums"]["partner_status"];
type RegistrationStatus = Database["public"]["Enums"]["registration_status"];
type EventGender = Database["public"]["Enums"]["event_gender"];
type EventFormat = Database["public"]["Enums"]["event_format"];

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

type RegData = {
  id: string;
  player_id: string;
  partner_registration_id: string | null;
  partner_status: PartnerStatus;
  status: RegistrationStatus;
  event_fee_cents: number;
  player: Player;
};

type EventData = {
  id: string;
  name: string;
  format: EventFormat;
  gender: EventGender;
};

type EventGroup = {
  event: EventData;
  regs: RegData[];
};

type ViewMode = "players" | "events";

function paymentBadge(status: RegistrationStatus) {
  const map: Record<
    RegistrationStatus,
    { label: string; bg: string; color: string }
  > = {
    paid: { label: "Paid", bg: "#dcfce7", color: "#15803d" },
    pending_payment: { label: "Pending", bg: "#fef9c3", color: "#a16207" },
    cancelled: { label: "Cancelled", bg: "#f3f4f6", color: "#6b7280" },
    refunded: { label: "Refunded", bg: "#f3f4f6", color: "#6b7280" },
    withdrawn: { label: "Withdrawn", bg: "#f3f4f6", color: "#6b7280" },
  };
  const s = map[status] ?? { label: status, bg: "#f3f4f6", color: "#6b7280" };
  return (
    <span
      style={{
        padding: "2px 7px",
        background: s.bg,
        color: s.color,
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {s.label}
    </span>
  );
}

function partnerBadge(ps: PartnerStatus) {
  if (ps === "confirmed" || ps === "solo") return null;
  const map: Record<string, { label: string; bg: string; color: string }> = {
    seeking: { label: "Seeking partner", bg: "#fef9c3", color: "#a16207" },
    pending: { label: "Invite pending", bg: "#eff6ff", color: "#1e40af" },
    declined: { label: "Declined", bg: "#fef2f2", color: "#991b1b" },
  };
  const s = map[ps] ?? { label: ps, bg: "#f3f4f6", color: "#6b7280" };
  return (
    <span
      style={{
        padding: "2px 7px",
        background: s.bg,
        color: s.color,
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 500,
      }}
    >
      {s.label}
    </span>
  );
}

function formatEventLabel(e: EventData) {
  const g =
    { men: "Men's", women: "Women's", mixed: "Mixed" }[e.gender] ?? e.gender;
  const f =
    { singles: "Singles", doubles: "Doubles" }[e.format] ?? e.format;
  return `${g} ${f}`;
}

function playerFullName(p: Player) {
  return `${p.first_name} ${p.last_name}`;
}

function ContactCell({ player }: { player: Player }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {player.email ? (
        <a
          href={`mailto:${player.email}`}
          style={{ color: "#2563eb", textDecoration: "none", fontSize: 12 }}
        >
          {player.email}
        </a>
      ) : (
        <span style={{ color: "#bbb", fontSize: 12 }}>no email</span>
      )}
      {player.phone ? (
        <a
          href={`tel:${player.phone}`}
          style={{ color: "#2563eb", textDecoration: "none", fontSize: 12 }}
        >
          {player.phone}
        </a>
      ) : null}
    </div>
  );
}

// All-attendees view for a tournament: one row per distinct player
// across every event they're registered in. Useful for organizers
// running check-in / contacting late drops / pulling a roster the
// morning of the event.
//
// Two views:
//   By Player — one row per player with their event badges (original layout).
//   By Event — one section per event showing confirmed teams, partner pairings,
//              contact info, and payment status.
export default function AttendeesPage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [eventGroups, setEventGroups] = useState<EventGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<ViewMode>("players");

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
          "id, player_id, partner_registration_id, partner_status, status, event_fee_cents, players(*), events!inner(id, name, format, gender, tournament_id, deleted_at)",
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

      type RawReg = {
        id: string;
        player_id: string;
        partner_registration_id: string | null;
        partner_status: PartnerStatus;
        status: RegistrationStatus;
        event_fee_cents: number;
        players: Player | null;
        events: {
          id: string;
          name: string;
          format: EventFormat;
          gender: EventGender;
        } | null;
      };
      const raw = (data ?? []) as unknown as RawReg[];

      // --- By Player grouping (existing) ---
      const byPlayer = new Map<string, Row>();
      for (const r of raw) {
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
      for (const row of grouped) {
        row.events.sort((a, b) => a.name.localeCompare(b.name));
      }
      setRows(grouped);

      // --- By Event grouping (new) ---
      // Group registrations by event, then sort within each event:
      // confirmed pairs first, pending next, seeking/declined last.
      const byEvent = new Map<string, EventGroup>();
      for (const r of raw) {
        if (!r.players || !r.events) continue;
        const rd: RegData = {
          id: r.id,
          player_id: r.player_id,
          partner_registration_id: r.partner_registration_id,
          partner_status: r.partner_status,
          status: r.status,
          event_fee_cents: r.event_fee_cents,
          player: r.players,
        };
        const eid = r.events.id;
        if (!byEvent.has(eid)) {
          byEvent.set(eid, {
            event: {
              id: eid,
              name: r.events.name,
              format: r.events.format,
              gender: r.events.gender,
            },
            regs: [],
          });
        }
        byEvent.get(eid)!.regs.push(rd);
      }

      const statusOrder: Record<PartnerStatus, number> = {
        confirmed: 0,
        solo: 0,
        pending: 1,
        seeking: 2,
        declined: 3,
      };
      const groups = Array.from(byEvent.values()).sort((a, b) =>
        a.event.name.localeCompare(b.event.name),
      );
      for (const g of groups) {
        g.regs.sort((a, b) => {
          const ao = statusOrder[a.partner_status] ?? 4;
          const bo = statusOrder[b.partner_status] ?? 4;
          if (ao !== bo) return ao - bo;
          return playerFullName(a.player).localeCompare(
            playerFullName(b.player),
          );
        });
      }
      setEventGroups(groups);

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
  // state — they signed up needing a partner.
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
            {view === "players" && filter
              ? ` · ${visible.length} matching "${filter}"`
              : null}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {view === "players" && (
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
                minWidth: 240,
              }}
            />
          )}
          <div
            style={{
              display: "flex",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            <button
              onClick={() => setView("players")}
              style={viewTabStyle(view === "players")}
            >
              By Player
            </button>
            <button
              onClick={() => setView("events")}
              style={{
                ...viewTabStyle(view === "events"),
                borderLeft: "1px solid #d1d5db",
              }}
            >
              By Event
            </button>
          </div>
        </div>
      </div>

      {view === "players" ? (
        <ByPlayerView
          visible={visible}
          rows={rows}
          seekers={seekers}
        />
      ) : (
        <ByEventView eventGroups={eventGroups} />
      )}
    </div>
  );
}

// --- By Player view (original layout, preserved exactly) ---

type ByPlayerViewProps = {
  visible: Row[];
  rows: Row[];
  seekers: { player: Player; events: EventForPlayer[] }[];
};

function ByPlayerView({ visible, rows, seekers }: ByPlayerViewProps) {
  return (
    <>
      {/* F2: Partner seekers section */}
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
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
        >
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
                <td
                  style={{
                    ...tdStyle,
                    color: row.player.email ? "#444" : "#bbb",
                  }}
                >
                  {row.player.email ?? "—"}
                </td>
                <td
                  style={{
                    ...tdStyle,
                    color: row.player.phone ? "#444" : "#bbb",
                  }}
                >
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
    </>
  );
}

// --- By Event view (new for issue #21) ---

function ByEventView({ eventGroups }: { eventGroups: EventGroup[] }) {
  if (eventGroups.length === 0) {
    return (
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
        No registrations yet — register teams to events first.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      {eventGroups.map((g) => (
        <EventRosterSection key={g.event.id} group={g} />
      ))}
    </div>
  );
}

function EventRosterSection({ group }: { group: EventGroup }) {
  const { event, regs } = group;

  // Build teams: walk regs in their already-sorted order and group
  // confirmed pairs into a single visual unit. Each reg is processed once.
  const regById = new Map<string, RegData>(regs.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const teams: Array<{ primary: RegData; partner: RegData | null }> = [];

  for (const reg of regs) {
    if (seen.has(reg.id)) continue;
    const partnerReg = reg.partner_registration_id
      ? (regById.get(reg.partner_registration_id) ?? null)
      : null;
    const isConfirmedPair =
      partnerReg &&
      !seen.has(partnerReg.id) &&
      reg.partner_status === "confirmed" &&
      partnerReg.partner_status === "confirmed";

    if (isConfirmedPair && partnerReg) {
      seen.add(reg.id);
      seen.add(partnerReg.id);
      teams.push({ primary: reg, partner: partnerReg });
    } else {
      seen.add(reg.id);
      teams.push({ primary: reg, partner: null });
    }
  }

  const seekingCount = regs.filter((r) => r.partner_status === "seeking").length;
  const pendingCount = regs.filter((r) => r.partner_status === "pending").length;

  return (
    <section>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 10,
          paddingBottom: 6,
          borderBottom: "2px solid #e5e7eb",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          {event.name}
        </h2>
        <span style={{ fontSize: 12, color: "#888" }}>
          {formatEventLabel(event)}
        </span>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: 12, color: "#666" }}>
            {regs.length} {regs.length === 1 ? "entry" : "entries"}
          </span>
          {seekingCount > 0 && (
            <span
              style={{
                fontSize: 11,
                padding: "2px 7px",
                background: "#fef9c3",
                color: "#a16207",
                borderRadius: 4,
                fontWeight: 500,
              }}
            >
              {seekingCount} seeking partner
            </span>
          )}
          {pendingCount > 0 && (
            <span
              style={{
                fontSize: 11,
                padding: "2px 7px",
                background: "#eff6ff",
                color: "#1e40af",
                borderRadius: 4,
                fontWeight: 500,
              }}
            >
              {pendingCount} pending
            </span>
          )}
        </div>
      </div>

      {teams.length === 0 ? (
        <div style={{ color: "#999", fontSize: 13 }}>No registrations.</div>
      ) : (
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
        >
          <thead>
            <tr
              style={{
                background: "#fafafa",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              <th style={thStyle}>
                {event.format === "doubles" ? "Team / Player" : "Player"}
              </th>
              <th style={thStyle}>Contact</th>
              <th style={thStyle}>Payment</th>
              <th style={thStyle}>Status</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((team, i) =>
              team.partner ? (
                <ConfirmedPairRows
                  key={team.primary.id}
                  primary={team.primary}
                  partner={team.partner}
                  stripe={i % 2 === 0}
                />
              ) : (
                <SingleEntryRow
                  key={team.primary.id}
                  reg={team.primary}
                  stripe={i % 2 === 0}
                />
              ),
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}

// Two-row block for a confirmed doubles pair, connected by a blue left bar.
function ConfirmedPairRows({
  primary,
  partner,
  stripe,
}: {
  primary: RegData;
  partner: RegData;
  stripe: boolean;
}) {
  const bg = stripe ? "#fff" : "#fafafa";
  const confirmedBadge = (
    <span
      style={{
        padding: "2px 7px",
        background: "#dcfce7",
        color: "#15803d",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 500,
      }}
    >
      Confirmed team
    </span>
  );

  return (
    <>
      <tr style={{ background: bg, borderTop: "1px solid #e5e7eb" }}>
        <td style={{ ...tdStyle, fontWeight: 500, paddingBottom: 3 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                width: 3,
                minHeight: 20,
                alignSelf: "stretch",
                background: "#2563eb",
                borderRadius: "2px 2px 0 0",
                flexShrink: 0,
              }}
            />
            {playerFullName(primary.player)}
          </div>
        </td>
        <td style={{ ...tdStyle, paddingBottom: 3 }}>
          <ContactCell player={primary.player} />
        </td>
        <td style={{ ...tdStyle, paddingBottom: 3 }}>
          {paymentBadge(primary.status)}
        </td>
        <td style={{ ...tdStyle, paddingBottom: 3 }}>{confirmedBadge}</td>
      </tr>
      <tr style={{ background: bg, borderBottom: "1px solid #e5e7eb" }}>
        <td style={{ ...tdStyle, fontWeight: 500, paddingTop: 3 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                width: 3,
                minHeight: 20,
                alignSelf: "stretch",
                background: "#2563eb",
                borderRadius: "0 0 2px 2px",
                flexShrink: 0,
              }}
            />
            {playerFullName(partner.player)}
          </div>
        </td>
        <td style={{ ...tdStyle, paddingTop: 3 }}>
          <ContactCell player={partner.player} />
        </td>
        <td style={{ ...tdStyle, paddingTop: 3 }}>
          {paymentBadge(partner.status)}
        </td>
        <td style={{ ...tdStyle, paddingTop: 3 }} />
      </tr>
    </>
  );
}

function SingleEntryRow({
  reg,
  stripe,
}: {
  reg: RegData;
  stripe: boolean;
}) {
  return (
    <tr
      style={{
        background: stripe ? "#fff" : "#fafafa",
        borderTop: "1px solid #e5e7eb",
      }}
    >
      <td style={{ ...tdStyle, fontWeight: 500 }}>
        {playerFullName(reg.player)}
      </td>
      <td style={tdStyle}>
        <ContactCell player={reg.player} />
      </td>
      <td style={tdStyle}>{paymentBadge(reg.status)}</td>
      <td style={tdStyle}>{partnerBadge(reg.partner_status)}</td>
    </tr>
  );
}

function viewTabStyle(active: boolean): CSSProperties {
  return {
    padding: "6px 14px",
    fontSize: 13,
    fontFamily: "inherit",
    fontWeight: active ? 600 : 400,
    background: active ? "#eff6ff" : "#fff",
    color: active ? "#2563eb" : "#444",
    border: "none",
    cursor: "pointer",
  };
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
