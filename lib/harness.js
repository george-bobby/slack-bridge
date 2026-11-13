/**
 * The harness: spawn, watch, relay, recover, clean up.
 *
 * The dashboard server *is* the watcher. Every worker is a child of this
 * process, so "is it busy, idle, stalled, gone" is read off the live stream
 * rather than scraped from a terminal, and there is no background watcher per
 * worker that can be forgotten, chained untracked, or left un-armed: one
 * process sees every job start and end (lib/jobs.js `events`), plus a timer
 * for stalls and a boot pass for whatever happened while it was down.
 *
 * An outcome is the unit of "this needs attention":
 *
 *   report               a worker wrote or changed report.md
 *   idle-without-report  it ended a turn without one (after one automatic nudge)
 *   worker-stalled       no activity for N minutes, not declared waiting
 *   worker-gone          it died, or the dashboard restarted under it
 *   usage-limit          the agent hit a usage limit
 *
 * Each outcome goes to events.log, the task's chat, the Inbox (decisions and
 * to-dos), a browser notification when it needs you, and, mode allowing,
 * a relay turn in the orchestrator chat.
 */

const fs = require("fs");
const path = require("path");

const env = require("./env");
const store = require("./store");
const jobs = require("./jobs");
const tasks = require("./tasks");
const bus = require("./bus");

const ROOT = path.join(__dirname, "..");
const ORCH = "orchestrator";
const USER = env.slackUserName;
const now = () => Math.floor(Date.now() / 1000);
const AWAY_QUEUE = path.join(tasks.DIR, "away-queue.json");

const cfg = () => store.readConfig().harness;

/* --------------------------------------------------------- orchestrator */

/** The pinned chat. Created once; never deleted by the harness. */
function ensureOrchestrator() {
  let run = store.loadRun(ORCH);
  if (run && run.kind === "orchestrator") return run;
  run = run || store.blankRun(ORCH, { who: "Orchestrator", action: "acted", phase: "idle" });
  run.kind = "orchestrator";
  run.who = "Orchestrator";
  run.text = "Your second-in-command. Hand it work; it spawns workers and tells you what happened.";
  run.opts = { ...run.opts, workdir: ROOT };
  store.saveRun(run);
  return run;
}

/* ---------------------------------------------------------------- titles */

function titleOf(taskId) {
  const meta = tasks.readMeta(taskId) || {};
  const run = store.loadRun(taskId);
  return String(meta.title || (run && (run.who !== "Slack thread" ? `${run.who}: ${run.text}` : run.permalink)) || taskId).slice(0, 90);
}

/* -------------------------------------------------------------- outcomes */

const NEEDS_YOU = new Set(["needs-input", "blocked", "idle-without-report", "worker-stalled", "worker-gone", "usage-limit"]);

/** Status written to meta.json for each outcome. */
function statusFor(name, parsed) {
  if (name === "report") return parsed ? parsed.status : "unknown";
  return name;
}

