/**
 * Persistence for the dashboard.
 *
 * Two stores live side by side, on purpose:
 *
 *   activity.json   the poller's write contract — a flat, capped array of one
 *                   line per mention. /scan-mentions owns it and knows nothing
 *                   about this file. Unchanged.
 *   runs/<id>.json  the chat record — one file per mention, holding the whole
 *                   conversation: the Slack message, every phase the pipeline
 *                   reported, the outcome, and every follow-up you typed plus
 *                   what Claude did about it.
 *
 * activity.json is mirrored *into* runs/ (never the other way), so a run still
 * shows up with its outcome and links even if the pipeline emitted no events
 * at all — an old poller, a dashboard that was down, a run that crashed. The
 * events are enrichment, never the source of truth for "did this happen".
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
const DATA_DIR = path.join(ROOT, "data");
const RUNS_DIR = path.join(DATA_DIR, "runs");

const PATHS = {
  data: DATA_DIR,
  config: path.join(DATA_DIR, "config.json"),
  state: path.join(DATA_DIR, "state.json"),
  activity: path.join(DATA_DIR, "activity.json"),
  cost: path.join(DATA_DIR, "cost.json"),
  runs: RUNS_DIR,
};

// The toggles the pipeline is gated on. `enabled` is the master switch read by
// run-once.sh before it spends anything; the rest are passed through to
// slack-fetch-pipeline as `toggles`.
const TOGGLE_KEYS = ["enabled", "createLinearIssue", "codexReplies", "saveToMemory", "reply"];

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
const PERMISSION_MODES = ["plan", "acceptEdits", "bypassPermissions"];
const EFFORT_LEVELS = ["", "low", "medium", "high", "xhigh", "max"];

const DEFAULT_JOB_OPTS = {
  model: env.pipelineModel,
  // Where the spawned session runs. It must be the repo the pipeline builds
  // against, not this folder, or Claude lands somewhere with no code in it —
  // hence TARGET_REPO in .env rather than a path baked in here.
  workdir: env.targetRepo,
  // How much the session may do unattended. bypassPermissions is what every
  // job hard-coded before this was selectable; plan and acceptEdits are the
  // two ways to hand it less rope, and both matter in a headless run because
  // there is nobody here to answer a prompt.
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

const DEFAULT_CONFIG = {
  // off   poll nothing, spend nothing
  // watch poll and list every mention in the inbox, dispatch nothing — you
  //       press Start on the ones you want
  // auto  poll, triage, and dispatch the oldest actionable one
  //
  // `enabled` is kept in lockstep (mode !== "off") because run-once.sh's
  // cheapest gate is a grep for it and older pollers only know the boolean.
  mode: "auto",
  enabled: true,
  createLinearIssue: false,
  codexReplies: true,
  // Let a run *propose* a memory — never write one. Proposals land in
  // data/runs/memories/, which no session loads, and only recurrence or an
  // explicit approval promotes one into the repo's memory. See lib/proposals.js
  // for why the old always-bank behaviour had to go.
  saveToMemory: true,
  reply: true,
  // Read by run-once.sh at the top of every tick, so the Settings drawer
  // changes real behaviour without editing the plist. Cadence is the one
  // exception: launchd owns the firing interval, so changing it here also
  // needs the job reloaded (the drawer offers a button). The starting values
  // come from .env, which is also what the plist is stamped with.
  poller: {
    intervalSec: env.pollIntervalSec,
    activeHours: env.pollActiveHours,
    activeDays: env.pollActiveDays,
    scanModel: env.scanModel,
  },
  // The starting point for every new chat's job options. A chat that has been
  // tuned in the composer keeps its own values; changing these only affects
  // chats you haven't touched.
  followup: { ...DEFAULT_JOB_OPTS },
};

const DEFAULT_STATE = {
  lastTs: "0",
  lastRun: null,
  lastRunStatus: "never run",
  runner: null, // cron (launchd) | dashboard (Poll now) | manual (hand-run)
  intervalSec: env.pollIntervalSec,
  mcpOk: true,
  mcpNote: "",
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Atomic write so a reader (the poller, another tab, us) never sees a
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
    ...raw,
    poller: { ...DEFAULT_CONFIG.poller, ...(raw.poller || {}) },
    followup: { ...DEFAULT_CONFIG.followup, ...(raw.followup || {}) },
  };
  // A config written before watch mode existed has `enabled` and no `mode`.
  if (!raw.mode) config.mode = raw.enabled === false ? "off" : "auto";
  config.enabled = config.mode !== "off";
  return config;
}

// Only ever merge known keys — the config file is also read by a bash script
// that greps it, and by the poller, so junk in it is not harmless.
function writeConfig(patch) {
  const next = readConfig();
  for (const key of TOGGLE_KEYS) {
    if (key in patch) next[key] = Boolean(patch[key]);
  }
  // `mode` and `enabled` are two views of one setting; whichever arrives wins
  // and the other is derived. Flipping the master switch back on returns you
  // to auto — watch mode is a deliberate choice, not a default.
  if (patch.mode && ["off", "watch", "auto"].includes(patch.mode)) {
    next.mode = patch.mode;
  } else if ("enabled" in patch) {
    next.mode = patch.enabled ? (next.mode === "off" ? "auto" : next.mode) : "off";
  }
  next.enabled = next.mode !== "off";
  if (patch.poller && typeof patch.poller === "object") {
    const p = patch.poller;
    if (p.intervalSec != null) {
      next.poller.intervalSec = Math.min(
        86400,
        Math.max(30, Number(p.intervalSec) || env.pollIntervalSec)
      );
    }
    // "" disables the window entirely; anything else must look like HH-HH.
    if (p.activeHours != null) {
      const v = String(p.activeHours).trim();
      if (v === "" || /^\d{1,2}-\d{1,2}$/.test(v)) next.poller.activeHours = v;
    }
    if (p.activeDays != null) {
      const v = String(p.activeDays).replace(/[^1-7]/g, "");
      if (v) next.poller.activeDays = v;
    }
    if (p.scanModel != null) {
      const v = String(p.scanModel).trim();
      if (/^[a-z0-9._-]{1,60}$/i.test(v)) next.poller.scanModel = v;
    }
  }
  if (patch.followup && typeof patch.followup === "object") {
    Object.assign(next.followup, sanitizeJobOpts(patch.followup));
  }
  writeJsonAtomic(PATHS.config, next);
  return next;
}

/* ------------------------------------------------------------------- state */

