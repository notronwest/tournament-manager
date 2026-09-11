import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { ConfirmModal } from "../../components/ConfirmModal";
import { displayHeading, fieldLabel } from "./contactsUi";
import {
  ink,
  inkSoft,
  inkMuted,
  cream,
  rule,
  ruleSoft,
  bodyFontStack,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  inputStyle,
  statusPanelStyle,
} from "../../lib/publicTheme";

// Merge one event into another: every team in the "merge away" event moves
// into the "keep" event in one transaction (merge_events), the kept event can
// be renamed in the same step, and the merged-away event disappears. The
// server refuses anything unsafe (different formats, a drawn bracket, a player
// active in both); this page shows those blockers before the organizer
// commits, via merge_events_preview.
//
// The two RPCs aren't in the generated types yet, so this page uses the
// untyped client for them (same pattern as lib/orgContacts).
const untyped = supabase as unknown as SupabaseClient;

type Tournament = { id: string; name: string; slug: string };

type EventRow = {
  id: string;
  name: string;
  format: string;
  gender: string;
  event_fee_cents: number;
  status: string;
};

type Side = {
  id: string;
  name: string;
  format: string;
  gender: string;
  fee_cents: number;
  status: string;
  max_teams?: number | null;
  registrations: number;
  waitlisted: number;
  matches: number;
};

type Preview = {
  source: Side;
  target: Side;
  same_format: boolean;
  same_gender: boolean;
  same_fee: boolean;
  conflicts: { player_id: string; name: string }[];
};

type MergeResult = {
  target_event_id: string;
  target_name: string;
  moved_registrations: number;
  moved_players: number;
  cancelled_duplicate_waitlist: number;
  moved_invites: number;
};

const ERROR_COPY: Record<string, string> = {
  same_event: "Pick two different events.",
  different_tournaments: "Both events must be in this tournament.",
  format_mismatch: "Singles and doubles events can't be merged.",
  bracket_already_drawn: "One of these events already has matches. Merging is only possible before a bracket is drawn.",
  forbidden: "Only an org admin can merge events.",
  source_not_found: "The event to merge away no longer exists.",
  target_not_found: "The event to keep no longer exists.",
};

function friendlyError(msg: string): string {
  const key = msg.split(":")[0].trim();
  if (msg.startsWith("player_conflict")) {
    return `These players are registered in both events, so the merge can't run yet: ${msg.slice("player_conflict:".length).trim()}. Withdraw or move one of their registrations first.`;
  }
  return ERROR_COPY[key] ?? msg;
}

