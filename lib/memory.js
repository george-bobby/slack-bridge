/**
 * Claude Code's project memory, read and written from the dashboard.
 *
 * Every repo Claude Code has worked in gets a directory under
 * `~/.claude/projects/<slug>/`, and the memory lives in `memory/` inside it:
 * one fact per file, plus a `MEMORY.md` index that is loaded into context at
 * the start of every session. That index is the thing worth editing from here —
 * it is what the poller's headless runs actually read, and until now the only
 * way to see what a run was told about the repo was to go open the folder.
 *
 * This module is deliberately the whole of the filesystem surface: index.js
 * hands it a workdir and a filename and gets back text, and every path it
 * builds is re-checked against the memory directory it derived. A POST to this
 * server can already start a session with permissions skipped, so the write
 * side is narrow on purpose — `*.md`, inside one directory, and nothing that
 * loses text: creating requires a name that does not exist yet, and retiring a
 * memory moves it into `.archive/` rather than unlinking it.
 *
 * **Every write also maintains `MEMORY.md`.** The index is the only part of a
 * project's memory that is loaded into every session, which makes it the real
 * context budget — a file the index doesn't mention is never found, and an
 * index line pointing at a file that has been retired is a broken promise. The
 * two are edited together here so neither can drift.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const memuse = require("./memuse");

const PROJECTS = path.join(os.homedir(), ".claude", "projects");

// Where a retired memory goes. Inside the memory directory so it travels with
// the project, dot-prefixed so Claude Code's own loader skips it, and a plain
// move so restoring is a move back.
const ARCHIVE = ".archive";

/**
 * A working directory to its `~/.claude/projects` folder name.
 *
 * Claude Code flattens the absolute path by replacing every character that is
 * not a letter or digit with a dash, which is why worktrees come out as
 * `-Users-george-Development-gym--claude-worktrees-exp-379`: the slash and the
 * dot of `/.claude` both become dashes and collapse into a visible `--`.
 */
function slugFor(workdir) {
  return path.resolve(workdir).replace(/[^a-zA-Z0-9]/g, "-");
}

function dirFor(workdir) {
  return path.join(PROJECTS, slugFor(workdir), "memory");
}

/**
 * A memory file's own name for itself.
 *
 * The per-fact files open with YAML frontmatter carrying `name`, `description`
 * and a `metadata.type` of user | feedback | project | reference — which is
 * what the list groups by, so a repo with twenty memories still reads as four
 * short sections rather than one wall of filenames. `MEMORY.md` has no
 * frontmatter at all, so both fallbacks matter.
 */
