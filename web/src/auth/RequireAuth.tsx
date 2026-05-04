import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";

// Wrap any route that requires a logged-in user. Unauthenticated visitors
// are bounced to /login with the original destination tucked into router
// state so we can return them after sign-in.
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ padding: 24, color: "#666", fontSize: 14 }}>Loading…</div>
    );
  }

  if (!session) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