function outcome(taskId, name, info = {}) {
  const parsed = info.parsed || null;
  const status = statusFor(name, parsed);
  const title = titleOf(taskId);
  const text =
    name === "report"
      ? `${status}: ${(parsed && parsed.tldr) || "(no TL;DR)"}`.slice(0, 600)
      : String(info.text || name).slice(0, 600);

  tasks.writeMeta(taskId, { status, lastOutcome: name, lastOutcomeAt: now() });
  tasks.appendEvent({ taskId, name, status, text });

  // The Inbox. A new report supersedes everything the old one was waiting on.
  const created = [];
  if (name === "report" && parsed) {
    tasks.closeTaskDecisions(taskId, ["question", "action", "resume"]);
    for (const q of parsed.questions) created.push(tasks.addDecision({ taskId, kind: "question", text: q }).decision);
    for (const a of parsed.actions) created.push(tasks.addDecision({ taskId, kind: "action", text: a }).decision);
    if ((status === "needs-input" || status === "blocked") && !parsed.questions.length) {
      created.push(tasks.addDecision({ taskId, kind: "question", text: `${status}: ${parsed.tldr || "see the report"}` }).decision);
    }
    if (status === "ready-for-review" || status === "pushed-follow-up") {
      // Workers write `pr: none` too; only a URL is a PR.
      const pr = [parsed.fields.pr, (tasks.readMeta(taskId) || {}).prUrl].find((u) => /^https?:\/\//.test(u || "")) || "";
      tasks.addTodo({ key: `review:${taskId}`, text: `Review ${pr ? "the PR for" : ""} ${title}`.replace(/\s+/g, " ").trim(), taskId, url: pr });
      if (pr) tasks.writeMeta(taskId, { prUrl: pr });
    }
  } else if (NEEDS_YOU.has(name)) {
    tasks.closeTaskDecisions(taskId, ["resume"]);
    created.push(tasks.addDecision({ taskId, kind: "resume", text: `${name}: ${text}` }).decision);
  }

  // The chat.
  const run = store.loadRun(taskId);
  if (run) {
    const msg = store.appendMessage(run, { role: "event", phase: "outcome", text: `**${name}** · ${text}` });
    store.saveRun(run);
    bus.broadcast("message", { runId: taskId, message: msg });
  }

  const needsYou = NEEDS_YOU.has(name) || NEEDS_YOU.has(status) || (parsed && parsed.actions.length > 0);
  bus.broadcast("outcome", { taskId, name, status, text, title, needsYou });
  bus.broadcast("inbox", inbox());
  bus.broadcast("runs", { runs: store.listRunSummaries() });

  relay(taskId, name, { status, text, title, parsed, needsYou, decisions: created });
}

/* ----------------------------------------------------------------- relay */

function relayText(taskId, name, { status, text, title, parsed, decisions }) {
  const lines = [`[harness] OUTCOME ${name} · task ${taskId} · "${title}"`, `status: ${status}`, text];
  if (parsed) {
    if (/^https?:\/\//.test(parsed.fields.pr || "")) lines.push(`PR: ${parsed.fields.pr}`);
    if (parsed.questions.length) lines.push(`open questions: ${parsed.questions.length}`);
    if (parsed.actions.length) lines.push(`action requests: ${parsed.actions.length}`);
  }
  if (decisions && decisions.length) lines.push(`Inbox: ${decisions.map((d) => `${d.id} (${d.kind})`).join(", ")}`);
  lines.push(`Report: ${tasks.paths(taskId).report}`);
  lines.push(`Relay this to ${USER} in 1-3 lines, leading with anything they need to do.`);
  return lines.join("\n");
}

function relay(taskId, name, info) {
  const c = cfg();
  if (!c.relay || taskId === ORCH) return;
  if (c.mode === "quiet" && !info.needsYou) return;
  const text = relayText(taskId, name, info);
  if (c.mode === "away") {
    const q = readJson(AWAY_QUEUE, []);
    q.push({ at: now(), text });
    writeJson(AWAY_QUEUE, q.slice(-200));
    return;
  }
  ensureOrchestrator();
  try {
    jobs.startFollowup(ORCH, text, { config: store.readConfig(), role: "relay", label: "relay", queue: true });
  } catch (e) {
    tasks.appendEvent({ taskId: ORCH, name: "relay-failed", text: e.message });
  }
}

/** Leaving away mode: one catch-up turn with everything that was held back. */
function setMode(mode) {
  if (!["normal", "quiet", "away"].includes(mode)) throw new Error("mode is normal, quiet or away");
  const before = cfg().mode;
  store.writeConfig({ harness: { mode } });
  if (before === "away" && mode !== "away") {
    const held = readJson(AWAY_QUEUE, []);
    writeJson(AWAY_QUEUE, []);
    if (held.length && cfg().relay) {
      ensureOrchestrator();
      const text = `[harness] ${USER} is back (mode: ${mode}). While away, ${held.length} outcome(s) were held:\n\n${held
        .map((h) => h.text.replace(/\nRelay this to .*$/m, ""))
        .join("\n\n")}\n\nBrief ${USER}: what needs them first, then the rest in a few lines.`;
      jobs.startFollowup(ORCH, text, { config: store.readConfig(), role: "relay", label: "catch-up", queue: true });
    }
  }
  bus.broadcast("inbox", inbox());
  return cfg();
}

/* ------------------------------------------------------------- job ends */

const LIMIT = /(usage limit|rate[ -]?limit(ed)?|limit reached|quota exceeded|credit balance is too low|out of (extra )?usage|5-hour limit|weekly limit)/i;

function onJobEnd(e) {
  const { runId, role, why, result, stderr, reportHashBefore } = e;

  if (role === "orchestrator") {
    drain(runId);
    return;
  }
  const meta = tasks.readMeta(runId) || {};

  if (why === "stopped") {
    tasks.writeMeta(runId, { status: "stopped" });
    tasks.appendEvent({ taskId: runId, name: "stopped", text: "stopped from the dashboard" });
    bus.broadcast("inbox", inbox());
    dispatch();
    return;
  }

  const said = `${(result && result.text) || ""}\n${stderr || ""}`;
  if (LIMIT.test(said) && (!result || result.failed || why !== "closed")) {
    outcome(runId, "usage-limit", { text: (said.match(new RegExp(`.{0,120}${LIMIT.source}.{0,120}`, "i")) || [said.trim().slice(-200)])[0] });
    dispatch();
    return;
  }

  // A queued follow-up goes in before judging this turn: the worker is about
  // to get another turn, and it will report at the end of that one.
  if (drain(runId)) return;

  const r = tasks.readReport(runId);
  const changedThisTurn = r && r.hash !== reportHashBefore;
  if (r && r.hash !== meta.reportHash) {
    tasks.writeMeta(runId, { reportHash: r.hash, nudged: false, stallFlagged: false });
    outcome(runId, "report", { parsed: r.parsed });
  } else if (!changedThisTurn) {
    const crashed = !result && why !== "closed";
    if (crashed) {
      outcome(runId, "worker-gone", { text: `the session ended without a result (${why}). ${String(stderr || "").trim().split("\n").slice(-2).join(" ")}`.trim() });
    } else if (!meta.nudged) {
      // One automatic nudge, then it's yours.
      tasks.writeMeta(runId, { nudged: true });
      tasks.appendEvent({ taskId: runId, name: "nudged", text: "ended a turn without a report" });
      try {
        jobs.startFollowup(
          runId,
          `[harness] You ended your turn without writing ${tasks.paths(runId).report}. Write it now per the report contract (frontmatter status, TL;DR, summary, changes, verification, open questions, action requests), then stop.`,
          { config: store.readConfig(), role: "harness", label: "nudge" }
        );
        return;
      } catch {}
    } else {
      outcome(runId, "idle-without-report", { text: "ended a turn without a report, even after a nudge" });
    }
  }
  dispatch();
}

/** Start one queued follow-up for a chat, if any. True when one started. */
function drain(runId) {
  const next = jobs.takePending(runId);
  if (!next) return false;
  try {
    jobs.startFollowup(runId, next.text, { config: store.readConfig(), role: next.role, label: next.label });
    return true;
  } catch (e) {
    tasks.appendEvent({ taskId: runId, name: "followup-failed", text: e.message });
    return false;
  }
}

/* --------------------------------------------------------------- stalls */

function checkStalls() {
  const c = cfg();
  for (const runId of jobs.runningIds()) {
    const act = jobs.activity(runId);
    if (!act || runId === ORCH) continue;
    const meta = tasks.readMeta(runId) || {};
    const idleSec = (Date.now() - act.lastEventAt) / 1000;
    if (meta.stallFlagged && idleSec < 60) {
      tasks.writeMeta(runId, { stallFlagged: false, status: "working" });
      continue;
    }
    if (act.awaiting) continue; // blocked on you; the ask card covers it
    // SB_STALL_SEC is the tests' override; minutes are too slow to wait on.
    const budget = Number(process.env.SB_STALL_SEC) || c.stallMinutes * 60;
    if (meta.declared && meta.declared.state === "waiting") {
      // A declared wait gets four times the budget, not forever.
      if (idleSec < budget * 4) continue;
    }
    if (idleSec > budget && !meta.stallFlagged) {
      tasks.writeMeta(runId, { stallFlagged: true });
      outcome(runId, "worker-stalled", {
        text: `no activity for ${Math.round(idleSec / 60)} min${act.tool ? ` (inside a ${act.tool} call)` : ""}${meta.declared && meta.declared.state === "waiting" ? `, declared waiting on: ${meta.declared.text}` : ""}`,
      });
    }
  }
}

/* -------------------------------------------------------------- capacity */

function workingCount() {
  let total = 0;
  const perRepo = new Map();
  for (const id of jobs.runningIds()) {
    if (id === ORCH) continue;
    const meta = tasks.readMeta(id) || {};
    if (meta.declared && meta.declared.state === "waiting") continue; // waiting doesn't count
    total++;
    const repo = meta.repo || "";
    perRepo.set(repo, (perRepo.get(repo) || 0) + 1);
  }
  return { total, perRepo };
}

function hasRoom(repo) {
  const c = cfg();
  const { total, perRepo } = workingCount();
  return total < c.maxWorkers && (perRepo.get(repo || "") || 0) < c.maxPerRepo;
}

/** Start queued tasks, oldest first, while there's room. */
function dispatch() {
  const queued = tasks
    .list()
    .filter((m) => m.status === "queued")
    .sort((a, b) => (a.queuedAt || a.createdAt) - (b.queuedAt || b.createdAt));
  for (const m of queued) {
    if (!hasRoom(m.repo)) continue;
    if (jobs.isRunning(m.id)) continue;
    try {
      if (m.kind === "slack") jobs.startPipeline(m.id, { config: store.readConfig() });
      else jobs.startTask(m.id, { config: store.readConfig(), note: "Dequeued: a slot opened up." });
      tasks.appendEvent({ taskId: m.id, name: "dequeued", text: "started from the queue" });
    } catch (e) {
      tasks.writeMeta(m.id, { status: "error" });
      tasks.appendEvent({ taskId: m.id, name: "dispatch-failed", text: e.message });
    }
  }
  bus.broadcast("runs", { runs: store.listRunSummaries() });
}

/* ----------------------------------------------------------------- spawn */

/**
 * A worker from a brief: validate, worktree, chat, task folder, then start
 * (or queue when over the cap). Returns the task id either way.
 */
async function spawnTask({ repo, title, brief, branch, opts = {}, start = true }) {
  const text = String(brief || "").trim();
  if (!text) throw new Error("a task needs a brief");
  if (text.length > 60000) throw new Error("brief too long");
  const repoPath = path.resolve(String(repo || store.readConfig().followup.workdir || env.targetRepo || ""));
  const t = String(title || text.split("\n").find((l) => l.trim()) || "task")
    .replace(/^#+\s*/, "")
    .slice(0, 80)
    .trim();
  const id = tasks.newTaskId(t);
  // A short time-based suffix keeps two tasks with the same title apart.
  const br = branch || `${env.branchPrefix}/${tasks.slugify(t) || "task"}-${Date.now().toString(36).slice(-4)}`;

  const wt = await tasks.createWorktree({ repo: repoPath, branch: br });

  const p = tasks.paths(id);
  tasks.writeBrief(id, `# ${t}\n\n${text}\n`);
  tasks.writeMeta(id, { kind: "task", title: t, repo: repoPath, worktree: wt.worktree, branch: wt.branch, base: wt.base, from: wt.from, status: "new" });

  const run = store.blankRun(id, { who: t, text: text.slice(0, 400), action: "pending", phase: "queued" });
  run.kind = "task";
  run.opts = { ...store.sanitizeJobOpts(opts), workdir: wt.worktree };
  store.appendMessage(run, { role: "user", text: `**Brief** (${p.brief})\n\n${text}` });
  store.saveRun(run);
  tasks.appendEvent({ taskId: id, name: "spawned", text: `${t} · ${wt.branch} in ${wt.worktree}` });

  let state = "created";
  if (start) {
    if (hasRoom(repoPath)) {
      jobs.startTask(id, { config: store.readConfig() });
      state = "started";
    } else {
      tasks.writeMeta(id, { status: "queued", queuedAt: now() });
      tasks.appendEvent({ taskId: id, name: "queued", text: "over the worker cap; starts when a slot opens" });
      state = "queued";
    }
  }
  bus.broadcast("runs", { runs: store.listRunSummaries() });
  bus.broadcast("inbox", inbox());
  return { taskId: id, state, worktree: wt.worktree, branch: wt.branch, brief: p.brief };
}

/** Pipeline start for a Slack chat, through the same cap. */
function startSlack(runId) {
  const run = store.loadRun(runId);
  if (!run) throw new Error("unknown run");
  tasks.writeMeta(runId, { kind: "slack", repo: env.targetRepo, title: run.text || run.permalink || runId });
  if (!hasRoom(env.targetRepo)) {
    tasks.writeMeta(runId, { status: "queued", queuedAt: now() });
    tasks.appendEvent({ taskId: runId, name: "queued", text: "over the worker cap; starts when a slot opens" });
    return { state: "queued" };
  }
  jobs.startPipeline(runId, { config: store.readConfig() });
  return { state: "started" };
}

/* -------------------------------------------------------------- relaunch */

function relaunch(taskId, note = "") {
  if (jobs.isRunning(taskId)) throw new Error("that worker is running; send a follow-up instead");
  const run = store.loadRun(taskId);
  if (!run) throw new Error("unknown task");
  tasks.closeTaskDecisions(taskId, ["resume"], "answered");
  tasks.writeMeta(taskId, { nudged: false, stallFlagged: false });
  tasks.appendEvent({ taskId, name: "relaunched", text: note || "" });
  if (!run.sessionId) {
    if (run.kind === "task") return jobs.startTask(taskId, { config: store.readConfig(), note: "Relaunched." });
    return jobs.startPipeline(taskId, { config: store.readConfig() });
  }
  const meta = tasks.readMeta(taskId) || {};
  return jobs.startFollowup(
    taskId,
    `[harness] You were interrupted (last state: ${meta.status || "unknown"}). Pick up where you left off: check the worktree's git status and your report, then continue toward the definition of done. ${note}`.trim(),
    { config: store.readConfig(), role: "harness", label: "relaunch" }
  );
}

/* --------------------------------------------------------------- declare */

function declare(taskId, state, text = "") {
  if (!tasks.exists(taskId)) throw new Error(`no such task: ${taskId}`);
  if (!["waiting", "resumed", "phase"].includes(state)) throw new Error("declare waiting | resumed | phase");
  const patch = { declared: { state: state === "phase" ? (tasks.readMeta(taskId).declared || {}).state || "working" : state === "resumed" ? "working" : state, text, at: now() } };
  if (state === "phase") patch.phase = text;
  tasks.writeMeta(taskId, patch);
  const run = store.loadRun(taskId);
  if (run) {
    const msg = store.appendMessage(run, { role: "event", phase: state === "phase" ? "phase" : state, text: text || state });
    store.saveRun(run);
    bus.broadcast("message", { runId: taskId, message: msg });
  }
  bus.broadcast("runs", { runs: store.listRunSummaries() });
  return tasks.readMeta(taskId);
}

/* --------------------------------------------------------------- answers */

/**
 * Answer a decision. A question's answer goes back to its worker as a
 * follow-up in your words; "do it" on an action sends the worker to make
 * the call, which the guard then puts to you as an exact-payload approval.
 */
function decide(id, { answer = "", action = "answer" } = {}) {
  const d = tasks.decisions().find((x) => x.id === id);
  if (!d) throw new Error(`no such decision: ${id}`);
  if (action === "dismiss") return tasks.updateDecision(id, { state: "dismissed" });
  if (action === "defer") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(answer)) throw new Error("defer takes a date: YYYY-MM-DD");
    return tasks.updateDecision(id, { state: "deferred", deferUntil: answer });
  }
  if (d.kind === "resume") {
    relaunch(d.taskId, answer);
    return tasks.updateDecision(id, { state: "answered", answer: answer || "resumed" });
  }
  const msg =
    d.kind === "action"
      ? `[harness] ${USER} approved your action request:\n"""\n${d.text}\n"""\n${answer ? `${USER} adds: ${answer}\n` : ""}Make exactly this write now (the harness will show ${USER} the exact payload once more), then update your report.`
      : `[harness] ${USER} answered your open question:\n"""\n${d.text}\n"""\nAnswer, in ${USER}'s words: ${answer}\n\nContinue, then update your report.`;
  if (d.kind === "question" && !String(answer).trim()) throw new Error("an answer needs words");
  const out = jobs.startFollowup(d.taskId, msg, { config: store.readConfig(), role: "harness", label: d.kind === "action" ? "approved" : "answer", queue: true });
  const rec = tasks.updateDecision(id, { state: "answered", answer: answer || "approved", deliveredAs: out && out.queued ? "queued" : "started" });
  tasks.appendEvent({ taskId: d.taskId, name: "decided", text: `${d.kind}: ${answer || "approved"}`.slice(0, 300) });
  bus.broadcast("inbox", inbox());
  return rec;
}

/* --------------------------------------------------------------- cleanup */

async function cleanup(taskId, { force = false } = {}) {
  if (jobs.isRunning(taskId)) throw new Error("stop the worker before cleaning up its worktree");
  const meta = tasks.readMeta(taskId);
  if (!meta) throw new Error(`no such task: ${taskId}`);
  if (!meta.worktree) {
    tasks.writeMeta(taskId, { status: "cleaned", cleanedAt: now() });
    return { removed: false, note: "no worktree recorded" };
  }
  const insp = await tasks.inspectWorktree(meta.worktree);
  if (insp.exists && (insp.dirty || insp.unpushed) && !force) {
    const why = [insp.dirty ? `${insp.dirtyFiles} uncommitted change(s)` : "", insp.unpushed ? `${insp.unpushed} unpushed commit(s)` : ""].filter(Boolean).join(" and ");
    const err = new Error(`refusing: ${meta.worktree} has ${why}. Push or commit first, or clean up with force.`);
    err.refused = true;
    throw err;
  }
  const killed = [];
  if (insp.exists) {
    for (const pid of await tasks.pidsInside(meta.worktree)) {
      try {
        process.kill(pid, "SIGTERM"); // exact PID, never a group or pattern
        killed.push(pid);
      } catch {}
    }
    await tasks.removeWorktree({ repo: meta.repo, worktree: meta.worktree, force: force && (insp.dirty || insp.unpushed > 0) });
  }
  tasks.writeMeta(taskId, { status: "cleaned", cleanedAt: now() });
  tasks.appendEvent({ taskId, name: "cleaned", text: `${meta.worktree} removed; branch ${meta.branch || "?"} kept${killed.length ? `; stopped pids ${killed.join(", ")}` : ""}` });
  bus.broadcast("runs", { runs: store.listRunSummaries() });
  return { removed: insp.exists, killed, branch: meta.branch };
}

/* -------------------------------------------------------- status/catchup */

function status() {
  return tasks.list().map((m) => {
    const live = jobs.isRunning(m.id);
    const act = jobs.activity(m.id);
    const r = tasks.readReport(m.id);
    const notes = [];
    if (m.status === "working" && !live) notes.push("meta says working but no live job (lost?)");
    if (live && !["working", "worker-stalled"].includes(m.status)) notes.push(`a job is live but status is ${m.status}`);
    return {
      id: m.id,
      kind: m.kind || "task",
      title: m.title || m.id,
      status: m.status,
      live,
      awaiting: !!(act && act.awaiting),
      idleSec: act ? Math.round((Date.now() - act.lastEventAt) / 1000) : null,
      tool: act ? act.tool : "",
      phase: m.phase || "",
      declared: m.declared || null,
      reportStatus: r ? r.parsed.status : "",
      tldr: r ? r.parsed.tldr.slice(0, 300) : "",
      pr: [r && r.parsed.fields.pr, m.prUrl].find((u) => /^https?:\/\//.test(u || "")) || "",
      repo: m.repo || "",
      worktree: m.worktree || "",
      branch: m.branch || "",
      queuedFollowups: jobs.pendingCount(m.id),
      notes,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  });
}

function inbox() {
  const c = cfg();
  const titles = new Map();
  const t = (id) => {
    if (!titles.has(id)) titles.set(id, titleOf(id));
    return titles.get(id);
  };
  const decisions = tasks.openDecisions().map((d) => ({ ...d, title: t(d.taskId) }));
  const todos = tasks.todos().filter((x) => !x.done).map((x) => ({ ...x, title: x.taskId ? t(x.taskId) : "" }));
  return { mode: c.mode, decisions, todos, counts: { decisions: decisions.length, todos: todos.length } };
}

function catchup(since) {
  const from = typeof since === "number" ? since : tasks.parseSince(since);
  return { since: from, ...inbox(), tasks: status().filter((s) => s.status !== "cleaned"), events: tasks.readEvents({ since: from }) };
}

/* ---------------------------------------------------------------- boot */

/**
 * After a restart. Every child died with the old process, so a task still
 * marked `working` was lost mid-turn; a report written while nobody watched
 * is caught up on; queued tasks get their chance.
 */
function recover() {
  ensureOrchestrator();
  for (const m of tasks.list()) {
    const r = tasks.readReport(m.id);
    if (r && r.hash !== m.reportHash) {
      tasks.writeMeta(m.id, { reportHash: r.hash, nudged: false });
      outcome(m.id, "report", { parsed: r.parsed });
      continue;
    }
    if (m.status === "working" || m.status === "worker-stalled") {
      tasks.writeMeta(m.id, { stallFlagged: false });
      outcome(m.id, "worker-gone", { text: "the dashboard restarted while this worker was mid-turn; resume it to continue" });
    }
  }
  // Runs left "running" in the chat file died too.
  for (const s of store.listRunSummaries()) {
    if (s.action === "running") {
      const run = store.loadRun(s.runId);
      run.action = "error";
      run.phase = "interrupted";
      store.saveRun(run);
    }
  }
  dispatch();
}

/* -------------------------------------------------------------- wiring */

function readJson(f, fb) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return fb;
  }
}
function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n");
}

let started = false;
function start() {
  if (started) return;
  started = true;
  fs.mkdirSync(tasks.DIR, { recursive: true });
  jobs.events.on("end", (e) => {
    try {
      onJobEnd(e);
    } catch (err) {
      console.error("harness: job end handling failed:", err);
    }
  });
  recover();
  const tick = Number(process.env.SB_TICK_MS) || 30000;
  setInterval(() => {
    try {
      checkStalls();
    } catch (err) {
      console.error("harness: stall check failed:", err);
    }
  }, tick).unref();
}

module.exports = {
  ORCH,
  start,
  ensureOrchestrator,
  spawnTask,
  startSlack,
  relaunch,
  declare,
  decide,
  cleanup,
  status,
  inbox,
  catchup,
  setMode,
  dispatch,
  outcome,
  hasRoom,
  workingCount,
};
