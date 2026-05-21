import { Navigate, Route, Routes } from "react-router-dom";
import LoginPage from "./auth/LoginPage";
import { RequireAuth } from "./auth/RequireAuth";
import { RequireProfile } from "./auth/RequireProfile";
import AdminIndexPage from "./pages/admin/AdminIndexPage";
import AdminLayout from "./pages/admin/AdminLayout";
import AttendeesPage from "./pages/admin/AttendeesPage";
import CourtManagerPage from "./pages/admin/CourtManagerPage";
import CreateTournamentPage from "./pages/admin/CreateTournamentPage";
import EventConsolePage from "./pages/admin/EventConsolePage";
import EventFormPage from "./pages/admin/EventFormPage";
import ScorecardsPage from "./pages/admin/ScorecardsPage";
import TournamentCourtManagerPage from "./pages/admin/TournamentCourtManagerPage";
import OrgOverviewPage from "./pages/admin/OrgOverviewPage";
import ProfilePage from "./pages/public/ProfilePage";
import PublicTournamentPage from "./pages/public/PublicTournamentPage";
import RegisterPage from "./pages/public/RegisterPage";
import SchedulePage from "./pages/admin/SchedulePage";
import RoundRobinEstimatorPage from "./pages/admin/tools/RoundRobinEstimatorPage";
import SeedEventPage from "./pages/admin/tools/SeedEventPage";
import TournamentDetailPage from "./pages/admin/TournamentDetailPage";
import TournamentsListPage from "./pages/admin/TournamentsListPage";

function HomePage() {
  return (
    <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ margin: "0 0 8px" }}>Tournament Manager</h1>
      <p style={{ color: "#555" }}>
        Public tournament browsing site coming soon. Organizers can{" "}
        <a href="/admin" style={{ color: "#2563eb" }}>
          sign in
        </a>
        .
      </p>
    </main>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/login" element={<LoginPage />} />

      {/* Public tournament pages — anonymous-readable. RLS already
          restricts to status in (published, closed, completed). */}
      <Route
        path="/t/:orgSlug/:tournamentSlug"
        element={<PublicTournamentPage />}
      />
      {/* Profile — one-time setup that owns name / phone / gender /
          ratings. Auth required. Reached either via RequireProfile's
          forced redirect (when the user has no name on file) or
          manually via an "Edit profile" link. The ?return= param
          governs where to send them next. */}
      <Route
        path="/profile"
        element={
          <RequireAuth>
            <ProfilePage />
          </RequireAuth>
        }
      />
      {/* Registration — auth required + profile required. RequireAuth
          bounces unauthenticated visitors to /login; RequireProfile
          bounces anyone without a complete player profile to /profile.
          Both route the user back here when they're done. */}
      <Route
        path="/t/:orgSlug/:tournamentSlug/register"
        element={
          <RequireAuth>
            <RequireProfile>
              <RegisterPage />
            </RequireProfile>
          </RequireAuth>
        }
      />

      {/* /admin → org picker (or auto-redirect if user has only one org) */}
      <Route
        path="/admin"
        element={
          <RequireAuth>
            <AdminIndexPage />
          </RequireAuth>
        }
      />

      {/* /admin/:orgSlug/* → org-scoped admin section, layout w/ sidebar */}
      <Route
        path="/admin/:orgSlug"
        element={
          <RequireAuth>
            <AdminLayout />
          </RequireAuth>
        }
      >
        <Route index element={<OrgOverviewPage />} />
        <Route
          path="tools/round-robin"
          element={<RoundRobinEstimatorPage />}
        />
        <Route
          path="tools/seed-event"
          element={<SeedEventPage />}
        />
        <Route path="tournaments" element={<TournamentsListPage />} />
        <Route path="tournaments/new" element={<CreateTournamentPage />} />
        <Route
          path="tournaments/:tournamentSlug"
          element={<TournamentDetailPage />}
        />
        <Route
          path="tournaments/:tournamentSlug/courts"
          element={<TournamentCourtManagerPage />}
        />
        <Route
          path="tournaments/:tournamentSlug/attendees"
          element={<AttendeesPage />}
        />
        <Route
          path="tournaments/:tournamentSlug/schedule"
          element={<SchedulePage />}
        />
        <Route
          path="tournaments/:tournamentSlug/events/new"
          element={<EventFormPage mode="create" />}
        />
        <Route
          path="tournaments/:tournamentSlug/events/:eventId"
          element={<EventConsolePage />}
        />
        <Route
          path="tournaments/:tournamentSlug/events/:eventId/edit"
          element={<EventFormPage mode="edit" />}
        />
        <Route
          path="tournaments/:tournamentSlug/events/:eventId/courts"
          element={<CourtManagerPage />}
        />
        <Route
          path="tournaments/:tournamentSlug/events/:eventId/scorecards"
          element={<ScorecardsPage />}
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
