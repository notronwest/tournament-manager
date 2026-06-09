import { Link } from "react-router-dom";

// Shown by court-centric pages (court manager, schedule) when the
// tournament's court count can't be resolved. Court count now lives on
// the selected venue (locations.court_count), not on the tournament —
// so there are two ways it can be missing:
//   * no venue selected      → prompt to pick one on the edit form
//   * venue has no court_count → prompt to set it on the venue
export function NoCourtCountNotice({
  orgSlug,
  tournamentSlug,
  hasVenue,
}: {
  orgSlug: string;
  tournamentSlug: string;
  hasVenue: boolean;
}) {
  return (
    <div
      style={{
        padding: "20px 24px",
        background: "#fffbeb",
        border: "1px solid #fde68a",
        borderRadius: 8,
        color: "#92400e",
        fontSize: 14,
        lineHeight: 1.5,
        maxWidth: 560,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        No court count for this tournament
      </div>
      {hasVenue ? (
        <p style={{ margin: "0 0 12px" }}>
          The selected venue doesn't have a court count set yet. Court-based
          scheduling needs it. Add a court count to the venue under{" "}
          <Link to={`/admin/${orgSlug}/locations`} style={linkStyle}>
            Venues
          </Link>
          .
        </p>
      ) : (
        <p style={{ margin: "0 0 12px" }}>
          This tournament has no venue selected. Court count now comes from the
          venue, so pick one (or add its court count) before scheduling.
        </p>
      )}
      <Link
        to={`/admin/${orgSlug}/tournaments/${tournamentSlug}/edit`}
        style={linkStyle}
      >
        {hasVenue ? "Edit tournament" : "Choose a venue"}
      </Link>
    </div>
  );
}

const linkStyle = {
  color: "#2563eb",
  textDecoration: "none",
  fontWeight: 500,
};
