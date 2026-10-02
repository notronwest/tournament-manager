// Pure contact-source types + filter predicate — no Supabase import, so it is
// unit-testable and safe to share between the Email and Contacts pages.

export type ContactSource = "registrant" | "import" | "manual";

export type SourceFilter = "all" | ContactSource;

/** Source filters OVERLAP: "Registrants" is everyone with an active
 * registration (even if they were also imported), "Imported" / "Added
 * manually" go by how the link row was created. Previously a registrant who
 * was also on the imported list only showed under "Imported", which made the
 * Registrants count read low (44 of 70 for Pickleball Angels). */
export function matchesSource(
  c: { source: ContactSource; isRegistrant: boolean },
  filter: SourceFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "registrant") return c.isRegistrant || c.source === "registrant";
  return c.source === filter;
}
