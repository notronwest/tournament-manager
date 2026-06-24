import { useEffect } from "react";
import { useLocation } from "react-router-dom";

// React Router (component <Routes>) doesn't reset scroll on navigation — it
// leaves the window wherever the previous page was. So tapping into a detail
// page from mid-list lands you partway down the new page. Mount this once
// inside the Router (App) to jump to the top on every route change.
//
// Keyed on pathname ONLY: changing search params or the hash (e.g. the
// DETAILS/REGISTER tabs on a tournament page, or an in-page anchor) should NOT
// scroll to top. Scrolling the window (not a container) — the app scrolls the
// document body.
export default function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}
