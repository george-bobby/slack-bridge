/**
 * Persistence for the dashboard.
 *
 *   config.json     the pipeline gates and the job defaults (Settings writes it)
 *   runs/<id>.json  the chat record — one file per Slack thread you handed the
 *                   bridge, holding the whole conversation: the Slack message,
 *                   every phase the pipeline reported, the outcome, and every
 *                   follow-up you typed plus what Claude did about it.
 *
 * Nothing here is written by a background process. A chat exists because you
 * pasted its Slack link (or a run you started from a terminal narrated itself
 * through scripts/emit.sh).
 *
 * Per-run files rather than one big log because a follow-up streams for
 * minutes: appending a token to a 5MB JSON array means rewriting 5MB.
 */

const fs = require("fs");
const path = require("path");

const env = require("./env");

const ROOT = path.join(__dirname, "..");

// Everything mutable lives under data/, which is gitignored wholesale (bar the
// committed config.example.json). Keeping it in one directory is what makes
// "what is state and what is source" answerable at a glance — and what lets
// the ignore rule be one line instead of five that drift.
const DATA_DIR = env.dataDir;
const RUNS_DIR = path.join(DATA_DIR, "runs");

const PATHS = {
  data: DATA_DIR,
  config: path.join(DATA_DIR, "config.json"),
  runs: RUNS_DIR,
};

// The toggles the pipeline is gated on, passed through to slack-fetch-pipeline
// as `toggles`.
const TOGGLE_KEYS = ["createLinearIssue", "botReview", "saveToMemory", "reply"];

/* --------------------------------------------------------------- job opts */

/**
 * How a job runs: which repo, which model, how much rope, how hard it thinks.
 *
 * These used to be two text boxes in Settings that applied to every job on the
 * machine. They are now per chat — the composer writes them into the run file
 * and Settings only supplies the starting point — so the validation lives here
 * rather than inside writeConfig(): three callers need exactly the same rules
 * (the defaults in config.json, a chat's overrides in its run file, and the
 * argv assembled in lib/jobs.js).
 */
const PERMISSION_MODES = ["plan", "manual", "acceptEdits", "bypassPermissions"];
const EFFORT_LEVELS = ["", "low", "medium", "high", "xhigh", "max"];

const DEFAULT_JOB_OPTS = {
  model: env.pipelineModel,
  // Where the spawned session runs. It must be the repo the pipeline builds
  // against, not this folder, or Claude lands somewhere with no code in it —
  // hence TARGET_REPO in .env rather than a path baked in here.
  workdir: env.targetRepo,
  // How much the session may do unattended. bypassPermissions is what every
  // job hard-coded before this was selectable; plan, manual and acceptEdits are
  // the three ways to hand it less rope. They stopped being merely narrower
  // when the dashboard learned to answer a prompt: `manual` asks you about
  // every tool call, and under plan the session's ExitPlanMode now reaches you
  // rather than being refused — see the ask lifecycle in lib/jobs.js.
  permissionMode: "bypassPermissions",
  // "" leaves --effort off the command line entirely, which is the behaviour
  // that shipped before the dial existed.
  effort: "",
  // The 1M-context variant, requested by suffixing the model id: `opus[1m]`.
  // Off by default — it prices differently, so it should be a choice.
  context1m: false,
};

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Keep only the keys we recognise, and only when the value is usable. Anything
 * rejected is dropped silently so the caller keeps whatever it had — a bad
 * value must never widen what a job can do.
 */
function sanitizeJobOpts(patch) {
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  if (patch.model != null) {
    const v = String(patch.model).trim();
    if (/^[a-z0-9._-]{1,60}$/i.test(v)) out.model = v;
  }
  if (patch.workdir != null) {
    const v = String(patch.workdir).trim();
    // A job spawns a session that can write; pointing it at a path that isn't
    // there is how you get one rooted at /.
    if (v === "" || (path.isAbsolute(v) && isDir(v))) out.workdir = v;
  }
  if (patch.permissionMode != null && PERMISSION_MODES.includes(String(patch.permissionMode))) {
    out.permissionMode = String(patch.permissionMode);
  }
  if (patch.effort != null && EFFORT_LEVELS.includes(String(patch.effort))) {
    out.effort = String(patch.effort);
  }
  if (patch.context1m != null) out.context1m = Boolean(patch.context1m);
  return out;
}

