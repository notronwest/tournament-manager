import { Navigate, Route, Routes } from "react-router-dom";
import LoginPage from "./auth/LoginPage";
import { RequireAuth } from "./auth/RequireAuth";
import { RequireProfile } from "./auth/RequireProfile";
import PartnerInvitesBanner from "./components/PartnerInvitesBanner";
import { PartnerInvitesProvider } from "./components/PartnerInvitesContext";
import PendingPaymentsBar from "./components/PendingPaymentsBar";
import { PendingPaymentsProvider } from "./components/PendingPaymentsContext";
import SiteHeader from "./components/SiteHeader";
import AdminIndexPage from "./pages/admin/AdminIndexPage";
import AdminLayout from "./pages/admin/AdminLayout";
import AttendeesPage from "./pages/admin/AttendeesPage";
import BulkEventsEditPage from "./pages/admin/BulkEventsEditPage";
import CourtManagerPage from "./pages/admin/CourtManagerPage";
import CreateOrganizationPage from "./pages/admin/CreateOrganizationPage";
import OrgStripeSettingsPage from "./pages/admin/OrgStripeSettingsPage";
import StripeOauthCallbackPage from "./pages/admin/StripeOauthCallbackPage";
import TournamentFormPage from "./pages/admin/TournamentFormPage";
import TournamentWizardPage from "./pages/admin/TournamentWizardPage";
import EventConsolePage from "./pages/admin/EventConsolePage";
import EventFormPage from "./pages/admin/EventFormPage";
import ScorecardsPage from "./pages/admin/ScorecardsPage";
import TournamentCourtManagerPage from "./pages/admin/TournamentCourtManagerPage";
import OrgOverviewPage from "./pages/admin/OrgOverviewPage";
import CheckoutPage from "./pages/public/CheckoutPage";
import HomePage from "./pages/public/HomePage";
import PartnerAcceptPage from "./pages/public/PartnerAcceptPage";
import ProfilePage from "./pages/public/ProfilePage";
import PublicTournamentPage from "./pages/public/PublicTournamentPage";
import RegisterPage from "./pages/public/RegisterPage";
import SchedulePage from "./pages/admin/SchedulePage";
import RoundRobinEstimatorPage from "./pages/admin/tools/RoundRobinEstimatorPage";
import SeedEventPage from "./pages/admin/tools/SeedEventPage";
import TestPlayersPage from "./pages/admin/tools/TestPlayersPage";
import TournamentDetailPage from "./pages/admin/TournamentDetailPage";
import TournamentsListPage from "./pages/admin/TournamentsListPage";

export default function App() {
  return (
    <PartnerInvitesProvider>
    <PendingPaymentsProvider>
      {/* Global top banner — rendered once for the whole app.
          SiteHeader hides itself on /login so the only "Sign in"
          surface there is the page itself. */}
      <SiteHeader />
      {/* Global partner-invite banner — appears below the header
          when the signed-in player has pending partner invites
          anywhere, regardless of the current route. */}
      <PartnerInvitesBanner />
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
      {/* Checkout for the new register-then-checkout flow. Auth +
          profile required (you need a player record to have pending
          regs). Reads pending_payment regs for this tournament,
          flips them to paid on Pay + fires partner-invite emails. */}
      <Route
        path="/t/:orgSlug/:tournamentSlug/checkout"
        element={
          <RequireAuth>
            <RequireProfile>
              <CheckoutPage />
            </RequireProfile>
          </RequireAuth>
        }
      />
      {/* Partner invite accept page. NOT wrapped in RequireAuth /
          RequireProfile — the page handles those states internally so
          unauthenticated visitors still see the "you've been invited"
          context banner before being asked to sign in. */}
      <Route
        path="/t/:orgSlug/:tournamentSlug/invites/:token"
        element={<PartnerAcceptPage />}
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

      {/* Platform-admin-only flow to spin up a new organization. Defined
          BEFORE the :orgSlug catch-all so the router doesn't treat
          "new-org" as a slug. The page itself double-gates on
          usePlatformAdmin. */}
      <Route
        path="/admin/new-org"
        element={
          <RequireAuth>
            <CreateOrganizationPage />
          </RequireAuth>
        }
      />

      {/* Stripe Connect OAuth callback. Fixed path (no org slug) so a
          single redirect_uri can be registered in Stripe Connect
          platform settings. The org comes through the OAuth state
          param. Also defined before the :orgSlug catch-all. */}
      <Route
        path="/admin/oauth/stripe-callback"
        element={
          <RequireAuth>
            <StripeOauthCallbackPage />
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
          path="settings/stripe"
          element={<OrgStripeSettingsPage />}
        />
        <Route
          path="tools/round-robin"
          element={<RoundRobinEstimatorPage />}
        />
        <Route
          path="tools/seed-event"
          element={<SeedEventPage />}
        />
        <Route
          path="tools/test-players"
          element={<TestPlayersPage />}
        />
        <Route path="tournaments" element={<TournamentsListPage />} />
        <Route
          path="tournaments/new"
          element={<TournamentWizardPage />}
        />
        <Route
          path="tournaments/:tournamentSlug"
          element={<TournamentDetailPage />}
        />
        <Route
          path="tournaments/:tournamentSlug/edit"
          element={<TournamentFormPage mode="edit" />}
        />
        <Route
          path="tournaments/:tournamentSlug/wizard"
          element={<TournamentWizardPage />}
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
          path="tournaments/:tournamentSlug/events/edit"
          element={<BulkEventsEditPage />}
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
      {/* Persistent pending-payments bar — sticky at the bottom of
          every page when the signed-in user has pending_payment
          registrations anywhere. Hides itself otherwise (and on
          the checkout page where its CTA would be redundant). */}
      <PendingPaymentsBar />
    </PendingPaymentsProvider>
    </PartnerInvitesProvider>
  );
}
