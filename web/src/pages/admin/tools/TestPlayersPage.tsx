import {
  useEffect,
  useState,
  type CSSProperties,
} from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../../supabase";
import { useCurrentOrg } from "../../../hooks/useCurrentOrg";
import type { Database } from "../../../types/supabase";

type Player = Database["public"]["Tables"]["players"]["Row"];
type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];

// Constants must match the edge function. If the function ever
// changes the password or domain, update here too.
const TEST_PASSWORD = "testpass123";
const TEST_EMAIL_DOMAIN = "example.test";

// Where we stash the admin's session before signing in as a test
// player, so the SiteHeader can restore it via setSession when the
// admin clicks "Switch back."
const IMPERSONATION_KEY = "tm:admin-session";

// Dev-only admin tool that lets an organizer "sign in as" any of
// 20 well-known test players to test the public registration flow.
// The page does three things:
//
//   1. Seeds the 20 test players via the seed-test-players edge
//      function (idempotent — safe to re-run any time).
//   2. Lets the admin pick a target tournament to land on after
//      signing in (the natural test path is the tournament's public
//      page where a test player would click Register).
//   3. Lists every test player with a "Sign in as" button. Clicking
//      it stashes the admin's session in sessionStorage and signs
//      in as the test player. SiteHeader renders a "Switch back"
//      banner while impersonating, which calls supabase.auth
//      .setSession with the stashed tokens to restore the admin.
export default function TestPlayersPage() {
  const { org } = useCurrentOrg();
  const navigate = useNavigate();

  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [targetTournamentId, setTargetTournamentId] = useState<string>("");
  const [testPlayers, setTestPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<string | null>(null);
  const [signingInAs, setSigningInAs] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    if (!org) return;
    setError(null);

    // Tournaments visible in this org — for the post-signin landing
    // picker. We're not filtering by status because the admin may
    // want to test a draft tournament too.
    const [tRes, pRes] = await Promise.all([
      supabase
        .from("tournaments")
        .select("*")
        .eq("organization_id", org.id)
        .is("deleted_at", null)
        .order("starts_at", { ascending: true }),
      supabase
        .from("players")
        .select("*")
        .ilike("email", `%@${TEST_EMAIL_DOMAIN}`)
        .is("deleted_at", null)
        .order("email", { ascending: true }),
    ]);
    if (tRes.error) {
      setError(tRes.error.message);
      setLoading(false);
      return;
    }
    if (pRes.error) {
      setError(pRes.error.message);
      setLoading(false);
      return;
    }
    setTournaments(tRes.data ?? []);
    setTestPlayers(pRes.data ?? []);
    // Default the picker to the first published tournament if any,
    // otherwise the first tournament of any status.
    if (tRes.data && tRes.data.length > 0 && !targetTournamentId) {
      const firstPublished = tRes.data.find((t) => t.status === "published");
      setTargetTournamentId((firstPublished ?? tRes.data[0]).id);
    }
    setLoading(false);
  };

  useEffect(() => {
    // reload() is intentionally not in deps — it would change every
    // render. The set-state-in-effect rule fires because reload sets
    // state synchronously at the top of its body, but reload is just
    // the initial-fetch helper here, not a state synchronizer.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  const onSeed = async () => {
    setSeeding(true);
    setSeedResult(null);
    setError(null);
    const { data, error: invErr } = await supabase.functions.invoke(
      "seed-test-players",
    );
    setSeeding(false);
    if (invErr) {
      setError(`Edge function failed: ${invErr.message}`);
      return;
    }
    const result = data as
      | {
          ok: boolean;
          created: number;
          alreadyExisted: number;
          total: number;
          errors: { email: string; error: string }[];
        }
      | undefined;
    if (!result?.ok) {
      setError("Edge function did not return ok.");
      return;
    }
    const parts = [
      `Created ${result.created}`,
      `${result.alreadyExisted} already existed`,
    ];
    if (result.errors.length > 0) {
      parts.push(`${result.errors.length} errored`);
    }
    setSeedResult(parts.join(" · "));
    if (result.errors.length > 0) {
      setError(
        result.errors
          .map((e) => `${e.email}: ${e.error}`)
          .join("\n"),
      );
    }
    await reload();
  };

  const onSignInAs = async (player: Player) => {
    if (!player.email) return;
    setSigningInAs(player.id);
    setError(null);

    // Stash the current admin session so the impersonation banner
    // can restore it later. We grab tokens directly instead of
    // calling getUser/getSession-and-stringify because we need both
    // the access AND refresh tokens for setSession to work.
    const { data: sessionData } = await supabase.auth.getSession();
    if (sessionData.session) {
      try {
        sessionStorage.setItem(
          IMPERSONATION_KEY,
          JSON.stringify({
            access_token: sessionData.session.access_token,
            refresh_token: sessionData.session.refresh_token,
            email: sessionData.session.user.email,
          }),
        );
      } catch {
        // sessionStorage is rarely unavailable but if it is we just
        // can't auto-restore — admin can sign back in manually.
      }
    }

    const { error: signErr } = await supabase.auth.signInWithPassword({
      email: player.email,
      password: TEST_PASSWORD,
    });
    if (signErr) {
      setError(`Sign-in failed: ${signErr.message}`);
      sessionStorage.removeItem(IMPERSONATION_KEY);
      setSigningInAs(null);
      return;
    }

    // Where to land. The user picks a target tournament; we drop
    // them at its public page so they can click Register on an
    // event. Fall back to / if no tournament is picked.
    const target = tournaments.find((t) => t.id === targetTournamentId);
    if (target && org) {
      navigate(`/t/${org.slug}/${target.slug}`);
    } else {
      navigate("/");
    }
  };

  if (!org) return null;

  return (
    <div style={{ maxWidth: 900 }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Test players</h1>
        <p style={{ color: "#666", margin: "4px 0 0", fontSize: 14, lineHeight: 1.5 }}>
          Sign in as one of 20 pre-seeded fake accounts to test the
          public registration flow end-to-end. The site header will
          show a "Switch back" link while you're impersonating —
          click it (or sign out and back in as yourself) to return.
        </p>
      </header>

      {/* Seed button + count */}
      <section
        style={{
          padding: 16,
          background: "#fafafa",
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          marginBottom: 20,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#444" }}>
            {testPlayers.length === 0
              ? "No test players yet"
              : `${testPlayers.length} test player${testPlayers.length === 1 ? "" : "s"} ready`}
          </div>
          {seedResult && (
            <div style={{ fontSize: 12, color: "#16a34a", marginTop: 4 }}>
              {seedResult}
            </div>
          )}
          <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
            Password for all test accounts: <code>{TEST_PASSWORD}</code>
            {" · "}emails end in <code>@{TEST_EMAIL_DOMAIN}</code>
          </div>
        </div>
        <button
          type="button"
          onClick={onSeed}
          disabled={seeding}
          style={primaryBtn(seeding)}
        >
          {seeding
            ? "Seeding…"
            : testPlayers.length === 0
              ? "Seed 20 test players"
              : "Re-seed (top up to 20)"}
        </button>
      </section>

      {/* Target tournament picker — controls where "Sign in as" lands */}
      {tournaments.length > 0 && (
        <section style={{ marginBottom: 20 }}>
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontSize: 13,
              color: "#444",
            }}
          >
            <span>
              <strong>Land on this tournament after sign-in:</strong>{" "}
              <span style={{ color: "#888" }}>
                (so you can click Register on an event)
              </span>
            </span>
            <select
              value={targetTournamentId}
              onChange={(e) => setTargetTournamentId(e.target.value)}
              style={selectStyle}
            >
              <option value="">— Just go to home page —</option>
              {tournaments.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.status !== "published" ? ` (${t.status})` : ""}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}

      {error && (
        <div
          style={{
            marginBottom: 16,
            padding: 12,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 6,
            color: "#991b1b",
            fontSize: 13,
            whiteSpace: "pre-wrap",
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ color: "#666", fontSize: 14 }}>Loading…</div>
      ) : testPlayers.length === 0 ? (
        <div
          style={{
            padding: 24,
            textAlign: "center",
            background: "#fff",
            border: "1px dashed #d1d5db",
            borderRadius: 8,
            color: "#666",
            fontSize: 14,
          }}
        >
          Click <strong>Seed 20 test players</strong> above to create
          the test accounts.
        </div>
      ) : (
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            background: "#fff",
            overflow: "hidden",
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#fafafa" }}>
                <Th>Name</Th>
                <Th>Gender</Th>
                <Th>Rating</Th>
                <Th>Email</Th>
                <Th style={{ width: 140, textAlign: "right" }}>{" "}</Th>
              </tr>
            </thead>
            <tbody>
              {testPlayers.map((p) => (
                <tr
                  key={p.id}
                  style={{ borderTop: "1px solid #f0f0f0" }}
                >
                  <Td>
                    {p.first_name} {p.last_name}
                  </Td>
                  <Td>{p.gender ?? "—"}</Td>
                  <Td>
                    {p.self_rating_doubles != null
                      ? p.self_rating_doubles.toFixed(1)
                      : "—"}
                  </Td>
                  <Td style={{ color: "#888" }}>{p.email}</Td>
                  <Td style={{ textAlign: "right" }}>
                    <button
                      type="button"
                      onClick={() => void onSignInAs(p)}
                      disabled={signingInAs !== null}
                      style={inlineBtn(signingInAs === p.id)}
                    >
                      {signingInAs === p.id ? "Signing in…" : "Sign in as"}
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bits
// ─────────────────────────────────────────────────────────────────────

function Th({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: CSSProperties;
}) {
  return (
    <th
      style={{
        padding: "10px 12px",
        textAlign: "left",
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        color: "#666",
        fontWeight: 600,
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: CSSProperties;
}) {
  return (
    <td style={{ padding: "10px 12px", ...style }}>{children}</td>
  );
}

function primaryBtn(busy: boolean): CSSProperties {
  return {
    padding: "10px 20px",
    background: busy ? "#9ca3af" : "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 500,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: "inherit",
  };
}

function inlineBtn(busy: boolean): CSSProperties {
  return {
    padding: "6px 12px",
    background: busy ? "#9ca3af" : "#fff",
    color: busy ? "#fff" : "#2563eb",
    border: `1px solid ${busy ? "#9ca3af" : "#2563eb"}`,
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 500,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: "inherit",
  };
}

const selectStyle: CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  background: "#fff",
  maxWidth: 480,
};
