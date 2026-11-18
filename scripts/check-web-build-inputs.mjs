// Fails when a non-test file under web/src imports a path outside web/ that is
// not listed in scripts/web-build-inputs.txt. Such a file is part of the website
// bundle, so a change to it must count as a website change in the post-deploy
// smoke (post-deploy-smoke.yml). Test files are not bundled and are skipped.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const inputs = readFileSync(join(root, "scripts/web-build-inputs.txt"), "utf8")
  .split("\n").map((l) => l.trim()).filter(Boolean);
const covered = (rel) => inputs.some((p) => rel === p.replace(/\/$/, "") || rel.startsWith(p.endsWith("/") ? p : p + "/"));

const isTest = (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || f.split(sep).includes("__fixtures__");
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.[cm]?[jt]sx?$/.test(name)) yield p;
  }
}

const importRe = /(?:\bfrom\s*|\bimport\s*\(?\s*|\bimport\s+)["'](\.\.?\/[^"']+)["']/g;
const bad = [];
for (const file of walk(join(root, "web/src"))) {
  if (isTest(file)) continue;
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(importRe)) {
    const rel = relative(root, resolve(dirname(file), m[1])).split(sep).join("/");
    if (rel.startsWith("web/") || covered(rel)) continue;
    bad.push(`${relative(root, file)} imports ${m[1]} (${rel})`);
  }
}
if (bad.length) {
  for (const b of bad) console.error(`::error::${b} — outside web/ and not in scripts/web-build-inputs.txt`);
  console.error("Add the path to scripts/web-build-inputs.txt so a change to it counts as a website change in the post-deploy smoke.");
  process.exit(1);
}
console.log("All imports from outside web/ are covered by scripts/web-build-inputs.txt.");
