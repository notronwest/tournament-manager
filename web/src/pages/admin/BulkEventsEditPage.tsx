import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];
type EventStatus = Database["public"]["Enums"]["event_status"];

// Editable in-memory row. Mirrors only the fields we want to bulk-
// edit; everything else stays untouched on save. Strings everywhere
// so the inputs can stay controlled (and "empty" can mean "null").
type Draft = {
  id: string;
  name: string;
  status: EventStatus;
  scheduledStartLocal: string; // datetime-local string, "" if unset
  maxTeams: string;            // numeric string, "" if unlimited
  feeDollars: string;          // numeric string, "" or "0" if free
};

// Per-row save state. Tracks save progress + error inline so a
// single bad row doesn't block the rest.
type RowState = {
  saving: boolean;
  error: string | null;
};

// Bulk events edit at /admin/:org/tournaments/:slug/events/edit.
// One editable row per event covering the fields organizers most
// commonly tweak after creation: name, status (draft → active etc.),
// scheduled start, max teams, event fee. Everything else
// (format / gender / point configs / bracket type) stays in the
// per-event edit form because changing those after registrations
// exist has side effects we don't want to bury in a bulk view.
//
// Save model: diff each row against the original snapshot; only
// rows with actual changes get sent. We do one UPDATE per dirty
// row in parallel rather than one big RPC, so per-row failures
// surface independently.
export default function BulkEventsEditPage() {
  const { org } = useCurrentOrg();
  const navigate = useNavigate();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [originals, setOriginals] = useState<Map<string, Draft>>(new Map());
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [rowState, setRowState] = useState<Map<string, RowState>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingAll, setSavingAll] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  // Initial load: tournament + every non-deleted event under it.
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

      const initial: Draft[] = (evs ?? []).map(eventToDraft);
      setDrafts(initial);
      // Clone for the originals map — drafts mutate, originals don't.
      setOriginals(new Map(initial.map((d) => [d.id, { ...d }])));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [org, tournamentSlug]);

  // Set of row ids that differ from their original snapshot. Used to
  // gate the "Save all" button and to decide which rows to update.
  const dirtyIds = useMemo(() => {
    const out = new Set<string>();
    for (const d of drafts) {
      const o = originals.get(d.id);
      if (!o) continue;
      if (
        o.name !== d.name ||
        o.status !== d.status ||
        o.scheduledStartLocal !== d.scheduledStartLocal ||
        o.maxTeams !== d.maxTeams ||
        o.feeDollars !== d.feeDollars
      ) {
        out.add(d.id);
      }
    }
    return out;
  }, [drafts, originals]);

  // Updates one field of one row by id. Keeps the rest of the row
  // immutable so React picks up the change on a shallow compare.
  const updateDraft = (id: string, patch: Partial<Draft>) => {
    setDrafts((rows) =>
      rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  };

  // Saves every dirty row. Validates per-row first; if any row fails
  // validation we stop before touching the database. Network errors
  // are tolerated per-row so one bad save doesn't block the rest.
  const onSaveAll = async () => {
    if (!org || !tournament) return;
    setError(null);
    setSavedAt(null);

    // Validate up front so we don't half-save.
    const validated: { draft: Draft; payload: EventUpdate }[] = [];
    for (const id of dirtyIds) {
      const d = drafts.find((r) => r.id === id);
      if (!d) continue;
      const v = validateAndBuildPayload(d);
      if ("error" in v) {
        setError(`${d.name || "Untitled event"}: ${v.error}`);
        return;
      }
      validated.push({ draft: d, payload: v.payload });
    }
    if (validated.length === 0) return;

    setSavingAll(true);

    // Reset per-row error state for the rows we're about to save.
    setRowState((prev) => {
      const next = new Map(prev);
      for (const v of validated) {
        next.set(v.draft.id, { saving: true, error: null });
      }
      return next;
    });

    // One UPDATE per row, in parallel. Each promise resolves with
    // either { id, ok: true } or { id, ok: false, error }.
    const results = await Promise.all(
      validated.map(async ({ draft, payload }) => {
        const { error: err } = await supabase
          .from("events")
          .update(payload)
          .eq("id", draft.id);
        return { id: draft.id, ok: !err, error: err?.message ?? null };
      }),
    );

    // Apply per-row results: clear the originals for the rows that
    // saved (so they're no longer dirty), and stash error messages
    // for the ones that didn't.
    setRowState((prev) => {
      const next = new Map(prev);
      for (const r of results) {
        next.set(r.id, { saving: false, error: r.ok ? null : r.error });
      }
      return next;
    });
    setOriginals((prev) => {
      const next = new Map(prev);
      for (const r of results) {
        if (!r.ok) continue;
        const d = drafts.find((row) => row.id === r.id);
        if (d) next.set(r.id, { ...d });
      }
      return next;
    });

    setSavingAll(false);
    if (results.every((r) => r.ok)) {
      setSavedAt(new Date());
    } else {
      setError(
        `${results.filter((r) => !r.ok).length} row${results.filter((r) => !r.ok).length === 1 ? "" : "s"} failed to save. See per-row errors.`,
      );
    }
  };

  if (!org) return null;

  if (loading) {
    return <div style={{ color: "#666", fontSize: 14 }}>Loading…</div>;
  }

  if (error && !tournament) {
    return (
      <div style={{ maxWidth: 600 }}>
        <h1 style={{ margin: "0 0 8px", fontSize: 20 }}>Can't load events</h1>
        <p style={{ color: "#666", fontSize: 14 }}>{error}</p>
        <button
          onClick={() => navigate(`/admin/${org.slug}/tournaments`)}
          style={secondaryBtn}
        >
          Back to tournaments
        </button>
      </div>
    );
  }
  if (!tournament) return null;

  const backUrl = `/admin/${org.slug}/tournaments/${tournament.slug}`;

  return (
    <div style={{ maxWidth: 1100 }}>
      <header style={{ marginBottom: 24 }}>
        <Link
          to={backUrl}
          style={{
            color: "#2563eb",
            fontSize: 13,
            textDecoration: "none",
          }}
        >
          ← {tournament.name}
        </Link>
        <h1 style={{ margin: "8px 0 4px", fontSize: 22 }}>Edit all events</h1>
        <p style={{ color: "#666", margin: 0, fontSize: 14 }}>
          Quick edits across every event. For format / gender / point
          settings / bracket type, use the per-event edit page.
        </p>
      </header>

      {drafts.length === 0 ? (
        <div
          style={{
            padding: 24,
            textAlign: "center",
            background: "#fafafa",
            border: "1px dashed #d1d5db",
            borderRadius: 8,
            color: "#666",
            fontSize: 14,
          }}
        >
          No events yet.{" "}
          <Link
            to={`${backUrl}/events/new`}
            style={{ color: "#2563eb" }}
          >
            Add one
          </Link>
          .
        </div>
      ) : (
        <>
          <div
            style={{
              overflow: "auto",
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              background: "#fff",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr style={{ background: "#fafafa" }}>
                  <Th style={{ minWidth: 220 }}>Name</Th>
                  <Th style={{ width: 140 }}>Status</Th>
                  <Th style={{ width: 200 }}>Scheduled start</Th>
                  <Th style={{ width: 110 }}>Max teams</Th>
                  <Th style={{ width: 110 }}>Fee ($)</Th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((d) => {
                  const isDirty = dirtyIds.has(d.id);
                  const state = rowState.get(d.id);
                  return (
                    <tr
                      key={d.id}
                      style={{
                        borderTop: "1px solid #f0f0f0",
                        background: state?.error
                          ? "#fef2f2"
                          : isDirty
                            ? "#fffbeb"
                            : "#fff",
                      }}
                    >
                      <Td>
                        <input
                          type="text"
                          value={d.name}
                          onChange={(e) =>
                            updateDraft(d.id, { name: e.target.value })
                          }
                          style={cellInputStyle}
                          disabled={savingAll}
                        />
                        {state?.error && (
                          <div
                            style={{
                              marginTop: 4,
                              color: "#991b1b",
                              fontSize: 11,
                            }}
                          >
                            {state.error}
                          </div>
                        )}
                      </Td>
                      <Td>
                        <select
                          value={d.status}
                          onChange={(e) =>
                            updateDraft(d.id, {
                              status: e.target.value as EventStatus,
                            })
                          }
                          style={cellInputStyle}
                          disabled={savingAll}
                        >
                          {EVENT_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {prettyStatus(s)}
                            </option>
                          ))}
                        </select>
                      </Td>
                      <Td>
                        <input
                          type="datetime-local"
                          value={d.scheduledStartLocal}
                          onChange={(e) => {
                            updateDraft(d.id, {
                              scheduledStartLocal: e.target.value,
                            });
                            // Close the native picker after a value
                            // change. Without this the calendar/clock
                            // popup just sits there until you click
                            // somewhere else, which is annoying in a
                            // bulk-edit context where you're zipping
                            // between rows.
                            e.currentTarget.blur();
                          }}
                          style={cellInputStyle}
                          disabled={savingAll}
                        />
                      </Td>
                      <Td>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          placeholder="—"
                          value={d.maxTeams}
                          onChange={(e) =>
                            updateDraft(d.id, { maxTeams: e.target.value })
                          }
                          style={cellInputStyle}
                          disabled={savingAll}
                        />
                      </Td>
                      <Td>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="0"
                          value={d.feeDollars}
                          onChange={(e) =>
                            updateDraft(d.id, { feeDollars: e.target.value })
                          }
                          style={cellInputStyle}
                          disabled={savingAll}
                        />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {error && (
            <div
              style={{
                marginTop: 16,
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
          )}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginTop: 16,
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              onClick={onSaveAll}
              disabled={savingAll || dirtyIds.size === 0}
              style={primaryBtn(savingAll || dirtyIds.size === 0)}
            >
              {savingAll
                ? "Saving…"
                : dirtyIds.size === 0
                  ? "No changes"
                  : `Save ${dirtyIds.size} change${dirtyIds.size === 1 ? "" : "s"}`}
            </button>
            <Link to={backUrl} style={secondaryLinkBtn}>
              Done
            </Link>
            {savedAt && dirtyIds.size === 0 && (
              <span style={{ color: "#16a34a", fontSize: 13 }}>
                Saved {savedAt.toLocaleTimeString()}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Validation + payload construction
// ─────────────────────────────────────────────────────────────────────

type EventUpdate = Database["public"]["Tables"]["events"]["Update"];

function validateAndBuildPayload(
  d: Draft,
): { payload: EventUpdate } | { error: string } {
  const name = d.name.trim();
  if (!name) return { error: "Name is required." };

  let scheduled_start_at: string | null = null;
  if (d.scheduledStartLocal) {
    const parsed = new Date(d.scheduledStartLocal);
    if (Number.isNaN(parsed.getTime())) {
      return { error: "Scheduled start is not a valid date/time." };
    }
    scheduled_start_at = parsed.toISOString();
  }

  let max_teams: number | null = null;
  if (d.maxTeams.trim()) {
    const n = parseInt(d.maxTeams, 10);
    if (Number.isNaN(n) || n < 0) {
      return { error: "Max teams must be a non-negative integer." };
    }
    max_teams = n;
  }

  const feeStr = d.feeDollars.trim();
  if (!feeStr) {
    return {
      payload: {
        name,
        status: d.status,
        scheduled_start_at,
        max_teams,
        event_fee_cents: 0,
      },
    };
  }
  const fee = parseFloat(feeStr);
  if (Number.isNaN(fee) || fee < 0) {
    return { error: "Fee must be a non-negative number." };
  }
  return {
    payload: {
      name,
      status: d.status,
      scheduled_start_at,
      max_teams,
      event_fee_cents: Math.round(fee * 100),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const EVENT_STATUSES: EventStatus[] = [
  "draft",
  "ready",
  "active",
  "on_hold",
  "medal_round",
  "complete",
  "verified",
];

function prettyStatus(s: EventStatus): string {
  // Replace underscores with spaces, capitalize first letter.
  const spaced = s.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function eventToDraft(e: Event): Draft {
  return {
    id: e.id,
    name: e.name,
    status: e.status,
    scheduledStartLocal: isoToLocal(e.scheduled_start_at),
    maxTeams: e.max_teams == null ? "" : String(e.max_teams),
    feeDollars:
      e.event_fee_cents > 0
        ? (e.event_fee_cents / 100).toFixed(2)
        : "",
  };
}

function isoToLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─────────────────────────────────────────────────────────────────────
// Styles
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

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td
      style={{
        padding: "8px 12px",
        verticalAlign: "top",
      }}
    >
      {children}
    </td>
  );
}

const cellInputStyle: CSSProperties = {
  padding: "6px 8px",
  border: "1px solid #e2e2e2",
  borderRadius: 4,
  fontSize: 13,
  fontFamily: "inherit",
  width: "100%",
  background: "#fff",
};

function primaryBtn(disabled: boolean): CSSProperties {
  return {
    padding: "10px 20px",
    background: disabled ? "#9ca3af" : "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
  };
}

const secondaryBtn: CSSProperties = {
  padding: "8px 16px",
  background: "#fff",
  color: "#555",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "inherit",
  marginTop: 12,
};

const secondaryLinkBtn: CSSProperties = {
  padding: "10px 20px",
  background: "#fff",
  color: "#555",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  cursor: "pointer",
  fontFamily: "inherit",
  textDecoration: "none",
};