function readState() {
  return { ...DEFAULT_STATE, ...readJson(PATHS.state, {}) };
}

/* -------------------------------------------------------------------- cost */

/**
 * Roll the per-tick ledger written by run-once.sh into the few numbers worth
 * looking at. Polling costs money whether or not it finds anything, so the
 * point of showing "today" next to the watching rate is that the run rate is
 * visible before the invoice is.
 */
function summariseCost() {
  const led = readJson(PATHS.cost, []);
  if (!Array.isArray(led) || !led.length) return null;
  const now = Date.now() / 1000;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const startOfDay = midnight.getTime() / 1000;

  // Two very different populations live in this ledger: hundreds of cheap
  // ticks that find nothing, and the occasional pipeline run costing dollars.
  // The median is the typical *poll*; anything far above it is real work.
  const recent = led
    .filter((e) => e.ts >= now - 86400)
    .map((e) => Number(e.cost) || 0)
    .sort((a, b) => a - b);
  const median = recent.length ? recent[Math.floor(recent.length / 2)] : 0;
  const workThreshold = median > 0 ? median * 5 : Infinity;

  let today = 0,
    todayTicks = 0,
    todayWork = 0,
    hourTicks = 0,
    dayPoll = 0,
    oldest = now;

  // 14 days of daily totals, split poll vs pipeline, for the Spend chart.
  const days = new Map();
  const dayKey = (ts) => {
    const d = new Date(ts * 1000);
    d.setHours(0, 0, 0, 0);
    return d.getTime() / 1000;
  };
  const horizon = dayKey(now) - 13 * 86400;

  for (const e of led) {
    const c = Number(e.cost) || 0;
    if (e.ts < oldest) oldest = e.ts;
    if (e.ts >= startOfDay) {
      today += c;
      todayTicks++;
      if (c > workThreshold) todayWork += c;
    }
    if (e.ts >= now - 3600) hourTicks++;
    if (e.ts >= now - 86400 && c <= workThreshold) dayPoll += c;
    const k = dayKey(e.ts);
    if (k >= horizon) {
      const row = days.get(k) || { day: k, poll: 0, work: 0, ticks: 0 };
      row.ticks++;
      if (c > workThreshold) row.work += c;
      else row.poll += c;
      days.set(k, row);
    }
  }

  // Cost of *watching* — polls only. Pipeline runs are excluded: extrapolating
  // one $4 run as if it recurred would report $100/day for a $6/day poller.
  // Once there's a full day of history, use what was actually spent; that
  // accounts for the active-hours window, which extrapolating an hour can't
  // (a busy-hour rate x 24 overstates a 12h/weekdays-only poller ~3x).
  const haveFullDay = now - oldest >= 86400;
  const pollPerDay = haveFullDay ? dayPoll : hourTicks ? median * hourTicks * 24 : null;

  // Fill the gaps so the chart shows quiet days as zero rather than closing
  // the gap and implying the poller ran every day.
  const series = [];
  for (let k = horizon; k <= dayKey(now); k += 86400) {
    series.push(days.get(k) || { day: k, poll: 0, work: 0, ticks: 0 });
  }

  return {
    today,
    todayTicks,
    todayWork,
    todayPoll: today - todayWork,
    pollPerDay,
    pollPerDayEstimated: !haveFullDay,
    median,
    ticks: led.length,
    series,
  };
}

