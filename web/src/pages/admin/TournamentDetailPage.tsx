import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];

// Placeholder detail page. Next milestone: edit tournament metadata,
// add/list events, view roster + registrations.
export default function TournamentDetailPage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();
  const [t, setT] = useState<Tournament | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!org || !tournamentSlug) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("tournaments")
        .select("*")
        .eq("organization_id", org.id)
        .eq("slug", tournamentSlug)
        .is("deleted_at", null)
        .maybeSingle();

      if (cancelled) return;
      if (error) {
        setError(error.message);
        return;
      }
      setT(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [org, tournamentSlug]);

  if (!org) return null;
  if (error) {
    return (
      <div style={{ color: "#991b1b", fontSize: 14 }}>{error}</div>
    );
  }
  if (!t) {
    return <div style={{ color: "#666", fontSize: 14 }}>Loading…</div>;
  }

  return (
    <div>
      <Link
        to={`/admin/${org.slug}/tournaments`}
        style={{
          color: "#2563eb",
          textDecoration: "none",
          fontSize: 13,
        }}
      >
        ← Tournaments
      </Link>
      <h1 style={{ margin: "12px 0 4px", fontSize: 22 }}>{t.name}</h1>
      <p style={{ color: "#666", margin: 0, fontSize: 14 }}>
        {t.description || "No description."}
      </p>

      <dl
        style={{
          marginTop: 24,
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          rowGap: 8,
          columnGap: 16,
          fontSize: 14,
          maxWidth: 600,
        }}
      >
        <DtDd label="Status" value={t.status} />
        <DtDd
          label="Starts"
          value={new Date(t.starts_at).toLocaleString()}
        />
        <DtDd label="Ends" value={new Date(t.ends_at).toLocaleString()} />
        <DtDd
          label="Registration opens"
          value={
            t.registration_opens_at
              ? new Date(t.registration_opens_at).toLocaleString()
              : "—"
          }
        />
        <DtDd
          label="Registration closes"
          value={
            t.registration_closes_at
              ? new Date(t.registration_closes_at).toLocaleString()
              : "—"
          }
        />
        <DtDd
          label="Entry fee"
          value={`$${(t.entry_fee_cents / 100).toFixed(2)}`}
        />
        <DtDd label="Location" value={t.location_name || "—"} />
        <DtDd label="Address" value={t.location_address || "—"} />
      </dl>

      <p
        style={{
          marginTop: 32,
          padding: 16,
          background: "#fafafa",
          border: "1px dashed #d1d5db",
          borderRadius: 6,
          color: "#666",
          fontSize: 13,
        }}
      >
        Events, registrations, and bracket management land in the next
        milestone.
      </p>
    </div>
  );
}

function DtDd({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt style={{ color: "#888", fontSize: 13 }}>{label}</dt>
      <dd style={{ margin: 0 }}>{value}</dd>
    </>
  );
}
