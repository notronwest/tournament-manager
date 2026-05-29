import {
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { PricingTiersEditor } from "../../components/PricingTiersEditor";
import {
  makeEmptyTierDraft,
  tierDraftsToInserts,
  tiersToDrafts,
  type PricingPattern,
  type TierDraft,
} from "../../lib/pricingTiers";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];

type Mode = "create" | "edit";

// Tournament create/edit form. The mode prop is set at the route
// level: /tournaments/new uses "create", /tournaments/:slug/edit uses
// "edit". We deliberately don't expose `status` here — the
// tournament status transitions (draft → published → closed →
// completed) have their own buttons on TournamentDetailPage to
// surface the side effects (public visibility) at the moment of the
// change. Everything else is fair game.
export default function TournamentFormPage({ mode }: { mode: Mode }) {
  const { org } = useCurrentOrg();
  const navigate = useNavigate();
  const { tournamentSlug: routeSlug } = useParams<{
    tournamentSlug?: string;
  }>();

  // Existing record we're editing (null while loading or in create mode).
  const [existing, setExisting] = useState<Tournament | null>(null);
  // Edit-mode loading state — separate from `busy` so the initial
  // fetch can show a skeleton without disabling the (yet-empty) form.
  const [loading, setLoading] = useState(mode === "edit");
  const [loadError, setLoadError] = useState<string | null>(null);

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
  // Pricing: a pattern + an ordered list of tier drafts. Create mode
  // starts as a single "Standard" tier (the simple default). Edit
  // mode loads the tournament's real tiers + pattern below.
  const [pricingPattern, setPricingPattern] =
    useState<PricingPattern>("single");
  const [pricingTiers, setPricingTiers] = useState<TierDraft[]>(() => [
    makeEmptyTierDraft("Standard"),
  ]);
  // Edit mode: how many registrations have already PAID for this
  // tournament. Drives a reassurance banner in the pricing editor —
  // those registrations have their price locked (snapshotted onto
  // event_registrations.event_fee_cents at checkout) and a tier
  // change here won't re-bill them.
  const [paidRegCount, setPaidRegCount] = useState(0);
  const [courtCount, setCourtCount] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edit-mode prefetch. Loads the existing tournament and seeds every
  // form field. Treats it as if the user just typed those values —
  // slugTouched=true so name-edits don't overwrite the slug they
  // already chose.
  useEffect(() => {
    if (mode !== "edit") return;
    if (!org || !routeSlug) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      const { data, error: err } = await supabase
        .from("tournaments")
        .select("*")
        .eq("organization_id", org.id)
        .eq("slug", routeSlug)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (err) {
        setLoadError(err.message);
        setLoading(false);
        return;
      }
      if (!data) {
        setLoadError("Tournament not found.");
        setLoading(false);
        return;
      }
      setExisting(data);
      setName(data.name);
      setSlug(data.slug);
      setSlugTouched(true);
      setDescription(data.description ?? "");
      setLocationName(data.location_name ?? "");
      setLocationAddress(data.location_address ?? "");
      setStartsAt(isoToLocal(data.starts_at));
      setEndsAt(isoToLocal(data.ends_at));
      setRegistrationOpensAt(isoToLocal(data.registration_opens_at));
      setRegistrationClosesAt(isoToLocal(data.registration_closes_at));
      setCourtCount(String(data.court_count));
      setPricingPattern(data.pricing_pattern);

      // Load the tournament's pricing tiers and convert to drafts.
      // Every tournament has at least one tier (backfilled by
      // migration 20260526170000), so this should always return rows;
      // fall back to a single Standard tier seeded from the legacy
      // columns if it somehow doesn't.
      const { data: tierRows } = await supabase
        .from("tournament_pricing_tiers")
        .select("*")
        .eq("tournament_id", data.id)
        .order("sort_order", { ascending: true });
      if (cancelled) return;
      if (tierRows && tierRows.length > 0) {
        setPricingTiers(tiersToDrafts(tierRows));
      } else {
        setPricingTiers([
          {
            ...makeEmptyTierDraft("Standard"),
            firstEventFeeDollars: (data.entry_fee_cents / 100).toFixed(2),
            additionalEventFeeDollars: (
              data.additional_event_fee_cents / 100
            ).toFixed(2),
          },
        ]);
      }

      // Count paid registrations so the pricing editor can reassure
      // the organizer that those locked-in prices won't change. Two
      // steps: event ids for this tournament, then a head-count of
      // paid event_registrations in them. Org members can read these
      // rows via the "event_regs read by player or org" RLS policy.
      const { data: evIdRows } = await supabase
        .from("events")
        .select("id")
        .eq("tournament_id", data.id)
        .is("deleted_at", null);
      if (cancelled) return;
      const eventIds = (evIdRows ?? []).map((e) => e.id);
      if (eventIds.length > 0) {
        const { count } = await supabase
          .from("event_registrations")
          .select("id", { count: "exact", head: true })
          .in("event_id", eventIds)
          .eq("status", "paid")
          .is("deleted_at", null);
        if (cancelled) return;
        setPaidRegCount(count ?? 0);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, org, routeSlug]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!org) return;
    setError(null);

    const finalSlug = (slug || slugify(name)).trim();
    if (!finalSlug) {
      setError("Slug is required.");
      return;
    }

    const startsAtIso = toIso(startsAt);
    const endsAtIso = toIso(endsAt);
    if (!startsAtIso || !endsAtIso) {
      setError("Start and end dates are required.");
      return;
    }
    if (new Date(endsAtIso) < new Date(startsAtIso)) {
      setError("End date must be on or after the start date.");
      return;
    }

    // Validate + convert the pricing tier drafts into DB rows. This
    // is also where date-window + fee validation happens.
    const tierResult = tierDraftsToInserts(pricingTiers);
    if (tierResult.error !== null) {
      setError(tierResult.error);
      return;
    }
    const tierRows = tierResult.rows;

    const courtCountNum = parseInt(courtCount || "0", 10);
    if (Number.isNaN(courtCountNum) || courtCountNum < 0) {
      setError("Court count must be a non-negative integer.");
      return;
    }

    // Tier 1 (the headline / earliest price) mirrors into the legacy
    // entry_fee_cents + additional_event_fee_cents columns so the read
    // sites still on those columns (PendingPaymentsContext, admin
    // list, home) stay accurate during the bridge period. Slice 5
    // migrates those reads to tiers; slice 6 drops the columns.
    const payload = {
      slug: finalSlug,
      name: name.trim(),
      description: description.trim() || null,
      location_name: locationName.trim() || null,
      location_address: locationAddress.trim() || null,
      starts_at: startsAtIso,
      ends_at: endsAtIso,
      registration_opens_at: toIso(registrationOpensAt),
      registration_closes_at: toIso(registrationClosesAt),
      entry_fee_cents: tierRows[0].first_event_fee_cents,
      additional_event_fee_cents: tierRows[0].additional_event_fee_cents,
      pricing_pattern: pricingPattern,
      court_count: courtCountNum,
    };

    setBusy(true);
    if (mode === "create") {
      const { data, error: insErr } = await supabase
        .from("tournaments")
        .insert({
          ...payload,
          organization_id: org.id,
          status: "draft",
        })
        .select()
        .single();
      if (insErr || !data) {
        setBusy(false);
        setError(insErr?.message ?? "Failed to create tournament.");
        return;
      }
      // Replace the tier set (the INSERT trigger created a placeholder
      // 'Standard' tier; the RPC clears it and writes the real rows).
      const { error: tierErr } = await supabase.rpc("replace_pricing_tiers", {
        p_tournament_id: data.id,
        p_tiers: tierRows,
      });
      setBusy(false);
      if (tierErr) {
        setError(`Tournament created, but pricing failed to save: ${tierErr.message}`);
        return;
      }
      navigate(`/admin/${org.slug}/tournaments/${data.slug}`);
    } else {
      if (!existing) return;
      const { data, error: updErr } = await supabase
        .from("tournaments")
        .update(payload)
        .eq("id", existing.id)
        .select()
        .single();
      if (updErr || !data) {
        setBusy(false);
        setError(updErr?.message ?? "Failed to save tournament.");
        return;
      }
      const { error: tierErr } = await supabase.rpc("replace_pricing_tiers", {
        p_tournament_id: existing.id,
        p_tiers: tierRows,
      });
      setBusy(false);
      if (tierErr) {
        setError(`Saved details, but pricing failed to save: ${tierErr.message}`);
        return;
      }
      // The slug may have changed; navigate to the (possibly new) URL.
      navigate(`/admin/${org.slug}/tournaments/${data.slug}`);
    }
  };

  if (!org) return null;

  if (mode === "edit" && loading) {
    return (
      <div style={{ color: "#666", fontSize: 14 }}>Loading…</div>
    );
  }
  if (mode === "edit" && loadError) {
    return (
      <div style={{ maxWidth: 600 }}>
        <h1 style={{ margin: "0 0 8px", fontSize: 20 }}>
          Can't load tournament
        </h1>
        <p style={{ color: "#666", fontSize: 14 }}>{loadError}</p>
        <button
          onClick={() => navigate(`/admin/${org.slug}/tournaments`)}
          style={secondaryBtn}
        >
          Back to tournaments
        </button>
      </div>
    );
  }

  const slugChanged =
    mode === "edit" && existing != null && slug !== existing.slug;

  return (
    <div style={{ maxWidth: 720 }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>
          {mode === "create" ? "New tournament" : "Edit tournament"}
        </h1>
        <p style={{ color: "#666", margin: "4px 0 0", fontSize: 14 }}>
          {mode === "create"
            ? "Create a draft. You can add events and publish later."
            : "Update tournament details. Status (draft / published / closed / completed) is managed from the tournament page."}
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
                // Only auto-sync slug in create mode and only while
                // the user hasn't touched it themselves. In edit mode
                // we always treat the existing slug as user-chosen.
                if (mode === "create" && !slugTouched) {
                  setSlug(slugify(e.target.value));
                }
              }}
              style={inputStyle}
            />
          </Field>
          <Field
            label="URL slug"
            required
            hint={
              slugChanged
                ? "Changing the slug changes the public URL. Old links will 404."
                : "Used in the public URL."
            }
          >
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

        <PricingTiersEditor
          pattern={pricingPattern}
          tiers={pricingTiers}
          paidRegistrationCount={paidRegCount}
          onChange={(nextPattern, nextTiers) => {
            setPricingPattern(nextPattern);
            setPricingTiers(nextTiers);
          }}
        />

        <FieldRow>
          <Field
            label="Court count"
            hint="Total courts available at the venue. Used by the schedule estimator."
          >
            <input
              type="number"
              min="0"
              step="1"
              value={courtCount}
              onChange={(e) => setCourtCount(e.target.value)}
              style={{ ...inputStyle, maxWidth: 160 }}
            />
          </Field>
        </FieldRow>

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
            {busy
              ? mode === "create"
                ? "Creating…"
                : "Saving…"
              : mode === "create"
                ? "Create tournament"
                : "Save changes"}
          </button>
          <button
            type="button"
            onClick={() =>
              navigate(
                mode === "edit" && existing
                  ? `/admin/${org.slug}/tournaments/${existing.slug}`
                  : `/admin/${org.slug}/tournaments`,
              )
            }
            style={secondaryBtn}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bits — kept inline to match project conventions (no shared form lib).
// ─────────────────────────────────────────────────────────────────────

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
// local time with no timezone. Treat as local; convert to ISO for
// Postgres timestamptz on save.
function toIso(localValue: string): string | null {
  if (!localValue) return null;
  return new Date(localValue).toISOString();
}

// Inverse of toIso for prefilling the form. Strips seconds + timezone
// so the value matches what `datetime-local` expects (YYYY-MM-DDTHH:MM).
function isoToLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
