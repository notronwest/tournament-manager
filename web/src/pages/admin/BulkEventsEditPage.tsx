import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { ConfirmModal } from "../../components/ConfirmModal";
import type { Database } from "../../types/supabase";
import {
  ink,
  inkSoft,
  inkMuted,
  bg,
  cream,
  rule,
  courtBlue,
  courtGreen,
  courtRed,
  dangerBg,
  dangerFg,
  warnBg,
  bodyFontStack,
  headingFontStack,
  displayFontStack,
} from "../../lib/publicTheme";

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
  // Ids marked for (soft) deletion + the confirm-before-delete gate.
  const [toDelete, setToDelete] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);

  const toggleDelete = (id: string) =>
    setToDelete((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
  // Soft-delete the marked events — but SKIP any with active (paid/pending)
  // registrations: deleting an event people paid into would orphan their money,
  // so we block it and surface a per-row error instead. Returns how many were
  // deleted vs blocked.
  const deleteMarked = async (): Promise<{ deletedIds: string[]; blocked: number }> => {
    const ids = [...toDelete];
    if (ids.length === 0) return { deletedIds: [], blocked: 0 };

    // Which marked events have registrations? (RPC is SECURITY DEFINER, so
    // RLS can't hide a registration we should be protecting.)
    const { data: regRows } = await supabase.rpc(
      "players_registered_for_events",
      { p_event_ids: ids },
    );
    const hasRegs = new Set(
      ((regRows ?? []) as { event_id: string }[]).map((r) => r.event_id),
    );
    const blocked = ids.filter((id) => hasRegs.has(id));
    const deletable = ids.filter((id) => !hasRegs.has(id));

    if (blocked.length > 0) {
      setRowState((prev) => {
        const next = new Map(prev);
        for (const id of blocked) {
          next.set(id, {
            saving: false,
            error: "Can't delete — players are registered. Cancel/refund them first.",
          });
        }
        return next;
      });
    }

    const results = await Promise.all(
      deletable.map(async (id) => {
        const { error: err } = await supabase
          .from("events")
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", id);
        return { id, ok: !err, error: err?.message ?? null };
      }),
    );
    const deletedIds = results.filter((r) => r.ok).map((r) => r.id);
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      setRowState((prev) => {
        const next = new Map(prev);
        for (const r of failed) next.set(r.id, { saving: false, error: r.error });
        return next;
      });
    }
    if (deletedIds.length > 0) {
      const del = new Set(deletedIds);
      setDrafts((rows) => rows.filter((r) => !del.has(r.id)));
      setOriginals((prev) => {
        const next = new Map(prev);
        for (const id of deletedIds) next.delete(id);
        return next;
      });
      setToDelete((prev) => {
        const next = new Set(prev);
        for (const id of deletedIds) next.delete(id);
        return next;
      });
    }
    return { deletedIds, blocked: blocked.length };
  };

  const doSave = async () => {
    if (!org || !tournament) return;
    setError(null);
    setSavedAt(null);
    setConfirmDelete(false);

    // Validate edits up front (skip rows marked for deletion).
    const validated: { draft: Draft; payload: EventUpdate }[] = [];
    for (const id of dirtyIds) {
      if (toDelete.has(id)) continue;
      const d = drafts.find((r) => r.id === id);
      if (!d) continue;
      const v = validateAndBuildPayload(d);
      if ("error" in v) {
        setError(`${d.name || "Untitled event"}: ${v.error}`);
        return;
      }
      validated.push({ draft: d, payload: v.payload });
    }

    setSavingAll(true);

    // 1) Deletions (registration-guarded).
    const { deletedIds, blocked } = await deleteMarked();

    // 2) Edits (excluding anything just deleted).
    const edits = validated.filter((v) => !deletedIds.includes(v.draft.id));
    setRowState((prev) => {
      const next = new Map(prev);
      for (const v of edits) next.set(v.draft.id, { saving: true, error: null });
      return next;
    });
    const results = await Promise.all(
      edits.map(async ({ draft, payload }) => {
        const { error: err } = await supabase
          .from("events")
          .update(payload)
          .eq("id", draft.id);
        return { id: draft.id, ok: !err, error: err?.message ?? null };
      }),
    );
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
    const editFails = results.filter((r) => !r.ok).length;
    if (editFails === 0 && blocked === 0) {
      setSavedAt(new Date());
    } else {
      const parts: string[] = [];
      if (editFails > 0)
        parts.push(`${editFails} edit${editFails === 1 ? "" : "s"} failed`);
      if (blocked > 0)
        parts.push(
          `${blocked} event${blocked === 1 ? "" : "s"} not deleted (players registered)`,
        );
      setError(`${parts.join("; ")}. See per-row errors.`);
    }
  };

  // Save button entry point — confirm first if anything is marked for deletion.
  const onSaveAll = () => {
    if (toDelete.size > 0) setConfirmDelete(true);
    else void doSave();
  };

  if (!org) return null;

  if (loading) {
    return <div style={{ color: inkSoft, fontSize: 14, fontFamily: bodyFontStack }}>Loading…</div>;
  }

  if (error && !tournament) {
    return (
      <div style={{ maxWidth: 600, fontFamily: bodyFontStack }}>
        <h1 style={{ margin: "0 0 8px", fontSize: 20, fontFamily: displayFontStack, color: ink }}>Can't load events</h1>
        <p style={{ color: inkSoft, fontSize: 14 }}>{error}</p>
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
    <div style={{ maxWidth: 1100, fontFamily: bodyFontStack }}>
      <header style={{ marginBottom: 24 }}>
        <Link
          to={backUrl}
          style={{
            color: courtBlue,
            fontSize: 13,
            textDecoration: "none",
          }}
        >
          ← {tournament.name}
        </Link>
        <h1 style={{ margin: "8px 0 4px", fontSize: 22, fontFamily: displayFontStack, color: ink }}>Edit all events</h1>
        <p style={{ color: inkSoft, margin: 0, fontSize: 14 }}>
          Quick edits across every event. For format / gender / point
          settings / bracket type, use the per-event edit page.
        </p>
      </header>

      {drafts.length === 0 ? (
        <div
          style={{
            padding: 24,
            textAlign: "center",
            background: cream,
            border: `1px dashed ${rule}`,
            borderRadius: 8,
            color: inkSoft,
            fontSize: 14,
          }}
        >
          No events yet.{" "}
          <Link
            to={`${backUrl}/events/new`}
            style={{ color: courtBlue }}
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
              border: `1px solid ${rule}`,
              borderRadius: 8,
              background: "#ffffff",
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
                <tr style={{ background: cream }}>
                  <Th style={{ minWidth: 220 }}>Name</Th>
                  <Th style={{ width: 140 }}>Status</Th>
                  <Th style={{ width: 200 }}>Scheduled start</Th>
                  <Th style={{ width: 110 }}>Max teams</Th>
                  <Th style={{ width: 130 }}>Custom price ($)</Th>
                  <Th style={{ width: 70 }}>Delete</Th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((d) => {
                  const isDirty = dirtyIds.has(d.id);
                  const marked = toDelete.has(d.id);
                  const state = rowState.get(d.id);
                  return (
                    <tr
                      key={d.id}
                      style={{
                        borderTop: `1px solid ${rule}`,
                        background:
                          marked || state?.error
                            ? dangerBg
                            : isDirty
                              ? warnBg
                              : "#ffffff",
                        opacity: marked ? 0.6 : 1,
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
                              color: dangerFg,
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
                          placeholder="—"
                          value={d.feeDollars}
                          onChange={(e) =>
                            updateDraft(d.id, { feeDollars: e.target.value })
                          }
                          style={cellInputStyle}
                          disabled={savingAll}
                        />
                      </Td>
                      <Td>
                        <input
                          type="checkbox"
                          checked={marked}
                          onChange={() => toggleDelete(d.id)}
                          disabled={savingAll}
                          aria-label={`Mark ${d.name || "event"} for deletion`}
                          style={{ width: 16, height: 16, cursor: "pointer" }}
                        />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div
            style={{
              marginTop: 10,
              fontSize: 12,
              color: inkMuted,
              lineHeight: 1.5,
            }}
          >
            <strong>Custom price</strong> is an optional override for a
            single event. Leave it blank (—) and the event uses the
            tournament's pricing: players pay the registration fee for
            their first event and the additional-event fee for each
            event after that. Only set a custom price for a one-off
            like a premium division — it replaces the tournament
            pricing for that event entirely.
          </div>

          {error && (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                background: dangerBg,
                border: `1px solid ${courtRed}`,
                borderRadius: 6,
                color: dangerFg,
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
              disabled={savingAll || (dirtyIds.size === 0 && toDelete.size === 0)}
              style={primaryBtn(
                savingAll || (dirtyIds.size === 0 && toDelete.size === 0),
              )}
            >
              {savingAll
                ? "Saving…"
                : dirtyIds.size === 0 && toDelete.size === 0
                  ? "No changes"
                  : [
                      dirtyIds.size > 0
                        ? `Save ${dirtyIds.size} change${dirtyIds.size === 1 ? "" : "s"}`
                        : null,
                      toDelete.size > 0
                        ? `${dirtyIds.size > 0 ? "delete" : "Delete"} ${toDelete.size}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
            </button>
            <Link to={backUrl} style={secondaryLinkBtn}>
              Cancel
            </Link>
            {savedAt && dirtyIds.size === 0 && toDelete.size === 0 && (
              <span style={{ color: courtGreen, fontSize: 13 }}>
                Saved {savedAt.toLocaleTimeString()}
              </span>
            )}
          </div>

          {confirmDelete && (
            <ConfirmModal
              title={`Delete ${toDelete.size} event${toDelete.size === 1 ? "" : "s"}?`}
              body={
                <>
                  This removes {toDelete.size === 1 ? "it" : "them"} from the
                  tournament and registration. Any event with registered players
                  is skipped — cancel or refund those first.
                </>
              }
              confirmLabel="Delete"
              cancelLabel="Keep"
              onCancel={() => setConfirmDelete(false)}
              onConfirm={async () => {
                await doSave();
              }}
            />
          )}
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
        color: inkSoft,
        fontWeight: 600,
        fontFamily: headingFontStack,
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
  border: `1px solid ${rule}`,
  borderRadius: 4,
  fontSize: 13,
  fontFamily: bodyFontStack,
  color: ink,
  width: "100%",
  background: "#ffffff",
};

function primaryBtn(disabled: boolean): CSSProperties {
  return {
    padding: "10px 20px",
    background: disabled ? inkMuted : ink,
    color: bg,
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: headingFontStack,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

const secondaryBtn: CSSProperties = {
  padding: "8px 16px",
  background: "transparent",
  color: ink,
  boxShadow: `inset 0 0 0 2px ${ink}`,
  border: "none",
  borderRadius: 6,
  fontSize: 13,
  fontFamily: headingFontStack,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  cursor: "pointer",
  marginTop: 12,
};

const secondaryLinkBtn: CSSProperties = {
  padding: "10px 20px",
  background: "transparent",
  color: ink,
  boxShadow: `inset 0 0 0 2px ${ink}`,
  border: "none",
  borderRadius: 6,
  fontSize: 13,
  fontFamily: headingFontStack,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  cursor: "pointer",
  textDecoration: "none",
  display: "inline-block",
};