/** What a job in this chat actually runs with: chat picks over Settings
 *  defaults over the built-ins. */
function jobOpts(config, run) {
  return {
    ...DEFAULT_JOB_OPTS,
    ...((config && config.followup) || {}),
    ...((run && run.opts) || {}),
  };
}

/**
 * mode         normal: every outcome is relayed to the orchestrator
 *              quiet:  only what needs you (questions, blocks, stalls, ...)
 *              away:   nothing is relayed; it's held and briefed on return
 * relay        whether outcomes start a turn in the orchestrator chat at all
 * maxWorkers   working workers at once, in total and per repo; past the cap a
 * maxPerRepo   new task is queued. Workers declared waiting don't count.
 * stallMinutes silence before a working worker is flagged as stalled
 * policy       per-category overrides of lib/policy.js (ask | allow)
 */
const DEFAULT_HARNESS = { mode: "normal", relay: true, maxWorkers: 3, maxPerRepo: 2, stallMinutes: 15, policy: {} };
const POLICY_KEYS = ["chat", "tickets", "docs", "prComments", "prMerge", "otherWrites", "destructiveGit"];

function sanitizeHarness(patch, base) {
  const out = { ...base, policy: { ...(base.policy || {}) } };
  if (!patch || typeof patch !== "object") return out;
  if (["normal", "quiet", "away"].includes(patch.mode)) out.mode = patch.mode;
  if (patch.relay != null) out.relay = Boolean(patch.relay);
  const int = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v))));
  if (Number.isFinite(Number(patch.maxWorkers)) && patch.maxWorkers !== "") out.maxWorkers = int(patch.maxWorkers, 1, 20);
  if (Number.isFinite(Number(patch.maxPerRepo)) && patch.maxPerRepo !== "") out.maxPerRepo = int(patch.maxPerRepo, 1, 20);
  if (Number.isFinite(Number(patch.stallMinutes)) && patch.stallMinutes !== "") out.stallMinutes = int(patch.stallMinutes, 1, 240);
  if (patch.policy && typeof patch.policy === "object") {
    for (const k of POLICY_KEYS) if (patch.policy[k] === "ask" || patch.policy[k] === "allow") out.policy[k] = patch.policy[k];
  }
  return out;
}

