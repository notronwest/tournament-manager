import { useState, type CSSProperties } from "react";
import { supabase } from "../supabase";
import {
  emptySelection,
  type PlayerSelection,
} from "./PlayerPicker";
import type { Database } from "../types/supabase";

type Player = Database["public"]["Tables"]["players"]["Row"];

// Search-and-list variant of the player picker, designed for the
// public registration flow where users may not be technically savvy.
// Same selection shape as PlayerPicker (so persistPlayerSelection
// works against either), but a deliberate UX:
//
//   * The user types in a search box and clicks "Search" (or
//     presses Enter). Results don't appear as a typeahead dropdown
//     that vanishes while they're reading — they stay on the page.
//   * Each result is a row with name, email, phone, ratings, and a
//     big "Pick" button. Easy to scan, easy to tap.
//   * Below the results, an always-visible "+ Add new player" card
//     frames the alternative: "Don't see them?"
//
// PlayerPicker (the typeahead) stays in use on admin pages where
// power users want speed. PartnerSearch is the no-jumpy-UI flavor
// for first-time registrants.
//
// Selection states render the same as PlayerPicker:
//   * existing → a compact chip with name + contact info, × clears.
//   * new      → an inline first/last/email/phone form.
//   * empty    → the search panel itself.
export function PartnerSearch({
  selection,
  onChange,
  excludePlayerIds = [],
}: {
  selection: PlayerSelection;
  onChange: (s: PlayerSelection) => void;
  excludePlayerIds?: string[];
}) {
  const [query, setQuery] = useState("");
  // What the user actually clicked Search on (so the "matches for X"
  // line stays consistent even after they keep typing).
  const [committedQuery, setCommittedQuery] = useState("");
  const [results, setResults] = useState<Player[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const runSearch = async () => {
    const q = query.trim();
    if (q.length < 2) {
      setHasSearched(true);
      setCommittedQuery(q);
      setResults([]);
      return;
    }
    setSearching(true);
    setHasSearched(true);
    setCommittedQuery(q);
    // Each space-separated token must match SOME field — supports
    // searching by full name even though first/last are separate
    // columns.
    const parts = q.split(/\s+/).filter(Boolean).slice(0, 4);
    let req = supabase
      .from("players")
      .select("*")
      .is("deleted_at", null);
    for (const part of parts) {
      const safe = part.replace(/[%,()]/g, "");
      if (!safe) continue;
      req = req.or(
        `first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,email.ilike.%${safe}%,phone.ilike.%${safe}%`,
      );
    }
    const { data } = await req.limit(20);
    setSearching(false);
    setResults((data ?? []).filter((p) => !excludePlayerIds.includes(p.id)));
  };

  // ─── EXISTING mode: chip + × ──────────────────────────────────────
  if (selection.mode === "existing") {
    const p = selection.player;
    return (
      <div style={chipRow}>
        <Avatar
          first={p.first_name ?? ""}
          last={p.last_name ?? ""}
          size={36}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500 }}>
            {p.first_name} {p.last_name}
          </div>
          {(p.email || p.phone) && (
            <div style={{ fontSize: 12, color: "#1e40af", marginTop: 2 }}>
              {[p.email, p.phone].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>
        {/* "Change" instead of a bare ×. The × was small enough to
            miss, and the label tells the user what's going to
            happen — clear the chip and surface the search input so
            they can pick someone else. */}
        <button
          type="button"
          onClick={() => {
            onChange(emptySelection);
            setQuery("");
            setCommittedQuery("");
            setResults([]);
            setHasSearched(false);
          }}
          style={changeBtn}
          aria-label="Change partner"
          title="Change partner"
        >
          Change
        </button>
      </div>
    );
  }

  // ─── NEW mode: inline create form ─────────────────────────────────
  if (selection.mode === "new") {
    return (
      <div style={newCardStyle}>
        <div
          style={{
            fontSize: 12,
            color: "#444",
            marginBottom: 8,
            fontWeight: 500,
          }}
        >
          New partner — we'll email them an invite to confirm
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            type="text"
            placeholder="First name *"
            value={selection.firstName}
            onChange={(e) =>
              onChange({ ...selection, firstName: e.target.value })
            }
            style={inputStyle}
          />
          <input
            type="text"
            placeholder="Last name *"
            value={selection.lastName}
            onChange={(e) =>
              onChange({ ...selection, lastName: e.target.value })
            }
            style={inputStyle}
          />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="email"
            placeholder="Email *"
            value={selection.email}
            onChange={(e) =>
              onChange({ ...selection, email: e.target.value })
            }
            style={inputStyle}
          />
          <input
            type="tel"
            placeholder="Phone (optional)"
            value={selection.phone}
            onChange={(e) =>
              onChange({ ...selection, phone: e.target.value })
            }
            style={inputStyle}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            onChange(emptySelection);
            setQuery("");
            setCommittedQuery("");
            setHasSearched(false);
          }}
          style={inlineLinkBtn}
        >
          ← Search again
        </button>
      </div>
    );
  }

  // ─── EMPTY mode: search panel ─────────────────────────────────────
  const trimmed = query.trim();
  const showResults = hasSearched && committedQuery.length >= 2;
  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 8,
        }}
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void runSearch();
            }
          }}
          placeholder="Search by name, email, or phone…"
          style={{ ...inputStyle, flex: 1 }}
        />
        <button
          type="button"
          onClick={() => void runSearch()}
          disabled={searching || trimmed.length < 2}
          style={primaryBtn(searching || trimmed.length < 2)}
        >
          {searching ? "Searching…" : "Search"}
        </button>
      </div>

      {showResults && (
        <>
          <div style={resultsLabel}>
            {results.length === 0
              ? `No players matching "${committedQuery}"`
              : `${results.length} match${results.length === 1 ? "" : "es"} for "${committedQuery}"`}
          </div>
          {results.length > 0 && (
            <div style={resultsList}>
              {results.map((p) => (
                <div key={p.id} style={resultRow}>
                  <Avatar
                    first={p.first_name ?? ""}
                    last={p.last_name ?? ""}
                    size={36}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>
                      {p.first_name} {p.last_name}
                    </div>
                    <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
                      {formatPlayerMeta(p) || "—"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      onChange({
                        mode: "existing",
                        player: p,
                        // Seed drafts from the picked player's stored
                        // contact info so persistPlayerSelection's
                        // diff stays empty when nothing's been edited.
                        // Defaulting to "" would always produce a
                        // diff and fire an UPDATE — which RLS blocks
                        // for cross-user writes and breaks the whole
                        // registration submit ("Cannot coerce...").
                        emailDraft: p.email ?? "",
                        phoneDraft: p.phone ?? "",
                      })
                    }
                    style={pickBtn}
                  >
                    Pick
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Always-visible Add-new card framed as "don't see them?" */}
      <div style={addNewCard}>
        <div style={{ fontSize: 13, color: "#555" }}>
          {showResults && results.length === 0
            ? "Couldn't find them?"
            : "Don't see them?"}{" "}
          You can invite someone new.
        </div>
        <button
          type="button"
          onClick={() => {
            // Pre-fill first/last from the query if it looks like a
            // name (one or two words). Email stays empty for the
            // user to enter.
            const parts = trimmed.split(/\s+/);
            onChange({
              mode: "new",
              firstName: parts[0] ?? "",
              lastName: parts.slice(1).join(" "),
              email: "",
              phone: "",
            });
          }}
          style={addNewBtn}
        >
          + Add new player
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bits
// ─────────────────────────────────────────────────────────────────────

function Avatar({
  first,
  last,
  size,
}: {
  first: string;
  last: string;
  size: number;
}) {
  const initials = `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase() || "?";
  return (
    <div
      style={{
        width: size,
        height: size,
        background: "#e0e7ff",
        color: "#4338ca",
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 600,
        fontSize: Math.round(size * 0.36),
        flexShrink: 0,
      }}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}

// Compact "email · phone · 3.5 mixed" line. Skips anything blank.
// Ratings stored as numeric in Postgres come back as 3 (not 3.0) when
// the trailing zero is "dropped" — format with toFixed(1) so "3
// doubles" doesn't look like "3 doubles events."
function formatPlayerMeta(p: Player): string {
  const bits: string[] = [];
  if (p.email) bits.push(p.email);
  if (p.phone) bits.push(p.phone);
  const r =
    p.self_rating_doubles ??
    p.self_rating_mixed ??
    p.self_rating_singles;
  if (r != null) {
    const which =
      p.self_rating_doubles != null
        ? "doubles"
        : p.self_rating_mixed != null
          ? "mixed"
          : "singles";
    bits.push(`${r.toFixed(1)} ${which}`);
  }
  return bits.join(" · ");
}

// ─── Styles ───────────────────────────────────────────────────────────

const inputStyle: CSSProperties = {
  padding: "10px 12px",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  width: "100%",
  background: "#fff",
};

function primaryBtn(disabled: boolean): CSSProperties {
  return {
    padding: "10px 18px",
    background: disabled ? "#9ca3af" : "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  };
}

const pickBtn: CSSProperties = {
  padding: "6px 14px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};

const resultsLabel: CSSProperties = {
  fontSize: 11,
  color: "#888",
  margin: "12px 0 6px",
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const resultsList: CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  overflow: "hidden",
  background: "#fff",
};

const resultRow: CSSProperties = {
  padding: "12px 14px",
  background: "#fff",
  borderBottom: "1px solid #f3f4f6",
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const chipRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 12px",
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  borderRadius: 8,
};

const changeBtn: CSSProperties = {
  padding: "6px 12px",
  background: "#fff",
  border: "1px solid #bfdbfe",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 500,
  color: "#1e40af",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
};

const newCardStyle: CSSProperties = {
  padding: 12,
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
};

const inlineLinkBtn: CSSProperties = {
  padding: "4px 0",
  background: "transparent",
  border: "none",
  color: "#2563eb",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
  marginTop: 8,
};

const addNewCard: CSSProperties = {
  marginTop: 12,
  padding: "12px 14px",
  background: "#fafafa",
  border: "1px dashed #d1d5db",
  borderRadius: 6,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};

const addNewBtn: CSSProperties = {
  padding: "6px 14px",
  background: "#fff",
  color: "#2563eb",
  border: "1px solid #2563eb",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
};

