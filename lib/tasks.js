/**
 * Tasks: the harness's source of truth, as plain files.
 *
 *   data/tasks/<id>/brief.md     what the worker was asked to do (written at spawn)
 *   data/tasks/<id>/meta.json    repo, worktree, branch, status, timestamps
 *   data/tasks/<id>/report.md    written by the worker; frontmatter `status:`
 *   data/tasks/decisions.json    questions and action requests waiting on you
 *   data/tasks/todos.json        things only you can do, deduplicated by key
 *   data/tasks/events.log        append-only JSON lines: every outcome, ever
 *
 * A task's id is its chat's runId, so a Slack thread's task folder is
 * `data/tasks/<thread_ts>/` and a typed task's is `data/tasks/t-<stamp>-<slug>/`.
 * The chat (data/runs/<id>.json) is the transcript; the task folder is the
 * contract. A restarted server rereads these and carries on (lib/watch.js).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const env = require("./env");

const DIR = path.join(env.dataDir, "tasks");
const FILES = {
  decisions: path.join(DIR, "decisions.json"),
  todos: path.join(DIR, "todos.json"),
  events: path.join(DIR, "events.log"),
};

const REPORT_STATUSES = ["ready-for-review", "needs-input", "blocked", "pushed-follow-up"];

/* ----------------------------------------------------------------- basics */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

const now = () => Math.floor(Date.now() / 1000);
const hash = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12);

function safeTaskId(id) {
  const s = String(id || "").trim();
  return /^[A-Za-z0-9._-]{1,80}$/.test(s) && !s.startsWith(".") ? s : null;
}

function taskDir(id) {
  const safe = safeTaskId(id);
  if (!safe) throw new Error(`bad task id: ${id}`);
  return path.join(DIR, safe);
}

const paths = (id) => {
  const d = taskDir(id);
  return { dir: d, brief: path.join(d, "brief.md"), meta: path.join(d, "meta.json"), report: path.join(d, "report.md") };
};

/** `t-261113-1702-fix-login-redirect`: sortable, readable, and a valid runId. */
function newTaskId(title) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `t-${stamp}-${slugify(title) || "task"}`.slice(0, 80);
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-")
    .slice(0, 40);
}

/* ------------------------------------------------------------------- meta */

function readMeta(id) {
  return readJson(paths(id).meta, null);
}

function writeMeta(id, patch) {
  const p = paths(id);
  const cur = readJson(p.meta, null) || { id, createdAt: now() };
  const next = { ...cur, ...patch, id, updatedAt: now() };
  writeJson(p.meta, next);
  return next;
}

function exists(id) {
  try {
    return fs.existsSync(paths(id).meta);
  } catch {
    return false;
  }
}

