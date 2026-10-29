// Add a child to the signed-in player's family (#1169, #1182, #1186).
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
import { useState, type CSSProperties, type FormEvent } from "react";
import { Field, FieldRow } from "./Field";
import { addDependent, type Dependent } from "../lib/guardians";
import {
  bodyFontStack,
  courtBlue,
  ctaPrimaryDisabledStyle,
  ctaPrimaryStyle,
  ctaSecondaryStyle,
  inkMuted,
  inputStyle,
  statusPanelStyle,
} from "../lib/publicTheme";

export function AddChildForm({
  guardianPlayerId,
  guardianEmail,
  onAdded,
  onCancel,
  variant = "page",
}: {
  guardianPlayerId: string;
  // The guardian's own address, where their player row has one, so the form
  // can offer it in one press (#1186). That is the common answer, not a
  // shortcut: a child's notices have to reach an adult, and this is the adult
  // standing at the form.
  guardianEmail?: string | null;
  // Handed the new dependent so the host can fold it into its own family
  // list — and, on the register form, select the child as the registrant.
  onAdded: (dependent: Dependent) => void;
  onCancel: () => void;
  variant?: "page" | "inline";
}) {
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [dob, setDob] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The child saved but their optional address didn't (#1186). Two writes, so
  // this state is reachable: the row exists, which makes it a thing to report
  // rather than a failure to retry — pressing Save again would add a second
  // child. So the form stops offering Save and offers the way onward instead.
  const [savedWithoutEmail, setSavedWithoutEmail] = useState<{
    dependent: Dependent;
    reason: string;
  } | null>(null);

  const inline = variant === "inline";

  const mine = (guardianEmail ?? "").trim();
  // Hidden once the field already holds it, so the control never offers a
  // press that would change nothing.
  const offerMine = mine !== "" && email.trim().toLowerCase() !== mine.toLowerCase();

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
    const {
      dependent,
      error: addErr,
      emailError,
    } = await addDependent({
      guardianPlayerId,
      firstName: first,
      lastName: last,
      dob,
      // The field is optional and blank is the normal answer, so an empty box
      // is sent as "no address", never as "".
      email: email.trim() || null,
    });
    setBusy(false);
    if (addErr || !dependent) {
      setError(addErr ?? "Couldn't add that child.");
      return;
    }
    if (emailError) {
      setSavedWithoutEmail({ dependent, reason: emailError });
      return;
    }
    setFirst("");
    setLast("");
    setDob("");
    setEmail("");
    onAdded(dependent);
  };

  // The child exists; only the address is missing. Nothing here offers to save
  // again — the one honest move is to say so and carry on into whatever the
  // host was doing, which for the register form is the registration itself.
  if (savedWithoutEmail) {
    const { dependent, reason } = savedWithoutEmail;
    const name = dependent.player.first_name ?? "Your child";
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Names the consequence and one move that actually exists. There is
            no screen anywhere that edits a dependent's address (the same gap
            as #1183), so this must not send the parent looking for one. */}
        <div style={{ ...statusPanelStyle("warn"), fontSize: 13 }}>
          <strong>{name} was added</strong>, but their email address
          didn&rsquo;t save ({reason}). Without one, notices about their
          registration reach nobody &mdash; remove them from My family and add
          them again to set it.
        </div>
        <div>
          <button
            type="button"
            onClick={() => {
              setSavedWithoutEmail(null);
              setFirst("");
              setLast("");
              setDob("");
              setEmail("");
              onAdded(dependent);
            }}
            style={ctaPrimaryStyle}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

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

      {/* Optional, and last, because a child can be registered on a name and a
          date of birth alone. But a player row with no address is a player
          nothing can be emailed to — a cancelled tournament or a partner
          change is skipped for them, and no guardian is substituted — so the
          form asks while it is cheap to answer (#1186). type="email" leaves
          the format check to the browser, which already does it and says so
          in the user's own language. */}
      <FieldRow>
        <Field label="Email address (optional)">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="off"
            style={inputStyle}
            disabled={busy}
          />
          {offerMine && (
            <button
              type="button"
              onClick={() => setEmail(mine)}
              disabled={busy}
              style={useMineStyle}
            >
              Use my address
            </button>
          )}
          <span style={{ fontSize: 12, color: inkMuted }}>
            Notices about their registration — a cancellation, a partner
            change — are emailed here, so most parents give their own address.
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

// The small benign inline action already used on the profile page (the
// password explainer toggle): courtBlue and underlined, not the courtRed of
// ghostButtonStyle, which this page spends on Remove.
const useMineStyle: CSSProperties = {
  alignSelf: "flex-start",
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "pointer",
  fontFamily: bodyFontStack,
  fontSize: 12,
  color: courtBlue,
  textDecoration: "underline",
  textUnderlineOffset: 2,
};
