// Shared HMAC unsubscribe token for contact-list emails.
//
// Signed with the service-role key (auto-injected into every edge function;
// never exposed — only the derived signature travels in the URL). The token
// binds (orgId, playerId, broadcastId) so the unsubscribe endpoint knows who is
// opting out and which send to credit the unsubscribe to.
//
// token = base64url("orgId:playerId:broadcastId") + "." + base64url(HMAC-SHA256)

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  const s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): Uint8Array {
  let s = input.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(key: string, msg: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
  return new Uint8Array(sig);
}

export async function makeUnsubToken(
  key: string,
  orgId: string,
  playerId: string,
  broadcastId: string,
): Promise<string> {
  const payload = `${orgId}:${playerId}:${broadcastId}`;
  const sig = await hmac(key, payload);
  return `${b64url(enc.encode(payload))}.${b64url(sig)}`;
}

export async function verifyUnsubToken(
  key: string,
  token: string,
): Promise<{ orgId: string; playerId: string; broadcastId: string } | null> {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (!payloadB64 || !sigB64) return null;

  let payload: string;
  try {
    payload = new TextDecoder().decode(b64urlDecode(payloadB64));
  } catch {
    return null;
  }

  const expected = await hmac(key, payload);
  let got: Uint8Array;
  try {
    got = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  // Constant-time compare.
  if (expected.length !== got.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ got[i];
  if (diff !== 0) return null;

  const [orgId, playerId, broadcastId] = payload.split(":");
  if (!orgId || !playerId || !broadcastId) return null;
  return { orgId, playerId, broadcastId };
}

// Public unsubscribe endpoint (verify_jwt=false). SUPABASE_URL is the project
// URL auto-injected into every function.
export function unsubscribeUrl(supabaseUrl: string, token: string): string {
  return `${supabaseUrl}/functions/v1/unsubscribe-contact?token=${encodeURIComponent(token)}`;
}
