import { Navigate, Route, Routes } from "react-router-dom";
import LoginPage from "./auth/LoginPage";
import { RequireAuth } from "./auth/RequireAuth";
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
import SchedulePage from "./pages/admin/SchedulePage";
import RoundRobinEstimatorPage from "./pages/admin/tools/RoundRobinEstimatorPage";
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
