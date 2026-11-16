// The promotion gate's decision, written down where it can be read and argued with (#866, D-0304).
//
// A main -> production promotion waits for Ron only when its diff carries one of three things:
//   (a) it deletes or rewrites existing club data
//   (b) it touches money
//   (c) it changes something a member sees or receives
// Everything below is the list of paths and patterns that decides (b) and (c), and the list of
// paths that are known to be none of the three. A path in NO list is "unclassified" and the gate
// FAILS CLOSED on it: a path nobody has thought about is not assumed to be harmless.

// (b) paths that move or price money a player or organizer pays: pricing, quotes, fees, coupons,
// donations, checkout, refunds, Stripe, and the edge functions behind them.
export const MONEY_PATHS = [
  /^web\/src\/lib\/(pricing|pricingTiers|quotePricing|quotePipeline|platformFee|refunds|stripe)(?:(?!\.test\.)[^/])*\.(ts|tsx)$/,
  /^web\/src\/pages\/public\/(Checkout|Donate|Credit|Estimate|CustomerQuote)[^/]*\.tsx$/,
  /^web\/src\/pages\/admin\/(OrgStripeSettings|StripeOauthCallback|TournamentCoupons|TournamentDonations)[^/]*\.tsx$/,
  /^web\/src\/pages\/admin\/quotes\//,
  /^web\/src\/components\/(DonationAmountPicker|PendingPayments[^/]*|PricingTiersEditor)\.tsx$/,
  /^supabase\/functions\/[^/]*(billing|charge|checkout|coupon|donat|fee|invoice|payment|price|pricing|quote|refund|stripe)/i,
  /(^|\/)[^/]*(refund|stripe|coupon|checkout|payout|billing)[^/]*\.(ts|tsx|js|mjs|sql)$/i,
];

// (b) money-MOVING terms in added lines of code (not docs, SQL or tests).
export const MONEY_CONTENT = /\b(stripe|refund\w*|coupon\w*|payment_intent|payout\w*|chargeback\w*|unit_amount|price_id|application_fee\w*|entry_fee_cents|event_fee_cents)\b|\.charges?\.create\b/i;

// (c) paths that are code which itself renders to, or sends to, a player or the public. This is a
// public registration site: the whole SPA ships to it, so every web/src file (organizer screens
// included, since organizers are customers) is member-facing unless it is a test. So are the edge
// functions (they send email and take payments) and the email templates.
export const MEMBER_PATHS = [
  /^web\/src\/(?!.*\.test\.).*\.(ts|tsx|css)$/,
  /^web\/public\//,
  /^web\/index\.html$/,
  /^web\/vite\.config\.ts$/,
  /^supabase\/functions\//,
  /^supabase\/email-templates\//,
];

// A path that is a test or an end-to-end spec. One spelling, shared by the SQL branch (a test
// never ships to production, so its statements are not judged as data loss) and the money branch.
export const TEST_PATH = /(^|\/)(tests?|e2e)\/|\.test\./;

// Known to be none of the three: internal tooling, docs, tests, evidence. SQL under
// supabase/migrations is judged by its CONTENT (sql.mjs), not by this list.
export const INTERNAL_PATHS = [
  /^docs\//,
  /\.md$/,
  /^\.design\//,
  /^mockups\//,
  /^web\/e2e\//,
  /^supabase\/migrations\//,
  /^supabase\/tests\//,
  /^supabase\/seed\.sql$/,
  /^supabase\/config\.toml$/,
  /(^|\/)test\//,
  /\.test\.(m?[jt]sx?)$/,
  /^\.github\//,
  /^\.wmpc\//,
  /^\.claude\//,
  /^scripts\//,
  /^pbcom-driver\//,
  /^web\/(package(-lock)?\.json|tsconfig[^/]*\.json|eslint\.config\.js|playwright[^/]*\.ts|vite-env\.d\.ts)$/,
  /^(\.gitignore|\.gitattributes|\.mcp\.json|\.env\.template|setup\.sh|capabilities\.json|package(-lock)?\.json)$/,
];

// The cos_approvals.action_kind a production-promotion ask is raised under (the stop-list kind).
export const PROMOTION_APPROVAL_KIND = 'ship_prod';
