import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { supabase } from "../supabase";
import type { Database } from "../types/supabase";

type Player = Database["public"]["Tables"]["players"]["Row"];

// Three states a slot can be in: empty, an existing player picked
// (with optional draft updates to fill missing email/phone), or a new
// player being entered inline. Stored on the parent so the consuming
// form can submit / validate / reset the whole shape at once.
export type PlayerSelection =
  | { mode: "empty" }
  | {
      mode: "existing";
      player: Player;
      // Drafts let the organizer fill in missing email/phone (or
      // overwrite stale values) at registration time. Empty string =
      // no change to that field.
      emailDraft: string;
      phoneDraft: string;
    }
  | {
      mode: "new";
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
    };

export const emptySelection: PlayerSelection = { mode: "empty" };

// Player picker: typeahead search over the global players table.
//   - Type a name / email / phone → live results.
//   - Click a result → switches to "existing" mode with editable
//     contact-info drafts (only relevant if missing or being updated).
//   - "+ Add new …" creates an inline new-player form pre-filled
//     with the typed query.
//
// Excludes any player whose id appears in `excludePlayerIds` (used to
// stop a doubles partner from being picked twice).
export function PlayerPicker({
  label,
  selection,
  onChange,
  excludePlayerIds = [],
}: {
  label: string;
  selection: PlayerSelection;
  onChange: (s: PlayerSelection) => void;
  excludePlayerIds?: string[];
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Player[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Debounced typeahead. Each space-separated token must match SOME
  // field — supports searching by full name even with the schema's
  // separate first/last columns.
  useEffect(() => {
    if (selection.mode !== "empty") return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(async () => {
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
      const { data, error } = await req.limit(8);
      if (cancelled) return;
      setSearching(false);
      if (error) {
        setResults([]);
        return;
      }
      setResults(
        (data ?? []).filter((p) => !excludePlayerIds.includes(p.id)),
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, selection.mode, excludePlayerIds]);

  // Click outside to close the dropdown.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // ─── EXISTING / NEW modes: collapsed chip + contact fields ─────────
  if (selection.mode === "existing") {
    const p = selection.player;
    const needsEmail = !p.email;
    const needsPhone = !p.phone;
    return (
      <div style={slotStyle}>
        <SlotLabel label={label} />
        <div style={chipRow}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500, fontSize: 13 }}>
              {p.first_name} {p.last_name}
            </div>
            {(p.email || p.phone) && (
              <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
                {[p.email, p.phone].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              onChange(emptySelection);
              setQuery("");
            }}
            style={clearBtn}
            aria-label="Clear selection"
          >
            ×
          </button>
        </div>
        {(needsEmail || needsPhone) && (
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            {needsEmail && (
              <input
                type="email"
                placeholder="Email (optional)"
                value={selection.emailDraft}
                onChange={(e) =>
                  onChange({ ...selection, emailDraft: e.target.value })
                }
                style={miniInput}
              />
            )}
            {needsPhone && (
              <input
                type="tel"
                placeholder="Phone (optional)"
                value={selection.phoneDraft}
                onChange={(e) =>
                  onChange({ ...selection, phoneDraft: e.target.value })
                }
                style={miniInput}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  if (selection.mode === "new") {
    return (
      <div style={slotStyle}>
        <SlotLabel label={`${label} (new)`} />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              placeholder="First name *"
              value={selection.firstName}
              onChange={(e) =>
                onChange({ ...selection, firstName: e.target.value })
              }
              style={miniInput}
            />
            <input
              type="text"
              placeholder="Last name *"
              value={selection.lastName}
              onChange={(e) =>
                onChange({ ...selection, lastName: e.target.value })
              }
              style={miniInput}
            />
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="email"
              placeholder="Email (optional)"
              value={selection.email}
              onChange={(e) =>
                onChange({ ...selection, email: e.target.value })
              }
              style={miniInput}
            />
            <input
              type="tel"
              placeholder="Phone (optional)"
              value={selection.phone}
              onChange={(e) =>
                onChange({ ...selection, phone: e.target.value })
              }
              style={miniInput}
            />
          </div>
          <button
            type="button"
            onClick={() => {
              onChange(emptySelection);
              setQuery("");
            }}
            style={{ ...clearBtnInline, alignSelf: "flex-start" }}
          >
            ← Search instead
          </button>
        </div>
      </div>
    );
  }

  // ─── EMPTY mode: search input + dropdown ──────────────────────────
  const trimmed = query.trim();
  const showCreate = trimmed.length >= 2;
  return (
    <div style={slotStyle} ref={containerRef}>
      <SlotLabel label={label} />
      <div style={{ position: "relative" }}>
        <input
          type="text"
          placeholder="Search by name, email, or phone…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          style={miniInput}
        />
        {open && (results.length > 0 || showCreate) && (
          <div style={dropdownStyle}>
            {searching && results.length === 0 && (
              <div style={dropdownEmptyStyle}>Searching…</div>
            )}
            {results.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onChange({
                    mode: "existing",
                    player: p,
                    emailDraft: "",
                    phoneDraft: "",
                  });
                  setOpen(false);
                  setQuery("");
                }}
                style={dropdownItemStyle}
              >
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {p.first_name} {p.last_name}
                </div>
                {(p.email || p.phone) && (
                  <div
                    style={{
                      fontSize: 11,
                      color: "#888",
                      marginTop: 1,
                    }}
                  >
                    {[p.email, p.phone].filter(Boolean).join(" · ")}
                  </div>
                )}
              </button>
            ))}
            {!searching && results.length === 0 && trimmed.length >= 2 && (
              <div style={dropdownEmptyStyle}>No matches.</div>
            )}
            {showCreate && (
              <button
                type="button"
                onClick={() => {
                  // Pre-fill first/last from the query — split on the
                  // first whitespace so "John Doe" → John, Doe and
                  // "John" → John, "" lets the organizer fill the
                  // last name.
                  const parts = trimmed.split(/\s+/);
                  onChange({
                    mode: "new",
                    firstName: parts[0] ?? "",
                    lastName: parts.slice(1).join(" "),
                    email: "",
                    phone: "",
                  });
                  setOpen(false);
                  setQuery("");
                }}
                style={dropdownCreateStyle}
              >
                + Add new player{trimmed ? `: "${trimmed}"` : ""}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Persists the selected player to the database, returning the canonical
// Player row. Pulled out of the form so call sites don't repeat it.
//   - existing mode: applies any draft email/phone updates to the
//     existing row.
//   - new mode:      inserts a new players row.
//   - empty mode:    returns null (caller should reject before this).
export async function persistPlayerSelection(
  s: PlayerSelection,
): Promise<{ player: Player | null; error: string | null }> {
  if (s.mode === "empty") {
    return { player: null, error: "No player selected." };
  }
  if (s.mode === "existing") {
    const updates: Partial<{ email: string; phone: string }> = {};
    if (s.emailDraft.trim() && s.emailDraft.trim() !== (s.player.email ?? "")) {
      updates.email = s.emailDraft.trim();
    }
    if (s.phoneDraft.trim() && s.phoneDraft.trim() !== (s.player.phone ?? "")) {
      updates.phone = s.phoneDraft.trim();
    }
    if (Object.keys(updates).length === 0) {
      return { player: s.player, error: null };
    }
    const { data, error } = await supabase
      .from("players")
      .update(updates)
      .eq("id", s.player.id)
      .select()
      .single();
    if (error || !data) {
      return { player: null, error: error?.message ?? "Update failed." };
    }
    return { player: data, error: null };
  }
  // new
  const first = s.firstName.trim();
  const last = s.lastName.trim();
  if (!first || !last) {
    return { player: null, error: "First and last name are required." };
  }
  const { data, error } = await supabase
    .from("players")
    .insert({
      first_name: first,
      last_name: last,
      email: s.email.trim() || null,
      phone: s.phone.trim() || null,
    })
    .select()
    .single();
  if (error || !data) {
    return { player: null, error: error?.message ?? "Insert failed." };
  }
  return { player: data, error: null };
}

// ─────────────────────────────────────────────────────────────────────
// Bits + styles
// ─────────────────────────────────────────────────────────────────────

function SlotLabel({ label }: { label: string }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: "#888",
        textTransform: "uppercase",
        letterSpacing: 0.5,
        marginBottom: 4,
      }}
    >
      {label}
    </div>
  );
}

const slotStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const chipRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  background: "#fff",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
};

const miniInput: CSSProperties = {
  flex: 1,
  width: "100%",
  padding: "6px 10px",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 13,
  fontFamily: "inherit",
};

const clearBtn: CSSProperties = {
  width: 22,
  height: 22,
  padding: 0,
  background: "transparent",
  border: "1px solid #e2e2e2",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
  color: "#666",
  fontFamily: "inherit",
};

const clearBtnInline: CSSProperties = {
  padding: "2px 6px",
  background: "transparent",
  border: "none",
  fontSize: 12,
  color: "#2563eb",
  cursor: "pointer",
  fontFamily: "inherit",
};

const dropdownStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 0,
  right: 0,
  background: "#fff",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
  zIndex: 50,
  maxHeight: 280,
  overflowY: "auto",
};

const dropdownItemStyle: CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 12px",
  textAlign: "left",
  background: "transparent",
  border: "none",
  borderBottom: "1px solid #f3f4f6",
  cursor: "pointer",
  fontFamily: "inherit",
};

const dropdownCreateStyle: CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 12px",
  textAlign: "left",
  background: "#fafafa",
  border: "none",
  cursor: "pointer",
  fontSize: 12,
  color: "#2563eb",
  fontWeight: 500,
  fontFamily: "inherit",
};

const dropdownEmptyStyle: CSSProperties = {
  padding: "8px 12px",
  fontSize: 12,
  color: "#888",
};
