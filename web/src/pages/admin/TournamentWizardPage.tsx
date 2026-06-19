import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { LocationPicker } from "../../components/LocationPicker";
import { ConfirmModal } from "../../components/ConfirmModal";
import { PricingTiersEditor } from "../../components/PricingTiersEditor";
import TournamentCouponsPage from "./TournamentCouponsPage";
import TournamentContactsPage from "./TournamentContactsPage";
import {
  makeEmptyTierDraft,
  tierDraftsToInserts,
  tiersToDrafts,
  type PricingPattern,
  type TierDraft,
} from "../../lib/pricingTiers";
import type { Database } from "../../types/supabase";
import {
  ink,
  inkSoft,
  inkMuted,
  bg,
  cream,
  creamDeep,
  rule,
  ruleSoft,
  courtBlue,
  courtGreen,
  courtRed,
  courtYellow,
  warnBg,
  warnFg,
  dangerBg,
  dangerFg,
  successBg,
  successFg,
  bodyFontStack,
  headingFontStack,
  monoFontStack,
} from "../../lib/publicTheme";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];
type CancellationPolicyPreset =
  Database["public"]["Enums"]["cancellation_policy_preset"];

// ─────────────────────────────────────────────────────────────────────
// Step model
// ─────────────────────────────────────────────────────────────────────

type StepId =
  | "basics"
  | "events"
  | "pricing"
  | "coupons"
  | "cancellation"
  | "sponsors"
  | "content"
  | "faqs"
  | "contacts"
  | "payment"
  | "review";

type StepMeta = {
  id: StepId;
  title: string;
  // Required for publish (the minimum-to-publish gate enforces these).
  required: boolean;
  // True for steps that are "coming in a follow-up slice" — they
  // render an explanation + link rather than a real form, so the
  // wizard still flows but the work happens elsewhere for now.
  stub: boolean;
};

const STEPS: StepMeta[] = [
  { id: "basics", title: "Basics", required: true, stub: false },
  { id: "events", title: "Events", required: true, stub: true },
  { id: "pricing", title: "Pricing", required: true, stub: false },
  { id: "coupons", title: "Coupons", required: false, stub: false },
  { id: "cancellation", title: "Cancellation policy", required: false, stub: true },
  { id: "sponsors", title: "Sponsors & branding", required: false, stub: true },
  { id: "content", title: "Content sections", required: false, stub: false },
  { id: "faqs", title: "FAQs", required: false, stub: true },
  { id: "contacts", title: "Tournament contacts", required: false, stub: false },
  { id: "payment", title: "Accept payment", required: false, stub: true },
  { id: "review", title: "Review & publish", required: true, stub: false },
];

// ─────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────

// Tournament creation wizard. Steps a new organizer through a
// tournament from a blank slate to publish in clear, focused
// stages — instead of one long form. Lives at
// /admin/:org/tournaments/new (new tournament) and
// /admin/:org/tournaments/:tournamentSlug/wizard (resume a draft).
//
// Slice 1 wires three real steps (Basics / Pricing / Review) plus
// five stubs (Events / Cancellation / Sponsors / FAQs / Payment).
// Follow-up slices replace each stub with its full step. The mockup
// (mockups/tournament-creation-flow.html) is the design source of
// truth for layout + copy.
const VALID_STEP_IDS: string[] = STEPS.map((s) => s.id);

