import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

// Shared confirmation modal — every "are you sure?" prompt in the app
// goes through this. Native window.confirm/alert/prompt are explicitly
// banned (see docs/DESIGN_PREFERENCES.md): native chrome breaks the
// app's visual language, blocks the JS event loop, and can't carry
// rich copy / multi-line bodies.
//
// Pass `destructive={false}` for non-destructive confirmations (apply
// changes, etc.) — flips the primary button from red to blue.
export function ConfirmModal({
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = true,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  // Esc cancels — common-enough keyboard expectation that builders
  // shouldn't have to wire it up at every call site.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [busy, onCancel]);

  const onClickConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={overlayStyle}
      onClick={(e) => {
        // Backdrop click cancels.
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        style={modalStyle}
      >
        <h2
          id="confirm-modal-title"
          style={{
            margin: "0 0 12px",
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          {title}
        </h2>
        <div style={{ fontSize: 13, color: "#444", lineHeight: 1.5 }}>
          {body}
        </div>
        <div
          style={{
            marginTop: 20,
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
          <button
            onClick={onCancel}
            disabled={busy}
            style={secondaryBtn(busy)}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onClickConfirm}
            disabled={busy}
            style={
              destructive ? destructiveBtn(busy) : primaryBtn(busy)
            }
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  zIndex: 1000,
};

const modalStyle: CSSProperties = {
  background: "#fff",
  borderRadius: 8,
  padding: 24,
  maxWidth: 480,
  width: "100%",
  boxShadow: "0 10px 40px rgba(0, 0, 0, 0.2)",
};

function primaryBtn(busy: boolean): CSSProperties {
  return {
    padding: "8px 16px",
    background: busy ? "#9ca3af" : "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: "inherit",
  };
}

function destructiveBtn(busy: boolean): CSSProperties {
  return {
    padding: "8px 16px",
    background: busy ? "#9ca3af" : "#dc2626",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: "inherit",
  };
}

function secondaryBtn(busy: boolean): CSSProperties {
  return {
    padding: "8px 16px",
    background: "#fff",
    color: "#555",
    border: "1px solid #e2e2e2",
    borderRadius: 6,
    fontSize: 13,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    opacity: busy ? 0.6 : 1,
  };
}
