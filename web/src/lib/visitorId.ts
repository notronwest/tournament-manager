// Anonymous first-party visitor id for campaign capture (D-0077). Minted
// once per browser via localStorage and reused across every public page
// view — NOT a player id, and never sent anywhere but our own RPC.

const VISITOR_ID_KEY = "wmpc_visitor_id";

export function getOrCreateVisitorId(): string {
  try {
    const existing = localStorage.getItem(VISITOR_ID_KEY);
    if (existing) return existing;
    const minted = crypto.randomUUID();
    localStorage.setItem(VISITOR_ID_KEY, minted);
    return minted;
  } catch {
    // Storage blocked (private mode / cookies off) — fall back to a
    // per-call id; dedupe just won't span page loads for this visitor.
    return crypto.randomUUID();
  }
}