function describe(text, file) {
  const fm = text.startsWith("---\n") ? text.slice(4, text.indexOf("\n---", 4) + 1) : "";
  // Descriptions are long enough to need quoting in YAML, and both the quotes
  // and the backslashes escaping the inner ones are syntax rather than content
  // — neither may reach the index line or the panel, which show the value to a
  // reader. Unescaping only inside a quoted scalar, because that is the only
  // place YAML gives `\"` that meaning.
  const field = (k) => {
    const raw = (fm.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, "m")) || [, ""])[1].trim();
    const m = raw.match(/^(['"])([\s\S]*)\1$/);
    if (!m) return raw;
    return m[1] === '"' ? m[2].replace(/\\(["\\])/g, "$1") : m[2].replace(/''/g, "'");
  };
  const heading = (text.match(/^#\s+(.+)$/m) || [, ""])[1].trim();
  return {
    title: field("name") || heading || file.replace(/\.md$/, ""),
    desc: field("description"),
    // `type:` only ever appears under `metadata:`, so it needs no more care.
    type: field("type"),
  };
}

/** Every `*.md` in a project's memory, index first and the rest alphabetical.
 *  Missing directory is a normal answer, not an error: most repos have no
 *  memory, and the panel says so rather than showing a failure.
 *
 *  Each file carries what it has cost and earned: `reads` and `lastUsedAt` from
 *  the session transcripts (see lib/memuse.js), and `unusedDays` measured from
 *  the last read *or* from when the file was written if it has never been read
 *  — a memory created yesterday is new, not stale, and the two are
 *  indistinguishable without that fallback. */
function list(workdir, opts = {}) {
  const dir = dirFor(workdir);
  const out = {
    dir,
    project: path.basename(path.resolve(workdir)),
    exists: false,
    files: [],
    archived: archived(workdir),
  };
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  out.exists = true;

  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    let stat, text;
    try {
      stat = fs.statSync(path.join(dir, name));
      if (!stat.isFile()) continue;
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    out.files.push({ name, size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000), ...describe(text, name) });
  }

  out.files.sort((a, b) =>
    a.name === "MEMORY.md" ? -1 : b.name === "MEMORY.md" ? 1 : a.name.localeCompare(b.name)
  );

  if (opts.usage !== false) {
    const stats = memuse.usage(
      workdir,
      out.files.map((f) => f.name)
    );
    out.scannedTranscripts = stats.transcripts;
    const now = Date.now();
    for (const f of out.files) {
      const s = stats.byName[f.name];
      if (!s) continue;
      f.reads = s.reads;
      f.recalls = s.recalls;
      f.lastUsedAt = s.lastUsedAt ? Math.floor(s.lastUsedAt / 1000) : 0;
      f.unusedDays = Math.floor((now - (s.lastUsedAt || f.mtime * 1000)) / 86400000);
    }
    // The index is what every session pays for, so its size is the budget the
    // panel shows rather than the total size of the memory directory.
    const idx = out.files.find((f) => f.name === "MEMORY.md");
    out.indexBytes = idx ? idx.size : 0;
  }

  /*
   * Does the index still agree with the directory?
   *
   * These drift, and the drift is silent in both directions. A memory the index
   * has stopped listing is still on disk and still perfectly good, but nothing
   * loads it and no session can find it — which also pins its read count at
   * zero forever, so any rule that retires unused memories will eventually
   * retire it *because* it was orphaned. An index line with no file behind it
   * is the mirror image: it spends context on every session to promise
   * something that cannot be opened.
   *
   * Neither is inferable from a file listing alone, and both are one set
   * difference away, so the panel is never without the answer.
   */
  const listed = new Set([...readIndex(dir).matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]));
  const present = new Set(out.files.map((f) => f.name).filter((n) => n !== "MEMORY.md"));
  out.orphaned = [...present].filter((n) => !listed.has(n));
  out.dangling = [...listed].filter((n) => n.endsWith(".md") && !present.has(n));
  for (const f of out.files) f.orphaned = out.orphaned.includes(f.name);

  return out;
}

/**
 * Resolve one file inside a project's memory, or throw.
 *
 * Two checks rather than one: the name has to look like a bare markdown
 * filename, *and* the joined path has to still be inside the directory after
 * resolution. The first rejects `../../.ssh/config` outright; the second is
 * what holds if the first is ever loosened, and costs nothing to keep.
 */
function resolve(workdir, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(String(name || ""))) {
    throw new Error("memory files are named like feedback-thing.md");
  }
  const dir = dirFor(workdir);
  const file = path.resolve(dir, name);
  if (path.dirname(file) !== path.resolve(dir)) throw new Error("outside the memory directory");
  return file;
}

function read(workdir, name) {
  const file = resolve(workdir, name);
  return { name, text: fs.readFileSync(file, "utf8") };
}

/**
 * Overwrite one memory file.
 *
 * Only files that already exist: this panel is for reading and correcting what
 * Claude wrote about the repo, and letting a browser POST new files into
 * `~/.claude` is a bigger door than that needs. Written through a temp file and
 * renamed, so a session reading MEMORY.md mid-save gets the old one or the new
 * one and never half of either.
 */
function write(workdir, name, text) {
  const file = resolve(workdir, name);
  if (!fs.existsSync(file)) throw new Error(`no such memory: ${name}`);
  if (typeof text !== "string") throw new Error("text must be a string");
  if (text.length > 500_000) throw new Error("that is too long to be a memory");

  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text.endsWith("\n") ? text : text + "\n");
  fs.renameSync(tmp, file);
  return { name, savedAt: Math.floor(Date.now() / 1000) };
}

/* ------------------------------------------------------------------ index */

/**
 * `MEMORY.md` as sections of bullets.
 *
 * The format is the one Claude Code writes and the one a human keeps editing by
 * hand, so this parses loosely and rewrites conservatively: headings are `#`
 * lines, entries are `- [Title](file.md) — hook`, and anything else in the file
 * is carried through untouched. A prose paragraph someone added under a heading
 * survives a create and a retire.
 */
const ENTRY = /^\s*-\s*\[[^\]]*\]\(([^)]+)\)/;

function indexOf(dir) {
  return path.join(dir, "MEMORY.md");
}

function readIndex(dir) {
  try {
    return fs.readFileSync(indexOf(dir), "utf8");
  } catch {
    return "";
  }
}

/** Add one entry, under `section` if it exists and in a new trailing section if
 *  it does not. Never adds a second line for a file already listed. */
function addToIndex(text, { name, title, hook, section }) {
  const lines = text.split("\n");
  if (lines.some((l) => (l.match(ENTRY) || [, ""])[1] === name)) return text;

  const entry = `- [${title}](${name})${hook ? ` — ${hook}` : ""}`;
  const heading = String(section || "").trim();
  const at = heading
    ? lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#{1,6}\s*/, "").trim() === heading)
    : -1;

  if (at === -1) {
    // A project's first memory writes the whole index, so the empty case must
    // not leave the blank lines that separate sections in a populated one.
    const body = text.replace(/\s*$/, "");
    const lead = body ? `${body}\n\n` : "";
    return `${lead}${heading ? `# ${heading}\n\n` : ""}${entry}\n`;
  }

  // Last bullet of that section, so a new memory lands beside its siblings
  // rather than above them.
  let end = at + 1;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    if (lines[i].trim()) end = i + 1;
  }
  lines.splice(end, 0, entry);
  return lines.join("\n");
}