export default function MergeEventsPage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();
  const [params] = useSearchParams();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [sourceId, setSourceId] = useState(params.get("source") ?? "");
  const [targetId, setTargetId] = useState("");
  // The kept event's name defaults to its current name until edited.
  const [typedName, setTypedName] = useState<string | null>(null);

  // Preview state is keyed by the pair it was computed for, so a stale
  // preview never shows for a different selection.
  const [previewState, setPreviewState] = useState<{
    key: string;
    data: Preview | null;
    error: string | null;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [result, setResult] = useState<MergeResult | null>(null);

  useEffect(() => {
    if (!org || !tournamentSlug) return;
    let cancelled = false;
    (async () => {
      const { data: t, error: tErr } = await supabase
        .from("tournaments")
        .select("id, name, slug")
        .eq("organization_id", org.id)
        .eq("slug", tournamentSlug)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (tErr || !t) {
        setLoadError(tErr?.message ?? "Tournament not found.");
        return;
      }
      const { data: evs, error: eErr } = await supabase
        .from("events")
        .select("id, name, format, gender, event_fee_cents, status")
        .eq("tournament_id", t.id)
        .is("deleted_at", null)
        .order("name");
      if (cancelled) return;
      if (eErr) {
        setLoadError(eErr.message);
        return;
      }
      setTournament(t);
      setEvents((evs ?? []) as EventRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [org, tournamentSlug]);

  const source = useMemo(() => events.find((e) => e.id === sourceId) ?? null, [events, sourceId]);
  const target = useMemo(() => events.find((e) => e.id === targetId) ?? null, [events, targetId]);

  const pairKey = sourceId && targetId && sourceId !== targetId ? `${sourceId}|${targetId}` : "";

  // Preview whenever both sides are chosen.
  useEffect(() => {
    if (!pairKey) return;
    const [src, tgt] = pairKey.split("|");
    let cancelled = false;
    (async () => {
      setPreviewLoading(true);
      const { data, error } = await untyped.rpc("merge_events_preview", {
        p_source_event_id: src,
        p_target_event_id: tgt,
      });
      if (cancelled) return;
      setPreviewState(
        error
          ? { key: pairKey, data: null, error: friendlyError(error.message) }
          : { key: pairKey, data: data as Preview, error: null },
      );
      setPreviewLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [pairKey]);

  const preview = previewState && previewState.key === pairKey ? previewState.data : null;
  const previewError = previewState && previewState.key === pairKey ? previewState.error : null;
  const newName = typedName ?? target?.name ?? "";

  const blockers: string[] = [];
  if (preview) {
    if (!preview.same_format) blockers.push(ERROR_COPY.format_mismatch);
    if (preview.source.matches > 0 || preview.target.matches > 0) blockers.push(ERROR_COPY.bracket_already_drawn);
    if (preview.conflicts.length > 0) {
      blockers.push(
        `Registered in both events: ${preview.conflicts.map((c) => c.name).join(", ")}. Withdraw or move one of their registrations first.`,
      );
    }
  }
  const canMerge = !!preview && blockers.length === 0 && newName.trim().length > 0 && !merging;

  const merge = async () => {
    setMerging(true);
    setMergeError(null);
    try {
      const { data, error } = await untyped.rpc("merge_events", {
        p_source_event_id: sourceId,
        p_target_event_id: targetId,
        p_new_name: newName.trim(),
      });
      if (error) {
        setMergeError(friendlyError(error.message));
        return;
      }
      setResult(data as MergeResult);
    } finally {
      setMerging(false);
    }
  };

  if (!org) return null;
  if (loadError) {
    return (
      <div style={{ fontFamily: bodyFontStack, color: ink }}>
        <div style={statusPanelStyle("danger")} role="alert">{loadError}</div>
      </div>
    );
  }
  if (!tournament) return <div style={{ color: inkMuted }}>Loading…</div>;

  const base = `/admin/${org.slug}/tournaments/${tournament.slug}`;

  if (result) {
    return (
      <div style={{ fontFamily: bodyFontStack, color: ink }}>
        <p style={{ margin: "0 0 6px", fontSize: 13 }}>
          <Link to={base} style={{ color: inkSoft }}>← {tournament.name}</Link>
        </p>
        <h1 style={displayHeading}>Events merged</h1>
        <div style={{ ...statusPanelStyle("success"), marginBottom: 16 }} role="status">
          <strong>{result.target_name}</strong> now holds everyone from both events:{" "}
          {result.moved_registrations} registration{result.moved_registrations === 1 ? "" : "s"} ({result.moved_players} player{result.moved_players === 1 ? "" : "s"}) moved
          {result.cancelled_duplicate_waitlist > 0 && (
            <>, {result.cancelled_duplicate_waitlist} duplicate waitlist entr{result.cancelled_duplicate_waitlist === 1 ? "y" : "ies"} dropped</>
          )}
          {result.moved_invites > 0 && <>, {result.moved_invites} pending partner invite{result.moved_invites === 1 ? "" : "s"} carried across</>}.
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link to={`${base}/events/${result.target_event_id}`} style={ctaPrimaryStyle}>Open {result.target_name}</Link>
          <Link to={`${base}/attendees`} style={{ ...ctaPrimaryStyle, background: "transparent", color: ink, border: `1px solid ${ink}` }}>Attendees</Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: bodyFontStack, color: ink }}>
      <p style={{ margin: "0 0 6px", fontSize: 13 }}>
        <Link to={base} style={{ color: inkSoft }}>← {tournament.name}</Link>
      </p>
      <h1 style={displayHeading}>Merge events</h1>
      <p style={{ color: inkSoft, fontSize: 15, margin: "0 0 18px", maxWidth: 620, lineHeight: 1.55 }}>
        Move every team from one event into another. Teams stay paired, what
        people paid stays as recorded, waitlists join in order, and the
        merged-away event disappears. You can give the kept event a new name.
      </p>

      {events.length < 2 && (
        <div style={{ ...statusPanelStyle("info"), marginBottom: 16 }}>
          You need at least two events to merge.
        </div>
      )}

      <div style={{ ...panelWrap, marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
          <div>
            <label style={fieldLabel} htmlFor="merge-source">Merge away</label>
            <select
              id="merge-source"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              style={inputStyle}
            >
              <option value="">Choose the event to empty…</option>
              {events.map((e) => (
                <option key={e.id} value={e.id} disabled={e.id === targetId}>
                  {e.name} · {e.format}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={fieldLabel} htmlFor="merge-target">Keep</label>
            <select
              id="merge-target"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              style={inputStyle}
            >
              <option value="">Choose the event everyone moves into…</option>
              {events.map((e) => {
                const wrongFormat = !!source && e.format !== source.format;
                return (
                  <option key={e.id} value={e.id} disabled={e.id === sourceId || wrongFormat}>
                    {e.name} · {e.format}{wrongFormat ? " (different format)" : ""}
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      </div>

      {previewLoading && <div style={{ color: inkMuted, marginBottom: 16 }}>Checking…</div>}
      {previewError && (
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 16 }} role="alert">{previewError}</div>
      )}

      {preview && source && target && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, marginBottom: 16 }}>
            <SideCard title="Merging away" side={preview.source} />
            <SideCard title="Keeping" side={preview.target} />
          </div>

          {blockers.length > 0 && (
            <div style={{ ...statusPanelStyle("danger"), marginBottom: 16 }} role="alert">
              <strong>Can't merge yet.</strong>
              <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                {blockers.map((b) => <li key={b} style={{ marginBottom: 4 }}>{b}</li>)}
              </ul>
              {preview.conflicts.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <Link to={`${base}/attendees`} style={{ color: "inherit" }}>Open Attendees to fix these</Link>
                </div>
              )}
            </div>
          )}

          {blockers.length === 0 && (!preview.same_fee || !preview.same_gender) && (
            <div style={{ ...statusPanelStyle("warn"), marginBottom: 16, fontSize: 13 }}>
              {!preview.same_fee && (
                <div>
                  <strong>Different fees.</strong> {preview.source.name} charged {fmtMoney(preview.source.fee_cents)} and {preview.target.name} charges {fmtMoney(preview.target.fee_cents)}. Nobody is re-charged or refunded by merging — each registration keeps what was paid. Settle any difference from the registration editor if you want to.
                </div>
              )}
              {!preview.same_gender && (
                <div style={{ marginTop: !preview.same_fee ? 6 : 0 }}>
                  <strong>Different gender divisions</strong> ({preview.source.gender} into {preview.target.gender}). Fine if that's the plan, but double-check the bracket makes sense.
                </div>
              )}
            </div>
          )}

          <div style={{ ...panelWrap, marginBottom: 16 }}>
            <label style={fieldLabel} htmlFor="merge-name">Name of the kept event</label>
            <input
              id="merge-name"
              type="text"
              value={newName}
              onChange={(e) => setTypedName(e.target.value)}
              placeholder={target.name}
              style={{ ...inputStyle, marginBottom: 6 }}
            />
            <p style={{ fontSize: 12, color: inkSoft, margin: 0, lineHeight: 1.5 }}>
              Players see this name on the tournament page and in their emails. Something like “{source.name} / {target.name}” tells them both brackets became one.
            </p>
          </div>

          {mergeError && (
            <div style={{ ...statusPanelStyle("danger"), marginBottom: 12 }} role="alert">{mergeError}</div>
          )}

          <button
            type="button"
            style={canMerge ? ctaPrimaryStyle : ctaPrimaryDisabledStyle}
            disabled={!canMerge}
            onClick={() => setConfirming(true)}
          >
            {merging ? "Merging…" : `Merge ${source.name} into ${newName.trim() || target.name}`}
          </button>
        </>
      )}

      {confirming && source && target && preview && (
        <ConfirmModal
          title="Merge these events?"
          destructive
          body={
            <>
              Move <strong>{preview.source.registrations}</strong> registration{preview.source.registrations === 1 ? "" : "s"}
              {preview.source.waitlisted > 0 && <> and {preview.source.waitlisted} waitlisted</>} from <strong>{source.name}</strong> into{" "}
              <strong>{newName.trim() || target.name}</strong>, then remove {source.name}? This can't be undone.
            </>
          }
          confirmLabel="Merge now"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setConfirming(false);
            await merge();
          }}
        />
      )}
    </div>
  );
}

function SideCard({ title, side }: { title: string; side: Side }) {
  return (
    <div style={{ border: `1px solid ${rule}`, borderRadius: 12, padding: 16, background: cream }}>
      <div style={{ ...fieldLabel, marginBottom: 4 }}>{title}</div>
      <div style={{ fontWeight: 700, fontSize: 16 }}>{side.name}</div>
      <div style={{ fontSize: 13, color: inkSoft, marginTop: 2 }}>
        {side.format} · {side.gender} · {fmtMoney(side.fee_cents)}
      </div>
      <div style={{ borderTop: `1px solid ${ruleSoft}`, marginTop: 10, paddingTop: 10, fontSize: 14 }}>
        <strong>{side.registrations}</strong> registered
        {side.waitlisted > 0 && <> · <strong>{side.waitlisted}</strong> waitlisted</>}
        {side.max_teams != null && <span style={{ color: inkMuted }}> · cap {side.max_teams}</span>}
        {side.matches > 0 && <span style={{ color: "#b91c1c" }}> · bracket drawn</span>}
      </div>
    </div>
  );
}

function fmtMoney(cents: number): string {
  return cents === 0 ? "free" : `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

const panelWrap = {
  border: `1px solid ${rule}`,
  borderRadius: 12,
  padding: 20,
  background: "#fff",
} as const;
