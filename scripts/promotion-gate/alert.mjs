// Puts a gate fault on Ron's phone (a Discord webhook), so a gate that cannot do its job is not
// found by a person reading CI output weeks later (#875). The webhook is a secret and is read from
// the environment; with it unset this reports that it could not alert and never throws.
export async function alertOwner(message, { webhook = process.env.PROMOTION_GATE_ALERT_WEBHOOK, fetchImpl = fetch } = {}) {
  if (!webhook) { console.error('promotion gate: PROMOTION_GATE_ALERT_WEBHOOK is unset, so nothing reached your phone'); return false; }
  try {
    const res = await fetchImpl(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: message.slice(0, 1900) }) });
    if (!res.ok) console.error(`promotion gate: the phone alert failed: HTTP ${res.status}`);
    return res.ok;
  } catch (e) { console.error(`promotion gate: the phone alert failed: ${e.message}`); return false; }
}
