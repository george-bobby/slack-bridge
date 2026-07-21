#!/usr/bin/env node
/**
 * Vendors the Milkdown (Crepe) editor into public/vendor/.
 *
 * The dashboard has no npm dependencies and no build step — `node index.js`
 * works with nothing installed — so the memory editor cannot `import` a package
 * and cannot pull one off a CDN at runtime either: this page can start sessions
 * with `--dangerously-skip-permissions`, and it should not need the network to
 * draw a text box. So the editor is fetched once, pinned, and committed.
 *
 * Re-run after bumping VERSION:  node scripts/vendor-milkdown.js
 *
 * What it writes:
 *   public/vendor/milkdown.mjs        the editor, one self-contained ES module
 *   public/vendor/node-process.mjs    a stub for the one Node global it wants
 *   public/vendor/milkdown.css        upstream CSS, both themes folded into one
 *
 * The CSS fold is the only non-mechanical step. Upstream ships two files of the
 * same 22 custom properties — crepe/ and crepe-dark/ — meant to be swapped by
 * loading one or the other. The dashboard picks its palette with `color-scheme`
 * and light-dark() instead (see the top of app.css), so the two files are zipped
 * into one block of light-dark() pairs and follow the theme toggle for free.
 */

const fs = require("fs");
const path = require("path");

const VERSION = "7.21.3";
const CDN = `https://cdn.jsdelivr.net/npm/@milkdown/crepe@${VERSION}/lib`;
const OUT = path.join(__dirname, "..", "public", "vendor");

// Upstream's theme/common/style.css is nothing but @import lines, and a plain
// <link> would make the browser fetch 15 more files. Inlined in its order.
const COMMON = [
  "prosemirror", "reset", "block-edit", "code-mirror", "cursor", "image-block",
  "link-tooltip", "list-item", "placeholder", "toolbar", "table", "latex",
  "top-bar", "diff", "ai",
];

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  return r.text();
}

/** `--name: value;` pairs out of a theme file, in source order. */
function themeVars(css) {
  const out = new Map();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  /* ---------------------------------------------------------------- js --- */

  // esm.sh's `?bundle` entry point is a two-line re-export; the code itself is
  // the .bundle.mjs behind it, which inlines every dependency (prosemirror,
  // remark, codemirror) and imports exactly one thing.
  const js = await get(`https://esm.sh/@milkdown/crepe@${VERSION}/es2022/crepe.bundle.mjs`);
  const POLYFILL = '"/node/process.mjs"';
  if (!js.includes(POLYFILL)) {
    throw new Error(`bundle no longer imports ${POLYFILL} — check what it wants now`);
  }
  const rewritten = js.replace(POLYFILL, '"./node-process.mjs"');
  // One import, and it must be the only one left pointing off this directory:
  // anything else would 404 at runtime in a page that has no import map.
  const stray = [...rewritten.matchAll(/(?:^|[;\n])\s*import\s[^;]*?from\s*"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((s) => s !== "./node-process.mjs");
  if (stray.length) throw new Error(`bundle imports things we did not vendor: ${stray.join(", ")}`);

  // Everything the bundle does with `process`, so the stub below can be checked
  // against it rather than assumed. esm.sh's own process polyfill is not used:
  // it pulls in its Node `events` and `tty` shims, which pull in more, and all
  // of it exists to back an API surface of exactly one property.
  const used = [...new Set([...rewritten.matchAll(/__Process\$\.(\w+)/g)].map((m) => m[1]))];
  if (used.length !== 1 || used[0] !== "env") {
    throw new Error(`bundle now uses process.${used.join(", process.")} — the stub only provides env`);
  }

  fs.writeFileSync(path.join(OUT, "milkdown.mjs"), rewritten);
  fs.writeFileSync(
    path.join(OUT, "node-process.mjs"),
    `/* Stands in for Node's \`process\` in the browser. The editor bundle reads\n` +
      ` * process.env to decide whether to log development warnings, and nothing\n` +
      ` * else — scripts/vendor-milkdown.js re-checks that on every vendor. */\n` +
      `export default { env: {} };\n`
  );

  /* --------------------------------------------------------------- css --- */

  const parts = [];
  for (const name of COMMON) {
    parts.push(`/* ===== ${name}.css ===== */\n${await get(`${CDN}/theme/common/${name}.css`)}`);
  }

  const light = themeVars(await get(`${CDN}/theme/crepe/style.css`));
  const dark = themeVars(await get(`${CDN}/theme/crepe-dark/style.css`));
  if (light.size !== dark.size || [...light.keys()].some((k) => !dark.has(k))) {
    throw new Error("the two crepe themes no longer declare the same variables");
  }

  const decls = [...light].map(([k, l]) => {
    const d = dark.get(k);
    // Fonts and shadows are the same in both files; only colours actually move.
    return `  ${k}: ${l === d ? l : `light-dark(${l}, ${d})`};`;
  });

  parts.push(
    `/* ===== crepe + crepe-dark, zipped into light-dark() pairs ===== */\n` +
      `.milkdown {\n${decls.join("\n")}\n}\n`
  );

  fs.writeFileSync(
    path.join(OUT, "milkdown.css"),
    `/* @milkdown/crepe ${VERSION} — generated by scripts/vendor-milkdown.js, do not edit.\n` +
      ` * Dashboard-side overrides (fonts, sizing, panel fit) live in app.css. */\n\n` +
      parts.join("\n")
  );

  for (const f of ["milkdown.mjs", "node-process.mjs", "milkdown.css"]) {
    const kb = (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0);
    console.log(`  public/vendor/${f}  ${kb} KB`);
  }
  console.log(`\n@milkdown/crepe ${VERSION} vendored.`);
}

main().catch((e) => {
  console.error(`vendor-milkdown: ${e.message}`);
  process.exit(1);
});
