// Tree-shaken SVG sprite iz lucide-static: skenira src/ i public/astro-client.js,
// skuplja imena ikona iz <Icon name="..."/> i ic("...") poziva i piše public/icons.svg
// samo s tim simbolima. Nepoznato ime ruši build, da se tipfeler ne izgubi tiho.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = join(root, "node_modules/lucide-static/icons");
const out = join(root, "public/icons.svg");

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const sources = [...walk(join(root, "src")), join(root, "public/astro-client.js")].filter((p) =>
  /\.(astro|ts|js|mjs)$/.test(p)
);

const names = new Set();
for (const file of sources) {
  const code = readFileSync(file, "utf8");
  for (const m of code.matchAll(/<Icon\b[^>]*?\bname="([a-z0-9-]+)"/g)) names.add(m[1]);
  // ic("x"), ic(cond ? "a" : "b"), iconLabel(el, "x", ...)
  for (const m of code.matchAll(/\b(?:ic|iconLabel)\(([^)]*)\)/g)) {
    for (const s of m[1].matchAll(/["']([a-z0-9]+(?:-[a-z0-9]+)*)["']/g)) names.add(s[1]);
  }
}

const symbols = [];
const missing = [];
for (const name of [...names].sort()) {
  const file = join(iconsDir, `${name}.svg`);
  if (!existsSync(file)) {
    missing.push(name);
    continue;
  }
  const svg = readFileSync(file, "utf8");
  const body = svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>[\s\S]*$/, "")
    .replace(/\s*\n\s*/g, "")
    .replace(/\s*\/>/g, "/>");
  symbols.push(`<symbol id="${name}" viewBox="0 0 24 24">${body}</symbol>`);
}

if (missing.length) {
  console.error(`build_icons: nepoznate Lucide ikone: ${missing.join(", ")}`);
  process.exit(1);
}

const sprite = `<svg xmlns="http://www.w3.org/2000/svg"><!-- Lucide (ISC) — generira scripts/build_icons.mjs -->${symbols.join("")}</svg>\n`;
writeFileSync(out, sprite);
console.log(`build_icons: ${symbols.length} ikona → public/icons.svg (${(sprite.length / 1024).toFixed(1)} KB)`);