export default function TournamentWizardPage() {
  const { org } = useCurrentOrg();
  const navigate = useNavigate();
  const { tournamentSlug: routeSlug, stepId: routeStepId } = useParams<{
    tournamentSlug?: string;
    stepId?: string;
  }>();
  const isResume = !!routeSlug;

  // Step is URL-driven — the `:stepId` param is the source of truth.
  // Defaults to "basics" when the legacy stepless URL is used.
  const currentStep: StepId = VALID_STEP_IDS.includes(routeStepId ?? "")
    ? (routeStepId as StepId)
    : "basics";

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const eventCount = events.length;

  // Basics form state
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [locationId, setLocationId] = useState<string | null>(null);
  const [locationName, setLocationName] = useState("");
  const [locationAddress, setLocationAddress] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [registrationOpensAt, setRegistrationOpensAt] = useState("");
  const [registrationClosesAt, setRegistrationClosesAt] = useState("");
  const [pickleballType, setPickleballType] = useState("");
  // Venue's default ball — used as placeholder for the override input.
  const [venuePickleballType, setVenuePickleballType] = useState<string | null>(null);

  // Pricing state
  const [pricingPattern, setPricingPattern] =
    useState<PricingPattern>("single");
  const [pricingTiers, setPricingTiers] = useState<TierDraft[]>(() => [
    makeEmptyTierDraft("Standard"),
  ]);
  const [activeRegCount, setActiveRegCount] = useState(0);

  // Step 4: Cancellation policy preset. Defaults to "standard" in the
  // UI for first-time runs (organizer can change or skip). null in
  // state = nothing chosen yet (resume mode for a tournament that
  // skipped this step previously).
  const [cancellationPreset, setCancellationPreset] =
    useState<CancellationPolicyPreset | null>("standard");

  // Step 5 (Sponsors) + Step 6 (Content sections) + Step 7 (FAQs).
  // Free-form markdown that renders as labeled sections on the public
  // tournament page. NULL (empty string → null on save) hides the section.
  const [sponsorsMd, setSponsorsMd] = useState("");
  const [faqsMd, setFaqsMd] = useState("");
  const [additionalInfoMd, setAdditionalInfoMd] = useState("");
  const [refundPolicyMd, setRefundPolicyMd] = useState("");
  const [weatherMd, setWeatherMd] = useState("");
  const [facilityInfoMd, setFacilityInfoMd] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingDraft, setLoadingDraft] = useState(isResume);
  // Soft-required publish warning modal (cancellation policy, Stripe).
  const [showPublishWarning, setShowPublishWarning] = useState(false);

  // When a saved venue is selected, fetch its pickleball_type so we can
  // show it as placeholder text in the tournament override input.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!locationId) {
        if (!cancelled) setVenuePickleballType(null);
        return;
      }
      const { data } = await supabase
        .from("locations")
        .select("pickleball_type")
        .eq("id", locationId)
        .maybeSingle();
      if (cancelled) return;
      setVenuePickleballType(data?.pickleball_type ?? null);
    })();
    return () => { cancelled = true; };
  }, [locationId]);

  // Redirect legacy step-less URLs to the per-step URL so bookmarks
  // and refreshes land on the right step going forward.
  useEffect(() => {
    if (routeStepId || !org) return;
    if (isResume && routeSlug) {
      navigate(`/admin/${org.slug}/tournaments/${routeSlug}/wizard/basics`, {
        replace: true,
      });
    } else {
      navigate(`/admin/${org.slug}/tournaments/new/basics`, { replace: true });
    }
  }, [routeStepId, org, isResume, routeSlug, navigate]);

  // Resume mode: hydrate every step's state from the existing draft.
  useEffect(() => {
    if (!isResume || !org || !routeSlug) return;
    let cancelled = false;
    (async () => {
      setLoadingDraft(true);
      const { data: t, error: tErr } = await supabase
        .from("tournaments")
        .select("*")
        .eq("organization_id", org.id)
        .eq("slug", routeSlug)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (tErr || !t) {
        setError(tErr?.message ?? "Tournament not found.");
        setLoadingDraft(false);
        return;
      }
      setTournament(t);
      setName(t.name);
      setSlug(t.slug);
      setSlugTouched(true);
      setDescription(t.description ?? "");
      setLocationId(t.location_id ?? null);
      setLocationName(t.location_name ?? "");
      setLocationAddress(t.location_address ?? "");
      setPickleballType(t.pickleball_type ?? "");
      setStartsAt(isoToLocal(t.starts_at));
      setEndsAt(isoToLocal(t.ends_at));
      setRegistrationOpensAt(isoToLocal(t.registration_opens_at));
      setRegistrationClosesAt(isoToLocal(t.registration_closes_at));
      setPricingPattern(t.pricing_pattern);
      // Preserve "not chosen" state when the org skipped Step 4
      // previously — don't snap them to "standard" on resume.
      setCancellationPreset(t.cancellation_policy_preset ?? null);
      setSponsorsMd(t.sponsors_md ?? "");
      setFaqsMd(t.faqs_md ?? "");
      setAdditionalInfoMd(t.additional_info_md ?? "");
      setRefundPolicyMd(t.refund_policy_md ?? "");
      setWeatherMd(t.weather_md ?? "");
      setFacilityInfoMd(t.facility_info_md ?? "");

      // Pricing tiers
      const { data: tierRows } = await supabase
        .from("tournament_pricing_tiers")
        .select("*")
        .eq("tournament_id", t.id)
        .order("sort_order", { ascending: true });
      if (cancelled) return;
      if (tierRows && tierRows.length > 0) {
        setPricingTiers(tiersToDrafts(tierRows));
      }

      // Events for Step 2 (the publish gate uses events.length).
      const { data: evRows } = await supabase
        .from("events")
        .select("*")
        .eq("tournament_id", t.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: true });
      if (cancelled) return;
      setEvents(evRows ?? []);

      // Active reg count — locks pricing editor if any paid/pending regs exist
      const eventIds = (evRows ?? []).map((e) => e.id);
      if (eventIds.length > 0) {
        const { count } = await supabase
          .from("event_registrations")
          .select("id", { count: "exact", head: true })
          .in("event_id", eventIds)
          .in("status", ["paid", "pending_payment"])
          .is("deleted_at", null);
        if (cancelled) return;
        setActiveRegCount(count ?? 0);
      }
      setLoadingDraft(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [isResume, org, routeSlug]);

  // Must be declared before any early returns to satisfy Rules of Hooks.
  // `org` is always non-null when this callback is actually invoked
  // (the component returns null before reaching any call site if org is absent).
  const goStep = useCallback(
    (id: StepId) => {
      const slug = tournament?.slug ?? routeSlug;
      if (slug) {
        navigate(`/admin/${org!.slug}/tournaments/${slug}/wizard/${id}`);
      } else {
        navigate(`/admin/${org!.slug}/tournaments/new/${id}`);
      }
    },
    [tournament, routeSlug, org, navigate]
  );

  if (!org) return null;
  if (loadingDraft) {
    return <div style={{ padding: 24, color: inkSoft, fontFamily: bodyFontStack }}>Loading draft…</div>;
  }

  // ── Save handlers ───────────────────────────────────────────────

  const saveBasics = async (): Promise<boolean> => {
    setError(null);
    const finalSlug = (slug || slugify(name)).trim();
    if (!name.trim()) {
      setError("Tournament name is required.");
      return false;
    }
    if (!finalSlug) {
      setError("URL slug is required.");
      return false;
    }
    const startsAtIso = toIso(startsAt);
    const endsAtIso = toIso(endsAt);
    if (!startsAtIso || !endsAtIso) {
      setError("Start and end dates are required.");
      return false;
    }
    if (new Date(endsAtIso) < new Date(startsAtIso)) {
      setError("End date must be on or after the start date.");
      return false;
    }
    const payload = {
      slug: finalSlug,
      name: name.trim(),
      description: description.trim() || null,
      location_id: locationId ?? null,
      location_name: locationId ? null : (locationName.trim() || null),
      location_address: locationId ? null : (locationAddress.trim() || null),
      pickleball_type: pickleballType.trim() || null,
      starts_at: startsAtIso,
      ends_at: endsAtIso,
      registration_opens_at: toIso(registrationOpensAt),
      registration_closes_at: toIso(registrationClosesAt),
    };

    setBusy(true);
    if (!tournament) {
      // First save of a brand-new tournament → INSERT.
      const { data, error: insErr } = await supabase
        .from("tournaments")
        .insert({
          ...payload,
          organization_id: org.id,
          status: "draft",
        })
        .select()
        .single();
      setBusy(false);
      if (insErr || !data) {
        setError(insErr?.message ?? "Failed to create tournament.");
        return false;
      }
      setTournament(data);
      // Transition from /new/basics to the resume URL at the basics
      // step — the caller (saveAndContinue) will then advance to events.
      navigate(
        `/admin/${org.slug}/tournaments/${data.slug}/wizard/basics`,
        { replace: true }
      );
      return true;
    }
    // Resume mode → UPDATE existing draft.
    const { data, error: updErr } = await supabase
      .from("tournaments")
      .update(payload)
      .eq("id", tournament.id)
      .select()
      .single();
    setBusy(false);
    if (updErr || !data) {
      setError(updErr?.message ?? "Failed to save.");
      return false;
    }
    setTournament(data);
    // Slug may have changed — keep URL in sync with same step.
    if (data.slug !== routeSlug) {
      navigate(
        `/admin/${org.slug}/tournaments/${data.slug}/wizard/${currentStep}`,
        { replace: true }
      );
    }
    return true;
  };

  const savePricing = async (): Promise<boolean> => {
    if (!tournament) {
      setError("Save Basics first so we have a draft to attach pricing to.");
      return false;
    }
    setError(null);
    const tierResult = tierDraftsToInserts(pricingTiers);
    if (tierResult.error !== null) {
      setError(tierResult.error);
      return false;
    }
    setBusy(true);
    const { error: updErr } = await supabase
      .from("tournaments")
      .update({ pricing_pattern: pricingPattern })
      .eq("id", tournament.id);
    if (updErr) {
      setBusy(false);
      setError(updErr.message);
      return false;
    }
    const { error: tierErr } = await supabase.rpc("replace_pricing_tiers", {
      p_tournament_id: tournament.id,
      p_tiers: tierResult.rows,
    });
    setBusy(false);
    if (tierErr) {
      setError(`Pricing failed to save: ${tierErr.message}`);
      return false;
    }
    return true;
  };

  const saveCancellationPolicy = async (): Promise<boolean> => {
    if (!tournament) {
      setError("Save Basics first.");
      return false;
    }
    setError(null);
    setBusy(true);
    const { error: updErr } = await supabase
      .from("tournaments")
      .update({ cancellation_policy_preset: cancellationPreset })
      .eq("id", tournament.id);
    setBusy(false);
    if (updErr) {
      setError(updErr.message);
      return false;
    }
    return true;
  };

  // Generic markdown-column saver — used by Sponsors and FAQs.
  // Empty string saves as NULL so the public page hides the section
  // entirely (rather than rendering an empty heading). The dynamic
  // column key needs a cast because the typed client refuses
  // computed-property objects for its strict Update type.
  const saveMarkdownColumn = async (
    column: "sponsors_md" | "faqs_md",
    value: string,
  ): Promise<boolean> => {
    if (!tournament) {
      setError("Save Basics first.");
      return false;
    }
    setError(null);
    setBusy(true);
    const trimmed = value.trim();
    const payload = {
      [column]: trimmed === "" ? null : trimmed,
    } as Database["public"]["Tables"]["tournaments"]["Update"];
    const { error: updErr } = await supabase
      .from("tournaments")
      .update(payload)
      .eq("id", tournament.id);
    setBusy(false);
    if (updErr) {
      setError(updErr.message);
      return false;
    }
    return true;
  };

  const saveContentSections = async (): Promise<boolean> => {
    if (!tournament) {
      setError("Save Basics first.");
      return false;
    }
    setError(null);
    setBusy(true);
    const trim = (v: string) => v.trim() || null;
    const { error: updErr } = await supabase
      .from("tournaments")
      .update({
        additional_info_md: trim(additionalInfoMd),
        refund_policy_md: trim(refundPolicyMd),
        weather_md: trim(weatherMd),
        facility_info_md: trim(facilityInfoMd),
      })
      .eq("id", tournament.id);
    setBusy(false);
    if (updErr) {
      setError(updErr.message);
      return false;
    }
    return true;
  };

  const publish = async (): Promise<void> => {
    if (!tournament) return;
    setError(null);
    setBusy(true);
    const { error: pubErr } = await supabase
      .from("tournaments")
      .update({ status: "published" })
      .eq("id", tournament.id);
    setBusy(false);
    if (pubErr) {
      setError(pubErr.message);
      return;
    }
    navigate(`/admin/${org.slug}/tournaments/${tournament.slug}`);
  };

  // ── Events handlers ─────────────────────────────────────────────

  const reloadEvents = async () => {
    if (!tournament) return;
    const { data } = await supabase
      .from("events")
      .select("*")
      .eq("tournament_id", tournament.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: true });
    setEvents(data ?? []);
  };

  const addDefaultEvents = async (divisions: DefaultDivision[]) => {
    if (!tournament || divisions.length === 0) return;
    setError(null);
    setBusy(true);
    const rows = divisions.map((d) => ({
      tournament_id: tournament.id,
      name: d.name,
      format: d.format,
      gender: d.gender,
      min_rating: d.min_rating,
      max_rating: d.max_rating,
    }));
    const { error: insErr } = await supabase.from("events").insert(rows);
    if (insErr) {
      setBusy(false);
      setError(insErr.message);
      return;
    }
    await reloadEvents();
    setBusy(false);
  };

  const removeEvent = async (eventId: string) => {
    setError(null);
    setBusy(true);
    const { error: delErr } = await supabase
      .from("events")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", eventId);
    if (delErr) {
      setBusy(false);
      setError(delErr.message);
      return;
    }
    await reloadEvents();
    setBusy(false);
  };

  // ── Navigation ──────────────────────────────────────────────────

  const stepIndex = STEPS.findIndex((s) => s.id === currentStep);
  const next = STEPS[stepIndex + 1];
  const prev = STEPS[stepIndex - 1];

  // On Save & continue: persist the current step (real steps only),
  // then advance.
  const saveCurrentStep = async (): Promise<boolean> => {
    if (currentStep === "basics") return saveBasics();
    if (currentStep === "pricing") return savePricing();
    if (currentStep === "cancellation") return saveCancellationPolicy();
    if (currentStep === "sponsors")
      return saveMarkdownColumn("sponsors_md", sponsorsMd);
    if (currentStep === "content") return saveContentSections();
    if (currentStep === "faqs") return saveMarkdownColumn("faqs_md", faqsMd);
    return true;
  };

  const saveAndContinue = async () => {
    const ok = await saveCurrentStep();
    if (ok && next) goStep(next.id);
  };

  const saveAndExit = async () => {
    const ok = await saveCurrentStep();
    if (ok) {
      if (tournament) {
        navigate(`/admin/${org.slug}/tournaments/${tournament.slug}`);
      } else {
        navigate(`/admin/${org.slug}/tournaments`);
      }
    }
  };

  // ── Minimum-to-publish gate ─────────────────────────────────────
  // Hard-required: must be met before Publish is enabled.
  const publishBlockers: string[] = [];
  if (!tournament) {
    publishBlockers.push("Complete the Basics step and save the draft first");
  } else {
    // A venue can be set either as a saved location (location_id) or as
    // free-text (location_name). Either satisfies the requirement.
    if (!tournament.location_id && !tournament.location_name?.trim())
      publishBlockers.push("Add a venue location (Basics step)");
    if (eventCount === 0)
      publishBlockers.push("Add at least one event (Events step)");
  }

  // Soft-required: publish is allowed but the organizer sees a warning
  // modal calling out the gap before the publish goes through.
  const softBlockers: string[] = [];
  if (tournament && !cancellationPreset)
    softBlockers.push("No cancellation policy set");
  if (org?.stripe_account_status === "not_connected")
    softBlockers.push("Stripe payments not connected — registrations won't charge");

  // ── Per-step rail-guard: if the current step has unmet REQUIRED
  // fields, the rail disables forward jumps so the organizer can't
  // wander into a later step on an unfinished foundation. Back
  // jumps are always allowed; jumps to the current step are no-ops.
  // ────────────────────────────────────────────────────────────────
  let currentStepBlocker: string | null = null;
  if (currentStep === "basics") {
    const missing: string[] = [];
    if (!name.trim()) missing.push("name");
    if (!startsAt) missing.push("start date");
    if (!endsAt) missing.push("end date");
    if (missing.length > 0) {
      currentStepBlocker = `Fill in ${missing.join(", ")} first.`;
    } else if (!tournament) {
      currentStepBlocker = 'Click "Save & continue" to save the draft first.';
    }
  } else if (currentStep === "events") {
    if (eventCount === 0) {
      currentStepBlocker = "Add at least one event before continuing.";
    }
  } else if (currentStep === "pricing") {
    const tierCheck = tierDraftsToInserts(pricingTiers);
    if (tierCheck.error !== null) {
      currentStepBlocker = tierCheck.error;
    }
  }
  // cancellation / sponsors / faqs / payment / review: optional or
  // terminal — no blocker.

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div style={shellStyle}>
      <Rail
        steps={STEPS}
        current={currentStep}
        forwardBlocker={currentStepBlocker}
        tournamentName={tournament?.name || name || "Untitled tournament"}
        onPick={goStep}
        onPublish={() => goStep("review")}
        onSaveExit={() => void saveAndExit()}
        publishable={publishBlockers.length === 0}
      />

      <main style={paneStyle}>
        {currentStep === "basics" && (
          <BasicsStep
            orgId={org.id}
            name={name}
            setName={setName}
            slug={slug}
            setSlug={setSlug}
            slugTouched={slugTouched}
            setSlugTouched={setSlugTouched}
            description={description}
            setDescription={setDescription}
            locationId={locationId}
            setLocationId={setLocationId}
            locationName={locationName}
            setLocationName={setLocationName}
            locationAddress={locationAddress}
            setLocationAddress={setLocationAddress}
            startsAt={startsAt}
            setStartsAt={setStartsAt}
            endsAt={endsAt}
            setEndsAt={setEndsAt}
            registrationOpensAt={registrationOpensAt}
            setRegistrationOpensAt={setRegistrationOpensAt}
            registrationClosesAt={registrationClosesAt}
            setRegistrationClosesAt={setRegistrationClosesAt}
            pickleballType={pickleballType}
            setPickleballType={setPickleballType}
            venuePickleballType={venuePickleballType}
            mode={tournament ? "edit" : "create"}
          />
        )}
        {currentStep === "events" && (
          <EventsStep
            tournament={tournament}
            events={events}
            orgSlug={org.slug}
            busy={busy}
            onAddDefaults={(divs) => void addDefaultEvents(divs)}
            onRemoveEvent={(id) => void removeEvent(id)}
          />
        )}
        {currentStep === "pricing" && (
          <PricingStep
            pattern={pricingPattern}
            tiers={pricingTiers}
            activeRegCount={activeRegCount}
            onChange={(p, t) => {
              setPricingPattern(p);
              setPricingTiers(t);
            }}
          />
        )}
        {currentStep === "coupons" && (
          tournament ? (
            <TournamentCouponsPage embedded />
          ) : (
            <SaveFirstNotice label="coupons" />
          )
        )}
        {currentStep === "contacts" && (
          tournament ? (
            <TournamentContactsPage embedded />
          ) : (
            <SaveFirstNotice label="contacts" />
          )
        )}
        {currentStep === "cancellation" && (
          <CancellationPolicyStep
            preset={cancellationPreset}
            onChange={setCancellationPreset}
          />
        )}
        {currentStep === "sponsors" && (
          <MarkdownStep
            title="Sponsors & branding"
            lede="List your sponsors so they show on the public tournament page. Markdown supported — link out, list multiple tiers, whatever fits. Image upload (logos / banner) is a follow-up."
            placeholder={`**Title sponsor:** [Acme Pickleball](https://example.com)\n\n**Court sponsors:**\n- Local Bagel Shop\n- Downtown Auto`}
            value={sponsorsMd}
            onChange={setSponsorsMd}
          />
        )}
        {currentStep === "content" && (
          <ContentSectionsStep
            additionalInfoMd={additionalInfoMd}
            setAdditionalInfoMd={setAdditionalInfoMd}
            refundPolicyMd={refundPolicyMd}
            setRefundPolicyMd={setRefundPolicyMd}
            weatherMd={weatherMd}
            setWeatherMd={setWeatherMd}
            facilityInfoMd={facilityInfoMd}
            setFacilityInfoMd={setFacilityInfoMd}
          />
        )}
        {currentStep === "faqs" && (
          <MarkdownStep
            title="FAQs"
            lede="Short Q+A entries for the public tournament page — parking, format details, lunch, etc. Markdown supported."
            placeholder={`**Where do I park?**\nThe main lot fills up fast — overflow on Main St.\n\n**What time do warm-ups start?**\n20 minutes before your first match.`}
            value={faqsMd}
            onChange={setFaqsMd}
          />
        )}
        {currentStep === "payment" && (
          <PaymentStep
            stripeStatus={org.stripe_account_status}
            stripeAccountId={org.stripe_account_id}
            orgSlug={org.slug}
          />
        )}
        {currentStep === "review" && (
          <ReviewStep
            tournament={tournament}
            eventCount={eventCount}
            pricingTiers={pricingTiers}
            pricingPattern={pricingPattern}
            cancellationPreset={cancellationPreset}
            stripeStatus={org.stripe_account_status}
            blockers={publishBlockers}
            softBlockers={softBlockers}
            onJumpTo={goStep}
          />
        )}

        {error && (
          <div
            style={{
              marginTop: 16,
              padding: 12,
              background: dangerBg,
              border: `1px solid ${courtRed}`,
              borderRadius: 6,
              color: dangerFg,
              fontSize: 13,
              fontFamily: bodyFontStack,
            }}
          >
            {error}
          </div>
        )}

        {/* Bottom action bar — Back / Skip-when-optional / Save&continue
            or Publish (on review). */}
        <div style={actionBarStyle}>
          <button
            type="button"
            style={btnGhost}
            onClick={() => prev && goStep(prev.id)}
            disabled={!prev || busy}
          >
            ← Back
          </button>
          {STEPS[stepIndex] && !STEPS[stepIndex].required && next && (
            <button
              type="button"
              style={btnSecondary}
              onClick={() => goStep(next.id)}
              disabled={busy}
            >
              Skip
            </button>
          )}
          <div style={{ flex: 1 }} />
          {currentStep === "review" ? (
            <button
              type="button"
              style={btnPrimary(busy || publishBlockers.length > 0)}
              onClick={() => {
                if (softBlockers.length > 0) {
                  setShowPublishWarning(true);
                } else {
                  void publish();
                }
              }}
              disabled={busy || publishBlockers.length > 0}
            >
              {busy ? "Publishing…" : "Publish tournament"}
            </button>
          ) : (
            <button
              type="button"
              style={btnPrimary(busy)}
              onClick={() => void saveAndContinue()}
              disabled={busy}
            >
              {busy ? "Saving…" : "Save & continue →"}
            </button>
          )}
        </div>
      </main>

      {showPublishWarning && (
        <ConfirmModal
          title="Publish with gaps?"
          body={
            <div>
              <p style={{ margin: "0 0 8px" }}>
                The tournament will go live, but a few optional items are missing:
              </p>
              <ul style={{ margin: "0 0 8px 18px", padding: 0 }}>
                {softBlockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              <p style={{ margin: 0 }}>Publish anyway?</p>
            </div>
          }
          confirmLabel="Yes, publish"
          cancelLabel="Go back"
          destructive={false}
          onCancel={() => setShowPublishWarning(false)}
          onConfirm={() => {
            setShowPublishWarning(false);
            void publish();
          }}
        />
      )}
    </div>
  );
}

// Shown for the embedded Coupons / Contacts steps before the tournament
// has been saved (a brand-new draft has no id to attach rows to). Once
// Basics is saved the tournament exists and the real page renders.
function SaveFirstNotice({ label }: { label: string }) {
  return (
    <div>
      <StepHeader
        title={label === "coupons" ? "Coupons" : "Tournament contacts"}
        lede={`Save the tournament first (finish Basics), then you can manage ${label} here.`}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Left rail
// ─────────────────────────────────────────────────────────────────────

function Rail({
  steps,
  current,
  forwardBlocker,
  tournamentName,
  onPick,
  onPublish,
  onSaveExit,
  publishable,
}: {
  steps: StepMeta[];
  current: StepId;
  // Non-null = the current step has unmet required fields; forward
  // step buttons in the rail are disabled and show this as a tooltip
  // so the organizer can't jump past an incomplete required step.
  // Back navigation is unaffected.
  forwardBlocker: string | null;
  tournamentName: string;
  onPick: (id: StepId) => void;
  onPublish: () => void;
  onSaveExit: () => void;
  publishable: boolean;
}) {
  const currentIdx = steps.findIndex((s) => s.id === current);
  return (
    <aside style={railStyle}>
      <div>
        <div style={{ fontSize: 11, color: inkMuted, textTransform: "uppercase", letterSpacing: 0.5, fontFamily: bodyFontStack }}>
          Tournament
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, color: ink, marginTop: 4, fontFamily: bodyFontStack }}>
          {tournamentName}
        </div>
        <div
          style={{
            display: "inline-block",
            marginTop: 6,
            padding: "2px 8px",
            background: ruleSoft,
            color: inkMuted,
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            fontFamily: bodyFontStack,
          }}
        >
          Draft
        </div>
      </div>

      <ol style={stepListStyle}>
        {steps.map((s, i) => {
          const state =
            i < currentIdx ? "done" : i === currentIdx ? "active" : "todo";
          const isForward = i > currentIdx;
          const disabled = isForward && forwardBlocker !== null;
          return (
            <li key={s.id}>
              <button
                type="button"
                disabled={disabled}
                title={disabled ? forwardBlocker ?? undefined : undefined}
                onClick={() => onPick(s.id)}
                style={{
                  ...stepBtnStyle(state),
                  opacity: disabled ? 0.45 : 1,
                  cursor: disabled ? "not-allowed" : "pointer",
                }}
              >
                <span style={indicatorStyle(state)}>
                  {disabled ? "🔒" : state === "done" ? "✓" : i + 1}
                </span>
                <span style={{ flex: 1 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: state === "active" ? 600 : 500,
                    }}
                  >
                    {s.title}
                  </div>
                  {!s.required && (
                    <div style={{ fontSize: 11, color: inkMuted }}>
                      Optional
                    </div>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {forwardBlocker && (
        <div
          style={{
            padding: "8px 10px",
            background: warnBg,
            border: `1px solid ${courtYellow}`,
            borderRadius: 6,
            fontSize: 11,
            color: warnFg,
            lineHeight: 1.5,
            fontFamily: bodyFontStack,
          }}
        >
          🔒 {forwardBlocker}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button
          type="button"
          onClick={onPublish}
          // Publish navigates to Review (a forward step), so the
          // rail-guard blocker applies here too: can't skip past an
          // incomplete required step by clicking Publish.
          disabled={!publishable || forwardBlocker !== null}
          title={forwardBlocker ?? undefined}
          style={{
            padding: "10px 14px",
            background: publishable && !forwardBlocker ? courtGreen : rule,
            color: publishable && !forwardBlocker ? "#ffffff" : inkMuted,
            border: "none",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 700,
            cursor: publishable && !forwardBlocker ? "pointer" : "not-allowed",
            fontFamily: headingFontStack,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {publishable ? "Review & publish →" : "Publish (needs more info)"}
        </button>
        <button
          type="button"
          onClick={onSaveExit}
          style={{
            padding: "8px 14px",
            background: "transparent",
            color: inkSoft,
            border: `1px solid ${rule}`,
            borderRadius: 6,
            fontSize: 12,
            cursor: "pointer",
            fontFamily: bodyFontStack,
          }}
        >
          Save &amp; exit
        </button>
      </div>
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Step 1: Basics
// ─────────────────────────────────────────────────────────────────────

function BasicsStep(props: {
  orgId: string;
  name: string;
  setName: (s: string) => void;
  slug: string;
  setSlug: (s: string) => void;
  slugTouched: boolean;
  setSlugTouched: (b: boolean) => void;
  description: string;
  setDescription: (s: string) => void;
  locationId: string | null;
  setLocationId: (id: string | null) => void;
  locationName: string;
  setLocationName: (s: string) => void;
  locationAddress: string;
  setLocationAddress: (s: string) => void;
  startsAt: string;
  setStartsAt: (s: string) => void;
  endsAt: string;
  setEndsAt: (s: string) => void;
  registrationOpensAt: string;
  setRegistrationOpensAt: (s: string) => void;
  registrationClosesAt: string;
  setRegistrationClosesAt: (s: string) => void;
  pickleballType: string;
  setPickleballType: (s: string) => void;
  venuePickleballType: string | null;
  mode: "create" | "edit";
}) {
  return (
    <div>
      <StepHeader
        title="Basics"
        lede="Name, dates, and where it's happening. This is the only step you have to fill in — everything else is skippable."
      />
      <FieldRow>
        <Field label="Tournament name" required>
          <input
            type="text"
            required
            value={props.name}
            onChange={(e) => {
              props.setName(e.target.value);
              if (props.mode === "create" && !props.slugTouched) {
                props.setSlug(slugify(e.target.value));
              }
            }}
            style={inputStyle}
          />
        </Field>
        <Field
          label="URL slug"
          required
          hint="Used in the public URL."
        >
          <input
            type="text"
            required
            value={props.slug}
            onChange={(e) => {
              props.setSlug(slugify(e.target.value));
              props.setSlugTouched(true);
            }}
            style={inputStyle}
          />
        </Field>
      </FieldRow>

      <Field label="Description">
        <textarea
          value={props.description}
          onChange={(e) => props.setDescription(e.target.value)}
          rows={3}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </Field>

      <Field label="Venue">
        <LocationPicker
          orgId={props.orgId}
          locationId={props.locationId}
          setLocationId={props.setLocationId}
          locationName={props.locationName}
          setLocationName={props.setLocationName}
          locationAddress={props.locationAddress}
          setLocationAddress={props.setLocationAddress}
        />
      </Field>

      <Field
        label="Ball (override)"
        hint={props.venuePickleballType ? `Venue default: ${props.venuePickleballType}` : undefined}
      >
        <input
          type="text"
          value={props.pickleballType}
          onChange={(e) => props.setPickleballType(e.target.value)}
          placeholder={props.venuePickleballType ?? "e.g. Franklin X-40, Selkirk S1"}
          style={inputStyle}
        />
      </Field>

      <FieldRow>
        <Field label="Starts at" required>
          <input
            type="datetime-local"
            required
            value={props.startsAt}
            onChange={(e) => props.setStartsAt(e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Ends at" required>
          <input
            type="datetime-local"
            required
            value={props.endsAt}
            onChange={(e) => props.setEndsAt(e.target.value)}
            style={inputStyle}
          />
        </Field>
      </FieldRow>

      <FieldRow>
        <Field label="Registration opens">
          <input
            type="datetime-local"
            value={props.registrationOpensAt}
            onChange={(e) => props.setRegistrationOpensAt(e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Registration closes">
          <input
            type="datetime-local"
            value={props.registrationClosesAt}
            onChange={(e) => props.setRegistrationClosesAt(e.target.value)}
            style={inputStyle}
          />
        </Field>
      </FieldRow>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Step 2: Events — default-division template (checkboxes) for the
// first pass, then a list of existing events with remove. The bulk
// events editor stays as the deeper edit surface for fine-tuning.
// ─────────────────────────────────────────────────────────────────────

type Gender = Database["public"]["Enums"]["event_gender"];
type Format = Database["public"]["Enums"]["event_format"];

type DefaultDivision = {
  id: string;
  name: string;
  format: Format;
  gender: Gender;
  min_rating: number;
  max_rating: number | null;
};

// Skill levels conventionally used at club tournaments. 3.0/3.5/4.0
// each cover a 0.5 band; 4.5+ is open-ended for everyone above 4.5.
const SKILL_LEVELS: { label: string; min: number; max: number | null }[] = [
  { label: "3.0", min: 3.0, max: 3.49 },
  { label: "3.5", min: 3.5, max: 3.99 },
  { label: "4.0", min: 4.0, max: 4.49 },
  { label: "4.5+", min: 4.5, max: null },
];

const GENDER_COLS: { id: Gender; label: string }[] = [
  { id: "men", label: "Mens" },
  { id: "women", label: "Womens" },
  { id: "mixed", label: "Mixed" },
];

function buildDefaultTemplate(): DefaultDivision[] {
  const out: DefaultDivision[] = [];
  for (const g of GENDER_COLS) {
    for (const s of SKILL_LEVELS) {
      out.push({
        id: `${g.id}-${s.label}`,
        name: `${g.label} ${s.label}`,
        format: "doubles",
        gender: g.id,
        min_rating: s.min,
        max_rating: s.max,
      });
    }
  }
  return out;
}

// Identity for matching existing events against the default template
// — same gender + format + rating window means "already covered."
function divisionKey(d: {
  gender: Gender;
  format: Format;
  min_rating: number | null;
  max_rating: number | null;
}): string {
  return `${d.gender}-${d.format}-${d.min_rating ?? "lo"}-${d.max_rating ?? "hi"}`;
}

function EventsStep({
  tournament,
  events,
  orgSlug,
  busy,
  onAddDefaults,
  onRemoveEvent,
}: {
  tournament: Tournament | null;
  events: Event[];
  orgSlug: string;
  busy: boolean;
  onAddDefaults: (divs: DefaultDivision[]) => void;
  onRemoveEvent: (id: string) => void;
}) {
  // Compute template data unconditionally so hooks below are always called
  // in the same order regardless of whether tournament is null (Rules of Hooks).
  const existingKeys = new Set(events.map(divisionKey));
  const allTemplates = buildDefaultTemplate();
  const availableTemplates = allTemplates.filter(
    (d) => !existingKeys.has(divisionKey(d)),
  );

  // Start with every available template pre-checked so a first-time
  // organizer can click one button and ship the whole bracket. They
  // un-check what they don't want.
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(availableTemplates.map((d) => d.id)),
  );
  // Re-seed when the set of available templates changes (after add).
  useEffect(() => {
    setChecked((prev) => {
      const next = new Set<string>();
      for (const t of availableTemplates) {
        // Default to checked for any newly-available template.
        next.add(prev.has(t.id) ? t.id : t.id);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length]);

  if (!tournament) {
    return (
      <div>
        <StepHeader
          title="Events"
          lede="Save Basics first — events attach to a draft tournament. Click ← Back if you haven't filled in Basics yet."
        />
      </div>
    );
  }

  const checkedCount = availableTemplates.filter((d) => checked.has(d.id))
    .length;

  return (
    <div>
      <StepHeader
        title="Events"
        lede="Each event is one bracket players can register for. We've pre-checked the common club divisions — uncheck the ones you don't want, or add custom events from the bulk editor."
      />

      {events.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: ink,
              marginBottom: 8,
              fontFamily: bodyFontStack,
            }}
          >
            Added so far ({events.length})
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 0,
              border: `1px solid ${rule}`,
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            {events.map((e) => (
              <div
                key={e.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 14px",
                  background: "#ffffff",
                  borderTop: `1px solid ${ruleSoft}`,
                  fontSize: 13,
                  fontFamily: bodyFontStack,
                }}
              >
                <div>
                  <strong>{e.name}</strong>
                  <span style={{ color: inkMuted, marginLeft: 8 }}>
                    {formatEventSummary(e)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveEvent(e.id)}
                  disabled={busy}
                  style={{
                    background: "transparent",
                    border: `1px solid ${courtRed}`,
                    color: dangerFg,
                    borderRadius: 4,
                    padding: "3px 10px",
                    fontSize: 12,
                    cursor: busy ? "not-allowed" : "pointer",
                    fontFamily: bodyFontStack,
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {availableTemplates.length > 0 && (
        <div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: ink,
              marginBottom: 8,
              fontFamily: bodyFontStack,
            }}
          >
            {events.length > 0
              ? "Add more standard divisions"
              : "Standard club divisions"}
          </div>
          <div
            style={{
              border: `1px solid ${rule}`,
              borderRadius: 8,
              overflow: "hidden",
              marginBottom: 12,
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr style={{ background: bg }}>
                  <th style={templateThStyle}>Skill</th>
                  {GENDER_COLS.map((g) => (
                    <th key={g.id} style={templateThStyle}>
                      {g.label} doubles
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SKILL_LEVELS.map((s) => (
                  <tr
                    key={s.label}
                    style={{ borderTop: `1px solid ${ruleSoft}` }}
                  >
                    <td
                      style={{
                        padding: "8px 12px",
                        fontWeight: 500,
                        color: ink,
                        fontFamily: bodyFontStack,
                      }}
                    >
                      {s.label}
                    </td>
                    {GENDER_COLS.map((g) => {
                      const id = `${g.id}-${s.label}`;
                      const isAvailable = availableTemplates.some(
                        (t) => t.id === id,
                      );
                      if (!isAvailable) {
                        return (
                          <td
                            key={g.id}
                            style={{
                              padding: "8px 12px",
                              color: successFg,
                              fontSize: 12,
                              fontFamily: bodyFontStack,
                            }}
                          >
                            ✓ added
                          </td>
                        );
                      }
                      return (
                        <td
                          key={g.id}
                          style={{ padding: "8px 12px" }}
                        >
                          <label
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 6,
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={checked.has(id)}
                              onChange={(e) => {
                                const next = new Set(checked);
                                if (e.target.checked) next.add(id);
                                else next.delete(id);
                                setChecked(next);
                              }}
                            />
                            <span style={{ color: ink, fontFamily: bodyFontStack }}>Include</span>
                          </label>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              onClick={() =>
                onAddDefaults(
                  availableTemplates.filter((d) => checked.has(d.id)),
                )
              }
              disabled={busy || checkedCount === 0}
              style={{
                padding: "9px 18px",
                background: busy || checkedCount === 0 ? inkMuted : ink,
                color: "#ffffff",
                border: "none",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 700,
                cursor: busy || checkedCount === 0 ? "not-allowed" : "pointer",
                fontFamily: headingFontStack,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              {busy
                ? "Adding…"
                : checkedCount === 0
                  ? "Pick at least one division"
                  : `Add ${checkedCount} event${checkedCount === 1 ? "" : "s"}`}
            </button>
            <Link
              to={`/admin/${orgSlug}/tournaments/${tournament.slug}/events/edit`}
              style={{ fontSize: 12, color: courtBlue, textDecoration: "none", fontFamily: bodyFontStack }}
            >
              Need a custom event (singles, age group, mixed format)? Open the
              full events editor →
            </Link>
          </div>
        </div>
      )}

      {availableTemplates.length === 0 && events.length > 0 && (
        <div
          style={{
            padding: 14,
            background: successBg,
            border: `1px solid ${courtGreen}`,
            borderRadius: 8,
            fontSize: 13,
            color: successFg,
            fontFamily: bodyFontStack,
          }}
        >
          All standard divisions added. Use the{" "}
          <Link
            to={`/admin/${orgSlug}/tournaments/${tournament.slug}/events/edit`}
            style={{ color: successFg, fontWeight: 600 }}
          >
            full events editor
          </Link>{" "}
          to add custom divisions (singles, age groups, etc.) or fine-tune
          max-teams + bracket type per event.
        </div>
      )}
    </div>
  );
}

// Compact human-readable summary of an event for the wizard's list.
function formatEventSummary(e: Event): string {
  const parts: string[] = [e.format];
  if (e.gender) parts.push(`${e.gender}`);
  if (e.min_rating != null || e.max_rating != null) {
    if (e.min_rating != null && e.max_rating != null) {
      parts.push(`${e.min_rating}–${e.max_rating}`);
    } else if (e.min_rating != null) {
      parts.push(`${e.min_rating}+`);
    } else if (e.max_rating != null) {
      parts.push(`≤${e.max_rating}`);
    }
  }
  return `· ${parts.join(" · ")}`;
}

const templateThStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 11,
  fontWeight: 600,
  color: inkSoft,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  background: bg,
  fontFamily: bodyFontStack,
};

// ─────────────────────────────────────────────────────────────────────
// Step 3: Pricing
// ─────────────────────────────────────────────────────────────────────

function PricingStep({
  pattern,
  tiers,
  activeRegCount,
  onChange,
}: {
  pattern: PricingPattern;
  tiers: TierDraft[];
  activeRegCount: number;
  onChange: (p: PricingPattern, t: TierDraft[]) => void;
}) {
  return (
    <div>
      <StepHeader
        title="Pricing"
        lede="Pick how pricing should change as the tournament gets closer. Most organizers use a single price or offer an early-bird discount."
      />
      <PricingTiersEditor
        pattern={pattern}
        tiers={tiers}
        activeRegCount={activeRegCount}
        onChange={onChange}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Step 4: Cancellation policy preset picker
// ─────────────────────────────────────────────────────────────────────

type CancellationPresetMeta = {
  id: Exclude<CancellationPolicyPreset, "custom">;
  title: string;
  bullets: string[];
  goodFor: string;
};

const CANCELLATION_PRESETS: CancellationPresetMeta[] = [
  {
    id: "generous",
    title: "Generous",
    bullets: [
      "Full refund up to 7 days before the tournament starts.",
      "No refund within 7 days.",
    ],
    goodFor: "New tournaments building trust with players.",
  },
  {
    id: "standard",
    title: "Standard",
    bullets: [
      "Full refund within 7 days of registering.",
      "Half refund more than 30 days before the tournament.",
      "No refund within 7 days of the tournament.",
    ],
    goodFor: "Most tournaments. The default.",
  },
  {
    id: "strict",
    title: "Strict",
    bullets: [
      "No refunds after registration — your spot is locked in.",
    ],
    goodFor:
      "High-demand events with waitlists where you don't want flake risk.",
  },
];

function CancellationPolicyStep({
  preset,
  onChange,
}: {
  preset: CancellationPolicyPreset | null;
  onChange: (p: CancellationPolicyPreset | null) => void;
}) {
  return (
    <div>
      <StepHeader
        title="Cancellation policy"
        lede="Pick a refund policy that fits how strict you want to be. We'll show this to players before they pay, and use it to process refunds automatically when someone withdraws or if you cancel the tournament."
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        {CANCELLATION_PRESETS.map((p) => {
          const selected = preset === p.id;
          return (
            <button
              type="button"
              key={p.id}
              onClick={() => onChange(p.id)}
              style={cancellationCardStyle(selected)}
              aria-pressed={selected}
            >
              <div
                style={{
                  fontWeight: 600,
                  fontSize: 14,
                  marginBottom: 8,
                  color: ink,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontFamily: bodyFontStack,
                }}
              >
                <span style={cancellationRadioStyle(selected)} />
                {p.title}
              </div>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: 18,
                  fontSize: 12,
                  color: inkSoft,
                  lineHeight: 1.55,
                  fontFamily: bodyFontStack,
                }}
              >
                {p.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              <div
                style={{
                  marginTop: 10,
                  fontSize: 11,
                  color: inkMuted,
                  fontStyle: "italic",
                  fontFamily: bodyFontStack,
                }}
              >
                Good for: {p.goodFor}
              </div>
            </button>
          );
        })}
      </div>

      <details
        style={{
          background: cream,
          border: `1px solid ${creamDeep}`,
          borderRadius: 6,
          padding: "10px 12px",
          fontSize: 12,
          color: inkSoft,
          lineHeight: 1.55,
          fontFamily: bodyFontStack,
        }}
      >
        <summary style={{ cursor: "pointer", fontWeight: 500 }}>
          ⓘ Need something different? Custom is coming
        </summary>
        <div style={{ marginTop: 8, color: ink }}>
          A Custom preset (your own refund windows + percentages) will
          land in a follow-up slice. For now, pick whichever of the three
          presets is closest and we'll let you fine-tune later. Skipping
          is also fine — the public page falls back to "Contact the
          organizer for the refund policy."
        </div>
      </details>
    </div>
  );
}

function cancellationCardStyle(selected: boolean): CSSProperties {
  return {
    background: selected ? cream : "#ffffff",
    border: `2px solid ${selected ? ink : rule}`,
    borderRadius: 8,
    padding: 14,
    cursor: "pointer",
    textAlign: "left",
    fontFamily: bodyFontStack,
    display: "flex",
    flexDirection: "column",
  };
}

function cancellationRadioStyle(selected: boolean): CSSProperties {
  return {
    width: 14,
    height: 14,
    borderRadius: "50%",
    border: `2px solid ${selected ? ink : rule}`,
    background: selected ? ink : "#ffffff",
    boxShadow: selected ? "inset 0 0 0 3px #ffffff" : "none",
    flexShrink: 0,
    boxSizing: "border-box",
  };
}

function prettyCancellationPreset(p: CancellationPolicyPreset): string {
  switch (p) {
    case "generous":
      return "Generous";
    case "standard":
      return "Standard";
    case "strict":
      return "Strict";
    case "custom":
      return "Custom";
  }
}

function cancellationPresetSummary(p: CancellationPolicyPreset): string {
  switch (p) {
    case "generous":
      return "Full refund > 7 days before, none within 7 days.";
    case "standard":
      return "Full refund <7d after reg, half >30d before, none <7d before.";
    case "strict":
      return "No refunds after registration.";
    case "custom":
      return "Custom windows.";
  }
}

// ─────────────────────────────────────────────────────────────────────
// Steps 5 + 6: Sponsors & FAQs — markdown textarea steps
// ─────────────────────────────────────────────────────────────────────

function MarkdownStep({
  title,
  lede,
  placeholder,
  value,
  onChange,
}: {
  title: string;
  lede: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <StepHeader title={title} lede={lede} />
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={12}
        style={{
          width: "100%",
          padding: "12px 14px",
          border: `1px solid ${rule}`,
          borderRadius: 6,
          fontSize: 14,
          fontFamily: monoFontStack,
          lineHeight: 1.55,
          resize: "vertical",
          boxSizing: "border-box",
          minHeight: 240,
          color: ink,
        }}
      />
      <div
        style={{
          marginTop: 8,
          fontSize: 12,
          color: inkMuted,
          lineHeight: 1.55,
          fontFamily: bodyFontStack,
        }}
      >
        Markdown supported: <code>**bold**</code>, <code>*italic*</code>,{" "}
        <code>[link](url)</code>, <code>- bullet</code>, blank line for a
        paragraph break. Leave empty to hide this section from the public
        page entirely.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Step 6: Content sections — additional info, refund policy, weather,
// facility info. Four optional prose blocks shown on the public page
// when non-empty. Each saves as NULL when left blank (hides section).
// ─────────────────────────────────────────────────────────────────────

function ContentSectionsStep({
  additionalInfoMd,
  setAdditionalInfoMd,
  refundPolicyMd,
  setRefundPolicyMd,
  weatherMd,
  setWeatherMd,
  facilityInfoMd,
  setFacilityInfoMd,
}: {
  additionalInfoMd: string;
  setAdditionalInfoMd: (v: string) => void;
  refundPolicyMd: string;
  setRefundPolicyMd: (v: string) => void;
  weatherMd: string;
  setWeatherMd: (v: string) => void;
  facilityInfoMd: string;
  setFacilityInfoMd: (v: string) => void;
}) {
  const sectionStyle: CSSProperties = {
    marginTop: 28,
    paddingTop: 24,
    borderTop: `1px solid ${ruleSoft}`,
  };
  const labelStyle: CSSProperties = {
    display: "block",
    fontSize: 14,
    fontWeight: 600,
    color: ink,
    marginBottom: 4,
    fontFamily: bodyFontStack,
  };
  const hintStyle: CSSProperties = {
    fontSize: 12,
    color: inkMuted,
    marginBottom: 8,
    lineHeight: 1.55,
    fontFamily: bodyFontStack,
  };
  const textareaStyle: CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    border: `1px solid ${rule}`,
    borderRadius: 6,
    fontSize: 14,
    fontFamily: monoFontStack,
    lineHeight: 1.55,
    resize: "vertical",
    boxSizing: "border-box",
    minHeight: 120,
    color: ink,
  };
  return (
    <div>
      <StepHeader
        title="Content sections"
        lede="Optional prose sections shown on the public tournament page when filled in. Leave any field empty to hide that section entirely."
      />
      <div>
        <label style={labelStyle}>Additional info</label>
        <div style={hintStyle}>
          Catch-all section for anything that doesn't fit elsewhere — schedule
          notes, bracket format, rules clarifications.
        </div>
        <textarea
          value={additionalInfoMd}
          onChange={(e) => setAdditionalInfoMd(e.target.value)}
          placeholder="## Schedule&#10;&#10;Pool play starts at 8 AM. Gold/Silver medal rounds begin at 1 PM."
          rows={5}
          style={textareaStyle}
        />
      </div>
      <div style={sectionStyle}>
        <label style={labelStyle}>Refund policy</label>
        <div style={hintStyle}>
          The refund copy players read before they pay. This is the text of
          your policy — the cancellation-policy preset (set in the previous
          step) determines the refund mechanism. Both render together on the
          public page.
        </div>
        <textarea
          value={refundPolicyMd}
          onChange={(e) => setRefundPolicyMd(e.target.value)}
          placeholder="Full refunds are available up to 14 days before the tournament. After that date, refunds are at the organizer's discretion."
          rows={5}
          style={textareaStyle}
        />
      </div>
      <div style={sectionStyle}>
        <label style={labelStyle}>Weather plan</label>
        <div style={hintStyle}>
          Rain / heat contingency so players know what happens if conditions
          turn. Shown on the public page when filled in.
        </div>
        <textarea
          value={weatherMd}
          onChange={(e) => setWeatherMd(e.target.value)}
          placeholder="Play continues in light rain. In the event of lightning or heavy rain, we pause for 30 minutes and reassess. No refunds for weather delays."
          rows={5}
          style={textareaStyle}
        />
      </div>
      <div style={sectionStyle}>
        <label style={labelStyle}>Facility info</label>
        <div style={hintStyle}>
          Parking, restrooms, food, accessibility — practical info players
          need on arrival.
        </div>
        <textarea
          value={facilityInfoMd}
          onChange={(e) => setFacilityInfoMd(e.target.value)}
          placeholder="**Parking:** Free lot off Main St, overflow on Oak Ave.&#10;&#10;**Food:** Snack bar on-site; bring your own lunch."
          rows={5}
          style={textareaStyle}
        />
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: inkMuted, lineHeight: 1.55, fontFamily: bodyFontStack }}>
        Markdown supported: <code>**bold**</code>, <code>*italic*</code>,{" "}
        <code>[link](url)</code>, <code>- bullet</code>, blank line for a
        paragraph break.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Step 7: Accept payment — Stripe Connect status surface
// ─────────────────────────────────────────────────────────────────────

type StripeStatus = Database["public"]["Enums"]["org_stripe_status"];

function PaymentStep({
  stripeStatus,
  stripeAccountId,
  orgSlug,
}: {
  stripeStatus: StripeStatus;
  stripeAccountId: string | null;
  orgSlug: string;
}) {
  const ctaLabel =
    stripeStatus === "not_connected"
      ? "Connect with Stripe →"
      : stripeStatus === "pending"
        ? "Continue Stripe onboarding →"
        : stripeStatus === "restricted"
          ? "Resolve in Stripe dashboard →"
          : "Manage Stripe settings →";

  return (
    <div>
      <StepHeader
        title="Accept payment"
        lede="Tournaments take real money via Stripe — each organization connects its own Stripe account, and players' registration fees flow into it directly (we take a small platform fee on top)."
      />

      <StripeStatusCard status={stripeStatus} accountId={stripeAccountId} />

      <div
        style={{
          marginTop: 18,
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <Link
          to={`/admin/${orgSlug}/settings/stripe`}
          style={{
            padding: "10px 18px",
            background: ink,
            color: bg,
            textDecoration: "none",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 700,
            fontFamily: headingFontStack,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {ctaLabel}
        </Link>
      </div>

      {stripeStatus !== "active" && (
        <div
          style={{
            marginTop: 16,
            padding: "10px 14px",
            background: cream,
            border: `1px solid ${creamDeep}`,
            borderRadius: 6,
            fontSize: 12,
            color: inkSoft,
            lineHeight: 1.55,
            fontFamily: bodyFontStack,
          }}
        >
          Skipping is fine for now — registrations will save and partner
          invites will fire as normal, but the "Pay" button on the
          checkout page won't actually charge a card until Stripe is
          connected. The PaymentIntent integration in the checkout flow
          is a separate follow-on.
        </div>
      )}
    </div>
  );
}

function StripeStatusCard({
  status,
  accountId,
}: {
  status: StripeStatus;
  accountId: string | null;
}) {
  const palette: Record<
    StripeStatus,
    { bg: string; border: string; fg: string; label: string; desc: string }
  > = {
    not_connected: {
      bg: warnBg,
      border: courtYellow,
      fg: warnFg,
      label: "Not connected",
      desc:
        "No Stripe account is linked to this organization yet. Until one is connected, registrations save as 'paid' without actually charging — fine for testing, not for production.",
    },
    pending: {
      bg: warnBg,
      border: courtYellow,
      fg: warnFg,
      label: "Onboarding in progress",
      desc:
        "Your Stripe account exists but verification isn't complete. Stripe usually finishes in a few minutes once you've submitted all required info.",
    },
    active: {
      bg: successBg,
      border: courtGreen,
      fg: successFg,
      label: "✓ Stripe connected",
      desc:
        "Your organization is ready to accept payments. Each registration moves money directly into your account (we take a platform fee on top).",
    },
    restricted: {
      bg: dangerBg,
      border: courtRed,
      fg: dangerFg,
      label: "⚠ Account restricted",
      desc:
        "Stripe has restricted this account — usually because of missing verification documents or a compliance flag. Resolve from your Stripe dashboard.",
    },
  };
  const p = palette[status];
  return (
    <div
      style={{
        padding: 14,
        background: p.bg,
        border: `1px solid ${p.border}`,
        borderRadius: 8,
      }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: p.fg,
          marginBottom: 6,
        }}
      >
        {p.label}
      </div>
      <div style={{ fontSize: 13, color: p.fg, lineHeight: 1.55 }}>
        {p.desc}
      </div>
      {accountId && (
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: p.fg,
            opacity: 0.7,
            fontFamily: monoFontStack,
          }}
        >
          Account: {accountId}
        </div>
      )}
    </div>
  );
}

function prettyStripeStatus(s: StripeStatus): string {
  switch (s) {
    case "not_connected":
      return "Not connected";
    case "pending":
      return "Onboarding in progress";
    case "active":
      return "Connected";
    case "restricted":
      return "Restricted";
  }
}

// (All step stubs are now real components — ComingSoonStub retired.)

// ─────────────────────────────────────────────────────────────────────
// Step 8: Review & publish
// ─────────────────────────────────────────────────────────────────────

function ReviewStep({
  tournament,
  eventCount,
  pricingTiers,
  pricingPattern,
  cancellationPreset,
  stripeStatus,
  blockers,
  softBlockers,
  onJumpTo,
}: {
  tournament: Tournament | null;
  eventCount: number;
  pricingTiers: TierDraft[];
  pricingPattern: PricingPattern;
  cancellationPreset: CancellationPolicyPreset | null;
  stripeStatus: StripeStatus;
  blockers: string[];
  softBlockers: string[];
  onJumpTo: (id: StepId) => void;
}) {
  // A saved venue is stored as location_id (location_name is null in that
  // case), so resolve its display name for the summary card below.
  const [savedVenueName, setSavedVenueName] = useState<string | null>(null);
  const venueLocationId = tournament?.location_id ?? null;
  useEffect(() => {
    if (!venueLocationId) return;
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("locations")
        .select("name")
        .eq("id", venueLocationId)
        .maybeSingle();
      if (!cancelled) setSavedVenueName(data?.name ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [venueLocationId]);

  const venueLabel =
    tournament?.location_name?.trim() ||
    (venueLocationId ? savedVenueName : null);

  return (
    <div>
      <StepHeader
        title="Review & publish"
        lede="Final check before this goes live and players can register."
      />

      {blockers.length > 0 ? (
        <div
          style={{
            marginBottom: 16,
            padding: 14,
            background: dangerBg,
            border: `1px solid ${courtRed}`,
            borderRadius: 8,
            fontSize: 13,
            color: dangerFg,
            fontFamily: bodyFontStack,
          }}
        >
          <strong>Not ready to publish yet — {blockers.length} item{blockers.length === 1 ? "" : "s"} required:</strong>
          <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div
          style={{
            marginBottom: 16,
            padding: 14,
            background: successBg,
            border: `1px solid ${courtGreen}`,
            borderRadius: 8,
            fontSize: 13,
            color: successFg,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontFamily: bodyFontStack,
          }}
        >
          <span style={{ fontSize: 16 }}>✓</span>
          <strong>Ready to publish</strong>
          {softBlockers.length > 0 && (
            <span style={{ color: warnFg, marginLeft: 8 }}>
              — {softBlockers.length} optional item{softBlockers.length === 1 ? "" : "s"} worth reviewing before you go live
            </span>
          )}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 14,
        }}
      >
        <ReviewCard
          title="Basics"
          onEdit={() => onJumpTo("basics")}
          done={!!tournament}
        >
          {tournament ? (
            <>
              <div>
                <strong>{tournament.name}</strong>
              </div>
              <div style={{ color: inkSoft, marginTop: 4, fontFamily: bodyFontStack }}>
                {fmtDate(tournament.starts_at)} – {fmtDate(tournament.ends_at)}
              </div>
              {venueLabel && (
                <div style={{ color: inkSoft, marginTop: 2, fontFamily: bodyFontStack }}>
                  {venueLabel}
                </div>
              )}
            </>
          ) : (
            <div style={{ color: warnFg, fontFamily: bodyFontStack }}>Not saved yet.</div>
          )}
        </ReviewCard>

        <ReviewCard
          title="Events"
          onEdit={() => onJumpTo("events")}
          done={eventCount > 0}
        >
          {eventCount > 0 ? (
            <div style={{ fontFamily: bodyFontStack }}>
              {eventCount} event{eventCount === 1 ? "" : "s"} configured
            </div>
          ) : (
            <div style={{ color: warnFg, fontFamily: bodyFontStack }}>
              At least one event is required.
            </div>
          )}
        </ReviewCard>

        <ReviewCard
          title="Pricing"
          onEdit={() => onJumpTo("pricing")}
          done={pricingTiers.length > 0}
        >
          <div style={{ fontFamily: bodyFontStack }}>
            Pattern: <strong>{prettyPattern(pricingPattern)}</strong>
          </div>
          <div style={{ color: inkSoft, marginTop: 4, fontFamily: bodyFontStack }}>
            {pricingTiers.length} tier
            {pricingTiers.length === 1 ? "" : "s"}
          </div>
        </ReviewCard>

        <ReviewCard
          title="Cancellation policy"
          onEdit={() => onJumpTo("cancellation")}
          done={!!cancellationPreset}
        >
          {cancellationPreset ? (
            <>
              <div style={{ fontFamily: bodyFontStack }}>
                <strong>{prettyCancellationPreset(cancellationPreset)}</strong>
              </div>
              <div style={{ color: inkSoft, marginTop: 4, fontFamily: bodyFontStack }}>
                {cancellationPresetSummary(cancellationPreset)}
              </div>
            </>
          ) : (
            <div style={{ color: warnFg, fontFamily: bodyFontStack }}>
              Not set — public page will show "Contact organizer for refunds."
            </div>
          )}
        </ReviewCard>

        <ReviewCard
          title="Payment"
          onEdit={() => onJumpTo("payment")}
          done={stripeStatus === "active"}
        >
          <div style={{ fontFamily: bodyFontStack }}>
            <strong>{prettyStripeStatus(stripeStatus)}</strong>
          </div>
          {stripeStatus !== "active" && (
            <div style={{ color: warnFg, marginTop: 4, fontFamily: bodyFontStack }}>
              Registrations will save without charging until Stripe is
              connected — fine for testing, not for production.
            </div>
          )}
        </ReviewCard>

        <ReviewCard
          title="Other optional steps"
          onEdit={() => onJumpTo("sponsors")}
          done={true}
        >
          <div style={{ color: inkSoft, fontFamily: bodyFontStack }}>
            Sponsors, FAQs — fill in either now or after publish.
          </div>
        </ReviewCard>
      </div>

    </div>
  );
}

function ReviewCard({
  title,
  onEdit,
  done,
  children,
}: {
  title: string;
  onEdit: () => void;
  done: boolean;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        padding: 14,
        background: done ? "#ffffff" : warnBg,
        border: `1px solid ${done ? rule : courtYellow}`,
        borderRadius: 8,
        fontSize: 13,
        fontFamily: bodyFontStack,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <strong style={{ color: ink }}>{title}</strong>
        <button
          type="button"
          onClick={onEdit}
          style={{
            background: "transparent",
            border: "none",
            color: courtBlue,
            cursor: "pointer",
            fontSize: 12,
            fontFamily: bodyFontStack,
          }}
        >
          Edit
        </button>
      </div>
      <div>{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Shared UI bits
// ─────────────────────────────────────────────────────────────────────

function StepHeader({ title, lede }: { title: string; lede: string }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: ink, fontFamily: headingFontStack, textTransform: "uppercase", letterSpacing: "0.04em" }}>{title}</h1>
      <p style={{ margin: "6px 0 0", color: inkSoft, fontSize: 14, lineHeight: 1.55, fontFamily: bodyFontStack }}>
        {lede}
      </p>
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
        color: inkSoft,
        marginBottom: 14,
        fontFamily: bodyFontStack,
      }}
    >
      <span>
        {label}
        {required && <span style={{ color: courtRed, marginLeft: 4 }}>*</span>}
      </span>
      {children}
      {hint && (
        <span style={{ fontSize: 12, color: inkMuted, marginTop: 2 }}>
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

// ─────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────

const shellStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "260px 1fr",
  gap: 24,
  alignItems: "start",
};

const railStyle: CSSProperties = {
  position: "sticky",
  top: 24,
  background: bg,
  border: `1px solid ${rule}`,
  borderRadius: 10,
  padding: 18,
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const stepListStyle: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

function stepBtnStyle(state: "done" | "active" | "todo"): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    padding: "8px 10px",
    background: state === "active" ? "#ffffff" : "transparent",
    border: state === "active" ? `1px solid ${rule}` : "1px solid transparent",
    borderRadius: 6,
    cursor: "pointer",
    textAlign: "left",
    fontFamily: bodyFontStack,
    color: state === "todo" ? inkMuted : ink,
  };
}

function indicatorStyle(state: "done" | "active" | "todo"): CSSProperties {
  return {
    width: 22,
    height: 22,
    borderRadius: "50%",
    background:
      state === "done"
        ? courtGreen
        : state === "active"
          ? ink
          : rule,
    color: state === "todo" ? inkMuted : "#ffffff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 11,
    fontWeight: 600,
    flexShrink: 0,
  };
}

const paneStyle: CSSProperties = {
  background: "#ffffff",
  border: `1px solid ${rule}`,
  borderRadius: 10,
  padding: "26px 30px",
  minHeight: 400,
  fontFamily: bodyFontStack,
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  border: `1px solid ${rule}`,
  borderRadius: 6,
  fontSize: 14,
  fontFamily: bodyFontStack,
  color: ink,
  boxSizing: "border-box",
};

const actionBarStyle: CSSProperties = {
  marginTop: 22,
  paddingTop: 16,
  borderTop: `1px solid ${ruleSoft}`,
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

const btnGhost: CSSProperties = {
  padding: "9px 18px",
  background: "transparent",
  color: inkSoft,
  border: `1px solid ${rule}`,
  borderRadius: 6,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: bodyFontStack,
};

const btnSecondary: CSSProperties = {
  padding: "9px 18px",
  background: "transparent",
  color: ink,
  border: `2px solid ${ink}`,
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: headingFontStack,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

function btnPrimary(disabled: boolean): CSSProperties {
  return {
    padding: "9px 22px",
    background: disabled ? inkMuted : ink,
    color: "#ffffff",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: headingFontStack,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers (mirror TournamentFormPage's set — kept inline to match the
// "bits inline" project convention)
// ─────────────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function toIso(localValue: string): string | null {
  if (!localValue) return null;
  return new Date(localValue).toISOString();
}

function isoToLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function prettyPattern(p: PricingPattern): string {
  switch (p) {
    case "single":
      return "Single price";
    case "early_bird":
      return "Early bird";
    case "early_bird_plus_late":
      return "Early bird + Late fee";
    case "custom":
      return "Custom";
  }
}
