import { useEffect, useRef, useState, type CSSProperties } from "react";
import { supabase } from "../supabase";
import { ConfirmModal } from "./ConfirmModal";
import { readFnError } from "../pages/admin/contactsUi";
import {
  inkSoft,
  inkMuted,
  rule,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  ctaSecondaryStyle,
  inputStyle,
  statusPanelStyle,
} from "../lib/publicTheme";
import type { ReportHeader, TournamentSummary } from "../lib/tournamentSummary";
import { renderSummaryPdf, summaryPdfFilename, bytesToBase64 } from "../lib/summaryPdf";

// "Email the summary to attendees" — sends the end-of-tournament report as a
// PDF attachment to every spot-holding registrant of the tournament, via the
// `send-tournament-summary` edge function. Resend can't attach files on its
// batch endpoint, so the function mails one recipient at a time in windows of
// ~25 and this modal loops until `nextCursor` is null, showing progress.
//
// Same shape as the tournament briefing page: live recipient count, a
// send-test-to-me button, an explicit consent checkbox, and a confirm step.
// The PDF is built once (client-side, pdf-lib) and reused for every window.

const FN = "send-tournament-summary";
const WINDOW = 25;

type Preview = { total: number; missingEmail: number; sample: string[]; fromAddress: string };
type SendResult = { total: number; sent: number; failed: number; nextCursor: number | null; broadcastId: string };