/* -------------------------------------------------------------------- runs */

// runId is a Slack ts ("1784560120.179279"). Never trust it as a filename —
// it arrives over HTTP from the poller and from the browser.
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
    // pending  seen in Slack, no job has touched it (watch mode, or automation
    //          off, or the poller triaged it as not-for-us)
    // running  a pipeline or a manual start is in flight
    // acted / skipped / error  terminal, as reported by the poller
    action: seed.action || "pending",
    // What the poller's triage thought, kept separate from `action` so the
    // sidebar can say "it decided this wasn't for us" without pretending a job
    // ran. Values: actionable | skip | "".
    triage: seed.triage || "",
    triageReason: seed.triageReason || "",
    startedBy: seed.startedBy || "", // poller | dashboard | ""
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
  return {
    runId: run.runId,
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
    // button, which used to key off `action === "pending"` — and so vanished
    // the moment the poller wrote `skipped`, including in watch mode where the
    // verdict was `actionable` and the chat was explicitly waiting for you.
    // That matters more now that the probe absorbs follow-ups into settled
    // threads without a session: Start is how you overrule it in one click.
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
 * A run id is a Slack **thread** ts, not the ts of the message that mentioned
 * you.
 *
 * That distinction is the whole of it. Keyed by message ts, a single
 * conversation sprayed chats: the pipeline files a Linear ticket in-thread,
 * @Linear answers, a colleague chimes in — each is a separate mention with its
 * own ts, so each became its own task with its own Start button and its own
 * pipeline run. Keyed by thread they are what they actually are, later messages
 * in a conversation that already has a chat.
 *
 * The rare exception is a thread that really does carry a second, unrelated
 * request. The poller says so explicitly with `newRequest: true`, and that —
 * and only that — mints a sibling chat `<threadTs>-2`. Nothing infers it, so
 * the default can never quietly split a thread again.
 */
const SIBLING = /^-(\d+)$/;

/**
 * Every chat filed against one thread, oldest first.
 *
 * Filenames only. A thread carrying a 40-minute pipeline run is megabytes to
 * parse, and all this needs is which ids exist.
 */
function threadRunIds(threadId) {
  ensureRunsDir();
  const found = [];
  for (const f of fs.readdirSync(RUNS_DIR)) {
    if (!f.endsWith(".json") || f.includes(".tmp-")) continue;
    const id = f.slice(0, -5);
    if (id === threadId) found.push({ id, n: 1 });
    else if (id.startsWith(threadId)) {
      // The dash is what keeps "1784560120.17927" from claiming
      // "1784560120.179279" — a suffix must be exactly `-<digits>`.
      const m = SIBLING.exec(id.slice(threadId.length));
      if (m) found.push({ id, n: Number(m[1]) });
    }
  }
  return found.sort((a, b) => a.n - b.n).map((x) => x.id);
}

/** Has this chat already absorbed this Slack message? The poller files every
 *  mention twice — once bare, once with its triage verdict — so "I have seen
 *  this ts" is what makes the second post a no-op instead of a duplicate. */
function hasSlackTs(run, msgTs) {
  return !!msgTs && run.messages.some((m) => m.role === "slack" && m.slackTs === msgTs);
}

/**
 * Two different questions, and conflating them silently drops work.
 *
 * `worked` — a pipeline or a job actually ran against this thread. Only this
 * justifies refusing to dispatch: the research is done, the ticket is filed,
 * the PR is open, and running it again would redo all three.
 *
 * `settled` — worked, *or* triage read the conversation and said it isn't our
 * work. Weaker, and it only ever gates whether a mention is worth **starting a
 * session for**, never whether real work gets done.
 *
 * The gap between them is the trap. The poller marks a mention `skipped` in
 * activity.json for its own bookkeeping whenever it doesn't dispatch — which
 * includes watch mode, where the verdict was `actionable` and the chat is
 * sitting there waiting for someone to press Start. Treating that as "handled"
 * would absorb the next message in a thread that is still owed an answer.
 */
function hasWorked(run) {
  return (
    !!run.sessionId ||
    ["acted", "running", "error"].includes(run.action) ||
    !!run.prUrl ||
    !!run.linearUrl
  );
}

function isSettled(run) {
  return hasWorked(run) || run.triage === "skip";
}

// Thread-level facts, true of every message in the conversation.
const THREAD_FIELDS = ["channel", "channelId", "threadTs"];
// Whose request this chat *is*. Only the opening message may write these: a
// later reply from the Linear bot must not rewrite the sidebar to say the ask
// came from a bot, and a triage verdict on a follow-up must not overwrite the
// verdict on the request itself.
const ROOT_FIELDS = ["who", "userId", "text", "permalink", "triage", "triageReason"];

function applyMention(run, m, isRoot) {
  let dirty = false;
  for (const k of isRoot ? [...THREAD_FIELDS, ...ROOT_FIELDS] : THREAD_FIELDS) {
    if (m[k] != null && m[k] !== "" && run[k] !== m[k]) {
      run[k] = m[k];
      dirty = true;
    }
  }
  return dirty;
}

function slackMessage(m) {
  return {
    role: "slack",
    author: m.who || "someone",
    text: m.text || "",
    permalink: m.permalink || "",
    slackTs: String(m.ts || m.runId || ""),
    ts: Math.floor(Number(m.ts) || Date.now() / 1000),
  };
}

/**
 * File a mention the poller saw into the inbox.
 *
 * Every mention lands here, including the ones triage decided are not our
 * work — that is the whole point. The old dashboard could only show you what
 * the pipeline chose to act on, so a mention it skipped (or that arrived while
 * automation was off) was invisible, and there was nowhere to disagree with
 * it. Now it shows up as `pending` with the reason, and you can press Start.
 *
 * Never downgrades a run that has already been worked: the poller re-reports
 * a mention on later ticks, and a finished chat must not revert to pending.
 *
 * The returned verdict is what the poller acts on. `appended` plus `started`
 * means "this landed in a chat somebody already worked" — a follow-up, not a
 * new job — which is the poller's cue not to dispatch a second pipeline at it.
 */
function upsertMention(m) {
  const threadId = safeId(m.threadTs || m.runId || m.ts);
  if (!threadId) return null;
  const msgTs = String(m.ts || m.runId || "");

  const siblings = threadRunIds(threadId).map(loadRun).filter(Boolean);

  // Already filed, on this tick or an earlier one. Only the verdict can move.
  const seen = siblings.find((r) => hasSlackTs(r, msgTs));
  if (seen) {
    const dirty = applyMention(seen, m, seen.rootTs === msgTs);
    if (dirty) saveRun(seen);
    return { id: seen.runId, dirty, created: false, appended: false, worked: hasWorked(seen), settled: isSettled(seen) };
  }

  const open = siblings.length ? siblings[siblings.length - 1] : null;

  // A chat mirrored out of activity.json knows the thread but not which message
  // opened it, so the first mention to arrive with a ts adopts the seat rather
  // than appending itself underneath a copy of itself.
  if (open && !open.rootTs && open.messages.filter((x) => x.role === "slack").length <= 1) {
    open.rootTs = msgTs;
    const first = open.messages.find((x) => x.role === "slack");
    if (first) first.slackTs = msgTs;
    applyMention(open, m, true);
    saveRun(open);
    return { id: open.runId, dirty: true, created: false, appended: false, worked: hasWorked(open), settled: isSettled(open) };
  }

  // The thread has a chat and this is simply another message in it.
  if (open && !m.newRequest) {
    appendMessage(open, slackMessage(m));
    applyMention(open, m, false);
    saveRun(open);
    return { id: open.runId, dirty: true, created: false, appended: true, worked: hasWorked(open), settled: isSettled(open) };
  }

  // A thread nobody has filed yet, or the rare second request inside one.
  const id = open ? `${threadId}-${threadRunIds(threadId).length + 1}` : threadId;
  const run = blankRun(id, {
    createdAt: Math.floor(Number(m.ts) || Date.now() / 1000),
    who: m.who,
    channel: m.channel,
    channelId: m.channelId,
    userId: m.userId,
    threadTs: m.threadTs || threadId,
    rootTs: msgTs,
    text: m.text,
    permalink: m.permalink,
    triage: m.triage,
    triageReason: m.triageReason,
    action: "pending",
  });
  appendMessage(run, slackMessage(m));
  saveRun(run);
  return { id, dirty: true, created: true, appended: false, worked: false, settled: false };
}

/**
 * Forget a chat, for good.
 *
 * The run file is the easy half. activity.json is the half that matters: it is
 * mirrored *into* runs/ on every change, so deleting only the file means the
 * next poller tick resurrects the chat with its outcome intact and no
 * explanation. A delete that undoes itself is worse than no delete button.
 *
 * The poller is otherwise activity.json's only writer, and it read-modify-writes
 * during a tick — so a delete pressed in the exact second a tick is recording a
 * result can lose that entry. That window is a second wide, on a button a human
 * presses, and the alternative (a tombstone list that also blocks the thread
 * from ever coming back) is worse.
 */
function deleteRun(id) {
  const safe = safeId(id);
  if (!safe) return false;
  try {
    fs.unlinkSync(runPath(safe));
  } catch {
    // Already gone. Still worth purging activity, or it comes back.
  }
  const activity = readJson(PATHS.activity, []);
  if (Array.isArray(activity)) {
    const kept = activity.filter((a) => safeId(a.runId || a.ts) !== safe);
    if (kept.length !== activity.length) writeJsonAtomic(PATHS.activity, kept);
  }
  return true;
}

/** `…/archives/C0B34/p1784615086259089?thread_ts=…` → `"1784615086.259089"`.
 *  A Slack permalink carries the message's own ts with the dot stripped; it is
 *  the only field on an activity entry that identifies *which* message it was.
 *  (`a.ts` there is wall-clock seconds — when the poller wrote the entry, not
 *  the message it is about — so it cannot answer this.) */
function tsFromPermalink(permalink) {
  const m = /\/p(\d{10})(\d{6})\b/.exec(String(permalink || ""));
  return m ? `${m[1]}.${m[2]}` : "";
}

/**
 * Of several activity entries sharing one runId, the one that speaks for the run.
 *
 * Preference order, each a strictly weaker signal than the last:
 *   1. its permalink resolves to the run's `rootTs` — proof it is the opening ask
 *   2. it is the only one with a permalink at all — bots post confirmations with
 *      none, so this separates a real message from a notification
 *   3. first in the array — no information left; at least be deterministic
 */
function rootEntry(entries, run) {
  const rootTs = run && run.rootTs;
  if (rootTs) {
    const exact = entries.find((a) => tsFromPermalink(a.permalink) === rootTs);
    if (exact) return exact;
  }
  const linked = entries.filter((a) => a.permalink);
  if (linked.length === 1) return linked[0];
  return linked[0] || entries[0];
}

/**
 * Mirror activity.json into runs/.
 *
 * Called on boot and whenever activity.json changes on disk. The poller's
 * entry is authoritative for the outcome fields; the transcript is ours. An
 * entry arriving for an unknown run creates the chat and seeds it with the
 * Slack message, which is what makes a run visible the instant the poller
 * marks it `running`.
 *
 * Returns the ids that actually changed, so the SSE push stays quiet on the
 * ~99% of syncs where nothing moved.
 */
function syncFromActivity() {
  const activity = readJson(PATHS.activity, []);
  if (!Array.isArray(activity)) return [];
  const touched = [];

  // Group before applying. Since a run is keyed by the *thread*, several
  // activity entries can legitimately share one runId — the original ask,
  // @Linear answering it, a colleague chiming in — and this loop used to apply
  // all of them in array order, so whichever spoke last renamed the chat after
  // itself. A real thread ended up titled "linear — Created issue EXP-388"
  // instead of the request that opened it.
  //
  // This is the same rule ROOT_FIELDS enforces in applyMention(); syncFromActivity
  // is simply the other door into a run, and it needs the same lock. Only the
  // entry that opened the thread speaks for it — the rest are already in the
  // transcript via POST /api/mentions, which is where message-level detail
  // belongs.
  const byId = new Map();
  for (const a of activity) {
    const id = safeId(a.runId || a.ts);
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(a);
  }

  for (const [id, entries] of byId) {
    let run = loadRun(id);
    // One entry is the overwhelmingly common case — every pipeline run, which
    // rewrites its single entry in place — and must behave exactly as before.
    const a = entries.length === 1 ? entries[0] : rootEntry(entries, run);
    let dirty = false;

    if (!run) {
      run = blankRun(id, {
        createdAt: Number(a.ts) || undefined,
        who: a.who,
        channel: a.channel,
        text: a.text,
        permalink: a.permalink,
        action: a.action,
      });
      appendMessage(run, {
        role: "slack",
        author: a.who || "someone",
        text: a.text || "",
        permalink: a.permalink || "",
        ts: Number(a.ts) || Math.floor(Date.now() / 1000),
      });
      dirty = true;
    }

    // Whose request this chat *is* may only be (re)written by the message that
    // opened the thread. Grouping above settles it when the root is present in
    // this sync, but activity.json is capped — the opening entry ages out while
    // follow-ups keep arriving, and then a lone @Linear confirmation is the only
    // entry for the runId and would rename the chat after the bot.
    //
    // So once a chat knows who it belongs to, "can't prove this is the root"
    // counts as "not the root". Bot confirmations carry no permalink, which is
    // precisely why being permissive here is what renamed the chat to begin with.
    const identityOwned = !run.who || !run.rootTs || tsFromPermalink(a.permalink) === run.rootTs;
    const fields = identityOwned
      ? ["who", "channel", "text", "permalink", "action", "outcome", "prUrl", "linearUrl"]
      : // The outcome half still applies: the poller rewrites its entry in place
        // when the pipeline returns, and that is how a chat learns it finished.
        ["channel", "action", "outcome", "prUrl", "linearUrl"];
    for (const k of fields) {
      if (a[k] != null && a[k] !== "" && run[k] !== a[k]) {
        run[k] = a[k];
        dirty = true;
      }
    }

    // A terminal action with no closing message means the pipeline finished
    // without emitting a `done` event (older poller, or it never got there).
    // Synthesise one so the chat doesn't just stop mid-timeline.
    const terminal = ["acted", "skipped", "error"].includes(run.action);
    const hasOutcome = run.messages.some((m) => m.role === "outcome");
    if (terminal && run.outcome && !hasOutcome) {
      appendMessage(run, {
        role: "outcome",
        action: run.action,
        text: run.outcome,
        prUrl: run.prUrl || "",
        linearUrl: run.linearUrl || "",
        ts: Number(a.ts) || Math.floor(Date.now() / 1000),
      });
      run.phase = run.action === "error" ? "error" : "done";
      dirty = true;
    }

    if (dirty) {
      saveRun(run);
      touched.push(id);
    }
  }
  return touched;
}

module.exports = {
  PATHS,
  sanitizeJobOpts,
  jobOpts,
  isDir,
  readConfig,
  writeConfig,
  readState,
  summariseCost,
  safeId,
  blankRun,
  loadRun,
  saveRun,
  listRunSummaries,
  appendMessage,
  upsertMention,
  deleteRun,
  syncFromActivity,
  ensureRunsDir,
};
