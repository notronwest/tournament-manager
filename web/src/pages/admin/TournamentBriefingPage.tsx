import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { ConfirmModal } from "../../components/ConfirmModal";
import { EMAIL_RE, displayHeading, fieldLabel, readFnError } from "./contactsUi";
import {
  ink,
  inkSoft,
  inkMuted,
  cream,
  rule,
  courtGreen,
  bodyFontStack,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  ctaSecondaryStyle,
  inputStyle,
  statusPanelStyle,
} from "../../lib/publicTheme";

// Player briefing ("know before you go") for ONE tournament: every registered
// player gets an email with their own events + start times and what to do
// before they arrive. The email itself is rendered server-side by the
// send-tournament-briefing edge function; this page collects the few knobs the
// organizer controls, shows a live preview of a real player's email, offers a
// test-send to yourself, and sends to everyone behind a confirmation.

type Tournament = {
  id: string;
  name: string;
  slug: string;
  status: string;
};

type Preview = {
  recipientCount: number;
  missingEmail: number;
  eventsMissingStart: string[];
  subject: string;
  html: string;
  sampleFor: string | null;
};

const FN = "send-tournament-briefing";

export default function TournamentBriefingPage() {
  const { org } = useCurrentOrg();
  const { user } = useAuth();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // What the organizer controls. Everything else (schedule, partners,
  // location, waitlist) comes from the tournament's own data.
  const [subject, setSubject] = useState("");
  const [waiverUrl, setWaiverUrl] = useState("");
  const [arriveMinutes, setArriveMinutes] = useState(30);
  const [firstGameWarmup, setFirstGameWarmup] = useState(10);
  const [matchWarmup, setMatchWarmup] = useState(3);
  const [notes, setNotes] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [consent, setConsent] = useState(false);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentMsg, setSentMsg] = useState<string | null>(null);

  // Start times are stored without a time zone; the email formats them in
  // this browser's zone and says so, so the organizer sends from where the
  // tournament is.
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  useEffect(() => {
    if (!org || !tournamentSlug) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("tournaments")
        .select("id, name, slug, status")
        .eq("organization_id", org.id)
        .eq("slug", tournamentSlug)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setLoadError(error.message);
        return;
      }
      if (!data) {
        setLoadError("Tournament not found.");
        return;
      }
      setTournament(data);
      setSubject(`${data.name}: your start times and what to bring`);
      setReplyTo((org.contact_email ?? user?.email ?? "").trim());
    })();
    return () => {
      cancelled = true;
    };
  }, [org, tournamentSlug, user?.email]);

  const replyToTrimmed = replyTo.trim();
  const replyToValid = replyToTrimmed.length === 0 || EMAIL_RE.test(replyToTrimmed);
  const waiverTrimmed = waiverUrl.trim();
  const waiverValid = waiverTrimmed.length === 0 || /^https?:\/\/\S+$/i.test(waiverTrimmed);

  const payload = useMemo(
    () => ({
      tournamentId: tournament?.id,
      timeZone,
      subject: subject.trim(),
      waiverUrl: waiverTrimmed,
      arriveMinutes,
      firstGameWarmupMinutes: firstGameWarmup,
      matchWarmupMinutes: matchWarmup,
      notes: notes.trim(),
      ...(replyToTrimmed ? { replyTo: replyToTrimmed } : {}),
    }),
    [tournament?.id, timeZone, subject, waiverTrimmed, arriveMinutes, firstGameWarmup, matchWarmup, notes, replyToTrimmed],
  );

  // Live preview, debounced so typing notes doesn't hammer the function.
  const previewSeq = useRef(0);
  useEffect(() => {
    if (!tournament || !waiverValid || !replyToValid) return;
    const seq = ++previewSeq.current;
    const handle = window.setTimeout(async () => {
      setPreviewLoading(true);
      const { data, error } = await supabase.functions.invoke(FN, {
        body: { ...payload, mode: "preview" },
      });
      if (seq !== previewSeq.current) return; // a newer request superseded this one
      if (error) {
        setPreviewError(await readFnError(error));
      } else {
        setPreviewError(null);
        setPreview(data as Preview);
      }
      setPreviewLoading(false);
    }, 500);
    return () => window.clearTimeout(handle);
  }, [tournament, payload, waiverValid, replyToValid]);

  const recipientCount = preview?.recipientCount ?? 0;
  const canSend =
    !!tournament && subject.trim().length > 0 && consent && recipientCount > 0 &&
    replyToValid && waiverValid && !sending;

  const sendTest = async () => {
    setTesting(true);
    setTestMsg(null);
    setSendError(null);
    try {
      const { data, error } = await supabase.functions.invoke(FN, {
        body: { ...payload, mode: "test" },
      });
      if (error) {
        setSendError(await readFnError(error));
        return;
      }
      setTestMsg(`Test sent to ${(data as { sentTo?: string })?.sentTo ?? "you"}. Check your inbox.`);
    } finally {
      setTesting(false);
    }
  };

  const send = async () => {
    setSending(true);
    setSendError(null);
    try {
      const { data, error } = await supabase.functions.invoke(FN, {
        body: { ...payload, mode: "send", consent: true },
      });
      if (error) {
        setSendError(await readFnError(error));
        return;
      }
      const d = data as { sent?: number; recipientCount?: number; failed?: number; detail?: string };
      const n = d?.sent ?? recipientCount;
      if (d?.failed) {
        setSendError(`Sent to ${n} player${n === 1 ? "" : "s"}, but ${d.failed} failed: ${d.detail ?? "unknown error"}`);
      }
      setSentMsg(`Your briefing is on its way to ${n} player${n === 1 ? "" : "s"}. Track delivery on the Email → History tab.`);
      setConsent(false);
    } finally {
      setSending(false);
    }
  };

  if (!org) return null;

  if (loadError) {
    return (
      <div style={{ fontFamily: bodyFontStack, color: ink }}>
        <div style={statusPanelStyle("danger")} role="alert">{loadError}</div>
      </div>
    );
  }
  if (!tournament) return <div style={{ color: inkMuted }}>Loading…</div>;

  const base = `/admin/${org.slug}/tournaments/${tournament.slug}`;
  const missingStart = preview?.eventsMissingStart ?? [];

  return (
    <div style={{ fontFamily: bodyFontStack, color: ink }}>
      <p style={{ margin: "0 0 6px", fontSize: 13 }}>
        <Link to={base} style={{ color: inkSoft }}>← {tournament.name}</Link>
      </p>
      <h1 style={displayHeading}>Player briefing</h1>
      <p style={{ color: inkSoft, fontSize: 15, margin: "0 0 18px", maxWidth: 620, lineHeight: 1.55 }}>
        Email every registered player their own start times and what to do
        before they arrive: sign the waiver, be there {arriveMinutes} minutes
        early, warm-up rules, what to bring, plus anything you add below.
      </p>

      {sentMsg && (
        <div style={{ ...statusPanelStyle("success"), marginBottom: 16 }} role="status">
          {sentMsg}{" "}
          <Link to={`/admin/${org.slug}/email?tab=history`} style={{ color: "inherit" }}>Open History</Link>
        </div>
      )}

      {/* Who gets it + readiness */}
      <div style={{ ...panelWrap, marginBottom: 16 }}>
        <div style={{ ...fieldLabel, marginBottom: 8 }}>Who gets it</div>
        {preview ? (
          <>
            <div style={{ fontSize: 14 }}>
              This email will go to <strong>{recipientCount}</strong> registered player{recipientCount === 1 ? "" : "s"}
              {preview.missingEmail > 0 && (
                <span style={{ color: inkMuted }}> · {preview.missingEmail} registrant{preview.missingEmail === 1 ? " has" : "s have"} no email address</span>
              )}
            </div>
            <p style={{ fontSize: 12, color: inkMuted, margin: "6px 0 0", lineHeight: 1.5 }}>
              Every paid, pending, and waitlisted registrant — this is about their
              registration, so it goes out even to people unsubscribed from your
              contact list. Times are shown in <strong>{timeZone.replace(/_/g, " ")}</strong>, this
              browser's time zone.
            </p>
          </>
        ) : (
          <div style={{ fontSize: 14, color: inkMuted }}>{previewError ?? "Counting players…"}</div>
        )}
        {missingStart.length > 0 && (
          <div style={{ ...statusPanelStyle("warn"), marginTop: 12, fontSize: 13 }} role="status">
            <strong>{missingStart.length} event{missingStart.length === 1 ? " has" : "s have"} no start time yet</strong>
            {" "}— players in {missingStart.length === 1 ? "it" : "them"} will read “Start time to be announced.”{" "}
            <Link to={`${base}/schedule`} style={{ color: "inherit" }}>Set start times on the Schedule page</Link>.
            <div style={{ marginTop: 6, color: inkSoft }}>{missingStart.join(" · ")}</div>
          </div>
        )}
      </div>

      {/* Settings */}
      <div style={{ ...panelWrap, marginBottom: 16 }}>
        <label style={fieldLabel} htmlFor="briefing-subject">Subject</label>
        <input
          id="briefing-subject"
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          style={{ ...inputStyle, marginBottom: 14 }}
        />

        <label style={fieldLabel} htmlFor="briefing-waiver">Waiver link (optional)</label>
        <input
          id="briefing-waiver"
          type="url"
          value={waiverUrl}
          onChange={(e) => setWaiverUrl(e.target.value)}
          placeholder="https://…"
          style={{ ...inputStyle, marginBottom: 6, ...(waiverValid ? null : { borderColor: "#c0392b" }) }}
        />
        <p style={{ fontSize: 12, color: inkSoft, margin: "0 0 14px", lineHeight: 1.5 }}>
          If players can sign online, paste the link and the email asks them to sign before they
          arrive. Leave blank and it says they'll sign at the check-in desk.
        </p>
        {!waiverValid && (
          <p style={{ fontSize: 12, color: "#c0392b", margin: "-8px 0 14px" }} role="alert">
            Enter a full link starting with http:// or https://.
          </p>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 14 }}>
          <MinutesField id="briefing-arrive" label="Arrive early" value={arriveMinutes} onChange={setArriveMinutes} max={240} />
          <MinutesField id="briefing-first" label="First-game warm-up" value={firstGameWarmup} onChange={setFirstGameWarmup} max={60} />
          <MinutesField id="briefing-match" label="Warm-up before each match" value={matchWarmup} onChange={setMatchWarmup} max={60} />
        </div>

        <label style={fieldLabel} htmlFor="briefing-notes">Anything else players should know (optional)</label>
        <textarea
          id="briefing-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={"Parking, food, raffle, medal ceremony time…\n\nBlank line = new paragraph."}
          rows={5}
          style={{ ...inputStyle, marginBottom: 14, resize: "vertical", lineHeight: 1.5 }}
        />

        <label style={fieldLabel} htmlFor="briefing-replyto">Reply-to address</label>
        <input
          id="briefing-replyto"
          type="email"
          value={replyTo}
          onChange={(e) => setReplyTo(e.target.value)}
          placeholder={user?.email ?? "replies@yourclub.com"}
          style={{ ...inputStyle, marginBottom: 6, ...(replyToValid ? null : { borderColor: "#c0392b" }) }}
        />
        <p style={{ fontSize: 12, color: inkSoft, margin: 0, lineHeight: 1.5 }}>
          Where player replies go. Prefilled with the club's contact email, or yours.
        </p>
        {!replyToValid && (
          <p style={{ fontSize: 12, color: "#c0392b", margin: "6px 0 0" }} role="alert">
            Enter a valid email address.
          </p>
        )}
      </div>

      {/* Preview */}
      <div style={{ ...panelWrap, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
          <div style={fieldLabel}>
            Preview{preview?.sampleFor ? ` — as ${preview.sampleFor} will see it` : ""}
          </div>
          <span style={{ fontSize: 12, color: inkMuted }}>{previewLoading ? "Updating…" : ""}</span>
        </div>
        {previewError && (
          <div style={{ ...statusPanelStyle("danger"), marginBottom: 10 }} role="alert">{previewError}</div>
        )}
        {preview ? (
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={preview.html}
            style={{ width: "100%", height: 720, border: `1px solid ${rule}`, borderRadius: 8, background: "#fff" }}
          />
        ) : (
          <div style={{ padding: 28, textAlign: "center", color: inkMuted, background: cream, borderRadius: 8 }}>
            Building the preview…
          </div>
        )}
        <p style={{ fontSize: 12, color: inkMuted, margin: "8px 0 0", lineHeight: 1.5 }}>
          Each player gets their own version listing only their events.
        </p>
      </div>

      {/* Send */}
      <div style={panelWrap}>
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13, color: inkSoft, marginBottom: 14, cursor: "pointer" }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }} />
          <span>I've checked the preview and the start times are right. This goes to every registered player and can't be unsent.</span>
        </label>

        {sendError && (
          <div style={{ ...statusPanelStyle("danger"), marginBottom: 12 }} role="alert">{sendError}</div>
        )}
        {testMsg && (
          <div style={{ fontSize: 13, color: courtGreen, fontWeight: 600, marginBottom: 12 }} role="status">✓ {testMsg}</div>
        )}

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            style={{ ...ctaSecondaryStyle, opacity: testing || !preview ? 0.6 : 1 }}
            disabled={testing || !preview || !waiverValid || !replyToValid}
            onClick={sendTest}
          >
            {testing ? "Sending test…" : `Send me a test (${user?.email ?? "you"})`}
          </button>
          <button
            type="button"
            style={canSend ? ctaPrimaryStyle : ctaPrimaryDisabledStyle}
            disabled={!canSend}
            onClick={() => setConfirming(true)}
          >
            {sending ? "Sending…" : `Send to ${recipientCount} player${recipientCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>

      {confirming && (
        <ConfirmModal
          title="Send the briefing?"
          destructive={false}
          body={
            <>
              Send “{subject.trim()}” to <strong>{recipientCount}</strong> registered player{recipientCount === 1 ? "" : "s"}?
              {missingStart.length > 0 && (
                <> {missingStart.length} event{missingStart.length === 1 ? " still has" : "s still have"} no start time.</>
              )}{" "}
              This can't be unsent.
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

function MinutesField({
  id,
  label,
  value,
  onChange,
  max,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
  max: number;
}) {
  return (
    <div>
      <label style={fieldLabel} htmlFor={id}>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          max={max}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(Math.min(max, Math.max(0, Math.round(n))));
          }}
          style={{ ...inputStyle, width: 90 }}
        />
        <span style={{ fontSize: 13, color: inkSoft }}>min</span>
      </div>
    </div>
  );
}

const panelWrap = {
  border: `1px solid ${rule}`,
  borderRadius: 12,
  padding: 20,
  background: "#fff",
} as const;
