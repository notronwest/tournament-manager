import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../supabase";

// Delivery history for contact-list emails. The contact_broadcasts /
// contact_broadcast_recipients tables aren't in the generated `Database` types
// until the migration reaches the linked project + types regen, so the client
// is cast to an untyped SupabaseClient here (mirrors lib/orgContacts).
// RLS restricts reads to org members, so no extra guard is needed.
const untyped = supabase as unknown as SupabaseClient;

export type BroadcastCounts = {
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
};

export type BroadcastSummary = {
  id: string;
  subject: string;
  sentAt: string;
  recipientCount: number;
  counts: BroadcastCounts;
};

export type BroadcastRecipient = {
  id: string;
  email: string;
  status: string;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  bouncedAt: string | null;
  complainedAt: string | null;
  unsubscribedAt: string | null;
};

// One row per send, newest first, with delivery counts aggregated from the
// per-recipient event timestamps (race-free — no rollup columns).
export async function fetchBroadcasts(orgId: string): Promise<BroadcastSummary[]> {
  const { data: bcs, error } = await untyped
    .from("contact_broadcasts")
    .select("id, subject, sent_at, recipient_count")
    .eq("organization_id", orgId)
    .order("sent_at", { ascending: false });
  if (error) throw new Error(error.message);
  const broadcasts = (bcs ?? []) as {
    id: string;
    subject: string;
    sent_at: string;
    recipient_count: number;
  }[];
  if (broadcasts.length === 0) return [];

  const ids = broadcasts.map((b) => b.id);
  const { data: recs, error: rErr } = await untyped
    .from("contact_broadcast_recipients")
    .select(
      "broadcast_id, delivered_at, opened_at, clicked_at, bounced_at, complained_at, unsubscribed_at",
    )
    .in("broadcast_id", ids);
  if (rErr) throw new Error(rErr.message);
  const rows = (recs ?? []) as Record<string, string | null>[];

  const byId = new Map<string, BroadcastCounts>();
  for (const b of broadcasts) {
    byId.set(b.id, {
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      complained: 0,
      unsubscribed: 0,
    });
  }
  for (const r of rows) {
    const c = byId.get(r.broadcast_id as string);
    if (!c) continue;
    if (r.delivered_at) c.delivered++;
    if (r.opened_at) c.opened++;
    if (r.clicked_at) c.clicked++;
    if (r.bounced_at) c.bounced++;
    if (r.complained_at) c.complained++;
    if (r.unsubscribed_at) c.unsubscribed++;
  }

  return broadcasts.map((b) => ({
    id: b.id,
    subject: b.subject,
    sentAt: b.sent_at,
    recipientCount: b.recipient_count,
    counts: byId.get(b.id) ?? {
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      complained: 0,
      unsubscribed: 0,
    },
  }));
}

// Per-recipient rows for one send (drill-down).
export async function fetchBroadcastRecipients(
  broadcastId: string,
): Promise<BroadcastRecipient[]> {
  const { data, error } = await untyped
    .from("contact_broadcast_recipients")
    .select(
      "id, email, status, delivered_at, opened_at, clicked_at, bounced_at, complained_at, unsubscribed_at",
    )
    .eq("broadcast_id", broadcastId)
    .order("email", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, string | null>[]).map((r) => ({
    id: r.id as string,
    email: r.email as string,
    status: (r.status as string) ?? "sent",
    deliveredAt: r.delivered_at ?? null,
    openedAt: r.opened_at ?? null,
    clickedAt: r.clicked_at ?? null,
    bouncedAt: r.bounced_at ?? null,
    complainedAt: r.complained_at ?? null,
    unsubscribedAt: r.unsubscribed_at ?? null,
  }));
}