const DEFAULT_CONFIG = {
  // Offer to file a Linear ticket once the verdict is in. The run drafts it and
  // asks you before creating anything.
  createLinearIssue: true,
  // After the PR opens, wait for the review bots that run on every push to a
  // ready PR, then run /resolve.
  botReview: true,
  // Let a run *propose* a memory — never write one. Proposals land in
  // data/runs/memories/, which no session loads, and only recurrence or an
  // explicit approval promotes one into the repo's memory. See lib/proposals.js
  // for why the old always-bank behaviour had to go.
  saveToMemory: true,
  reply: true,
  // The harness: how outcomes reach you, and how many workers run at once.
  harness: { ...DEFAULT_HARNESS },
  // The starting point for every new chat's job options. A chat that has been
  // tuned in the composer keeps its own values; changing these only affects
  // chats you haven't touched.
  followup: { ...DEFAULT_JOB_OPTS },
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Atomic write so a reader (a job, another tab, us) never sees a
// half-written file. The mkdir is here rather than at boot because a fresh
// clone has no data/ at all, and the first thing to touch it may as well be
// whichever writer got there first.
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/* ------------------------------------------------------------------ config */

function readConfig() {
  const raw = readJson(PATHS.config, {});
  const config = {
    ...DEFAULT_CONFIG,
    followup: { ...DEFAULT_CONFIG.followup, ...(raw.followup || {}) },
    harness: sanitizeHarness(raw.harness, DEFAULT_HARNESS),
  };
  for (const key of TOGGLE_KEYS) if (key in raw) config[key] = Boolean(raw[key]);
  // Configs written while this targeted Codex call the review gate codexReplies.
  if (!("botReview" in raw) && "codexReplies" in raw) config.botReview = Boolean(raw.codexReplies);
  return config;
}

// Only ever merge known keys, so a stray field from an old config or a bad
// POST cannot end up steering a run.
function writeConfig(patch) {
  const next = readConfig();
  for (const key of TOGGLE_KEYS) {
    if (key in patch) next[key] = Boolean(patch[key]);
  }
  if (patch.followup && typeof patch.followup === "object") {
    Object.assign(next.followup, sanitizeJobOpts(patch.followup));
  }
  if (patch.harness && typeof patch.harness === "object") next.harness = sanitizeHarness(patch.harness, next.harness);
  writeJsonAtomic(PATHS.config, next);
  return next;
}

/* -------------------------------------------------------------------- cost */

/**
 * What the jobs you started have cost: today, and a 14-day daily series for
 * the Spend chart. Read off the runs themselves — every finished job records
 * its `total_cost_usd` on its message — so there is no second ledger to drift.
 */
function summariseCost() {
  ensureRunsDir();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const startOfDay = midnight.getTime() / 1000;
  const dayKey = (ts) => {
    const d = new Date(ts * 1000);
    d.setHours(0, 0, 0, 0);
    return d.getTime() / 1000;
  };
  const horizon = dayKey(Date.now() / 1000) - 13 * 86400;

  let today = 0,
    todayJobs = 0,
    jobs = 0,
    total = 0;
  const days = new Map();
  for (const f of fs.readdirSync(RUNS_DIR)) {
    if (!f.endsWith(".json") || f.includes(".tmp-")) continue;
    const run = readJson(path.join(RUNS_DIR, f), null);
    for (const m of (run && Array.isArray(run.messages) && run.messages) || []) {
      const c = Number(m.cost) || 0;
      if (!c) continue;
      const ts = Number(m.ts) || 0;
      jobs++;
      total += c;
      if (ts >= startOfDay) {
        today += c;
        todayJobs++;
      }
      const k = dayKey(ts);
      if (k >= horizon) {
        const row = days.get(k) || { day: k, poll: 0, work: 0, ticks: 0 };
        row.work += c;
        row.ticks++;
        days.set(k, row);
      }
    }
  }

  // Quiet days stay in the series as zero rather than closing the gap. `poll`
  // is always 0 (nothing runs idle any more) and `ticks` counts jobs; the
  // shape is kept so the chart reads the same fields it always has.
  const series = [];
  for (let k = horizon; k <= dayKey(Date.now() / 1000); k += 86400) {
    series.push(days.get(k) || { day: k, poll: 0, work: 0, ticks: 0 });
  }
  return { today, todayJobs, jobs, total, series };
}

/* -------------------------------------------------------------------- runs */

// runId is a Slack ts ("1784560120.179279"). Never trust it as a filename —
// it arrives over HTTP from emit.sh and from the browser.
function safeId(runId) {
  const id = String(runId || "").trim();
  return /^[A-Za-z0-9._-]{1,80}$/.test(id) && !id.startsWith(".") ? id : null;
}

function runPath(id) {
  return path.join(RUNS_DIR, `${id}.json`);
}

function ensureRunsDir() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function blankRun(id, seed = {}) {
  return {
    runId: id,
    createdAt: seed.createdAt || Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
    who: seed.who || "someone",
    channel: seed.channel || "",
    channelId: seed.channelId || "",
    threadTs: seed.threadTs || id,
    // The ts of the message that *opened* this chat. Everything after it is a
    // later message in the same thread, and must not be allowed to rewrite who
    // asked or what they asked for — see upsertMention.
    rootTs: seed.rootTs || "",
    userId: seed.userId || "",
    text: seed.text || "",
    permalink: seed.permalink || "",
    // pending  added from a Slack link, no job has touched it yet
    // running  a pipeline or a follow-up is in flight
    // acted / skipped / error  terminal, as reported by the pipeline
    action: seed.action || "pending",
    // Legacy triage fields from the poller days; kept so old run files and the
    // sidebar still agree on their shape.
    triage: seed.triage || "",
    triageReason: seed.triageReason || "",
    startedBy: seed.startedBy || "", // dashboard | terminal | ""
    outcome: seed.outcome || "",
    prUrl: seed.prUrl || "",
    linearUrl: seed.linearUrl || "",
    phase: seed.phase || "queued",
    // The uuid the follow-up sessions resume. Minted on the first follow-up so
    // the second one continues the same conversation instead of re-reading the
    // whole thread from scratch.
    sessionId: null,
    // This chat's overrides of the Settings job defaults, written by the
    // composer. Sparse on purpose: a key that isn't here follows the default,
    // so changing a default still moves chats you never tuned.
    opts: {},
    cost: 0,
    seenAt: 0, // when you last opened this chat — drives the unread dot
    messages: [],
  };
}

function loadRun(id) {
  const safe = safeId(id);
  if (!safe) return null;
  const run = readJson(runPath(safe), null);
  if (!run) return null;
  run.messages = Array.isArray(run.messages) ? run.messages : [];
  // Runs written before job options were per chat have no `opts` at all.
  if (!run.opts || typeof run.opts !== "object") run.opts = {};
  return run;
}

function saveRun(run) {
  ensureRunsDir();
  run.updatedAt = Math.floor(Date.now() / 1000);
  writeJsonAtomic(runPath(run.runId), run);
  return run;
}

/**
 * Drop every pending permission prompt, at boot.
 *
 * An ask is a question a *live child process* is blocked on, and those children
 * are ours — they die with the server. So a `pendingAsk` still on disk when we
 * start up belongs to a session that no longer exists, and leaving it there
 * gives you a sidebar full of Allow buttons that answer nothing and an
 * "awaiting you" badge that never clears.
 *
 * The step is marked `cancelled` rather than deleted, because it did happen:
 * the transcript should still show that the run stopped to ask and never got an
 * answer, which is usually the explanation for whatever it did next.
 */
function clearPendingAsks() {
  ensureRunsDir();
  let swept = 0;
  for (const f of fs.readdirSync(RUNS_DIR)) {
    if (!f.endsWith(".json") || f.includes(".tmp-")) continue;
    const run = readJson(path.join(RUNS_DIR, f), null);
    if (!run || !run.runId || !run.pendingAsk) continue;
    delete run.pendingAsk;
    for (const m of Array.isArray(run.messages) ? run.messages : []) {
      for (const s of Array.isArray(m.steps) ? m.steps : []) {
        if (s.ask && s.ask.state === "pending") s.ask.state = "cancelled";
      }
    }
    // Not saveRun(): bumping updatedAt here would mark every swept chat unread
    // on every restart.
    writeJsonAtomic(runPath(run.runId), run);
    swept++;
  }
  return swept;
}

/**
 * Every chat, newest first, as the sidebar needs them.
 *
 * Summarised rather than whole: a thread carrying a 40-minute pipeline run is
 * megabytes of transcript, and the sidebar draws one line from it. The two
 * halves are never wanted apart — every caller (the SSE seed, GET /api/runs,
 * and the four `runs` broadcasts) wants exactly this — so they are one call.
 */
function listRunSummaries() {
  ensureRunsDir();
  const out = [];
  for (const f of fs.readdirSync(RUNS_DIR)) {
    if (!f.endsWith(".json") || f.includes(".tmp-")) continue;
    const run = readJson(path.join(RUNS_DIR, f), null);
    if (run && run.runId) out.push(summariseRun(run));
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function summariseRun(run) {
  // Read straight off disk by listRunSummaries(), so it has not been through
  // loadRun()'s normalisation — a run file written before `messages` existed,
  // or a truncated one, would otherwise take the sidebar down with it.
  const messages = Array.isArray(run.messages) ? run.messages : [];
  const last = messages[messages.length - 1] || null;
  let task = null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "tasks", run.runId, "meta.json"), "utf8"));
    task = { status: meta.status || "", phase: meta.phase || "", branch: meta.branch || "", declared: meta.declared || null };
  } catch {}
  return {
    runId: run.runId,
    kind: run.kind || "slack",
    task,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    who: run.who,
    channel: run.channel,
    channelId: run.channelId,
    text: run.text,
    action: run.action,
    triage: run.triage || "",
    triageReason: run.triageReason || "",
    startedBy: run.startedBy || "",
    started: run.action !== "pending" || !!run.sessionId,
    // Has a job actually *run* against this thread? Drives the sidebar's Start
    // button.
    worked: hasWorked(run),
    phase: run.phase,
    outcome: run.outcome,
    prUrl: run.prUrl,
    linearUrl: run.linearUrl,
    permalink: run.permalink,
    cost: run.cost || 0,
    messages: messages.length,
    seenAt: run.seenAt || 0,
    unread: (run.updatedAt || 0) > (run.seenAt || 0),
    // A job blocked on you, rather than merely working. Deliberately louder
    // than `unread` in the sidebar: an unread chat is something to read when
    // you get to it, an awaiting one is a session sitting idle burning nothing
    // until you answer. Cleared by lib/jobs.js the moment it is answered, and
    // swept at boot by clearPendingAsks() — the child died with the server, so
    // a pendingAsk that outlives a restart is asking on behalf of nobody.
    awaiting: !!(run.pendingAsk && run.pendingAsk.id),
    askedFor: (run.pendingAsk && run.pendingAsk.summary) || "",
    live: run.action === "running" || (last && last.state === "running") || false,
    lastRole: last ? last.role : null,
    lastText: last ? String(last.text || "").slice(0, 160) : "",
  };
}

