import {
  createContext,
  useContext,
  useEffect,
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
  resetPasswordForEmail: (
    email: string,
    redirectTo: string,
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
  // Kept as a separate state so its reference only changes when the user's
  // identity changes. TOKEN_REFRESHED hands back a new session object with
  // the same user.id, and without this the new reference would invalidate
  // every [user] dependency array in the ~13 consumers, causing an app-wide
  // data refetch every time the tab regains focus.
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Restore session on mount.
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setLoading(false);
    });

    // Subscribe to changes — sign-in, sign-out, token refresh, etc.
    const { data } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      // Only swap the user ref when the identity actually changes so that a
      // background TOKEN_REFRESHED doesn't trigger downstream effect re-runs.
      setUser((prev) => {
        const next = newSession?.user ?? null;
        return prev?.id === next?.id ? prev : next;
      });
    });

    return () => data.subscription.unsubscribe();
  }, []);

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

  const resetPasswordForEmail = async (email: string, redirectTo: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
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
        resetPasswordForEmail,
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
