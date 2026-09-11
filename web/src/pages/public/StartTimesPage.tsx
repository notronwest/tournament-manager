import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import SiteFooter from "../../components/SiteFooter";
import {
  bodyFontStack,
  contentColStyle,
  courtRed,
  cream,
  creamDeep,
  displayFontStack,
  headingFontStack,
  ink,
  inkMuted,
  inkSoft,
  monoFontStack,
  pageWrapStyle,
  rule,
  ruleSoft,
} from "../../lib/publicTheme";

// Public start-times page: every event in the tournament with its scheduled
// start, grouped by day and ordered by time, so a player (or a parent, or a
// spectator) can answer "when do I need to be there?" without logging in.
// Events without a time yet sit in their own "to be announced" group. Times
// render in the viewer's local time zone, like the rest of the public site.

type EventRow = {
  id: string;
  name: string;
  format: string;
  gender: string;
  scheduled_start_at: string | null;
};

type Tournament = {
  id: string;
  name: string;
  slug: string;
  starts_at: string;
  ends_at: string;
  location_name: string | null;
  location_address: string | null;
  // Saved org venue (tournaments.location_id → locations). Wins over the
  // legacy free-text columns above, which are empty for wizard-made
  // tournaments.
  locations: SavedLocation | SavedLocation[] | null;
};

type SavedLocation = {
  name: string;
  address: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
};

function composeLocationAddress(loc: SavedLocation): string | null {
  const parts: string[] = [];
  if (loc.address) parts.push(loc.address);
  if (loc.address_line2) parts.push(loc.address_line2);
  const stateZip =
    loc.state && loc.postal_code ? `${loc.state} ${loc.postal_code}` : (loc.state ?? loc.postal_code ?? null);
  const cityStateZip = [loc.city, stateZip].filter(Boolean).join(", ");
  if (cityStateZip) parts.push(cityStateZip);
  return parts.length > 0 ? parts.join(", ") : null;
}

function venueLine(t: Tournament): string {
  const loc = Array.isArray(t.locations) ? (t.locations[0] ?? null) : t.locations;
  if (loc) return [loc.name, composeLocationAddress(loc)].filter(Boolean).join(", ");
  return [t.location_name, t.location_address].filter(Boolean).join(", ");
}