function list() {
  let names = [];
  try {
    names = fs.readdirSync(DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((d) => d.isDirectory() && safeTaskId(d.name))
    .map((d) => readMeta(d.name))
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function writeBrief(id, text) {
  const p = paths(id);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.brief, String(text).endsWith("\n") ? text : `${text}\n`);
  return p.brief;
}

/* ----------------------------------------------------------------- report */

/** The report's bytes and a content hash, or null when there is none yet. */
function readReport(id) {
  try {
    const text = fs.readFileSync(paths(id).report, "utf8");
    return { text, hash: hash(text), parsed: parseReport(text) };
  } catch {
    return null;
  }
}

/**
 * Parse the report contract.
 *
 *   ---
 *   status: ready-for-review | needs-input | blocked | pushed-follow-up
 *   pr: <url>            (any other key: kept in `fields`)
 *   ---
 *   ## TL;DR
 *   ## Summary / Changes / Verification
 *   ## Open questions      one bullet per question
 *   ## Action requests     one bullet per outward write wanted
 *   ## Proposed commit/PR text
 *
 * Lenient on purpose: a report a worker got slightly wrong is still a report,
 * and the watcher would rather relay it with `status: unknown` than drop it.
 */
function parseReport(text) {
  const src = String(text || "");
  const fields = {};
  let body = src;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (fm) {
    body = src.slice(fm[0].length);
    for (const line of fm[1].split("\n")) {
      const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
      if (m) fields[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  const sections = {};
  let cur = "_lead";
  for (const line of body.split("\n")) {
    const h = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (h) {
      cur = h[1].toLowerCase().replace(/[^a-z0-9;/ ]/g, "").trim();
      sections[cur] = "";
      continue;
    }
    sections[cur] = (sections[cur] || "") + line + "\n";
  }
  const pick = (...names) => {
    for (const n of names) {
      const k = Object.keys(sections).find((s) => s === n || s.startsWith(n));
      if (k) return sections[k].trim();
    }
    return "";
  };
  const bullets = (s) => {
    const out = [];
    let cur = null;
    for (const line of String(s).split("\n")) {
      const m = /^\s{0,3}(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
      if (m) {
        if (cur) out.push(cur.trim());
        cur = m[1];
      } else if (cur !== null && line.trim()) {
        cur += "\n" + line.replace(/^\s{2,}/, "");
      }
    }
    if (cur) out.push(cur.trim());
    // "None." or "None. (an aside about what isn't needed)" both mean none.
    return out.filter((b) => !/^(none|n\/a|nothing|-|\(none\))(\.|$|[.:,;]\s)/i.test(b.trim()));
  };
  const status = REPORT_STATUSES.includes(fields.status) ? fields.status : fields.status ? "unknown" : "unknown";
  return {
    status,
    fields,
    tldr: pick("tldr", "tl;dr", "tl dr") || (sections._lead || "").trim().split("\n\n")[0] || "",
    questions: bullets(pick("open questions", "questions")),
    actions: bullets(pick("action requests", "actions")),
    sections,
  };
}

/* -------------------------------------------------------------- decisions */

/**
 * One entry per thing waiting on you. `key` dedupes: the same question
 * relayed twice (a report rewritten without changing it) is one decision.
 *
 *   kind: question   a worker's open question; answering sends it back
 *         action     an outward write a worker wants; "do it" sends it back
 *         resume     a worker the server lost (restart) or that stalled
 */
function decisions() {
  return readJson(FILES.decisions, []);
}

function addDecision({ taskId, kind, text, key }) {
  const all = decisions();
  const k = key || `${taskId}:${kind}:${hash(text)}`;
  const dup = all.find((d) => d.key === k && d.state === "open");
  if (dup) return { decision: dup, duplicate: true };
  const d = {
    id: `d-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    key: k,
    taskId,
    kind,
    text: String(text).slice(0, 4000),
    state: "open",
    createdAt: now(),
  };
  all.push(d);
  writeJson(FILES.decisions, all.slice(-500));
  return { decision: d, duplicate: false };
}

function updateDecision(id, patch) {
  const all = decisions();
  const d = all.find((x) => x.id === id);
  if (!d) throw new Error(`no such decision: ${id}`);
  Object.assign(d, patch, { updatedAt: now() });
  writeJson(FILES.decisions, all);
  return d;
}

/** Open decisions, minus the ones deferred to a later day. */
function openDecisions({ includeDeferred = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return decisions().filter((d) => {
    if (d.state === "open") return true;
    if (d.state === "deferred") return includeDeferred || !d.deferUntil || d.deferUntil <= today;
    return false;
  });
}

/** Close every open decision of a task, e.g. once it reports again. */
function closeTaskDecisions(taskId, kinds, state = "superseded") {
  const all = decisions();
  let n = 0;
  for (const d of all) {
    if (d.taskId === taskId && (d.state === "open" || d.state === "deferred") && (!kinds || kinds.includes(d.kind))) {
      d.state = state;
      d.updatedAt = now();
      n++;
    }
  }
  if (n) writeJson(FILES.decisions, all);
  return n;
}

/* ------------------------------------------------------------------ todos */

function todos() {
  return readJson(FILES.todos, []);
}

/** Refuses a second open to-do with the same key rather than stacking it. */
function addTodo({ key, text, taskId = "", url = "" }) {
  const k = String(key || "").trim() || `todo:${hash(text)}`;
  const all = todos();
  const dup = all.find((t) => t.key === k && !t.done);
  if (dup) return { todo: dup, duplicate: true };
  const t = { key: k, text: String(text).slice(0, 500), taskId, url, done: false, createdAt: now() };
  all.push(t);
  writeJson(FILES.todos, all.slice(-500));
  return { todo: t, duplicate: false };
}

function doneTodo(key) {
  const all = todos();
  const t = all.find((x) => x.key === key && !x.done);
  if (!t) throw new Error(`no open to-do: ${key}`);
  t.done = true;
  t.doneAt = now();
  writeJson(FILES.todos, all);
  return t;
}

/* ----------------------------------------------------------------- events */

function appendEvent(ev) {
  fs.mkdirSync(DIR, { recursive: true });
  const line = { at: now(), ...ev };
  fs.appendFileSync(FILES.events, JSON.stringify(line) + "\n");
  return line;
}

function readEvents({ since = 0, limit = 200 } = {}) {
  let text = "";
  try {
    text = fs.readFileSync(FILES.events, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if ((e.at || 0) >= since) out.push(e);
    } catch {}
  }
  return out.slice(-limit);
}

/** "3h" / "45m" / "2d" -> seconds ago as a unix timestamp. */
function parseSince(s) {
  const m = /^(\d+)\s*([mhd])$/.exec(String(s || "").trim());
  if (!m) return now() - 8 * 3600;
  return now() - Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2]];
}

/* -------------------------------------------------------------- worktrees */

function git(args, cwd, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(" ")}: ${String(stderr || err.message).trim().split("\n").slice(-2).join(" ")}`));
      else resolve(String(stdout).trim());
    });
  });
}

async function defaultBranch(repo) {
  try {
    const ref = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo);
    return ref.replace(/^origin\//, "");
  } catch {
    for (const b of ["main", "master"]) {
      try {
        await git(["rev-parse", "--verify", "--quiet", b], repo);
        return b;
      } catch {}
    }
    return "main";
  }
}

function worktreeRootFor(repo) {
  const clean = repo.replace(/\/+$/, "");
  if (env.worktreeRoot && env.targetRepo && path.resolve(env.targetRepo) === path.resolve(clean)) return env.worktreeRoot;
  return `${clean}-worktrees`;
}

/**
 * Validate everything, then make the worktree. Validation first so a bad
 * spawn fails before it leaves a half-made branch behind.
 */
async function createWorktree({ repo, branch }) {
  if (!repo || !path.isAbsolute(repo) || !fs.existsSync(path.join(repo, ".git"))) {
    throw new Error(`not a git checkout: ${repo}`);
  }
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.startsWith("-")) {
    throw new Error(`bad branch name: ${branch}`);
  }
  await git(["check-ref-format", "--branch", branch], repo);
  try {
    await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo);
    throw new Error(`branch already exists: ${branch}`);
  } catch (e) {
    if (/already exists/.test(e.message)) throw e;
  }
  const base = await defaultBranch(repo);
  let from = base;
  // Fresh default branch: fetch it, and branch from the remote copy so a stale
  // local main never leaks into the task. No remote is fine (scratch repos).
  try {
    await git(["fetch", "--quiet", "origin", base], repo, 120000);
    from = `origin/${base}`;
  } catch {}
  const root = worktreeRootFor(repo);
  const dir = path.join(root, branch.replace(/\//g, "-"));
  if (fs.existsSync(dir)) throw new Error(`worktree path already exists: ${dir}`);
  fs.mkdirSync(root, { recursive: true });
  await git(["worktree", "add", "--quiet", "-b", branch, dir, from], repo, 120000);
  return { worktree: dir, branch, base, from };
}

/**
 * What cleanup would lose. `dirty` is uncommitted changes; `unpushed` is
 * commits on the branch that no remote branch holds. Either one makes
 * cleanup refuse without --force.
 */
async function inspectWorktree(dir) {
  if (!dir || !fs.existsSync(dir)) return { exists: false, dirty: false, unpushed: 0 };
  const status = await git(["status", "--porcelain"], dir).catch(() => "");
  let unpushed = 0;
  try {
    const out = await git(["rev-list", "--count", "HEAD", "--not", "--remotes"], dir);
    unpushed = Number(out) || 0;
  } catch {}
  // A branch with no remote at all, but also no commits of its own, loses
  // nothing; one with commits and no remote is exactly the case to refuse.
  return { exists: true, dirty: !!status, dirtyFiles: status.split("\n").filter(Boolean).length, unpushed };
}

/** PIDs of processes whose cwd is inside `dir`, via lsof. Exact PIDs only. */
function pidsInside(dir) {
  return new Promise((resolve) => {
    execFile("lsof", ["-a", "-d", "cwd", "-F", "pn", "-u", String(process.getuid())], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const pids = [];
      let pid = null;
      for (const line of String(stdout || "").split("\n")) {
        if (line.startsWith("p")) pid = Number(line.slice(1));
        else if (line.startsWith("n") && pid) {
          const n = line.slice(1);
          if ((n === dir || n.startsWith(dir + "/")) && pid !== process.pid) pids.push(pid);
        }
      }
      resolve([...new Set(pids)]);
    });
  });
}

async function removeWorktree({ repo, worktree, force }) {
  const args = ["worktree", "remove", worktree];
  if (force) args.splice(2, 0, "--force");
  await git(args, repo, 60000);
}

module.exports = {
  DIR,
  FILES,
  REPORT_STATUSES,
  paths,
  safeTaskId,
  newTaskId,
  slugify,
  readMeta,
  writeMeta,
  exists,
  list,
  writeBrief,
  readReport,
  parseReport,
  decisions,
  addDecision,
  updateDecision,
  openDecisions,
  closeTaskDecisions,
  todos,
  addTodo,
  doneTodo,
  appendEvent,
  readEvents,
  parseSince,
  git,
  defaultBranch,
  createWorktree,
  inspectWorktree,
  pidsInside,
  removeWorktree,
  hash,
};
