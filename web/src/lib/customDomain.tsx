import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "../supabase";

// Custom-domain routing (#408). When the app is served on an organizer's
// own hostname (e.g. pickleballangels.com) rather than a canonical host,
// we resolve that host to the tournament it maps to (custom_domains table)
// and render that tournament at the site root. Everything else (other
// paths, auth, etc.) works exactly the same on the custom host — only "/"
// is special-cased.

type State =
  | { status: "canonical" }
  | { status: "loading" }
  | { status: "resolved"; orgSlug: string; tournamentSlug: string }
  | { status: "notfound" };

const CustomDomainContext = createContext<State>({ status: "canonical" });

// eslint-disable-next-line react-refresh/only-export-components
export function useCustomDomain(): State {
  return useContext(CustomDomainContext);
}

// Hosts that serve the normal app. Anything else is a candidate custom
// domain and gets looked up in custom_domains.
// eslint-disable-next-line react-refresh/only-export-components
export function isCanonicalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (!h || h === "localhost" || h === "127.0.0.1") return true;
  if (h.endsWith(".pages.dev")) return true;
  if (h === "bertanderne.com" || h.endsWith(".bertanderne.com")) return true;
  return false;
}

export function CustomDomainProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(() =>
    isCanonicalHost(window.location.hostname)
      ? { status: "canonical" }
      : { status: "loading" },
  );

  useEffect(() => {
    if (state.status !== "loading") return;
    let cancelled = false;
    void (async () => {
      const host = window.location.hostname.toLowerCase();
      const { data, error } = await supabase
        .from("custom_domains")
        .select("tournaments(slug, organizations(slug))")
        .eq("host", host)
        .maybeSingle();
      if (cancelled) return;
      // Nested join shape: { tournaments: { slug, organizations: { slug } } }
      const t = (data as { tournaments?: { slug?: string; organizations?: { slug?: string } } } | null)
        ?.tournaments;
      const orgSlug = t?.organizations?.slug;
      const tournamentSlug = t?.slug;
      if (error || !orgSlug || !tournamentSlug) {
        setState({ status: "notfound" });
      } else {
        setState({ status: "resolved", orgSlug, tournamentSlug });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.status]);

  return (
    <CustomDomainContext.Provider value={state}>
      {children}
    </CustomDomainContext.Provider>
  );
}
