import { useState, useRef, useEffect } from "react";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../supabase";

// Categories surfaced in the dropdown.
const CATEGORIES = [
  { value: "bug",         label: "Bug report" },
  { value: "feature",     label: "Feature idea" },
  { value: "improvement", label: "Improvement" },
  { value: "other",       label: "Other" },
] as const;
type Category = (typeof CATEGORIES)[number]["value"];

type State =
  | { phase: "idle" }
  | { phase: "open" }
  | { phase: "submitting" }
  | { phase: "success" }
  | { phase: "error"; message: string };

// Floating feedback launcher + popover form.
// Rendered once at the App level; visible on every page.
// z-index 50 keeps it above the PendingPaymentsBar (z 30).
export default function FeedbackWidget() {
  const { session } = useAuth();
  const [state, setState] = useState<State>({ phase: "idle" });
  const [category, setCategory] = useState<Category>("bug");
  const [message, setMessage] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // On phones the floating launcher crowded the bottom sticky Register CTA
  // (#500 audit), so on mobile we hide the FAB and surface Feedback as an item
  // in the SiteHeader hamburger dropdown instead. matchMedia (inline styles,
  // no CSS media query).
  const [isMobile, setIsMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 767px)");
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Let the mobile header (which has no FAB) open the panel via a window event.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const open = () => setState({ phase: "open" });
    window.addEventListener("wmpc:open-feedback", open);
    return () => window.removeEventListener("wmpc:open-feedback", open);
  }, []);

  // Close on outside click.
  useEffect(() => {
    if (state.phase !== "open") return;
    function handler(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setState({ phase: "idle" });
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [state.phase]);

  // Focus textarea when panel opens.
  useEffect(() => {
    if (state.phase === "open") {
      setTimeout(() => textRef.current?.focus(), 50);
    }
  }, [state.phase]);

  async function handleSubmit() {
    const trimmed = message.trim();
    if (!trimmed) return;

    setState({ phase: "submitting" });

    // Pass user info from the session so the server can verify via JWT.
    const headers: Record<string, string> = {};
    if (session?.access_token) {
      headers["Authorization"] = `Bearer ${session.access_token}`;
    }

    try {
      const { data, error } = await supabase.functions.invoke(
        "submit-feedback",
        {
          body: {
            category,
            message: trimmed,
            pageUrl: window.location.href,
          },
          headers,
        },
      );

      if (error) {
        setState({ phase: "error", message: error.message || "Something went wrong. Please try again." });
        return;
      }
      if (data?.error) {
        setState({ phase: "error", message: data.error });
        return;
      }
      setState({ phase: "success" });
      setMessage("");
      setCategory("bug");
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof Error ? err.message : "Something went wrong. Please try again.",
      });
    }
  }

  function openPanel() {
    setState({ phase: "open" });
  }

  function closePanel() {
    setState({ phase: "idle" });
    setMessage("");
    setCategory("bug");
  }

  const isOpen = state.phase === "open" || state.phase === "submitting" || state.phase === "success" || state.phase === "error";

  // On mobile, with the FAB hidden and the entry point in the header, there's
  // nothing to render unless the panel is open — don't mount an empty fixed box.
  if (isMobile && !isOpen) return null;

  return (
    <div
      style={{ position: "fixed", bottom: 80, right: 20, zIndex: 50 }}
      ref={panelRef}
    >
      {/* Floating launcher button — desktop only. On mobile the entry point is
          a "Feedback" item in the SiteHeader hamburger dropdown, which dispatches
          the `wmpc:open-feedback` event the effect above listens for. */}
      {!isOpen && !isMobile && (
        <button
          onClick={openPanel}
          aria-label="Send feedback"
          title="Send feedback"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 14px",
            borderRadius: 20,
            border: "1px solid #d1d5db",
            background: "#fff",
            color: "#374151",
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
            boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
          }}
        >
          <span style={{ fontSize: 15, lineHeight: 1 }}>?</span>
          Feedback
        </button>
      )}

      {/* Popover panel */}
      {isOpen && (
        <div
          style={{
            width: 310,
            background: "#fff",
            border: "1px solid #d1d5db",
            borderRadius: 10,
            boxShadow: "0 4px 20px rgba(0,0,0,0.13)",
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 14px 10px",
              borderBottom: "1px solid #e5e7eb",
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 14, color: "#111827" }}>
              Send feedback
            </span>
            <button
              onClick={closePanel}
              aria-label="Close feedback"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "#6b7280",
                fontSize: 18,
                lineHeight: 1,
                padding: "0 2px",
              }}
            >
              ×
            </button>
          </div>

          {/* Body */}
          <div style={{ padding: "12px 14px 14px" }}>
            {state.phase === "success" ? (
              <div style={{ textAlign: "center", padding: "16px 0" }}>
                <div style={{ fontSize: 24, marginBottom: 8 }}>✓</div>
                <div style={{ fontSize: 14, color: "#111827", fontWeight: 600, marginBottom: 4 }}>
                  Thanks for your feedback!
                </div>
                <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 16 }}>
                  We filed it as a GitHub issue.
                </div>
                <button
                  onClick={closePanel}
                  style={{
                    padding: "6px 16px",
                    borderRadius: 6,
                    border: "1px solid #d1d5db",
                    background: "#fff",
                    color: "#374151",
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  Close
                </button>
              </div>
            ) : (
              <>
                {state.phase === "error" && (
                  <div
                    style={{
                      marginBottom: 10,
                      padding: "8px 10px",
                      borderRadius: 6,
                      background: "#fdeae6",
                      color: "#9c2412",
                      fontSize: 13,
                    }}
                  >
                    {state.message}
                  </div>
                )}

                {/* Category */}
                <div style={{ marginBottom: 10 }}>
                  <label
                    htmlFor="feedback-category"
                    style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 4 }}
                  >
                    Category
                  </label>
                  <select
                    id="feedback-category"
                    value={category}
                    onChange={(e) => setCategory(e.target.value as Category)}
                    disabled={state.phase === "submitting"}
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      borderRadius: 6,
                      border: "1px solid #d1d5db",
                      fontSize: 13,
                      color: "#111827",
                      background: "#fff",
                    }}
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Message */}
                <div style={{ marginBottom: 12 }}>
                  <label
                    htmlFor="feedback-message"
                    style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 4 }}
                  >
                    Message
                  </label>
                  <textarea
                    id="feedback-message"
                    ref={textRef}
                    value={message}
                    onChange={(e) => {
                      setState((s) => s.phase === "error" ? { phase: "open" } : s);
                      setMessage(e.target.value);
                    }}
                    disabled={state.phase === "submitting"}
                    rows={4}
                    maxLength={3000}
                    placeholder="Describe the issue or idea..."
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      borderRadius: 6,
                      border: "1px solid #d1d5db",
                      fontSize: 13,
                      color: "#111827",
                      resize: "vertical",
                      boxSizing: "border-box",
                    }}
                  />
                  <div style={{ fontSize: 11, color: "#9ca3af", textAlign: "right", marginTop: 2 }}>
                    {message.length}/3000
                  </div>
                </div>

                {/* Submit */}
                <button
                  onClick={handleSubmit}
                  disabled={state.phase === "submitting" || !message.trim()}
                  style={{
                    width: "100%",
                    padding: "8px 0",
                    borderRadius: 6,
                    border: "none",
                    background: message.trim() && state.phase !== "submitting" ? "#2563eb" : "#93c5fd",
                    color: "#fff",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: message.trim() && state.phase !== "submitting" ? "pointer" : "not-allowed",
                  }}
                >
                  {state.phase === "submitting" ? "Sending…" : "Send feedback"}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
