import type { CSSProperties } from "react";
import type { Standing } from "../lib/bracketTeams";
import { bodyFontStack, courtGreen, courtRed, ink, inkMuted, monoFontStack, ruleSoft } from "../lib/publicTheme";

// One pool's standings — # / Team / W / L / PF / PA / Diff — as the public
// live results page and the per-bracket tab both show it. Rows arrive already
// ranked (computeStandings), so the row index is the place. At phone width
// the PF / PA columns drop out so the team column keeps room for two names
// (five numeric columns left it wrapping one letter per line at 390px).
export function StandingsTable({ rows, highlightTop }: { rows: Standing[]; highlightTop?: number }) {
  return (
    <div>
      <style>{`@media (max-width: 479px) { .standings-wide { display: none; } }`}</style>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: bodyFontStack, tableLayout: "auto" }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, width: 28, textAlign: "left" }}>#</th>
            <th style={{ ...thStyle, textAlign: "left" }}>Team</th>
            <th style={numTh}>W</th>
            <th style={numTh}>L</th>
            <th style={numTh} className="standings-wide">PF</th>
            <th style={numTh} className="standings-wide">PA</th>
            <th style={numTh}>Diff</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i) => {
            const advancing = highlightTop != null && i < highlightTop;
            return (
              <tr
                key={s.team.captainRegId}
                style={{ borderTop: `1px solid ${ruleSoft}`, background: advancing ? "#f3f8f4" : undefined }}
              >
                <td style={{ ...tdStyle, color: inkMuted }}>{i + 1}</td>
                <td style={{ ...tdStyle, fontWeight: 500, color: ink }}>{s.team.label}</td>
                <td style={numTd}>{s.wins}</td>
                <td style={numTd}>{s.losses}</td>
                <td style={{ ...numTd, color: inkMuted }} className="standings-wide">{s.pf}</td>
                <td style={{ ...numTd, color: inkMuted }} className="standings-wide">{s.pa}</td>
                <td style={{ ...numTd, color: s.diff > 0 ? courtGreen : s.diff < 0 ? courtRed : inkMuted }}>
                  {s.diff > 0 ? `+${s.diff}` : s.diff}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const thStyle: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: inkMuted,
  fontWeight: 700,
  padding: "6px 8px",
  fontFamily: monoFontStack,
};
const numTh: CSSProperties = { ...thStyle, textAlign: "right", width: 40, whiteSpace: "nowrap" };
const tdStyle: CSSProperties = { fontSize: 14, padding: "7px 8px", fontFamily: bodyFontStack };
const numTd: CSSProperties = {
  ...tdStyle,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
  color: ink,
  whiteSpace: "nowrap",
};
