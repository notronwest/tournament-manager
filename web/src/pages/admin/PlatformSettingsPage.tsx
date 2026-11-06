// Platform fee settings — the three levels, one page.
//
// The platform's cut on each registration can be set in three places, and the
// most specific one that is set wins:
//
//   Default        the rate every organizer gets unless something overrides it
//   Organization   one organizer's agreed rate, inherited by all its tournaments
//   Tournament     a single event's rate
//
// Resolution lives in resolvePlatformFee (supabase/functions/_shared/
// platformFee.ts) — the same function create-payment-intent charges with, so
// the fee shown on a row here is the number Stripe is handed, not a second
// opinion about it. The two number inputs, the validation, the worked example
// and the inherit/override choice are PlatformFeeEditor, mounted three times.
//
// Writes are gated in the database as well as here: a trigger refuses a
// platform-fee column to anyone who is not a platform admin, so an org admin
// cannot zero the platform's cut on their own org.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import { usePlatformAdmin } from "../../hooks/usePlatformAdmin";
import { PlatformFeeEditor, FeeSourceBadge } from "../../components/PlatformFeeEditor";
import {
  formatFeeShort,
  platformFeeSaveMessage,
  type PlatformFeeValue,
} from "../../lib/platformFeeDisplay";
import {
  resolvePlatformFee,
  type ResolvedPlatformFee,
} from "../../../../supabase/functions/_shared/platformFee";
import { SectionTabs } from "../../components/SectionTabs";
import {
  ink,
  inkSoft,
  inkMuted,
  rule,
  breadcrumbLinkStyle,
  pageH1Style,
  pageSubStyle,
  panelMutedStyle,
  ctaSecondaryStyle,
  inputStyle,
  statusPanelStyle,
  bodyFontStack,
} from "../../lib/publicTheme";

const FEE_TABS = [
  { key: "default" as const, label: "Default" },
  { key: "orgs" as const, label: "Organizers" },
  { key: "tournaments" as const, label: "Tournaments" },
];
type FeeTab = (typeof FEE_TABS)[number]["key"];

type FeeColumns = {
  platform_fee_bps: number | null;
  platform_fee_fixed_cents: number | null;
};

type PlatformSettingsRow = {
  platform_fee_bps: number;
  platform_fee_fixed_cents: number;
  updated_at: string;
  updated_by: string | null;
};

type OrgRow = FeeColumns & { id: string; slug: string; name: string };

type TournamentRow = FeeColumns & {
  id: string;
  slug: string;
  name: string;
  organization_id: string;
};

const TOURNAMENT_SEARCH_LIMIT = 20;
const MIN_SEARCH_CHARS = 2;

