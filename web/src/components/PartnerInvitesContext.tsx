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

export type PendingPartnerInvite = {
  eventId: string;
  eventName: string;
  tournamentSlug: string;
  orgSlug: string;
  inviterName: string;
  token: string;
};

type PartnerInvitesContextValue = {
  // null until first load; [] once loaded with zero results.
  invites: PendingPartnerInvite[] | null;
  refresh: () => Promise<void>;
};

const PartnerInvitesContext =
  createContext<PartnerInvitesContextValue | null>(null);

export function PartnerInvitesProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { user } = useAuth();
  const [invites, setInvites] = useState<PendingPartnerInvite[] | null>(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setInvites([]);
      return;
    }

    const { data: me } = await supabase
      .from("players")
      .select("id")
      .eq("auth_user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!me) {
      setInvites([]);
      return;
    }

    type Row = {
      event_id: string;
      token: string;
      event: {
        name: string;
        tournament: {
          slug: string;
          organization: { slug: string } | null;
        } | null;
      } | null;
      inviter: { first_name: string; last_name: string } | null;
    };

    const { data, error } = await supabase
      .from("partner_invites")
      .select(
        `event_id, token,
         event:events!event_id (
           name,
           tournament:tournaments!tournament_id (
             slug,
             organization:organizations!organization_id (slug)
           )
         ),
         inviter:players!inviter_player_id (first_name, last_name)`,
      )
      .eq("invitee_player_id", me.id)
      .eq("status", "pending");

    if (error || !data) {
      setInvites([]);
      return;
    }

    const rows = data as unknown as Row[];
    const out: PendingPartnerInvite[] = [];
    for (const r of rows) {
      const ev = r.event;
      const tournament = ev?.tournament;
      const org = tournament?.organization;
      if (!ev || !tournament || !org) continue;
      out.push({
        eventId: r.event_id,
        eventName: ev.name,
        tournamentSlug: tournament.slug,
        orgSlug: org.slug,
        inviterName: r.inviter
          ? `${r.inviter.first_name} ${r.inviter.last_name}`
          : "Someone",
        token: r.token,
      });
    }
    setInvites(out);
  }, [user]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  return (
    <PartnerInvitesContext.Provider value={{ invites, refresh }}>
      {children}
    </PartnerInvitesContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePartnerInvites(): PartnerInvitesContextValue {
  const ctx = useContext(PartnerInvitesContext);
  if (!ctx) {
    throw new Error(
      "usePartnerInvites must be used inside <PartnerInvitesProvider>",
    );
  }
  return ctx;
}
