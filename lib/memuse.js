/**
 * How often each memory actually gets read, measured rather than assumed.
 *
 * A memory costs context in every session for as long as it exists, and earns
 * that cost only when a run opens it. Both halves are observable: Claude Code
 * writes one JSONL transcript per session under `~/.claude/projects/<slug>/`,
 * and a run that consults a memory does it with a `Read` tool call carrying the
 * file's path. Counting those is the difference between pruning on evidence and
 * pruning on a hunch.
 *
 * Kept apart from lib/memory.js on purpose: that module owns the memory
 * directory and answers instantly, this one walks hundreds of megabytes of
 * transcript beside it. The split is the cache — rescanning every session on
 * every panel open would make the panel feel broken.
 *
 * What is deliberately *not* counted:
 *   - `MEMORY.md` itself. It is loaded into every session by design, so its
 *     count would be "all of them" and would say nothing.
 *   - Index dumps. MEMORY.md lists every memory by filename, so any block
 *     quoting it mentions all of them at once; a block naming more than
 *     INDEX_GIVEAWAY distinct memories is that, not a recall of each.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const CACHE = path.join(__dirname, "..", "data", "memuse.json");

// A text block naming more than this many distinct memories is quoting the
// index, not recalling one. Three is comfortably above a real cross-reference
// (memories link to each other with [[name]]) and far below a 19-line index.
const INDEX_GIVEAWAY = 3;

// Transcripts are append-only and can get large; this is a guard against a
// pathological one stalling the scan, not a meaningful limit.
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

function slugFor(workdir) {
  return path.resolve(workdir).replace(/[^a-zA-Z0-9]/g, "-");
}

/** Every `*.jsonl` under a project, at any depth. Sessions live one directory
 *  down (`<uuid>/<uuid>.jsonl`) in current Claude Code and directly in the
 *  project folder in older layouts, so both are walked rather than guessed. */
function transcripts(projectDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      // The memory directory is the thing being measured, never a source of
      // measurements — and it holds no transcripts anyway.
      if (e.isDirectory()) {
        if (e.name !== "memory") walk(p);
      } else if (e.name.endsWith(".jsonl")) {
        out.push(p);
      }
    }
  };
  walk(projectDir);
  return out;
}

/**
 * One transcript's contribution: how many times each memory was read, and when
 * it was last touched.
 *
 * Only `Read` calls whose path is inside a `memory/` directory count, so a run
 * that happens to read a file with the same basename somewhere in the repo
 * doesn't inflate anything.
 */
function scanOne(file, names) {
  const hits = {};
  const bump = (name, ts, key) => {
    const h = (hits[name] = hits[name] || { reads: 0, recalls: 0, last: 0 });
    h[key]++;
    if (ts > h.last) h.last = ts;
  };

  let text;
  try {
    if (fs.statSync(file).size > MAX_TRANSCRIPT_BYTES) return hits;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return hits;
  }

  for (const line of text.split("\n")) {
    // Cheap reject first: the overwhelming majority of lines never name a
    // memory, and JSON.parse on all of them is the whole cost of this scan.
    if (!line.includes(".md")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(entry.timestamp || "") || 0;
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === "tool_use" && block.name === "Read") {
        const p = block.input && block.input.file_path;
        if (typeof p !== "string") continue;
        const base = path.basename(p);
        if (names.has(base) && p.includes(`${path.sep}memory${path.sep}`)) bump(base, ts, "reads");
        continue;
      }
      if (block.type === "text" && typeof block.text === "string" && block.text.includes("system-reminder")) {
        const named = [...names].filter((n) => block.text.includes(n));
        if (named.length && named.length <= INDEX_GIVEAWAY) {
          for (const n of named) bump(n, ts, "recalls");
        }
      }
    }
  }
  return hits;
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE, "utf8"));
  } catch {
    return {};
  }
}

function writeCache(value) {
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    const tmp = `${CACHE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    fs.renameSync(tmp, CACHE);
  } catch {
    // A cache that cannot be written is slow, not broken.
  }
}

/**
 * Read counts and last-used dates for every memory in a project.
 *
 * Incremental: a transcript is re-read only when its size or mtime has moved,
 * which for an append-only log means "the session said something new". A cold
 * scan of a few hundred sessions takes a second or two; every scan after it is
 * a stat per file.
 *
 * `names` is passed in rather than read here so the caller decides what counts
 * as a memory — lib/memory.js already has the listing, and two modules
 * disagreeing about that set is the kind of bug nobody finds.
 */
function usage(workdir, names) {
  const want = new Set((names || []).filter((n) => n && n !== "MEMORY.md"));
  const slug = slugFor(workdir);
  const projectDir = path.join(PROJECTS, slug);
  const empty = { byName: {}, transcripts: 0, scannedAt: 0 };
  if (!want.size) return empty;

  let files;
  try {
    files = transcripts(projectDir);
  } catch {
    return empty;
  }

  const cache = readCache();
  const prev = cache[slug] || { files: {} };
  const next = { files: {}, scannedAt: Math.floor(Date.now() / 1000) };
  // A memory added since the last scan was never looked for, so its cached
  // misses mean nothing — one changed name invalidates the whole project.
  const sameSet = prev.names && prev.names.length === want.size && prev.names.every((n) => want.has(n));

  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const sig = { mtime: Math.floor(stat.mtimeMs), size: stat.size };
    const cached = prev.files[file];
    next.files[file] =
      sameSet && cached && cached.mtime === sig.mtime && cached.size === sig.size
        ? cached
        : { ...sig, hits: scanOne(file, want) };
  }

  const byName = {};
  for (const n of want) byName[n] = { reads: 0, recalls: 0, lastUsedAt: 0 };
  for (const rec of Object.values(next.files)) {
    for (const [name, h] of Object.entries(rec.hits || {})) {
      const acc = byName[name];
      if (!acc) continue;
      acc.reads += h.reads || 0;
      acc.recalls += h.recalls || 0;
      if (h.last > acc.lastUsedAt) acc.lastUsedAt = h.last;
    }
  }

  next.names = [...want];
  cache[slug] = next;
  writeCache(cache);

  return { byName, transcripts: files.length, scannedAt: next.scannedAt };
}

module.exports = { usage, slugFor };
