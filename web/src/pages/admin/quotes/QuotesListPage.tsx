import { Link } from "react-router-dom";
import { usePlatformAdmin } from "../../../hooks/usePlatformAdmin";
import OpportunitiesPipeline from "../../../components/OpportunitiesPipeline";
import {
  bodyFontStack,
  breadcrumbLinkStyle,
  ink,
  inkSoft,
  pageH1Style,
  rule,
} from "../../../lib/publicTheme";

// The opportunities pipeline — every quote as an opportunity, tagged with its
// derived lifecycle stage (New → Quoted → Accepted → Signed), with show/hide
// filtering. The list itself is the reusable <OpportunitiesPipeline>, also
// embedded on the admin home.
export default function QuotesListPage() {
  const isPlatformAdmin = usePlatformAdmin();

  if (isPlatformAdmin === null) {
    return <div style={{ padding: 24, color: inkSoft, fontSize: 14, fontFamily: bodyFontStack }}>Loading…</div>;
  }
  if (!isPlatformAdmin) {
    return (
      <main style={{ padding: 24, maxWidth: 600, margin: "0 auto", fontFamily: bodyFontStack }}>
        <h1 style={{ ...pageH1Style, fontSize: 20, marginTop: 0 }}>Access denied</h1>
        <p style={{ color: inkSoft, fontSize: 14 }}>This page is restricted to platform administrators.</p>
        <Link to="/admin" style={breadcrumbLinkStyle}>← Back to admin</Link>
      </main>
    );
  }

  return (
    <main style={{ padding: "24px 24px 48px", maxWidth: 900, margin: "0 auto", fontFamily: bodyFontStack }}>
      <div style={{ marginBottom: 20 }}>
        <Link to="/admin" style={breadcrumbLinkStyle}>← Back to admin</Link>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 12 }}>
        <h1 style={{ ...pageH1Style, fontSize: 24, marginTop: 0, marginBottom: 0 }}>Opportunities</h1>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Link
            to="/admin/quotes/catalog"
            style={{ fontSize: 13, color: inkSoft, textDecoration: "none", padding: "6px 12px", border: `1px solid ${rule}`, borderRadius: 6 }}
          >
            Service catalog
          </Link>
          <Link
            to="/admin/quotes/new"
            style={{ display: "inline-block", padding: "8px 16px", background: ink, color: "#fff", textDecoration: "none", borderRadius: 6, fontSize: 13, fontWeight: 600 }}
          >
            + Start a quote
          </Link>
        </div>
      </div>
      <p style={{ fontSize: 13, color: inkSoft, margin: "0 0 20px" }}>
        Every quote, from new inquiry through a signed agreement. Toggle the
        stages below to show or hide.
      </p>

      <OpportunitiesPipeline />
    </main>
  );
}