export function SummaryEmailModal({
  tournamentId,
  header,
  summary,
  note,
  onClose,
}: {
  tournamentId: string;
  header: ReportHeader;
  summary: TournamentSummary;
  note: string;
  onClose: () => void;
}) {
  const [subject, setSubject] = useState(`${header.tournamentName} — results & summary`);
  const [message, setMessage] = useState(
    "Thanks for playing with us! The full summary — every bracket, every podium and the headline numbers — is attached as a PDF.",
  );
  const [consent, setConsent] = useState(false);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<{ sent: number; failed: number; total: number } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Built lazily on first send/test and cached — the report doesn't change
  // while the modal is open.
  const pdfRef = useRef<{ filename: string; contentBase64: string } | null>(null);
  const [pdfSize, setPdfSize] = useState<number | null>(null);

  const busy = testing || sending;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !confirming) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [busy, confirming, onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.functions.invoke(FN, {
        body: { tournamentId, mode: "preview" },
      });
      if (cancelled) return;
      if (error) {
        setPreviewError(await readFnError(error));
        return;
      }
      setPreview(data as Preview);
    })();
    return () => {
      cancelled = true;
    };
  }, [tournamentId]);

  const buildPdf = async () => {
    if (pdfRef.current) return pdfRef.current;
    const bytes = await renderSummaryPdf({ header, summary, note });
    const built = { filename: summaryPdfFilename(header), contentBase64: bytesToBase64(bytes) };
    pdfRef.current = built;
    setPdfSize(bytes.byteLength);
    return built;
  };

  const total = preview?.total ?? 0;
  const subjectOk = subject.trim().length > 0 && subject.trim().length <= 200;
  const canSend = !!preview && total > 0 && subjectOk && consent && !busy && !done;

  const sendTest = async () => {
    setTesting(true);
    setTestMsg(null);
    setSendError(null);
    try {
      const attachment = await buildPdf();
      const { data, error } = await supabase.functions.invoke(FN, {
        body: { tournamentId, mode: "test", subject: subject.trim(), message, attachment },
      });
      if (error) {
        setSendError(await readFnError(error));
        return;
      }
      setTestMsg(`Test sent to ${(data as { sentTo?: string })?.sentTo ?? "you"} — check your inbox for the PDF.`);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Couldn't build the PDF.");
    } finally {
      setTesting(false);
    }
  };

  const send = async () => {
    setSending(true);
    setSendError(null);
    setProgress({ sent: 0, failed: 0, total });
    try {
      const attachment = await buildPdf();
      let cursor: number | null = 0;
      let broadcastId: string | undefined;
      let sent = 0;
      let failed = 0;
      while (cursor !== null) {
        const { data, error } = await supabase.functions.invoke(FN, {
          body: {
            tournamentId,
            mode: "send",
            consent: true,
            subject: subject.trim(),
            message,
            attachment,
            cursor,
            limit: WINDOW,
            broadcastId,
          },
        });
        if (error) {
          setSendError(
            `${await readFnError(error)} — ${sent} of ${total} ${sent === 1 ? "email was" : "emails were"} sent before the error.`,
          );
          return;
        }
        const r = data as SendResult;
        sent += r.sent;
        failed += r.failed;
        broadcastId = r.broadcastId;
        cursor = r.nextCursor;
        setProgress({ sent, failed, total: r.total });
      }
      setDone(
        failed > 0
          ? `Sent to ${sent} attendee${sent === 1 ? "" : "s"}; ${failed} failed. Track delivery on Email → History.`
          : `Your summary is on its way to ${sent} attendee${sent === 1 ? "" : "s"}. Track delivery on Email → History.`,
      );
      setConsent(false);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Couldn't build the PDF.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      style={overlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="summary-email-title" style={modalStyle}>
        <h2 id="summary-email-title" style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 600 }}>
          Email the summary to attendees
        </h2>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: inkSoft, lineHeight: 1.5 }}>
          Every registered player gets this message with the report attached as a PDF
          {pdfSize !== null ? ` (${Math.max(1, Math.round(pdfSize / 1024))} KB)` : ""}.
        </p>

        <div style={{ ...statusPanelStyle(previewError ? "danger" : "info"), fontSize: 13, marginBottom: 14 }} role="status">
          {previewError ? (
            previewError
          ) : preview ? (
            <>
              <strong>{total}</strong> attendee{total === 1 ? "" : "s"} with an email address
              {preview.missingEmail > 0 && (
                <span style={{ color: inkMuted }}>
                  {" "}· {preview.missingEmail} {preview.missingEmail === 1 ? "has" : "have"} no email and will be skipped
                </span>
              )}
              <span style={{ color: inkMuted }}> · from {preview.fromAddress}</span>
            </>
          ) : (
            "Counting attendees…"
          )}
        </div>

        <label style={labelStyle} htmlFor="summary-email-subject">Subject</label>
        <input
          id="summary-email-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={200}
          disabled={busy || !!done}
          style={{ ...inputStyle, marginBottom: 12 }}
        />

        <label style={labelStyle} htmlFor="summary-email-message">Message</label>
        <textarea
          id="summary-email-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          disabled={busy || !!done}
          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5, marginBottom: 6 }}
        />
        <p style={{ fontSize: 12, color: inkSoft, margin: "0 0 14px", lineHeight: 1.5 }}>
          Blank lines start a new paragraph. The note from the report page is included in the PDF, not here.
        </p>

        {!done && (
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13, lineHeight: 1.5, marginBottom: 14 }}>
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              disabled={busy}
              style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }}
            />
            <span>I've checked the report. This goes to every registered player and can't be unsent.</span>
          </label>
        )}

        {sendError && (
          <div style={{ ...statusPanelStyle("danger"), fontSize: 13, marginBottom: 12 }} role="alert">{sendError}</div>
        )}
        {testMsg && !sendError && (
          <div style={{ ...statusPanelStyle("info"), fontSize: 13, marginBottom: 12 }} role="status">{testMsg}</div>
        )}
        {progress && sending && (
          <div style={{ ...statusPanelStyle("info"), fontSize: 13, marginBottom: 12 }} role="status" aria-live="polite">
            Sending… {progress.sent} of {progress.total}
            {progress.failed > 0 ? ` (${progress.failed} failed)` : ""}. Keep this window open.
          </div>
        )}
        {done && (
          <div style={{ ...statusPanelStyle("success"), fontSize: 13, marginBottom: 12 }} role="status">{done}</div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 6 }}>
          <button type="button" onClick={onClose} disabled={busy} style={{ ...ctaSecondaryStyle, opacity: busy ? 0.6 : 1 }}>
            {done ? "Close" : "Cancel"}
          </button>
          {!done && (
            <>
              <button
                type="button"
                onClick={sendTest}
                disabled={busy || !preview || !subjectOk}
                style={{ ...ctaSecondaryStyle, opacity: busy || !preview || !subjectOk ? 0.6 : 1 }}
              >
                {testing ? "Sending test…" : "Send a test to me"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={!canSend}
                style={canSend ? ctaPrimaryStyle : ctaPrimaryDisabledStyle}
              >
                {sending ? "Sending…" : `Send to ${total} attendee${total === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </div>
      </div>

      {confirming && (
        <ConfirmModal
          title="Send the summary?"
          destructive={false}
          body={
            <>
              Send “{subject.trim()}” with the PDF attached to <strong>{total}</strong> attendee{total === 1 ? "" : "s"}?
              {" "}This can't be unsent.
            </>
          }
          confirmLabel="Send now"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setConfirming(false);
            await send();
          }}
        />
      )}
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  zIndex: 1000,
};

const modalStyle: CSSProperties = {
  background: "var(--surface)",
  borderRadius: 8,
  padding: 24,
  maxWidth: 560,
  width: "100%",
  maxHeight: "calc(100vh - 32px)",
  overflowY: "auto",
  boxShadow: "0 10px 40px rgba(0, 0, 0, 0.2)",
  border: `1px solid ${rule}`,
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 12.5,
  fontWeight: 600,
  color: inkSoft,
  marginBottom: 4,
};
