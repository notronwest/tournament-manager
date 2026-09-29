import { useNavigate, useParams } from "react-router-dom";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { EventSettingsForm } from "./EventSettingsForm";

// Route wrapper for creating / editing an event. The editable form
// itself lives in <EventSettingsForm> so the exact same controls are
// reused inline on the Event Console "Settings" tab and inside the
// Bracket Setup wizard (#1005) — there is one settings editor, not a
// page form plus a separate console copy. This wrapper only supplies
// the page-level navigation: where to go after a save, and where
// Cancel returns to.
export default function EventFormPage({ mode }: { mode: "create" | "edit" }) {
  const { org } = useCurrentOrg();
  const { tournamentSlug, eventId } = useParams<{
    tournamentSlug: string;
    eventId: string;
  }>();
  const navigate = useNavigate();

  if (!org) return null;

  const base = `/admin/${org.slug}/tournaments/${tournamentSlug}`;
  const backTo =
    mode === "edit" && eventId ? `${base}/events/${eventId}` : base;

  return (
    <EventSettingsForm
      mode={mode}
      variant="page"
      onSaved={(savedId) => navigate(`${base}/events/${savedId}`)}
      onCancel={() => navigate(backTo)}
    />
  );
}