let seq = 0;
function newMessageId() {
  seq = (seq + 1) % 1e6;
  return `${Date.now().toString(36)}${seq.toString(36)}`;
}

function appendMessage(run, msg) {
  const full = {
    id: newMessageId(),
    ts: Math.floor(Date.now() / 1000),
    ...msg,
  };
  run.messages.push(full);
  return full;
}

/* ------------------------------------------------------- one thread, one chat */

/**
 * A run id is a Slack **thread** ts, not the ts of whichever message you
 * copied the link of. One conversation is one chat: pasting a link to a later
 * reply in a thread that already has a chat opens that chat instead of
 * starting a second, half-informed run against the same request.
 */

/** Has a pipeline or a job actually run against this thread? */
function hasWorked(run) {
  return (
    !!run.sessionId ||
    ["acted", "running", "error"].includes(run.action) ||
    !!run.prUrl ||
    !!run.linearUrl
  );
}

/**
 * Pull the channel and thread out of a Slack link.
 *
 * Accepts what "Copy link" gives you for a top-level message
 * (`…/archives/C0B34/p1784615086259089`) and for a reply in a thread
 * (`…/archives/C0B34/p1784615099123456?thread_ts=1784615086.259089&cid=C0B34`).
 * A Slack permalink carries the message's own ts with the dot stripped; the
 * `thread_ts` query parameter, when present, is the thread it lives in.
 */
