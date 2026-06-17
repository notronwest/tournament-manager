// One-off: rasterize the site's brush wordmark (cream-on-dark, SVG) to a
// retina PNG for use in transactional emails — email clients don't render
// SVG, so the auth templates need a hosted raster. Output lands in
// web/public/email/ so Cloudflare Pages serves it as a static asset at
// /email/logo@2x.png (NOT caught by the SPA _redirects fallback).
//
// Run from anywhere:  node scripts/render-email-logo.mjs
// (@resvg/resvg-js is a devDependency of web/, resolved explicitly below.)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const require = createRequire(resolve(repo, "web/package.json"));
const { Resvg } = require("@resvg/resvg-js");
const srcSvg = resolve(repo, "web/src/assets/bert-and-erne-brush-mark.svg");
const outDir = resolve(repo, "web/public/email");
const outPng = resolve(outDir, "logo@2x.png");

// Display size in the email is 240×37 (same as the navbar). Render at 2×
// for retina. The mark's viewBox is 395×61 (~6.48:1); width 480 → height ~74.
const svg = readFileSync(srcSvg, "utf8");
const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 480 } });
const png = resvg.render().asPng();
mkdirSync(outDir, { recursive: true });
writeFileSync(outPng, png);
console.log(`wrote ${outPng} (${png.length} bytes)`);
