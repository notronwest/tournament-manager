import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "../supabase";
import { useAuth } from "../auth/AuthProvider";
import { computeLineItems } from "../lib/pricing";
import { pickActivePricingTier, type PricingTier } from "../lib/pricingTiers";
import type { Database } from "../types/supabase";

// Aggregated view of the signed-in user's pending_payment
// registrations, grouped by tournament. The site-wide
// PendingPaymentsBar renders from this; pages that mutate the
// pending set (e.g. inline-register on the tournament page) call
// refresh() so the bar reflects the change immediately.
export type PendingTournamentGroup = {
  tournamentId: string;
  tournamentName: string;
  tournamentSlug: string;
  orgSlug: string;
  // Total cents the user would owe at checkout, computed across
  // their entire pending basket for this tournament using D's
  // first / additional / override tier math.
  totalCents: number;
  events: {
    eventId: string;
    eventName: string;
    cents: number;
    tier: "first" | "additional" | "override";
  }[];
};

type PendingPaymentsContextValue = {
  // null until first load completes; [] once loaded with zero
  // results. Components can treat "groups === null" as "show
  // nothing yet" (so the bar doesn't flash empty during init).
  groups: PendingTournamentGroup[] | null;
  refresh: () => Promise<void>;
};

const PendingPaymentsContext =
  createContext<PendingPaymentsContextValue | null>(null);

export function PendingPaymentsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { user } = useAuth();
  const [groups, setGroups] = useState<PendingTournamentGroup[] | null>(
    null,
  );

  const refresh = useCallback(async () => {
    if (!user) {
      setGroups([]);
      return;
    }

    // Find the user's player record. Bail out cleanly if they
    // haven't set up a profile yet (fresh signup) — no pending
    // possible in that case.
    const { data: me } = await supabase
      .from("players")
      .select("id")
      .eq("auth_user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!me) {
      setGroups([]);
      return;
    }

    // Pull every pending_payment registration with enough joined
    // context to render the bar + group by tournament. We fetch the
    // event + tournament + its pricing tiers alongside the reg, so
    // the bar can price the basket against the currently-active tier
    // (what the player will actually owe at checkout).
    const { data, error } = await supabase
      .from("event_registrations")
      .select(
        `id, event_id,
         event:events!event_id (
           id, name, event_fee_cents,
           tournament:tournaments!tournament_id (
             id, name, slug,
             organization:organizations!organization_id (slug),
             pricing_tiers:tournament_pricing_tiers (
               id, sort_order, label, starts_at, ends_at,
               first_event_fee_cents, additional_event_fee_cents,
               tournament_id, created_at, updated_at
             )
           )
         )`,
      )
      .eq("player_id", me.id)
      .eq("status", "pending_payment")
      .is("deleted_at", null);
    if (error || !data) {
      setGroups([]);
      return;
    }

    // Drill into the join. Supabase typegen makes these to-one
    // relations technically nullable; we cast through unknown.
    type Row = {
      id: string;
      event_id: string;
      event: {
        id: string;
        name: string;
        event_fee_cents: number;
        tournament: {
          id: string;
          name: string;
          slug: string;
          organization: { slug: string } | null;
          pricing_tiers: PricingTier[] | null;
        } | null;
      } | null;
    };
    const rows = data as unknown as Row[];

    // Group rows by tournament id. For each tournament group, run
    // D's pricing helper across that tournament's pending events to
    // get per-event cents + total. Fees come from the tournament's
    // currently-active pricing tier.
    const byTournament = new Map<
      string,
      {
        tournamentId: string;
        tournamentName: string;
        tournamentSlug: string;
        orgSlug: string;
        entryFeeCents: number;
        additionalEventFeeCents: number;
        events: { id: string; name: string; event_fee_cents: number }[];
      }
    >();
    for (const r of rows) {
      const ev = r.event;
      const t = ev?.tournament;
      const org = t?.organization;
      if (!ev || !t || !org) continue;
      let g = byTournament.get(t.id);
      if (!g) {
        const activeTier = pickActivePricingTier(t.pricing_tiers ?? []);
        g = {
          tournamentId: t.id,
          tournamentName: t.name,
          tournamentSlug: t.slug,
          orgSlug: org.slug,
          entryFeeCents: activeTier?.first_event_fee_cents ?? 0,
          additionalEventFeeCents: activeTier?.additional_event_fee_cents ?? 0,
          events: [],
        };
        byTournament.set(t.id, g);
      }
      g.events.push({
        id: ev.id,
        name: ev.name,
        event_fee_cents: ev.event_fee_cents,
      });
    }

    const out: PendingTournamentGroup[] = [];
    for (const g of byTournament.values()) {
      const { items, totalCents } = computeLineItems(g.events, {
        firstEventFeeCents: g.entryFeeCents,
        additionalEventFeeCents: g.additionalEventFeeCents,
      });
      out.push({
        tournamentId: g.tournamentId,
        tournamentName: g.tournamentName,
        tournamentSlug: g.tournamentSlug,
        orgSlug: g.orgSlug,
        totalCents,
        events: items.map((it) => ({
          eventId: it.event.id,
          eventName:
            g.events.find((e) => e.id === it.event.id)?.name ??
            "Event",
          cents: it.cents,
          tier: it.tier,
        })),
      });
    }
    // Stable sort by tournament name so the bar's order doesn't
    // shuffle every refetch.
    out.sort((a, b) => a.tournamentName.localeCompare(b.tournamentName));
    setGroups(out);
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <PendingPaymentsContext.Provider value={{ groups, refresh }}>
      {children}
    </PendingPaymentsContext.Provider>
  );
}

export function usePendingPayments(): PendingPaymentsContextValue {
  const ctx = useContext(PendingPaymentsContext);
  if (!ctx) {
    throw new Error(
      "usePendingPayments must be used inside <PendingPaymentsProvider>",
    );
  }
  return ctx;
}

// Convenience type re-export for callers building Line-item-shaped data.
export type { Database };
