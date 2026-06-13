import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import {
  bodyFontStack,
  ink,
  inkMuted,
  rule,
} from "../lib/publicTheme";

export default function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer style={footerStyle}>
      <div style={innerStyle}>
        <span style={copyStyle}>
          &copy; {year} bert &amp; erne
        </span>
        <nav style={linksStyle} aria-label="Footer">
          <Link to="/privacy" style={linkStyle}>Privacy Policy</Link>
          <Link to="/terms" style={linkStyle}>Terms of Service</Link>
        </nav>
      </div>
    </footer>
  );
}

const footerStyle: CSSProperties = {
  borderTop: `1px solid ${rule}`,
  padding: "20px clamp(20px, 4vw, 32px)",
  fontFamily: bodyFontStack,
  background: "transparent",
};

const innerStyle: CSSProperties = {
  maxWidth: 1200,
  margin: "0 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: "8px 16px",
};

const copyStyle: CSSProperties = {
  fontSize: 13,
  color: inkMuted,
};

const linksStyle: CSSProperties = {
  display: "flex",
  gap: 16,
};

const linkStyle: CSSProperties = {
  fontSize: 13,
  color: ink,
  textDecoration: "none",
  fontWeight: 500,
};
