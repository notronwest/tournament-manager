import { useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";

// Form to create a draft tournament. We always create as 'draft' so the
// organizer can add events + settings before publishing. Redirects to the
// tournament detail page on success.
export default function CreateTournamentPage() {
  const { org } = useCurrentOrg();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [locationName, setLocationName] = useState("");
  const [locationAddress, setLocationAddress] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [registrationOpensAt, setRegistrationOpensAt] = useState("");
  const [registrationClosesAt, setRegistrationClosesAt] = useState("");
  const [entryFeeDollars, setEntryFeeDollars] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!org) return;
    setError(null);
    setBusy(true);

    const finalSlug = (slug || slugify(name)).trim();
    if (!finalSlug) {
      setError("Slug is required.");
      setBusy(false);
      return;
    }

    const startsAtIso = toIso(startsAt);
    const endsAtIso = toIso(endsAt);
    if (!startsAtIso || !endsAtIso) {
      setError("Start and end dates are required.");
      setBusy(false);
      return;
    }
    if (new Date(endsAtIso) < new Date(startsAtIso)) {
      setError("End date must be on or after the start date.");
      setBusy(false);
      return;
    }

    const entryFeeCents = Math.round(
      parseFloat(entryFeeDollars || "0") * 100,
    );
    if (Number.isNaN(entryFeeCents) || entryFeeCents < 0) {
      setError("Entry fee must be a non-negative number.");
      setBusy(false);
      return;
    }

    const { data, error: insErr } = await supabase
      .from("tournaments")
      .insert({
        organization_id: org.id,
        slug: finalSlug,
        name: name.trim(),
        description: description.trim() || null,
        location_name: locationName.trim() || null,
        location_address: locationAddress.trim() || null,
        starts_at: startsAtIso,
        ends_at: endsAtIso,
        registration_opens_at: toIso(registrationOpensAt),
        registration_closes_at: toIso(registrationClosesAt),
        entry_fee_cents: entryFeeCents,
        status: "draft",
      })
      .select()
      .single();

    setBusy(false);
    if (insErr) {
      setError(insErr.message);
      return;
    }
    if (data) {
      navigate(`/admin/${org.slug}/tournaments/${data.slug}`);
    }
  };

  if (!org) return null;

  return (
    <div style={{ maxWidth: 720 }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>New tournament</h1>
        <p style={{ color: "#666", margin: "4px 0 0", fontSize: 14 }}>
          Create a draft. You can add events and publish later.
        </p>
      </header>

      <form
        onSubmit={onSubmit}
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        <FieldRow>
          <Field label="Name" required>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
              style={inputStyle}
            />
          </Field>
          <Field label="URL slug" required hint="Used in the public URL.">
            <input
              type="text"
              required
              value={slug}
              onChange={(e) => {
                setSlug(slugify(e.target.value));
                setSlugTouched(true);
              }}
              style={inputStyle}
            />
          </Field>
        </FieldRow>

        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }}
          />
        </Field>

        <FieldRow>
          <Field label="Location name">
            <input
              type="text"
              value={locationName}
              onChange={(e) => setLocationName(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="Location address">
            <input
              type="text"
              value={locationAddress}
              onChange={(e) => setLocationAddress(e.target.value)}
              style={inputStyle}
            />
          </Field>
        </FieldRow>

        <FieldRow>
          <Field label="Starts at" required>
            <input
              type="datetime-local"
              required
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="Ends at" required>
            <input
              type="datetime-local"
              required
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              style={inputStyle}
            />
          </Field>
        </FieldRow>

        <FieldRow>
          <Field label="Registration opens">
            <input
              type="datetime-local"
              value={registrationOpensAt}
              onChange={(e) => setRegistrationOpensAt(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="Registration closes">
            <input
              type="datetime-local"
              value={registrationClosesAt}
              onChange={(e) => setRegistrationClosesAt(e.target.value)}
              style={inputStyle}
            />
          </Field>
        </FieldRow>

        <Field
          label="Entry fee (USD)"
          hint="Tournament-level fee charged once per registrant. Per-event fees are set when you create events."
        >
          <input
            type="number"
            min="0"
            step="0.01"
            value={entryFeeDollars}
            onChange={(e) => setEntryFeeDollars(e.target.value)}
            style={{ ...inputStyle, maxWidth: 160 }}
          />
        </Field>

        {error && (
          <div
            style={{
              padding: 12,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 6,
              color: "#991b1b",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
          <button type="submit" disabled={busy} style={primaryBtn(busy)}>
            {busy ? "Creating…" : "Create tournament"}
          </button>
          <button
            type="button"
            onClick={() => navigate(`/admin/${org.slug}/tournaments`)}
            style={secondaryBtn}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 13,
        color: "#555",
      }}
    >
      <span>
        {label}
        {required && <span style={{ color: "#ef4444", marginLeft: 4 }}>*</span>}
      </span>
      {children}
      {hint && (
        <span style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
          {hint}
        </span>
      )}
    </label>
  );
}

function FieldRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 16,
      }}
    >
      {children}
    </div>
  );
}

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  width: "100%",
};

function primaryBtn(busy: boolean): CSSProperties {
  return {
    padding: "10px 20px",
    background: busy ? "#9ca3af" : "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 500,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: "inherit",
  };
}

const secondaryBtn: CSSProperties = {
  padding: "10px 20px",
  background: "#fff",
  color: "#555",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  cursor: "pointer",
  fontFamily: "inherit",
};

// ─── helpers ─────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// <input type="datetime-local"> emits "YYYY-MM-DDTHH:MM" in the user's
// local time with no timezone. Treat it as local; convert to ISO for
// Postgres timestamptz.
function toIso(localValue: string): string | null {
  if (!localValue) return null;
  return new Date(localValue).toISOString();
}