export default function StartTimesPage() {
  const { orgSlug, tournamentSlug } = useParams<{ orgSlug: string; tournamentSlug: string }>();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgSlug || !tournamentSlug) return;
    let cancelled = false;
    (async () => {
      const { data: org, error: oErr } = await supabase
        .from("organizations")
        .select("id")
        .eq("slug", orgSlug)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (oErr || !org) {
        setError(oErr?.message ?? "Tournament not found.");
        setLoading(false);
        return;
      }
      const { data: t, error: tErr } = await supabase
        .from("tournaments")
        .select(
          "id, name, slug, starts_at, ends_at, location_name, location_address, locations(name, address, address_line2, city, state, postal_code)",
        )
        .eq("organization_id", org.id)
        .eq("slug", tournamentSlug)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (tErr || !t) {
        setError(tErr?.message ?? "Tournament not found.");
        setLoading(false);
        return;
      }
      const { data: evs, error: eErr } = await supabase
        .from("events")
        .select("id, name, format, gender, scheduled_start_at")
        .eq("tournament_id", t.id)
        .is("deleted_at", null)
        .order("scheduled_start_at", { ascending: true, nullsFirst: false })
        .order("name");
      if (cancelled) return;
      if (eErr) {
        setError(eErr.message);
        setLoading(false);
        return;
      }
      setTournament(t);
      setEvents((evs ?? []) as EventRow[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug, tournamentSlug]);

  // Group scheduled events by local calendar day, in order; unscheduled last.
  const groups = useMemo(() => {
    const byDay = new Map<string, { label: string; events: EventRow[] }>();
    const tba: EventRow[] = [];
    for (const e of events) {
      if (!e.scheduled_start_at) {
        tba.push(e);
        continue;
      }
      const d = new Date(e.scheduled_start_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const g = byDay.get(key) ?? { label: fmtDay(e.scheduled_start_at), events: [] };
      g.events.push(e);
      byDay.set(key, g);
    }
    const days = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, g]) => ({ ...g, events: g.events.sort(byStart) }));
    return { days, tba: tba.sort((a, b) => a.name.localeCompare(b.name)) };
  }, [events]);

  if (loading) {
    return (
      <main style={pageWrapStyle}>
        <div style={contentColStyle(680)}>
          <p style={{ color: inkMuted, fontSize: 14 }}>Loading…</p>
        </div>
      </main>
    );
  }
  if (error || !tournament) {
    return (
      <main style={pageWrapStyle}>
        <div style={contentColStyle(680)}>
          <p style={{ color: "#991b1b", fontSize: 14 }}>{error ?? "Tournament not found."}</p>
        </div>
      </main>
    );
  }

  const scheduledCount = events.length - groups.tba.length;
  const where = venueLine(tournament);

  return (
    <main style={pageWrapStyle}>
      <div style={contentColStyle(680)}>
        <div style={{ marginBottom: 8 }}>
          <Link
            to={`/t/${orgSlug}/${tournamentSlug}`}
            style={{ fontSize: 13, color: inkMuted, textDecoration: "none" }}
          >
            ← {tournament.name}
          </Link>
        </div>

        <header
          style={{
            background: `linear-gradient(180deg, ${cream} 0%, ${creamDeep} 100%)`,
            borderRadius: 10,
            padding: "32px 28px 24px",
            marginBottom: 28,
          }}
        >
          <div
            style={{
              fontFamily: monoFontStack,
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.2em",
              color: courtRed,
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            Start times
          </div>
          <h1
            style={{
              fontFamily: displayFontStack,
              fontSize: "clamp(28px, 5vw, 44px)",
              lineHeight: 0.98,
              margin: "0 0 12px",
              color: ink,
            }}
          >
            {tournament.name}
          </h1>
          <p style={{ margin: 0, fontSize: 15, color: inkSoft, lineHeight: 1.55, fontFamily: bodyFontStack }}>
            {fmtRange(tournament.starts_at, tournament.ends_at)}
            {where ? ` · ${where}` : ""}
          </p>
          <p style={{ margin: "10px 0 0", fontSize: 14, color: inkSoft, lineHeight: 1.55, fontFamily: bodyFontStack }}>
            Please arrive <strong>30 minutes before</strong> your first start time to check in and
            warm up. Brackets can shift as the day runs, so check the desk when you arrive.
          </p>
        </header>

        {events.length === 0 && (
          <p style={{ color: inkMuted, fontSize: 14 }}>No events have been announced yet.</p>
        )}

        {scheduledCount === 0 && events.length > 0 && (
          <div style={noticeStyle}>
            Start times haven't been set yet. Check back closer to the tournament, or watch
            for an email from the organizers.
          </div>
        )}

        {groups.days.map((day) => (
          <section key={day.label} style={{ marginBottom: 28 }}>
            <h2 style={dayHeadingStyle}>{day.label}</h2>
            <ul style={listStyle}>
              {day.events.map((e) => (
                <li key={e.id} style={rowStyle}>
                  <div style={timeStyle}>{fmtTime(e.scheduled_start_at as string)}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 16, color: ink }}>{e.name}</div>
                    <div style={{ fontSize: 13, color: inkMuted, marginTop: 2 }}>{describe(e)}</div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}

        {groups.tba.length > 0 && scheduledCount > 0 && (
          <section style={{ marginBottom: 28 }}>
            <h2 style={dayHeadingStyle}>Time to be announced</h2>
            <ul style={listStyle}>
              {groups.tba.map((e) => (
                <li key={e.id} style={rowStyle}>
                  <div style={{ ...timeStyle, color: inkMuted }}>TBA</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 16, color: ink }}>{e.name}</div>
                    <div style={{ fontSize: 13, color: inkMuted, marginTop: 2 }}>{describe(e)}</div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p style={{ fontSize: 12, color: inkMuted, margin: "8px 0 32px" }}>
          Times are shown in your device's time zone.
        </p>
      </div>
      <SiteFooter />
    </main>
  );
}

function describe(e: EventRow): string {
  const g = { men: "Men's", women: "Women's", mixed: "Mixed", open: "Open" }[e.gender] ?? e.gender;
  return `${g} ${e.format}`;
}

function byStart(a: EventRow, b: EventRow): number {
  return (a.scheduled_start_at ?? "").localeCompare(b.scheduled_start_at ?? "") || a.name.localeCompare(b.name);
}

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function fmtRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const day = (d: Date) => d.toLocaleDateString(undefined, { month: "long", day: "numeric" });
  if (day(s) === day(e)) return s.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  return `${day(s)} – ${day(e)}`;
}

const dayHeadingStyle: CSSProperties = {
  fontFamily: headingFontStack,
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: ink,
  margin: "0 0 10px",
};

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  border: `1px solid ${rule}`,
  borderRadius: 10,
  background: "#fff",
  overflow: "hidden",
};

const rowStyle: CSSProperties = {
  display: "flex",
  gap: 16,
  alignItems: "flex-start",
  padding: "14px 16px",
  borderTop: `1px solid ${ruleSoft}`,
};

const timeStyle: CSSProperties = {
  flex: "0 0 84px",
  fontFamily: displayFontStack,
  fontSize: 20,
  lineHeight: 1.1,
  color: courtRed,
  paddingTop: 1,
};

const noticeStyle: CSSProperties = {
  border: `1px dashed ${rule}`,
  borderRadius: 10,
  padding: 20,
  color: inkSoft,
  fontSize: 14,
  lineHeight: 1.55,
  background: cream,
  marginBottom: 24,
};
