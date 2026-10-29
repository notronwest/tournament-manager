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
import { useId, useState, type FormEvent } from "react";
import { Field, FieldRow } from "./Field";
import { addDependent, setDependentEmail, type Dependent } from "../lib/guardians";
import {
  ctaPrimaryDisabledStyle,
  ctaPrimaryStyle,
  ctaSecondaryStyle,
  inkMuted,
  inlineActionStyle,
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
  // this state is reachable: the row exists, which makes pressing Save again
  // the wrong move — it would add a second child. So the form stops offering
  // Save and offers the half that actually failed, on its own.
  const [savedWithoutEmail, setSavedWithoutEmail] = useState<Dependent | null>(
    null,
  );
  const [retryFailed, setRetryFailed] = useState(false);
  const emailId = useId();

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
      // The raw message is for whoever is reading the console — an RLS
      // sentence or an envoy reset is not something to hand a parent.
      console.error("add child: email write failed", emailError);
      setSavedWithoutEmail(dependent);
      return;
    }
    setFirst("");
    setLast("");
    setDob("");
    setEmail("");
    onAdded(dependent);
  };

  // The child exists; only the address is missing. Both moves are offered
  // here, where the person is standing, because a message rendered by the
  // host afterwards lands somewhere else — at the top of a long family list,
  // or on a card that cannot act on it. The primary is the one write that
  // failed, retried on its own. The secondary is labelled for what it costs
  // and that is the whole of the telling: the family row carries "No email
  // address" from then on, and the control to set one, so nothing about this
  // has to be remembered or repeated on another screen.
  if (savedWithoutEmail) {
    const dependent = savedWithoutEmail;
    const name = dependent.player.first_name ?? "Your child";
    const clear = () => {
      setSavedWithoutEmail(null);
      setRetryFailed(false);
      setFirst("");
      setLast("");
      setDob("");
      setEmail("");
    };
    const onRetry = async () => {
      setBusy(true);
      const { error: retryErr } = await setDependentEmail(dependent.player.id, email);
      setBusy(false);
      if (retryErr) {
        console.error("add child: email retry failed", retryErr);
        setRetryFailed(true);
        return;
      }
      // Carry the stored address on the row the host is about to show, so the
      // family list doesn't need a second read to catch up.
      const withEmail: Dependent = {
        ...dependent,
        player: { ...dependent.player, email: email.trim() || null },
      };
      clear();
      onAdded(withEmail);
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ ...statusPanelStyle("warn"), fontSize: 13 }}>
          <strong>{name} was added</strong>, but their email address
          didn&rsquo;t save. Without one, notices about their registration
          reach nobody.
          {retryFailed && " That didn\u2019t work either \u2014 the save keeps failing."}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onRetry}
            disabled={busy}
            style={busy ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
          >
            {busy ? "Saving…" : retryFailed ? "Try once more" : "Try again"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              clear();
              onAdded(dependent);
            }}
            style={
              busy
                ? { ...ctaSecondaryStyle, opacity: 0.6, cursor: "not-allowed" }
                : ctaSecondaryStyle
            }
          >
            Continue without it
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
        {/* htmlFor rather than a wrapping label: this field holds a second
            control, and a wrapping label would fold "Use my address" and the
            helper sentence into the input's accessible name. */}
        <Field label="Email address (optional)" htmlFor={emailId}>
          <input
            id={emailId}
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
              style={
                busy
                  ? { ...inlineActionStyle, opacity: 0.6, cursor: "not-allowed" }
                  : inlineActionStyle
              }
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
