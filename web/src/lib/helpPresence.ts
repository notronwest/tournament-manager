// Tiny cross-component flag: is a "Need help?" button currently on the page?
// When it is, the global FeedbackWidget hides its own floating launcher so the
// two don't overlap — feedback is instead reachable from inside the Need-help
// panel (which dispatches the existing `wmpc:open-feedback` event). On pages
// without a Need-help button, the FeedbackWidget launcher shows as normal.

let present = false;
const subscribers = new Set<() => void>();

export function setHelpPresent(v: boolean): void {
  if (present === v) return;
  present = v;
  subscribers.forEach((fn) => fn());
}

export function isHelpPresent(): boolean {
  return present;
}

export function subscribeHelpPresent(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
