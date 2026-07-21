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

// Phases the pipeline reports, in the order it walks them. The UI renders the
// timeline from this list, so a phase it doesn't know still shows — it just
// sorts last and gets the generic dot.
const PHASES = [
  "queued",
  "context",
  "root-cause",
  "verdict",
  "linear",
  "build",
  "verify",
  "pr",
  "review",
  "resolve",
  "memory",
  "reply",
  "done",
  "error",
];

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

function listRuns() {
  ensureRunsDir();
  const out = [];
  for (const f of fs.readdirSync(RUNS_DIR)) {
    if (!f.endsWith(".json") || f.includes(".tmp-")) continue;
    const run = readJson(path.join(RUNS_DIR, f), null);
    if (run && run.runId) out.push(run);
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// What the sidebar needs — never the messages, which can be megabytes.
function summariseRun(run) {
  const last = run.messages[run.messages.length - 1] || null;
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
    // Has any job ever touched this mention? Drives the sidebar's Start button:
    // a mention nobody has run is the one thing you can act on from here.
    started: run.action !== "pending" || !!run.sessionId,
    phase: run.phase,
    outcome: run.outcome,
    prUrl: run.prUrl,
    linearUrl: run.linearUrl,
    permalink: run.permalink,
    cost: run.cost || 0,
    messages: run.messages.length,
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
 */
function upsertMention(m) {
  const id = safeId(m.runId || m.ts);
  if (!id) return null;
  let run = loadRun(id);
  let dirty = false;

  if (!run) {
    run = blankRun(id, {
      createdAt: Math.floor(Number(m.ts) || Date.now() / 1000),
      who: m.who,
      channel: m.channel,
      channelId: m.channelId,
      userId: m.userId,
      threadTs: m.threadTs || id,
      text: m.text,
      permalink: m.permalink,
      triage: m.triage,
      triageReason: m.triageReason,
      action: "pending",
    });
    appendMessage(run, {
      role: "slack",
      author: m.who || "someone",
      text: m.text || "",
      permalink: m.permalink || "",
      ts: Math.floor(Number(m.ts) || Date.now() / 1000),
    });
    dirty = true;
  }

  for (const k of ["who", "channel", "channelId", "userId", "threadTs", "text", "permalink", "triage", "triageReason"]) {
    if (m[k] != null && m[k] !== "" && run[k] !== m[k]) {
      run[k] = m[k];
      dirty = true;
    }
  }
  if (dirty) saveRun(run);
  return { id, dirty };
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

  for (const a of activity) {
    const id = safeId(a.runId || a.ts);
    if (!id) continue;
    let run = loadRun(id);
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

    // The poller owns these five. It rewrites the `running` entry in place when
    // the pipeline returns, so this is where a chat learns it finished.
    for (const k of ["who", "channel", "text", "permalink", "action", "outcome", "prUrl", "linearUrl"]) {
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
  PHASES,
  TOGGLE_KEYS,
  DEFAULT_CONFIG,
  DEFAULT_JOB_OPTS,
  PERMISSION_MODES,
  EFFORT_LEVELS,
  sanitizeJobOpts,
  jobOpts,
  isDir,
  readJson,
  writeJsonAtomic,
  readConfig,
  writeConfig,
  readState,
  summariseCost,
  safeId,
  blankRun,
  loadRun,
  saveRun,
  listRuns,
  summariseRun,
  appendMessage,
  upsertMention,
  syncFromActivity,
  ensureRunsDir,
};
