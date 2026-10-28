// Add a child to the signed-in player's family (#1169, #1182).
//
// ONE implementation, mounted in two places (D-0049):
//
//   * variant="page"   — the My family section of the profile page, where a
//     parent manages the whole family list.
//   * variant="inline" — inside an event's register form, reached from the
//     "Registering for" chooser, so a parent can find and use the youth path
//     without already knowing the profile screen exists. That discoverability
//     gap is the whole of #1182: registering a minor needs no organizer
//     configuration and is always available, but before this it was invisible
//     from the one screen a parent actually starts on.
//
// The validation lives here rather than in either host, which is the point of
// sharing it. The date-of-birth rule in particular is a product rule with a
// reason attached — not a database constraint — and two copies of it would
// drift the moment one host's wording changed.
import { useState, type FormEvent } from "react";
import { Field, FieldRow } from "./Field";
import { addDependent, type Dependent } from "../lib/guardians";
import {
  ctaPrimaryDisabledStyle,
  ctaPrimaryStyle,
  ctaSecondaryStyle,
  inkMuted,
  inputStyle,
  statusPanelStyle,
} from "../lib/publicTheme";

export function AddChildForm({
  guardianPlayerId,
  onAdded,
  onCancel,
  variant = "page",
}: {
  guardianPlayerId: string;
  // Handed the new dependent so the host can fold it into its own family
  // list — and, on the register form, select the child as the registrant.
  onAdded: (dependent: Dependent) => void;
  onCancel: () => void;
  variant?: "page" | "inline";
}) {
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [dob, setDob] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inline = variant === "inline";

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!first.trim() || !last.trim()) {
      setError("A first and last name are both needed.");
      return;
    }
    if (!dob) {
      // Not a database rule — the row would save without one. But a child
      // added for a juniors bracket and no date of birth is a registration
      // that will be refused later for a reason nobody can see here, so the
      // field is required at the point where it is easy to supply.
      setError("A date of birth is needed so age-restricted brackets can check it.");
      return;
    }

    setBusy(true);
    const { dependent, error: addErr } = await addDependent({
      guardianPlayerId,
      firstName: first,
      lastName: last,
      dob,
    });
    setBusy(false);
    if (addErr || !dependent) {
      setError(addErr ?? "Couldn't add that child.");
      return;
    }
    setFirst("");
    setLast("");
    setDob("");
    onAdded(dependent);
  };

  // The name pair shares a row where there is width for it and wraps to one
  // column where there isn't: Field asks for 160px and FieldRow wraps, so a
  // 390px phone — and the narrower column inside a register card — both get
  // the stacked layout without either host asking for it.
  const nameFields = (
    <>
      <Field label="First name" required>
        <input
          type="text"
          required
          value={first}
          onChange={(e) => setFirst(e.target.value)}
          style={inputStyle}
          disabled={busy}
        />
      </Field>
      <Field label="Last name" required>
        <input
          type="text"
          required
          value={last}
          onChange={(e) => setLast(e.target.value)}
          style={inputStyle}
          disabled={busy}
        />
      </Field>
    </>
  );

  return (
    <form
      onSubmit={onSubmit}
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      {error && (
        <div style={{ ...statusPanelStyle("danger"), fontSize: 13 }}>{error}</div>
      )}

      <FieldRow>{nameFields}</FieldRow>

      <FieldRow>
        <Field label="Date of birth" required>
          <input
            type="date"
            required
            value={dob}
            onChange={(e) => setDob(e.target.value)}
            style={inputStyle}
            disabled={busy}
          />
          <span style={{ fontSize: 12, color: inkMuted }}>
            A juniors bracket checks this, so it&rsquo;s needed here.
          </span>
        </Field>
      </FieldRow>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          type="submit"
          disabled={busy}
          style={busy ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
        >
          {busy ? "Saving…" : inline ? "Save and continue" : "Save child"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setError(null);
            onCancel();
          }}
          style={
            busy
              ? { ...ctaSecondaryStyle, opacity: 0.6, cursor: "not-allowed" }
              : ctaSecondaryStyle
          }
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
