import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { usePlatformAdmin } from "../../hooks/usePlatformAdmin";
import { ConfirmModal } from "../../components/ConfirmModal";
import {
  ink,
  inkSoft,
  inkMuted,
  courtRed,
  dangerBg,
  dangerFg,
  bodyFontStack,
  monoFontStack,
  pageH1Style,
  inputStyle,
} from "../../lib/publicTheme";

// Platform-admin-only "danger zone" for an organization. Today it
// holds a single action: delete (soft-delete) the whole org.
//
// Deleting goes through the delete-organization edge function
// (service_role) so the platform-admin check is enforced server-side
// — the client gate here is purely cosmetic. The function soft-
// deletes the org and cascades deleted_at to its tournaments.
export default function OrgDangerZonePage() {
  const { org, loading, error } = useCurrentOrg();
  const isPlatformAdmin = usePlatformAdmin();
  const navigate = useNavigate();

  const [tournamentCount, setTournamentCount] = useState<number | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Count the active tournaments that this delete will hide, so the
  // warning can be specific about the blast radius.
  useEffect(() => {
    if (!org) return;
    let cancelled = false;
    (async () => {
      const { count } = await supabase
        .from("tournaments")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id)
        .is("deleted_at", null);
      if (!cancelled) setTournamentCount(count ?? 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [org]);

  if (loading || isPlatformAdmin === null) {
    return (
      <div style={{ color: inkMuted, fontSize: 14, fontFamily: bodyFontStack }}>
        Loading…
      </div>
    );
  }

  if (error || !org) {
    return (
      <div style={{ color: dangerFg, fontSize: 14, fontFamily: bodyFontStack }}>
        {error ?? "Organization not found."}
      </div>
    );
  }

  // Hard client gate: only platform admins may delete an org. The
  // edge function re-checks, so this is just UX.
  if (isPlatformAdmin !== true) {
    return (
      <div style={{ maxWidth: 640, fontFamily: bodyFontStack }}>
        <h1 style={{ ...pageH1Style, marginTop: 0 }}>Danger zone</h1>
        <p style={{ color: inkSoft, fontSize: 14, lineHeight: 1.55 }}>
          Only platform admins can delete an organization. If you need this
          org removed, contact a platform admin.
        </p>
      </div>
    );
  }

  const nameMatches = confirmText.trim() === org.name;

  const executeDelete = async () => {
    setActionError(null);
    const { data, error: fnErr } = await supabase.functions.invoke(
      "delete-organization",
      { body: { organizationId: org.id } },
    );

    if (fnErr) {
      // functions.invoke surfaces non-2xx as a FunctionsError; the
      // JSON body sits on fnErr.context (a Response).
      let message = fnErr.message;
      try {
        const ctx = (fnErr as unknown as { context?: Response }).context;
        if (ctx) {
          const b = (await ctx.json()) as { error?: string };
          if (b.error) message = b.error;
        }
      } catch {
        /* fall through */
      }
      setActionError(message);
      setShowModal(false);
      return;
    }
    if (!data?.ok) {
      setActionError((data as { error?: string })?.error ?? "Failed to delete.");
      setShowModal(false);
      return;
    }
    // Org is gone — bounce back to the picker (it's no longer
    // reachable; useCurrentOrg would 404 on a refetch).
    navigate("/admin", { replace: true });
  };

  return (
    <div style={{ maxWidth: 640, fontFamily: bodyFontStack }}>
      <h1 style={{ ...pageH1Style, marginTop: 0 }}>Danger zone</h1>

      <div
        style={{
          marginTop: 14,
          padding: 20,
          background: "#fff",
          border: `1px solid ${courtRed}`,
          borderRadius: 8,
        }}
      >
        <h2
          style={{
            margin: "0 0 6px",
            fontSize: 17,
            color: ink,
          }}
        >
          Delete this organization
        </h2>
        <p style={{ margin: 0, color: inkSoft, fontSize: 14, lineHeight: 1.55 }}>
          This removes <strong>{org.name}</strong> from all admin views and
          hides it from the public site.
          {tournamentCount === null
            ? ""
            : tournamentCount > 0
              ? ` Its ${tournamentCount} tournament${tournamentCount === 1 ? "" : "s"} will also be hidden, so their public registration pages stop serving.`
              : " It has no tournaments to hide."}
        </p>
        <p
          style={{
            margin: "10px 0 0",
            color: inkMuted,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          This is a soft delete — the data is retained and a platform admin can
          restore it directly in the database if needed. No registrations or
          payment records are erased.
        </p>

        <label
          style={{
            display: "block",
            marginTop: 18,
            fontSize: 13,
            color: inkSoft,
          }}
        >
          Type the organization name{" "}
          <span style={{ fontFamily: monoFontStack, color: ink }}>
            {org.name}
          </span>{" "}
          to confirm:
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={org.name}
            autoComplete="off"
            style={{ ...inputStyle, marginTop: 6, maxWidth: 360 }}
          />
        </label>

        {actionError && (
          <div
            style={{
              marginTop: 14,
              padding: "10px 12px",
              background: dangerBg,
              border: `1px solid ${courtRed}`,
              borderRadius: 6,
              color: dangerFg,
              fontSize: 13,
            }}
          >
            {actionError}
          </div>
        )}

        <button
          type="button"
          disabled={!nameMatches}
          onClick={() => setShowModal(true)}
          style={{
            marginTop: 16,
            padding: "10px 18px",
            background: nameMatches ? courtRed : "#e2e2e2",
            color: nameMatches ? "#fff" : "#999",
            border: "none",
            borderRadius: 6,
            fontSize: 14,
            fontWeight: 600,
            cursor: nameMatches ? "pointer" : "not-allowed",
            fontFamily: bodyFontStack,
          }}
        >
          Delete organization
        </button>
      </div>

      {showModal && (
        <ConfirmModal
          title={`Delete ${org.name}?`}
          body={
            <>
              This hides the organization and
              {tournamentCount && tournamentCount > 0
                ? ` its ${tournamentCount} tournament${tournamentCount === 1 ? "" : "s"}`
                : " all of its data"}{" "}
              from everyone. It's reversible by a platform admin in the
              database, but there's no in-app undo.
            </>
          }
          confirmLabel="Delete organization"
          onCancel={() => setShowModal(false)}
          onConfirm={executeDelete}
        />
      )}
    </div>
  );
}
