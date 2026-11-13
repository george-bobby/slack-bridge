/**
 * End-to-end harness tests against a real dashboard process, a real scratch
 * repo with a bare origin, and the stub agent (test/stub-claude.js). Nothing
 * here touches the real data/, the real repos or costs usage.
 *
 *   node --test test/
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const STUB = path.join(__dirname, "stub-claude.js");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sb-harness-")));
const DATA = path.join(tmp, "data");
const REPO = path.join(tmp, "repo");
const ORIGIN = path.join(tmp, "origin.git");
const PORT = 47000 + Math.floor(Math.random() * 1500);
const URL_ = `http://127.0.0.1:${PORT}`;

const git = (args, cwd = REPO) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function makeRepo() {
  fs.mkdirSync(REPO, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(REPO, "README.md"), "scratch\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  execFileSync("git", ["init", "-q", "--bare", ORIGIN]);
  git(["remote", "add", "origin", ORIGIN]);
  git(["push", "-q", "-u", "origin", "main"]);
  git(["remote", "set-head", "origin", "main"]);
}

const ENV = {
  ...process.env,
  SB_DATA_DIR: DATA,
  CLAUDE_BIN: STUB,
  SLACK_BRIDGE_PORT: String(PORT),
  SLACK_BRIDGE_ENV_FILE: path.join(tmp, "none.env"),
  TARGET_REPO: REPO,
  WORKTREE_ROOT: path.join(tmp, "wt"),
  SLACK_USER_NAME: "Alex",
  BRANCH_PREFIX: "test",
  SB_TICK_MS: "300",
  SB_STALL_SEC: "2",
  STUB_LOG: path.join(tmp, "stub.log"),
  SB_URL: URL_,
  SB_TASK_ID: "",
};

let server = null;
function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, "index.js")], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", (d) => process.env.SB_TEST_VERBOSE && process.stderr.write(d));
  return waitFor(async () => (await fetch(`${URL_}/api/state`).then((r) => r.ok).catch(() => false)), 10000, "server up");
}
function stopServer() {
  if (!server) return Promise.resolve();
  const s = server;
  server = null;
  return new Promise((r) => {
    s.on("exit", r);
    s.kill("SIGTERM"); // the exact PID this test started
  });
}

async function api(method, p, body) {
  const r = await fetch(URL_ + p, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

function sb(...args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin", "sb"), ...args], { env: ENV, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

async function waitFor(fn, ms = 15000, what = "condition") {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const meta = (id) => JSON.parse(fs.readFileSync(path.join(DATA, "tasks", id, "meta.json"), "utf8"));
const statusIs = (id, s) => () => {
  try {
    return meta(id).status === s;
  } catch {
    return false;
  }
};
const idle = (id) => async () => !(await api("GET", "/api/state")).jobs.running.includes(id);

async function spawnTask(title, brief, extra = {}) {
  const r = await api("POST", "/api/tasks", { repo: REPO, title, brief, ...extra });
  assert.equal(r.ok, true, r.error);
  return r;
}

test.before(async () => {
  makeRepo();
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "config.json"), JSON.stringify({ harness: { maxWorkers: 2, maxPerRepo: 2, relay: true, mode: "normal" } }));
  await startServer();
});
test.after(async () => {
  await stopServer();
  if (!process.env.SB_TEST_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
});

test("spawn → worker in its own worktree → report → relayed, main checkout untouched", async () => {
  const t = await spawnTask("add a function", "Add a function and a test.\nstub:report=ready-for-review");
  assert.equal(t.state, "started");
  await waitFor(statusIs(t.taskId, "ready-for-review"), 15000, "report");

  assert.ok(fs.existsSync(t.worktree), "worktree exists");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], t.worktree), t.branch);
  assert.equal(git(["status", "--porcelain"]), "", "main checkout untouched");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"]), "main");

  // The worker ran with the guard hook, its contract and its identity.
  const log = fs.readFileSync(ENV.STUB_LOG, "utf8").trim().split("\n").map(JSON.parse);
  const mine = log.find((l) => l.env.SB_TASK_ID === t.taskId);
  assert.ok(mine.argv.includes("--settings"));
  assert.match(mine.argv[mine.argv.indexOf("--settings") + 1], /guard\.js/);
  const sys = fs.readFileSync(mine.argv[mine.argv.indexOf("--append-system-prompt-file") + 1], "utf8");
  assert.match(sys, /report contract/);
  assert.match(sys, new RegExp(t.worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(mine.env.SB_ROLE, "task");
  assert.equal(mine.env.SB_GUARD, "1");

  const inbox = await api("GET", "/api/inbox");
  assert.ok(inbox.todos.some((x) => x.key === `review:${t.taskId}`), "review to-do");

  // The orchestrator got a relay turn about it.
  await waitFor(async () => {
    const o = await api("GET", "/api/runs/orchestrator");
    return o.run.messages.some((m) => m.role === "relay" && m.text.includes(t.taskId));
  }, 10000, "relay");
  const o = (await api("GET", "/api/runs/orchestrator")).run;
  assert.equal(o.kind, "orchestrator");
});

test("needs-input → decision → answer goes back to the worker → ready", async () => {
  const t = await spawnTask("pick a format", "stub:report=needs-input\nstub:question=CSV or JSON? (recommend CSV)");
  await waitFor(statusIs(t.taskId, "needs-input"), 15000, "needs-input");
  const d = (await api("GET", "/api/inbox")).decisions.find((x) => x.taskId === t.taskId);
  assert.equal(d.kind, "question");
  assert.match(d.text, /CSV or JSON/);
  await waitFor(idle(t.taskId), 5000, "idle");
  const r = sb("decide", d.id, "CSV, as you recommended");
  assert.equal(r.code, 0, r.err);
  await waitFor(statusIs(t.taskId, "ready-for-review"), 15000, "answered → ready");
  const run = (await api("GET", `/api/runs/${t.taskId}`)).run;
  assert.ok(run.messages.some((m) => m.role === "harness" && m.text.includes("CSV, as you recommended")));
  assert.ok(!(await api("GET", "/api/inbox")).decisions.some((x) => x.id === d.id), "decision closed");
});

test("defer hides a decision until its day; duplicate to-dos are refused", async () => {
  const t = await spawnTask("two questions", "stub:report=needs-input\nstub:question=First?\nstub:question=Second?");
  await waitFor(statusIs(t.taskId, "needs-input"), 15000);
  const ds = (await api("GET", "/api/inbox")).decisions.filter((x) => x.taskId === t.taskId);
  assert.equal(ds.length, 2);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  assert.equal(sb("defer", ds[1].id, tomorrow).code, 0);
  const open = (await api("GET", "/api/inbox")).decisions.filter((x) => x.taskId === t.taskId);
  assert.deepEqual(open.map((x) => x.id), [ds[0].id]);

  assert.equal(sb("todo", "add", "merge-42", "Merge PR 42").code, 0);
  const dup = sb("todo", "add", "merge-42", "Merge PR 42 again");
  assert.equal(dup.code, 3);
  assert.match(dup.err, /already on the list/);
  assert.equal(sb("todo", "done", "merge-42").code, 0);

  const c = sb("catchup", "--since", "1h");
  assert.equal(c.code, 0);
  assert.match(c.out, /Waiting on you/);
  assert.match(c.out, /First\?/);
  assert.doesNotMatch(c.out, /Second\?/);
});

test("no report: one nudge, then idle-without-report; a nudge that works yields a report", async () => {
  const a = await spawnTask("silent", "stub:noreport");
  await waitFor(statusIs(a.taskId, "idle-without-report"), 15000, "idle-without-report");
  const run = (await api("GET", `/api/runs/${a.taskId}`)).run;
  assert.equal(run.messages.filter((m) => m.role === "harness" && /without writing/.test(m.text)).length, 1, "nudged exactly once");

  const b = await spawnTask("forgetful", "stub:noreport\nstub:report-on-nudge");
  await waitFor(statusIs(b.taskId, "ready-for-review"), 15000, "report after nudge");
});

test("stall, usage limit and a dead worker each become an outcome", async () => {
  const s = await spawnTask("slow", "stub:stall=4\nstub:report=ready-for-review");
  await waitFor(statusIs(s.taskId, "worker-stalled"), 10000, "stall");
  await waitFor(statusIs(s.taskId, "ready-for-review"), 15000, "recovers to report");

  const l = await spawnTask("limited", "stub:limit");
  await waitFor(statusIs(l.taskId, "usage-limit"), 15000, "usage-limit");

  const g = await spawnTask("crashy", "stub:exit");
  await waitFor(statusIs(g.taskId, "worker-gone"), 15000, "worker-gone");
  assert.ok((await api("GET", "/api/inbox")).decisions.some((d) => d.taskId === g.taskId && d.kind === "resume"));
});

test("a permission ask reaches the dashboard and the answer reaches the worker", async () => {
  const t = await spawnTask("asky", "stub:ask\nstub:report=ready-for-review");
  const ask = await waitFor(async () => {
    const r = (await api("GET", `/api/runs/${t.taskId}`)).run;
    return r && r.pendingAsk;
  }, 10000, "ask");
  const ans = await api("POST", `/api/runs/${t.taskId}/answer`, { askId: ask.id, behavior: "deny", message: "no force-push" });
  assert.equal(ans.ok, true);
  await waitFor(statusIs(t.taskId, "ready-for-review"), 15000);
});

test("capacity: past the cap a task queues, then starts when a slot frees", async () => {
  const a = await spawnTask("cap a", "stub:stall=1\nstub:report=ready-for-review");
  const b = await spawnTask("cap b", "stub:stall=1\nstub:report=ready-for-review");
  const c = await spawnTask("cap c", "stub:report=ready-for-review");
  assert.equal(a.state, "started");
  assert.equal(b.state, "started");
  assert.equal(c.state, "queued");
  await waitFor(statusIs(c.taskId, "ready-for-review"), 20000, "queued task ran");
});

test("a follow-up sent mid-turn is queued and delivered after", async () => {
  const t = await spawnTask("busy", "stub:stall=1\nstub:report=ready-for-review");
  await waitFor(async () => (await api("GET", "/api/state")).jobs.running.includes(t.taskId), 5000);
  const r = sb("followup", t.taskId, "also handle the empty case");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /queued/);
  await waitFor(async () => {
    const run = (await api("GET", `/api/runs/${t.taskId}`)).run;
    return run.messages.some((m) => m.role === "user" && m.text === "also handle the empty case");
  }, 15000, "delivered");
});

test("cleanup refuses unpushed work, removes with --force, keeps the branch", async () => {
  const t = await spawnTask("committer", "stub:report=ready-for-review");
  await waitFor(statusIs(t.taskId, "ready-for-review"), 15000);
  await waitFor(idle(t.taskId), 5000);
  fs.writeFileSync(path.join(t.worktree, "new.txt"), "x\n");
  git(["add", "."], t.worktree);
  git(["commit", "-q", "-m", "local only"], t.worktree);

  const refused = sb("cleanup", t.taskId);
  assert.equal(refused.code, 3);
  assert.match(refused.err, /unpushed/);
  assert.ok(fs.existsSync(t.worktree));

  const forced = sb("cleanup", t.taskId, "--force");
  assert.equal(forced.code, 0, forced.err);
  assert.ok(!fs.existsSync(t.worktree));
  assert.equal(git(["rev-parse", "--verify", "--quiet", `refs/heads/${t.branch}`]).length > 0, true, "branch kept");

  // A pushed, clean worktree goes without --force.
  const u = await spawnTask("pusher", "stub:report=ready-for-review");
  await waitFor(statusIs(u.taskId, "ready-for-review"), 15000);
  await waitFor(idle(u.taskId), 5000);
  assert.equal(sb("cleanup", u.taskId).code, 0);
});

test("modes: quiet relays only what needs you; away holds and briefs on return", async () => {
  const relays = async () => (await api("GET", "/api/runs/orchestrator")).run.messages.filter((m) => m.role === "relay").length;
  await waitFor(idle("orchestrator"), 10000, "orchestrator idle");

  assert.equal(sb("mode", "quiet").code, 0);
  const before = await relays();
  const q = await spawnTask("quiet ok", "stub:report=ready-for-review");
  await waitFor(statusIs(q.taskId, "ready-for-review"), 15000);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await relays(), before, "a plain ready report is not relayed in quiet mode");

  assert.equal(sb("mode", "away").code, 0);
  const w = await spawnTask("away q", "stub:report=needs-input\nstub:question=Which one?");
  await waitFor(statusIs(w.taskId, "needs-input"), 15000);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await relays(), before, "held while away");

  assert.equal(sb("mode", "normal").code, 0);
  await waitFor(async () => {
    const o = (await api("GET", "/api/runs/orchestrator")).run;
    return o.messages.some((m) => m.role === "relay" && /Alex is back/.test(m.text) && m.text.includes(w.taskId));
  }, 10000, "catch-up relay");
});

test("restart: a worker lost mid-turn is reported and resumable; reports written while down are caught up", async () => {
  const lost = await spawnTask("long", "stub:stall=60");
  await waitFor(async () => (await api("GET", "/api/state")).jobs.running.includes(lost.taskId), 5000);
  const quiet = await spawnTask("offline report", "stub:noreport");
  await waitFor(statusIs(quiet.taskId, "idle-without-report"), 15000);

  await stopServer();
  fs.writeFileSync(path.join(DATA, "tasks", quiet.taskId, "report.md"), "---\nstatus: blocked\n---\n## TL;DR\nWritten while the dashboard was down.\n");
  await startServer();

  await waitFor(statusIs(lost.taskId, "worker-gone"), 5000, "lost → gone");
  await waitFor(statusIs(quiet.taskId, "blocked"), 5000, "caught up");
  const d = (await api("GET", "/api/inbox")).decisions.find((x) => x.taskId === lost.taskId && x.kind === "resume");
  assert.ok(d, "resume decision");
  assert.equal(sb("relaunch", lost.taskId).code, 0);
  await waitFor(statusIs(lost.taskId, "ready-for-review"), 15000, "resumed → report");
});
