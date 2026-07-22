import type { ReactNode } from "react";
import { Navigate, useParams } from "react-router-dom";
import { usePlatformAdmin } from "../hooks/usePlatformAdmin";

// Route guard for platform-admin-only surfaces (dev/test tools). Org admins are
// bounced to their org overview rather than seeing the page. While the check
// resolves (null), render nothing to avoid a flash of the guarded page.
export function RequirePlatformAdmin({ children }: { children: ReactNode }) {
  const isPlatformAdmin = usePlatformAdmin();
  const { orgSlug } = useParams<{ orgSlug: string }>();

  if (isPlatformAdmin === null) return null;
  if (isPlatformAdmin !== true) {
    return <Navigate to={orgSlug ? `/admin/${orgSlug}` : "/admin"} replace />;
  }
  return <>{children}</>;
}
