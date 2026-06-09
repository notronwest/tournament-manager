import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AuthError, Session, User } from "@supabase/supabase-js";
import { supabase } from "../supabase";

type AuthContextValue = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signInWithPassword: (
    email: string,
    password: string,
  ) => Promise<{ error: AuthError | null }>;
  signUpWithPassword: (
    email: string,
    password: string,
    redirectTo?: string,
  ) => Promise<{ error: AuthError | null }>;
  signInWithMagicLink: (
    email: string,
    redirectTo?: string,
  ) => Promise<{ error: AuthError | null }>;
  signInWithGoogle: (
    redirectTo?: string,
  ) => Promise<{ error: AuthError | null }>;
  updatePassword: (
    password: string,
  ) => Promise<{ error: AuthError | null }>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

// Default landing page after a successful magic-link or OAuth round-trip.
// Callers can override per call — e.g. the public registration flow passes
// the tournament URL so the user lands back where they started instead of
// being dumped at /admin.
function defaultRedirectTo(): string {
  return `${window.location.origin}/admin`;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const user = session?.user ?? null;

  useEffect(() => {
    // Restore session on mount.
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    // Subscribe to changes — sign-in, sign-out, token refresh, etc.
    const { data } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  // Silent email backfill (issue #157). Every auth path gives us a verified
  // `user.email` — Google's OAuth returns it by default, and magic-link /
  // password both require one. But a *player* row can lack an email (admin-
  // pre-created rows, or the auth-linked update path that never wrote one),
  // which silently breaks receipts and partner-cancellation notices — those
  // read `players.email` (see supabase/functions/send-partner-cancellation).
  // So when the signed-in user's own linked row has no email, copy in their
  // session email. This is deliberately client-side, not a DB trigger: RLS
  // confines the update to the user's own row (auth_user_id = auth.uid()) and
  // we only ever write their own session email, so there's no way to fill in
  // someone else's address. (A SECURITY DEFINER trigger reading auth.users
  // would be an email-harvest vector given the open insert policy + publicly
  // readable players table.) Best-effort and silent — never blocks the user.
  const backfilledForRef = useRef<string | null>(null);
  useEffect(() => {
    const uid = user?.id;
    const email = user?.email;
    if (!uid || !email) return;
    if (backfilledForRef.current === uid) return; // once per signed-in user
    backfilledForRef.current = uid;

    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("players")
        .select("id, email")
        .eq("auth_user_id", uid)
        .is("deleted_at", null);
      // Only act on an unambiguous single linked row that's missing an email.
      if (cancelled || error || !data || data.length !== 1) return;
      const row = data[0];
      if (row.email && row.email.trim()) return;
      // `.is("email", null)` makes the write race-safe: if another path filled
      // the email between our read and write, this no-ops instead of clobbering.
      await supabase
        .from("players")
        .update({ email })
        .eq("id", row.id)
        .is("email", null);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.email]);

  const signInWithPassword = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    return { error };
  };

  const signUpWithPassword = async (
    email: string,
    password: string,
    redirectTo?: string,
  ) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: redirectTo ?? defaultRedirectTo() },
    });
    return { error };
  };

  const signInWithMagicLink = async (email: string, redirectTo?: string) => {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo ?? defaultRedirectTo() },
    });
    return { error };
  };

  const signInWithGoogle = async (redirectTo?: string) => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: redirectTo ?? defaultRedirectTo() },
    });
    return { error };
  };

  // Lets the user set (or change) their password from inside the app —
  // primarily used from the first-fill ProfilePage so a magic-link
  // signup can opt into a password while they're already filling out
  // their profile. They have to be signed in for this to succeed; the
  // Supabase SDK uses the active session under the hood.
  const updatePassword = async (password: string) => {
    const { error } = await supabase.auth.updateUser({ password });
    return { error };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        signInWithPassword,
        signUpWithPassword,
        signInWithMagicLink,
        signInWithGoogle,
        updatePassword,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
