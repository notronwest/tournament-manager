// Env-gated feature flags. No DB-backed flags exist yet (an org-level column
// would need its own migration) — this is the first, and the simplest: a
// build-time VITE_* var, same pattern as VITE_GA_MEASUREMENT_ID etc. Default
// is OFF (unset/anything but "true") so every environment is safe until a
// flag is explicitly turned on for it.

/**
 * $20 account-credit offer on the public recap page + its /credit landing
 * page (#1114). Must stay OFF until the credit ledger/grant (#1102) ships —
 * promising money we can't yet grant is worse than the plain CTA. Flip on
 * per Cloudflare Pages project (preview/TEST/PROD) once #1102 lands.
 */
/** Dollar amount quoted by the CTA + landing page copy (#1114). Single source
 * so the recap CTA and the /credit landing page never quote different
 * numbers. */
export const CREDIT_OFFER_AMOUNT_USD = 20;

export function isCreditOfferEnabled(): boolean {
  return (
    (import.meta.env.VITE_CREDIT_OFFER as string | undefined)
      ?.trim()
      .toLowerCase() === "true"
  );
}
