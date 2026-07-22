import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import {
  fetchBroadcasts,
  fetchBroadcastRecipients,
  type BroadcastSummary,
  type BroadcastRecipient,
} from "../../lib/contactBroadcasts";
import {
  ink,
  inkSoft,
  inkMuted,
  cream,
  rule,
  ruleSoft,
  courtGreen,
  courtBlue,
  courtRed,
  bodyFontStack,
  headingFontStack,
  displayFontStack,
  statusPanelStyle,
  breadcrumbLinkStyle,
} from "../../lib/publicTheme";

// Email history / delivery status for a club's contact-list emails. Counts are
// aggregated from per-recipient event timestamps (see lib/contactBroadcasts).
export default function ContactEmailsPage() {
  const { org } = useCurrentOrg();
  const [broadcasts, setBroadcasts] = useState<BroadcastSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!org) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchBroadcasts(org.id);
        if (cancelled) return;
        setBroadcasts(data);
        setLoadError(null);
      } catch (e) {
        if (cancelled) return;
        setLoadError((e as { message?: string })?.message ?? "Could not load email history.");
        setBroadcasts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org]);

  if (!org) return null;

  return (
    <div style={{ fontFamily: bodyFontStack, color: ink }}>
      <Link to={`/admin/${org.slug}/contacts`} style={{ ...breadcrumbLinkStyle, display: "inline-block", marginBottom: 8 }}>
        ← Contacts
      </Link>
      <h1 style={displayHeading}>Email history</h1>
      <p style={{ color: inkSoft, fontSize: 15, margin: "0 0 20px", maxWidth: 620, lineHeight: 1.55 }}>
        Every email you've sent to your contact list, with delivery status —
        delivered, opened, clicked, bounced, and unsubscribes.
      </p>

      {loadError && (
        <div style={{ ...statusPanelStyle("danger"), marginBottom: 16 }} role="alert">
          {loadError}
        </div>
      )}

      {broadcasts === null ? (
        <div style={{ color: inkMuted }}>Loading…</div>
      ) : broadcasts.length === 0 ? (
        <div
          style={{
            border: `1px dashed ${rule}`,
            borderRadius: 10,
            padding: 28,
            textAlign: "center",
            color: inkMuted,
            background: cream,
          }}
        >
          No emails sent yet. Head to <Link to={`/admin/${org.slug}/contacts`} style={breadcrumbLinkStyle}>Contacts</Link> to send your first one.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {broadcasts.map((b) => (
            <SendCard
              key={b.id}
              broadcast={b}
              open={openId === b.id}
              onToggle={() => setOpenId(openId === b.id ? null : b.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SendCard({
  broadcast,
  open,
  onToggle,
}: {
  broadcast: BroadcastSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const c = broadcast.counts;
  const sent = broadcast.recipientCount;
  return (
    <div style={{ border: `1px solid ${rule}`, borderRadius: 10, overflow: "hidden" }}>
      <button
        onClick={onToggle}
        style={{
          width: "100%",
          textAlign: "left",
          background: cream,
          border: "none",
          cursor: "pointer",
          padding: "14px 16px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          fontFamily: bodyFontStack,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: ink }}>{broadcast.subject}</div>
          <div style={{ fontSize: 12, color: inkMuted, marginTop: 2 }}>
            {fmtDateTime(broadcast.sentAt)} · {sent} recipient{sent === 1 ? "" : "s"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <Stat label="Delivered" value={c.delivered} total={sent} color={courtGreen} />
          <Stat label="Opened" value={c.opened} total={sent} color={courtBlue} />
          <Stat label="Clicked" value={c.clicked} total={sent} color={courtBlue} />
          {c.bounced > 0 && <Stat label="Bounced" value={c.bounced} total={sent} color={courtRed} />}
          {c.complained > 0 && <Stat label="Spam" value={c.complained} total={sent} color={courtRed} />}
          {c.unsubscribed > 0 && <Stat label="Unsub" value={c.unsubscribed} total={sent} color={inkMuted} />}
          <span style={{ color: inkMuted, fontSize: 13, marginLeft: 4 }}>{open ? "▲" : "▼"}</span>
        </div>
      </button>
      {open && <RecipientList broadcastId={broadcast.id} />}
    </div>
  );
}

function Stat({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <span
      title={`${value} of ${total} (${pct}%)`}
      style={{
        display: "inline-flex",
        gap: 5,
        alignItems: "baseline",
        fontSize: 12,
        padding: "3px 8px",
        borderRadius: 999,
        background: "#fff",
        border: `1px solid ${ruleSoft}`,
      }}
    >
      <strong style={{ color }}>{value}</strong>
      <span style={{ color: inkSoft }}>{label}</span>
    </span>
  );
}

function RecipientList({ broadcastId }: { broadcastId: string }) {
  const [rows, setRows] = useState<BroadcastRecipient[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchBroadcastRecipients(broadcastId);
        if (!cancelled) setRows(data);
      } catch (e) {
        if (!cancelled) setErr((e as { message?: string })?.message ?? "Could not load recipients.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [broadcastId]);

  if (err) return <div style={{ ...statusPanelStyle("danger"), margin: 12 }}>{err}</div>;
  if (rows === null) return <div style={{ padding: 14, color: inkMuted, fontSize: 13 }}>Loading recipients…</div>;

  return (
    <div style={{ overflowX: "auto", borderTop: `1px solid ${ruleSoft}` }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 460 }}>
        <thead>
          <tr style={{ background: "#fff" }}>
            <th style={thStyle}>Email</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Last event</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderTop: `1px solid ${ruleSoft}` }}>
              <td style={tdStyle}>{r.email}</td>
              <td style={tdStyle}>
                <StatusPill status={r.unsubscribedAt ? "unsubscribed" : r.status} />
              </td>
              <td style={{ ...tdStyle, color: inkMuted }}>
                {fmtDateTime(
                  r.clickedAt ?? r.openedAt ?? r.deliveredAt ?? r.bouncedAt ?? r.complainedAt ?? r.unsubscribedAt,
                ) || "—"}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td style={{ ...tdStyle, color: inkMuted }} colSpan={3}>
                No recipient records for this send.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    sent: { bg: "#f1f3f4", fg: inkSoft, label: "Sent" },
    delivery_delayed: { bg: "#fff7e6", fg: "#8a6d1a", label: "Delayed" },
    delivered: { bg: "#e8f5ea", fg: "#2c7a3d", label: "Delivered" },
    opened: { bg: "#e7f0fb", fg: "#1e5fb0", label: "Opened" },
    clicked: { bg: "#e7f0fb", fg: "#1e5fb0", label: "Clicked" },
    bounced: { bg: "#fdeaea", fg: "#b3352c", label: "Bounced" },
    complained: { bg: "#fdeaea", fg: "#b3352c", label: "Spam" },
    unsubscribed: { bg: "#f1f3f4", fg: inkMuted, label: "Unsubscribed" },
  };
  const s = map[status] ?? map.sent;
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: s.bg, color: s.fg }}>
      {s.label}
    </span>
  );
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const displayHeading: CSSProperties = {
  fontFamily: displayFontStack,
  fontSize: 26,
  margin: "0 0 6px",
  color: ink,
};
const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  fontSize: 11,
  fontWeight: 700,
  color: inkSoft,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  fontFamily: headingFontStack,
};
const tdStyle: CSSProperties = { padding: "8px 12px", color: ink };