/** Drop a file's entry, and the heading above it if that leaves it empty. */
function removeFromIndex(text, name) {
  const lines = text.split("\n").filter((l) => (l.match(ENTRY) || [, ""])[1] !== name);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      let hasBody = false;
      for (let j = i + 1; j < lines.length && !/^#{1,6}\s/.test(lines[j]); j++) {
        if (lines[j].trim()) hasBody = true;
      }
      if (!hasBody) {
        while (i + 1 < lines.length && !lines[i + 1].trim()) i++;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n");
}

function saveText(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text.endsWith("\n") ? text : text + "\n");
  fs.renameSync(tmp, file);
}

/* ------------------------------------------------------- create and retire */

/**
 * Write a memory that does not exist yet, and list it in the index.
 *
 * Refuses to overwrite: an approval that silently replaced a memory would lose
 * the very thing the panel exists to protect. The frontmatter is checked rather
 * than trusted because `describe()` and Claude Code's own loader both read it
 * by key — a file without `name` and `description` is findable by neither.
 */
function create(workdir, name, text, opts = {}) {
  const file = resolve(workdir, name);
  if (name === "MEMORY.md") throw new Error("MEMORY.md is the index, not a memory");
  if (fs.existsSync(file)) throw new Error(`already exists: ${name} — update it instead`);
  if (typeof text !== "string" || !text.trim()) throw new Error("a memory needs text");
  if (text.length > 500_000) throw new Error("that is too long to be a memory");

  const meta = describe(text, name);
  if (!meta.desc) throw new Error("frontmatter needs a description — it is what recall matches on");
  if (!["user", "feedback", "project", "reference"].includes(meta.type)) {
    throw new Error("frontmatter needs metadata.type of user | feedback | project | reference");
  }

  const dir = dirFor(workdir);
  fs.mkdirSync(dir, { recursive: true });
  saveText(file, text);
  saveText(
    indexOf(dir),
    addToIndex(readIndex(dir), {
      name,
      title: opts.title || meta.title,
      hook: opts.hook || meta.desc,
      section: opts.section,
    })
  );
  return { name, createdAt: Math.floor(Date.now() / 1000) };
}

/**
 * Retire a memory: out of the index, into `.archive/`.
 *
 * Deliberately not a delete. A memory is the distilled output of work that has
 * already happened and cannot be reconstructed from the repo, and the pruning
 * signal that suggests retiring one — nobody has read it lately — is exactly
 * the signal that is wrong about a memory covering a rare case. Moving it costs
 * a directory entry and makes the mistake recoverable.
 */
function archive(workdir, name) {
  const file = resolve(workdir, name);
  if (name === "MEMORY.md") throw new Error("MEMORY.md is the index, not a memory");
  if (!fs.existsSync(file)) throw new Error(`no such memory: ${name}`);

  const dir = dirFor(workdir);
  const into = path.join(dir, ARCHIVE);
  fs.mkdirSync(into, { recursive: true });
  fs.renameSync(file, path.join(into, name));
  saveText(indexOf(dir), removeFromIndex(readIndex(dir), name));
  return { name, archivedAt: Math.floor(Date.now() / 1000) };
}

/**
 * List a memory that is on disk but missing from the index.
 *
 * Distinct from `restore` because the file never moved: something rewrote
 * MEMORY.md and dropped the line, leaving a perfectly good memory that no
 * session can find. The fix is one index entry, rebuilt from the file's own
 * frontmatter, so it says exactly what the memory says about itself.
 */
function relist(workdir, name, opts = {}) {
  const file = resolve(workdir, name);
  if (name === "MEMORY.md") throw new Error("MEMORY.md is the index, not a memory");
  if (!fs.existsSync(file)) throw new Error(`no such memory: ${name}`);

  const dir = dirFor(workdir);
  const meta = describe(fs.readFileSync(file, "utf8"), name);
  saveText(
    indexOf(dir),
    addToIndex(readIndex(dir), {
      name,
      title: opts.title || meta.title,
      hook: opts.hook || meta.desc,
      section: opts.section,
    })
  );
  return { name, relistedAt: Math.floor(Date.now() / 1000) };
}

/** Put an archived memory back, index line and all. */
function restore(workdir, name) {
  const file = resolve(workdir, name);
  const dir = dirFor(workdir);
  const from = path.join(dir, ARCHIVE, name);
  if (!fs.existsSync(from)) throw new Error(`not archived: ${name}`);
  if (fs.existsSync(file)) throw new Error(`already live: ${name}`);

  fs.renameSync(from, file);
  const meta = describe(fs.readFileSync(file, "utf8"), name);
  saveText(indexOf(dir), addToIndex(readIndex(dir), { name, title: meta.title, hook: meta.desc }));
  return { name, restoredAt: Math.floor(Date.now() / 1000) };
}

function archived(workdir) {
  try {
    return fs.readdirSync(path.join(dirFor(workdir), ARCHIVE)).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
}

module.exports = {
  dirFor,
  list,
  read,
  write,
  create,
  archive,
  restore,
  relist,
  archived,
  addToIndex,
  removeFromIndex,
};