function parseSlackLink(link) {
  let url;
  try {
    url = new URL(String(link || "").trim());
  } catch {
    throw new Error("that isn't a link — paste the Slack message's \"Copy link\" URL");
  }
  if (url.protocol !== "https:" || !/(^|\.)slack\.com$/i.test(url.hostname)) {
    throw new Error("not a slack.com link");
  }
  const m = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\/|$)/.exec(url.pathname);
  if (!m) throw new Error("couldn't find a channel and message in that Slack link");
  const channelId = m[1];
  const messageTs = `${m[2]}.${m[3]}`;
  const thread = url.searchParams.get("thread_ts");
  const threadTs = thread && /^\d{10}\.\d{6}$/.test(thread) ? thread : messageTs;
  return {
    channelId,
    messageTs,
    threadTs,
    permalink: `${url.origin}${url.pathname}${thread ? `?thread_ts=${threadTs}&cid=${channelId}` : ""}`,
  };
}

/**
 * Open (or create) the chat for a pasted Slack link.
 *
 * Nothing is fetched here — this process holds no Slack credentials. The chat
 * starts as just the link; the pipeline reads the thread through the Slack
 * connector inside its Claude session and narrates who asked and what they
 * said back into the chat (see emit.sh's `who=`/`message=` fields).
 */
function createFromLink(link) {
  const parsed = parseSlackLink(link);
  const id = safeId(parsed.threadTs);
  if (!id) throw new Error("bad thread id in that link");
  const existing = loadRun(id);
  if (existing) return { run: existing, created: false };
  const run = blankRun(id, {
    channelId: parsed.channelId,
    threadTs: parsed.threadTs,
    rootTs: parsed.messageTs,
    permalink: parsed.permalink,
    who: "Slack thread",
    text: parsed.permalink,
    action: "pending",
  });
  saveRun(run);
  return { run, created: true };
}

/** Forget a chat, for good. The Slack thread, PR and Linear issue stay. */
function deleteRun(id) {
  const safe = safeId(id);
  if (!safe) return false;
  try {
    fs.unlinkSync(runPath(safe));
  } catch {
    // Already gone.
  }
  return true;
}

module.exports = {
  PATHS,
  sanitizeJobOpts,
  jobOpts,
  isDir,
  readConfig,
  writeConfig,
  summariseCost,
  safeId,
  blankRun,
  loadRun,
  saveRun,
  clearPendingAsks,
  listRunSummaries,
  appendMessage,
  parseSlackLink,
  createFromLink,
  deleteRun,
  ensureRunsDir,
};