// A read that fails says what is missing and what to do, in the page's own
// words — never the database's.
// Recent is relative, older is absolute — a save ten seconds ago reading as
// a wall-clock time with seconds makes the reader do arithmetic to answer
// "was that me, just now?".
function relativeWhen(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const LOAD_FAILED = "Couldn't load the fees. Nothing has changed; reload the page to try again.";
const SEARCH_FAILED = "Couldn't search tournaments. Reload the page and try again.";

export default function PlatformSettingsPage() {
  const { user } = useAuth();
  const isPlatformAdmin = usePlatformAdmin();

  const [tab, setTab] = useState<FeeTab>("default");

  // ── Global default ──────────────────────────────────────────────────
  const [settings, setSettings] = useState<PlatformSettingsRow | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  // The name behind platform_settings.updated_by, when there is one. Null
  // leaves the "by …" clause off entirely rather than printing an id.
  const [savedByName, setSavedByName] = useState<string | null>(null);
  // "Last saved" is relative, so it has to be recomputed as time passes —
  // rendered once it would read "just now" on an open page indefinitely.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNowTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const [savingDefault, setSavingDefault] = useState(false);
  const [defaultSaveError, setDefaultSaveError] = useState<string | null>(null);
  const [defaultSavedAt, setDefaultSavedAt] = useState<string | null>(null);

  // ── Organizers ──────────────────────────────────────────────────────
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [orgSearch, setOrgSearch] = useState("");
  const [editingOrgId, setEditingOrgId] = useState<string | null>(null);
  // Busy, failed and saved are all held BY ROW ID, never page-wide. A save
  // outlives the editor that started it: close that row, or open another,
  // before the response lands and page-level state puts the answer on the
  // wrong row or on no row at all — and after an explicit Save, silence
  // reads as success. Each row owns its own outcome, and renders it on the
  // row rather than inside the editor, which may be shut by then.
  const [orgRowBusyId, setOrgRowBusyId] = useState<string | null>(null);
  const [orgRowError, setOrgRowError] = useState<{ id: string; message: string } | null>(null);
  const [orgSaved, setOrgSaved] = useState<{ id: string; at: string } | null>(null);

  // ── Tournaments ─────────────────────────────────────────────────────
  // The default view is only the tournaments that HAVE a rate of their own — a
  // short, meaningful list. Everything else is reachable by searching, so the
  // page never becomes a wall of every event ever run.
  const [overriddenTournaments, setOverriddenTournaments] = useState<TournamentRow[] | null>(null);
  const [tournamentsError, setTournamentsError] = useState<string | null>(null);
  const [tournamentSearch, setTournamentSearch] = useState("");
  // Hits carry the query they answer, so "are these results for what is
  // typed now?" is derived rather than synced by a second state write.
  const [searchHits, setSearchHits] = useState<{ q: string; rows: TournamentRow[] } | null>(null);
  const [editingTournamentId, setEditingTournamentId] = useState<string | null>(null);
  const [tournamentRowBusyId, setTournamentRowBusyId] = useState<string | null>(null);
  const [tournamentRowError, setTournamentRowError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [tournamentSaved, setTournamentSaved] = useState<{ id: string; at: string } | null>(
    null,
  );

  const defaultFee = useMemo(
    () => ({
      bps: settings?.platform_fee_bps ?? 0,
      fixedCents: settings?.platform_fee_fixed_cents ?? 0,
    }),
    [settings],
  );

  const orgById = useMemo(() => {
    const m = new Map<string, OrgRow>();
    (orgs ?? []).forEach((o) => m.set(o.id, o));
    return m;
  }, [orgs]);

  // The fee an organizer's tournaments get when they set nothing of their own:
  // the organizer's rate, else the default.
  const orgEffective = useCallback(
    (org: FeeColumns | undefined) => resolvePlatformFee(null, org ?? null, settings),
    [settings],
  );

  // ── Load ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isPlatformAdmin) return;
    let cancelled = false;
    (async () => {
      const [s, o, t] = await Promise.all([
        supabase
          .from("platform_settings")
          .select("platform_fee_bps, platform_fee_fixed_cents, updated_at, updated_by")
          .eq("id", true)
          .single(),
        supabase
          .from("organizations")
          .select("id, slug, name, platform_fee_bps, platform_fee_fixed_cents")
          .is("deleted_at", null)
          .order("name"),
        supabase
          .from("tournaments")
          .select("id, slug, name, organization_id, platform_fee_bps, platform_fee_fixed_cents")
          .is("deleted_at", null)
          .not("platform_fee_bps", "is", null)
          .order("starts_at", { ascending: false }),
      ]);
      if (cancelled) return;
      if (s.error) setSettingsError(LOAD_FAILED);
      else setSettings(s.data as PlatformSettingsRow);
      if (o.error) setOrgsError(LOAD_FAILED);
      else setOrgs(o.data as OrgRow[]);
      if (t.error) setTournamentsError(LOAD_FAILED);
      else setOverriddenTournaments(t.data as TournamentRow[]);

      const savedBy = (s.data as PlatformSettingsRow | null)?.updated_by;
      if (savedBy) {
        const { data: who } = await supabase
          .from("players")
          .select("first_name, last_name")
          .eq("auth_user_id", savedBy)
          .maybeSingle();
        if (cancelled) return;
        const name = [who?.first_name, who?.last_name].filter(Boolean).join(" ").trim();
        setSavedByName(name === "" ? null : name);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPlatformAdmin]);

  // ── Tournament search (debounced) ───────────────────────────────────
  useEffect(() => {
    const q = tournamentSearch.trim();
    if (q.length < MIN_SEARCH_CHARS) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        const { data, error } = await supabase
          .from("tournaments")
          .select("id, slug, name, organization_id, platform_fee_bps, platform_fee_fixed_cents")
          .is("deleted_at", null)
          .ilike("name", `%${q}%`)
          .order("starts_at", { ascending: false })
          .limit(TOURNAMENT_SEARCH_LIMIT);
        if (cancelled) return;
        if (error) setTournamentsError(SEARCH_FAILED);
        else setSearchHits({ q, rows: data as TournamentRow[] });
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tournamentSearch]);

  // ── Saves ───────────────────────────────────────────────────────────
  const saveDefault = async (next: PlatformFeeValue) => {
    if (!user || !next) return; // the default level always has a value
    setSavingDefault(true);
    setDefaultSaveError(null);
    setDefaultSavedAt(null);
    const { data, error } = await supabase
      .from("platform_settings")
      .update({
        platform_fee_bps: next.bps,
        platform_fee_fixed_cents: next.fixedCents,
        updated_at: new Date().toISOString(),
        updated_by: user.id,
      })
      .eq("id", true)
      .select("platform_fee_bps, platform_fee_fixed_cents, updated_at, updated_by")
      .single();
    setSavingDefault(false);
    if (error) {
      setDefaultSaveError(platformFeeSaveMessage(error));
      return;
    }
    setSettings(data as PlatformSettingsRow);
    setDefaultSavedAt((data as PlatformSettingsRow).updated_at);
  };

  const saveOrgFee = async (orgId: string, next: PlatformFeeValue) => {
    setOrgRowBusyId(orgId);
    setOrgRowError(null);
    setOrgSaved(null);
    const { data, error } = await supabase
      .from("organizations")
      .update({
        platform_fee_bps: next?.bps ?? null,
        platform_fee_fixed_cents: next?.fixedCents ?? null,
      })
      .eq("id", orgId)
      .select("id, slug, name, platform_fee_bps, platform_fee_fixed_cents")
      .single();
    setOrgRowBusyId(null);
    if (error) {
      setOrgRowError({ id: orgId, message: platformFeeSaveMessage(error) });
      // Leave the editor as the operator left it — open with their draft if
      // they are still there, shut if they closed it. The row carries the
      // refusal either way.
      return;
    }
    setOrgs((prev) => (prev ?? []).map((o) => (o.id === orgId ? (data as OrgRow) : o)));
    // Only the row that saved closes. Page-wide, this discarded whatever the
    // operator had typed in a row they opened while the save was in flight.
    setEditingOrgId((prev) => (prev === orgId ? null : prev));
    setOrgSaved({ id: orgId, at: new Date().toISOString() });
  };

  const saveTournamentFee = async (tournamentId: string, next: PlatformFeeValue) => {
    setTournamentRowBusyId(tournamentId);
    setTournamentRowError(null);
    setTournamentSaved(null);
    const { data, error } = await supabase
      .from("tournaments")
      .update({
        platform_fee_bps: next?.bps ?? null,
        platform_fee_fixed_cents: next?.fixedCents ?? null,
      })
      .eq("id", tournamentId)
      .select("id, slug, name, organization_id, platform_fee_bps, platform_fee_fixed_cents")
      .single();
    setTournamentRowBusyId(null);
    if (error) {
      setTournamentRowError({ id: tournamentId, message: platformFeeSaveMessage(error) });
      return;
    }
    const saved = data as TournamentRow;
    // The default list holds only tournaments with a rate of their own, so a
    // cleared rate leaves it and a new one joins it.
    setOverriddenTournaments((prev) => {
      const rest = (prev ?? []).filter((t) => t.id !== saved.id);
      return saved.platform_fee_bps === null ? rest : [saved, ...rest];
    });
    setSearchHits((prev) =>
      prev ? { q: prev.q, rows: prev.rows.map((t) => (t.id === saved.id ? saved : t)) } : null,
    );
    setEditingTournamentId((prev) => (prev === tournamentId ? null : prev));
    setTournamentSaved({ id: saved.id, at: new Date().toISOString() });
  };

  // ── Gates ───────────────────────────────────────────────────────────
  if (isPlatformAdmin === null) {
    return <div style={loadingStyle}>Loading platform fees…</div>;
  }

  if (!isPlatformAdmin) {
    return (
      <main style={shellStyle}>
        <h1 style={{ ...pageH1Style, fontSize: 20, marginTop: 0 }}>Access denied</h1>
        <p style={{ color: inkSoft, fontSize: 14 }}>
          This page is restricted to platform administrators.
        </p>
        <Link to="/admin" style={breadcrumbLinkStyle}>
          ← Back to admin
        </Link>
      </main>
    );
  }

  if (settingsError) {
    return (
      <main style={shellStyle}>
        <h1 style={{ ...pageH1Style, fontSize: 20, marginTop: 0 }}>Couldn't load platform fees</h1>
        <p style={{ color: inkSoft, fontSize: 14 }}>{settingsError}</p>
        <p style={{ color: inkSoft, fontSize: 14 }}>
          Reload the page to try again — nothing was changed.
        </p>
        <Link to="/admin" style={breadcrumbLinkStyle}>
          ← Back to admin
        </Link>
      </main>
    );
  }

  if (settings === null) {
    return <div style={loadingStyle}>Loading platform fees…</div>;
  }

  const customOrgCount = (orgs ?? []).filter((o) => o.platform_fee_bps !== null).length;
  const overrideCount = (overriddenTournaments ?? []).length;

  const orgQuery = orgSearch.trim().toLowerCase();
  const shownOrgs = (orgs ?? []).filter(
    (o) =>
      orgQuery === "" ||
      o.name.toLowerCase().includes(orgQuery) ||
      o.slug.toLowerCase().includes(orgQuery),
  );

  // Searching replaces the list of tournaments that set their own fee. null
  // means "still waiting" — results that answer an older query are not shown
  // as if they answered this one.
  const trimmedTournamentQuery = tournamentSearch.trim();
  const isSearching = trimmedTournamentQuery.length >= MIN_SEARCH_CHARS;
  const tournamentList = isSearching
    ? searchHits?.q === trimmedTournamentQuery
      ? searchHits.rows
      : null
    : overriddenTournaments;

  return (
    <main style={shellStyle}>
      <div style={{ marginBottom: 16 }}>
        <Link to="/admin/site" style={breadcrumbLinkStyle}>
          ← Site admin
        </Link>
      </div>

      <h1 style={{ ...pageH1Style, marginTop: 0, marginBottom: 8 }}>Platform fees</h1>
      {/* One lede, carrying both jobs it has to do: say what the page is for,
          and name all three things it lets you set with live counts, so
          standing at the top you can say what this page does without
          scrolling. It replaced a second paragraph AND the per-tab heading
          and sub that repeated it — 460px of header stack was pushing the
          only button below the fold at 390x844. */}
      <p style={{ ...pageSubStyle, marginTop: 0, marginBottom: 8, maxWidth: 620 }}>
        The platform's cut of each registration, taken from the organizer's payout. Set a fee
        for everyone, for one organizer, or for one tournament — the most specific wins.
      </p>
      <p style={{ fontSize: 13, color: inkSoft, marginTop: 0, marginBottom: 16 }}>
        Default now{" "}
        <strong style={{ color: ink }}>
          {formatFeeShort(defaultFee.bps, defaultFee.fixedCents)}
        </strong>
        {" · "}
        {customOrgCount === 0
          ? "no organizer has their own rate"
          : `${customOrgCount} organizer${customOrgCount === 1 ? "" : "s"} with their own rate`}
        {" · "}
        {overrideCount === 0
          ? "no tournament sets its own"
          : `${overrideCount} tournament${overrideCount === 1 ? "" : "s"} set their own`}
      </p>

      <SectionTabs
        tabs={FEE_TABS}
        value={tab}
        onChange={setTab}
        idPrefix="platform-fee"
        ariaLabel="Platform fee levels"
      />

      {/* ── Default ──────────────────────────────────────────────────── */}
      {tab === "default" && (
        <div
          role="tabpanel"
          id="platform-fee-panel-default"
          aria-labelledby="platform-fee-tab-default"
        >
          <p style={sectionSubStyle}>
            Every tournament that sets no fee of its own, and whose organizer sets none
            either. Changing it moves all of them at once.
          </p>
          <div style={{ ...panelMutedStyle, padding: 16 }}>
            <PlatformFeeEditor
              // Remount on each save so the draft re-seeds from what landed,
              // instead of an effect syncing it.
              key={settings.updated_at}
              idPrefix="default"
              variant="page"
              value={{
                bps: settings.platform_fee_bps,
                fixedCents: settings.platform_fee_fixed_cents,
              }}
              saving={savingDefault}
              error={defaultSaveError}
              savedAt={defaultSavedAt}
              onSave={(next) => void saveDefault(next)}
            />
          </div>
          {/* Who last saved it is named or not mentioned — a truncated
              account id is not a person, and printing one asks the reader to
              go and look something up. */}
          <p style={{ fontSize: 12, color: inkSoft, marginTop: 12 }}>
            Last saved {relativeWhen(settings.updated_at)}
            {savedByName ? ` by ${savedByName}` : ""}
          </p>
        </div>
      )}

      {/* ── Organizers ───────────────────────────────────────────────── */}
      {tab === "orgs" && (
        <div role="tabpanel" id="platform-fee-panel-orgs" aria-labelledby="platform-fee-tab-orgs">
          <p style={sectionSubStyle}>
            Set the fee every one of an organizer's tournaments inherits. A tournament that
            sets its own fee keeps it.
          </p>

          <input
            type="search"
            placeholder="Search organizers…"
            aria-label="Search organizers"
            value={orgSearch}
            onChange={(e) => setOrgSearch(e.target.value)}
            style={{ ...inputStyle, minHeight: 44, marginBottom: 16 }}
          />

          {orgsError && <div style={statusPanelStyle("danger")}>{orgsError}</div>}
          {!orgsError && orgs === null && <div style={loadingRowStyle}>Loading organizers…</div>}
          {!orgsError &&
            orgs !== null &&
            (shownOrgs.length === 0 ? (
              <div style={emptyStyle}>
                {orgSearch.trim() === ""
                  ? "No organizers yet. The first one to sign up appears here."
                  : `No organizer matches “${orgSearch.trim()}”. Clear the search to see all of them.`}
              </div>
            ) : (
              shownOrgs.map((org) => (
                <FeeRow
                  key={org.id}
                  level="organization"
                  title={org.name}
                  meta={null}
                  effective={orgEffective(org)}
                  own={ownFee(org)}
                  open={editingOrgId === org.id}
                  idPrefix={`org-${org.id}`}
                  inheritLabel="the default"
                  inheritedFee={defaultFee}
                  saving={orgRowBusyId === org.id}
                  error={orgRowError?.id === org.id ? orgRowError.message : null}
                  savedAt={orgSaved?.id === org.id ? orgSaved.at : null}
                  onToggle={() => {
                    setOrgRowError(null);
                    setOrgSaved(null);
                    setEditingOrgId(editingOrgId === org.id ? null : org.id);
                  }}
                  onSave={(next) => void saveOrgFee(org.id, next)}
                />
              ))
            ))}
        </div>
      )}

      {/* ── Tournaments ──────────────────────────────────────────────── */}
      {tab === "tournaments" && (
        <div
          role="tabpanel"
          id="platform-fee-panel-tournaments"
          aria-labelledby="platform-fee-tab-tournaments"
        >
          <p style={sectionSubStyle}>
            Tournaments that set their own fee are listed here — set the fee on any of them, or
            search to give another tournament one.
          </p>

          <input
            type="search"
            placeholder="Search all tournaments by name…"
            aria-label="Search all tournaments by name"
            value={tournamentSearch}
            onChange={(e) => setTournamentSearch(e.target.value)}
            style={{ ...inputStyle, minHeight: 44, marginBottom: 16 }}
          />

          {tournamentsError && <div style={statusPanelStyle("danger")}>{tournamentsError}</div>}
          {!tournamentsError && tournamentList === null && (
            <div style={loadingRowStyle}>
              {isSearching ? "Searching tournaments…" : "Loading tournaments…"}
            </div>
          )}
          {!tournamentsError && tournamentList !== null && tournamentList.length === 0 && (
            <div style={emptyStyle}>
              {isSearching
                ? `No tournament matches “${tournamentSearch.trim()}”. Try part of the name.`
                : "No tournament sets its own fee. Search above to set a fee on one; every other tournament follows its organizer or the default."}
            </div>
          )}
          {!tournamentsError && tournamentList !== null && tournamentList.length > 0 && (
            <div>
              {isSearching && tournamentList.length === TOURNAMENT_SEARCH_LIMIT && (
                <p style={{ fontSize: 12, color: inkSoft, marginTop: 0, marginBottom: 8 }}>
                  Showing the first {TOURNAMENT_SEARCH_LIMIT} matches — narrow the search to see
                  more.
                </p>
              )}
              {tournamentList.map((t) => {
                const org = orgById.get(t.organization_id);
                const inherited = orgEffective(org);
                return (
                  <FeeRow
                    key={t.id}
                    level="tournament"
                    title={t.name}
                    meta={org ? org.name : "Organizer unavailable"}
                    effective={resolvePlatformFee(t, org ?? null, settings)}
                    own={ownFee(t)}
                    open={editingTournamentId === t.id}
                    idPrefix={`tournament-${t.id}`}
                    inheritLabel={
                      inherited.source === "organization"
                        ? `${org?.name ?? "the organizer"}'s rate`
                        : "the default"
                    }
                    inheritedFee={{ bps: inherited.feeBps, fixedCents: inherited.feeFixedCents }}
                    saving={tournamentRowBusyId === t.id}
                    error={
                      tournamentRowError?.id === t.id ? tournamentRowError.message : null
                    }
                    savedAt={tournamentSaved?.id === t.id ? tournamentSaved.at : null}
                    onToggle={() => {
                      setTournamentRowError(null);
                      setTournamentSaved(null);
                      setEditingTournamentId(editingTournamentId === t.id ? null : t.id);
                    }}
                    onSave={(next) => void saveTournamentFee(t.id, next)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}
    </main>
  );
}

const shellStyle = {
  padding: "24px 16px",
  maxWidth: 720,
  margin: "0 auto",
  fontFamily: bodyFontStack,
};

const loadingStyle = {
  padding: 24,
  color: inkSoft,
  fontSize: 14,
  fontFamily: bodyFontStack,
};

const loadingRowStyle = {
  padding: 24,
  color: inkSoft,
  fontSize: 14,
  border: `1px solid ${rule}`,
  borderRadius: 8,
};

const emptyStyle = {
  padding: 24,
  color: inkSoft,
  fontSize: 14,
  textAlign: "center" as const,
  border: `1px dashed ${inkMuted}`,
  borderRadius: 8,
};

const sectionSubStyle = {
  fontSize: 13,
  color: inkSoft,
  marginTop: 16,
  marginBottom: 12,
  maxWidth: 560,
};

// Name + fee on the left, badge + the row's one control on the right; wraps to
// stacked rather than squeezing the name column to nothing at 390px
// (DESIGN_PREFERENCES mobile-first — the EventCard failure).
const rowHeadStyle = {
  display: "flex" as const,
  flexWrap: "wrap" as const,
  alignItems: "center" as const,
  gap: 12,
};

const rowTextStyle = {
  flex: "1 1 200px",
  minWidth: 0,
};

const rowMetaStyle = {
  fontSize: 12,
  color: inkSoft,
  marginTop: 4,
};

const rowActionsStyle = {
  display: "flex" as const,
  alignItems: "center" as const,
  gap: 8,
  marginLeft: "auto" as const,
};

// Secondary, never filled: the only filled button on screen is inside
// whichever editor is open.
const rowButtonStyle = {
  ...ctaSecondaryStyle,
  fontSize: 13,
  padding: "10px 16px",
  minHeight: 44,
  whiteSpace: "nowrap" as const,
};

const editorWellStyle = {
  marginTop: 16,
  paddingTop: 16,
  borderTop: `1px solid ${rule}`,
};

// One list row at either level: name, the fee that applies now, where it came
// from, and the row's single control. Opening it mounts the shared editor —
// the organizer list and the tournament list differ only in the strings they
// hand in, so there is one row component, not two.
function FeeRow({
  level,
  title,
  meta,
  effective,
  own,
  open,
  idPrefix,
  inheritLabel,
  inheritedFee,
  saving,
  error,
  savedAt,
  onToggle,
  onSave,
}: {
  // Which list this row is in — decides whether the fee's origin is worth
  // naming (see the meta line) and nothing else.
  level: "organization" | "tournament";
  title: string;
  meta: string | null;
  effective: ResolvedPlatformFee;
  own: PlatformFeeValue;
  open: boolean;
  idPrefix: string;
  inheritLabel: string;
  inheritedFee: { bps: number; fixedCents: number };
  saving: boolean;
  error: string | null;
  // When this row last saved, or null. Shown on the ROW, not inside the
  // editor, because saving collapses the editor — and when the saved value
  // equals the inherited one the badge is the only other thing that moves.
  // A timestamp, not a flag: "just now" written into the markup stays "just
  // now" for as long as the page is open.
  savedAt: string | null;
  onToggle: () => void;
  onSave: (next: PlatformFeeValue) => void;
}) {
  return (
    <div style={{ ...panelMutedStyle, padding: 16, marginBottom: 8 }}>
      <div style={rowHeadStyle}>
        <div style={rowTextStyle}>
          <div style={{ fontSize: 14, fontWeight: 600, color: ink }}>{title}</div>
          <div style={rowMetaStyle}>
            {meta ? `${meta} · ` : ""}
            {formatFeeShort(effective.feeBps, effective.feeFixedCents)}
            {/* Say where the fee came from only when it came from somewhere
                ELSE. On an organizer's own row "from the organizer" would be
                telling them a rate is their own rate. */}
            {effective.source === "default"
              ? " — from the default"
              : effective.source === "organization" && level === "tournament"
                ? " — from the organizer"
                : ""}
          </div>
        </div>
        <div style={rowActionsStyle}>
          <FeeSourceBadge source={effective.source} />
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            style={rowButtonStyle}
          >
            {open ? "Close" : "Set fee"}
          </button>
        </div>
      </div>
      {savedAt && !open && (
        <div style={{ ...statusPanelStyle("success"), marginTop: 12, fontSize: 13 }}>
          Saved {relativeWhen(savedAt)} — this fee applies to the next registration taken.
        </div>
      )}
      {/* Outside the `open` guard on purpose: a refusal that arrives after
          the operator closed the row still has to reach them, and on the row
          they acted on. */}
      {error && !open && (
        <div style={{ ...statusPanelStyle("danger"), marginTop: 12, fontSize: 13 }}>{error}</div>
      )}
      {open && (
        <div style={editorWellStyle}>
          <PlatformFeeEditor
            idPrefix={idPrefix}
            variant="inline"
            value={own}
            inheritLabel={inheritLabel}
            inheritedFee={inheritedFee}
            saving={saving}
            error={error}
            onSave={onSave}
          />
        </div>
      )}
    </div>
  );
}

// Both levels store a fee the same way: both columns set, or both null.
function ownFee(row: FeeColumns): PlatformFeeValue {
  return row.platform_fee_bps !== null && row.platform_fee_fixed_cents !== null
    ? { bps: row.platform_fee_bps, fixedCents: row.platform_fee_fixed_cents }
    : null;
}
