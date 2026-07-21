#!/usr/bin/env node
/**
 * slack-bridge dashboard
 *
 * A zero-dependency local control panel for the Slack -> Claude Code fetch
 * pipeline. It does NOT talk to Slack. Mention detection, context gathering,
 * replies and Linear all happen inside Claude Code via the claude.ai Slack /
 * Linear MCP connectors, driven by the `/scan-mentions` poller.
 *
 * What it owns:
 *   data/config.json    toggles + poller settings (dashboard writes, poller reads)
 *   data/state.json     the poller's watermark + heartbeat (poller writes)
 *   data/activity.json  the poller's rolling log of processed mentions
 *   data/cost.json      per-tick $ ledger (scripts/run-once.sh appends)
 *   data/runs/<id>.json one chat per mention: transcript, phases, follow-ups
 *
 * The chat is the new surface: every mention is a thread you can scroll back
 * through and *reply to*, which spawns a real Claude session against the repo
 * (see lib/jobs.js). That is why every mutating route below is origin-checked
 * and the listener is pinned to loopback — a page on the open web must not be
 * able to POST a follow-up into a session that runs with permissions skipped.
 *
 * Run:  node index.js        (open http://localhost:4319)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const env = require("./lib/env");
const store = require("./lib/store");
const jobs = require("./lib/jobs");
const bus = require("./lib/bus");

const ROOT = __dirname;
// PORT stays supported for a one-off override; SLACK_BRIDGE_PORT in .env is
// the setting emit.sh and inbox.sh also read, so the three agree by default.
const PORT = Number(process.env.PORT) || env.port;
const PUBLIC = path.join(ROOT, "public");
const LAUNCHD_LABEL = env.launchdLabel;

/* --------------------------------------------------------------- launchd */

// Whether the launchd job is loaded, refreshed out-of-band so /api/state never
// blocks on launchctl. The poller's self-reported `runner` says who ran the
// last tick; this says whether the job is installed at all. The pair is what
// distinguishes "installed but never ticked" from "not installed", and catches
// a hand-run tick racing the job on state.json.
let cronInstalled = false;

function refreshCronInstalled() {
  execFile(
    "/bin/launchctl",
    ["print", `gui/${process.getuid()}/${LAUNCHD_LABEL}`],
    { timeout: 4000 },
    (err) => {
      const next = !err;
      if (next !== cronInstalled) {
        cronInstalled = next;
        bus.broadcast("state", snapshot());
      }
      cronInstalled = next;
    }
  );
}

/* ------------------------------------------------------------- http utils */

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2e6) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Loopback-only guard for mutating requests.
 *
 * The server already binds 127.0.0.1, which stops remote connections but not
 * a browser: any page you visit can POST to http://localhost:4319, and DNS
 * rebinding can defeat a naive Host check. Since a POST here can start a
 * session with `--dangerously-skip-permissions`, require both a loopback Host
 * *and* — when the browser sends one — a same-origin Origin.
 */
function sameOrigin(req) {
  const host = String(req.headers.host || "");
  const hostOk = /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i.test(host);
  const origin = req.headers.origin;
  if (!hostOk) return false;
  if (!origin) return true; // curl / the poller's emit.sh send no Origin
  return /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i.test(origin);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found: " + rel);
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  });
}

/* -------------------------------------------------------------- job opts */

/** Fold a composer's picks into a chat before its job launches. Silent when
 *  there is nothing to apply — every caller passes an optional field. */
function applyOpts(id, opts) {
  const clean = store.sanitizeJobOpts(opts);
  if (!Object.keys(clean).length) return;
  const run = store.loadRun(id);
  if (!run) return;
  run.opts = { ...run.opts, ...clean };
  store.saveRun(run);
}

/* ------------------------------------------------------------ dir picker */

/**
 * Directory listing for the composer's working-directory picker.
 *
 * A browser cannot hand back an absolute path — `webkitdirectory` gives
 * relative names and the File System Access API gives an opaque handle — so
 * the picker walks the real filesystem through here instead. Read-only, names
 * only, and it never reads a file: it answers "what folders are inside this
 * one", which is exactly what the picker draws.
 */
function listDirs(dir) {
  const target = path.resolve(dir && dir !== "~" ? dir : os.homedir());
  if (!store.isDir(target)) throw new Error("not a directory");
  const dirs = [];
  for (const name of fs.readdirSync(target)) {
    if (name.startsWith(".")) continue; // .git, .venv, node_modules noise
    if (name === "node_modules") continue;
    const full = path.join(target, name);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue; // a broken symlink or something we cannot see
    }
    // Don't follow symlinks: a link into / would make the picker look infinite.
    if (!stat.isDirectory()) continue;
    dirs.push({ name, path: full, repo: fs.existsSync(path.join(full, ".git")) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    home: os.homedir(),
    repo: fs.existsSync(path.join(target, ".git")),
    dirs: dirs.slice(0, 500),
  };
}

/* ---------------------------------------------------------------- payload */

function snapshot() {
  return {
    config: store.readConfig(),
    state: store.readState(),
    cronInstalled,
    cost: store.summariseCost(),
    jobs: { running: jobs.runningIds() },
    meta: {
      port: PORT,
      root: ROOT,
      workdir: jobs.resolveWorkdir(store.readConfig()),
      paths: store.PATHS,
    },
    now: Date.now(),
  };
}

/* ----------------------------------------------------------------- routes */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (req.method !== "GET" && !sameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: "cross-origin request refused" });
    return;
  }

  // --- live stream ---------------------------------------------------------
  if (req.method === "GET" && p === "/api/events") {
    bus.subscribe(req, res);
    // Seed the new tab so it never renders an empty shell waiting for a tick.
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    res.write(
      `event: runs\ndata: ${JSON.stringify({ runs: store.listRuns().map(store.summariseRun) })}\n\n`
    );
    return;
  }

  // --- everything the header + settings drawer render ----------------------
  if (req.method === "GET" && p === "/api/state") {
    sendJson(res, 200, snapshot());
    return;
  }

  // --- working-directory picker --------------------------------------------
  if (req.method === "GET" && p === "/api/dirs") {
    try {
      sendJson(res, 200, { ok: true, ...listDirs(url.searchParams.get("path")) });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  // --- sidebar -------------------------------------------------------------
  if (req.method === "GET" && p === "/api/runs") {
    sendJson(res, 200, { runs: store.listRuns().map(store.summariseRun) });
    return;
  }

  // --- one chat ------------------------------------------------------------
  const runMatch = p.match(/^\/api\/runs\/([^/]+)(?:\/(\w+))?$/);
  if (runMatch) {
    const id = store.safeId(decodeURIComponent(runMatch[1]));
    const verb = runMatch[2];
    if (!id) {
      sendJson(res, 400, { ok: false, error: "bad run id" });
      return;
    }

    if (req.method === "GET" && !verb) {
      const run = store.loadRun(id);
      if (!run) {
        sendJson(res, 404, { ok: false, error: "no such run" });
        return;
      }
      sendJson(res, 200, { run, running: jobs.isRunning(id) });
      return;
    }

    // The poller and the pipeline narrate themselves through here. Best-effort
    // by design: `emit.sh` swallows failures, so a dashboard that isn't
    // running never blocks or breaks a headless tick.
    if (req.method === "POST" && verb === "event") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const run = store.loadRun(id) || store.blankRun(id, body);
        // First contact for a run the poller hasn't logged yet: seed the chat
        // with the Slack message so the transcript starts where Slack did.
        if (!run.messages.length && (body.text || body.message)) {
          store.appendMessage(run, {
            role: "slack",
            author: body.who || run.who,
            text: body.message || body.text || "",
            permalink: body.permalink || run.permalink || "",
          });
        }
        for (const k of ["who", "channel", "channelId", "userId", "permalink", "threadTs", "prUrl", "linearUrl", "action"]) {
          if (body[k]) run[k] = body[k];
        }
        const phase = String(body.phase || "step");
        const msg = store.appendMessage(run, {
          role: body.role === "outcome" ? "outcome" : "event",
          phase,
          text: String(body.detail || body.text || ""),
          prUrl: body.prUrl || "",
          linearUrl: body.linearUrl || "",
        });
        run.phase = phase;
        store.saveRun(run);
        bus.broadcast("message", { runId: id, message: msg });
        bus.broadcast("run-updated", { runId: id });
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e.message || e) });
      }
      return;
    }

    // This chat's job options — which repo, model, permission mode, effort and
    // context window its next job runs with. Sparse: only the keys you have
    // actually changed are stored, so a chat you never tuned keeps following
    // the Settings defaults.
    if (req.method === "POST" && verb === "opts") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const run = store.loadRun(id);
        if (!run) throw new Error("unknown run");
        run.opts = { ...run.opts, ...store.sanitizeJobOpts(body.opts || body) };
        store.saveRun(run);
        bus.broadcast("run-updated", { runId: id });
        sendJson(res, 200, { ok: true, opts: run.opts, effective: store.jobOpts(store.readConfig(), run) });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e.message || e) });
      }
      return;
    }

    if (req.method === "POST" && verb === "followup") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const text = String(body.text || "").trim();
        if (!text) throw new Error("empty follow-up");
        if (text.length > 20000) throw new Error("follow-up too long");
        // The composer sends what it is showing along with the message, so the
        // job can never run under options you changed but that hadn't landed.
        applyOpts(id, body.opts);
        const msg = jobs.startFollowup(id, text, { config: store.readConfig() });
        sendJson(res, 200, { ok: true, message: msg });
      } catch (e) {
        sendJson(res, 409, { ok: false, error: String(e.message || e) });
      }
      return;
    }

    // Run the pipeline on a mention by hand. This is what makes watch mode
    // (and automation-off) a workflow rather than a read-only list.
    if (req.method === "POST" && verb === "start") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        applyOpts(id, body.opts);
        const msg = jobs.startPipeline(id, { config: store.readConfig() });
        bus.broadcast("runs", { runs: store.listRuns().map(store.summariseRun) });
        sendJson(res, 200, { ok: true, message: msg });
      } catch (e) {
        sendJson(res, 409, { ok: false, error: String(e.message || e) });
      }
      return;
    }

    if (req.method === "POST" && verb === "stop") {
      sendJson(res, 200, { ok: jobs.stop(id) });
      return;
    }

    // Clears the unread dot. Cheap enough to fire on every chat open.
    if (req.method === "POST" && verb === "seen") {
      const run = store.loadRun(id);
      if (run) {
        run.seenAt = Math.floor(Date.now() / 1000);
        store.saveRun(run);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "DELETE" && !verb) {
      if (jobs.isRunning(id)) {
        sendJson(res, 409, { ok: false, error: "stop the running follow-up first" });
        return;
      }
      try {
        fs.unlinkSync(path.join(store.PATHS.runs, `${id}.json`));
      } catch {}
      bus.broadcast("runs", { runs: store.listRuns().map(store.summariseRun) });
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // --- the inbox -----------------------------------------------------------
  // /scan-mentions posts every mention it sees here, including the ones triage
  // decided are not our work. The old dashboard could only show what the
  // pipeline chose to act on, so anything it skipped — or that arrived while
  // automation was off — was invisible and there was nowhere to disagree.
  if (req.method === "POST" && p === "/api/mentions") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const list = Array.isArray(body.mentions) ? body.mentions : [body];
      let changed = 0;
      for (const m of list.slice(0, 200)) {
        const out = store.upsertMention(m);
        if (out && out.dirty) changed++;
      }
      if (changed) bus.broadcast("runs", { runs: store.listRuns().map(store.summariseRun) });
      sendJson(res, 200, { ok: true, changed });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  // --- toggles + settings --------------------------------------------------
  if (req.method === "POST" && p === "/api/config") {
    try {
      const incoming = JSON.parse((await readBody(req)) || "{}");
      const config = store.writeConfig(incoming);
      bus.broadcast("state", snapshot());
      sendJson(res, 200, { ok: true, config });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  // --- poll now ------------------------------------------------------------
  if (req.method === "POST" && p === "/api/tick") {
    const out = await jobs.tickNow();
    sendJson(res, 200, out);
    return;
  }

  // --- launchd job ---------------------------------------------------------
  if (req.method === "POST" && p === "/api/cron") {
    let action = "";
    try {
      action = JSON.parse((await readBody(req)) || "{}").action;
    } catch {}
    if (!["cron", "cron-off"].includes(action)) {
      sendJson(res, 400, { ok: false, error: "action must be cron | cron-off" });
      return;
    }
    execFile(path.join(ROOT, "scripts", "install.sh"), [action], { timeout: 20000, cwd: ROOT }, (err, stdout, stderr) => {
      refreshCronInstalled();
      sendJson(res, err ? 500 : 200, {
        ok: !err,
        output: String(stdout || "") + String(stderr || ""),
      });
    });
    return;
  }

  // --- static --------------------------------------------------------------
  if (req.method === "GET") {
    serveStatic(res, p);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

/* ---------------------------------------------------- watching the files */

// The poller writes its files with an atomic rename, which swaps the inode and
// makes fs.watch on a path unreliable. Stat-polling four small files costs
// nothing and never misses a write.
const watched = ["config", "state", "activity", "cost"];
const stamps = new Map();

function pollFiles() {
  let stateChanged = false;
  let activityChanged = false;
  for (const key of watched) {
    let mtime = 0;
    try {
      mtime = fs.statSync(store.PATHS[key]).mtimeMs;
    } catch {}
    if (stamps.get(key) !== mtime) {
      stamps.set(key, mtime);
      if (key === "activity") activityChanged = true;
      else stateChanged = true;
    }
  }
  if (activityChanged) {
    const touched = store.syncFromActivity();
    if (touched.length) {
      bus.broadcast("runs", { runs: store.listRuns().map(store.summariseRun) });
      for (const id of touched) bus.broadcast("run-updated", { runId: id });
    }
    stateChanged = true;
  }
  if (stateChanged) bus.broadcast("state", snapshot());
}

/* -------------------------------------------------------------------- go */

store.ensureRunsDir();
store.syncFromActivity(); // backfill chats for everything the poller logged before today
refreshCronInstalled();
setInterval(refreshCronInstalled, 15000).unref();
setInterval(pollFiles, 1500).unref();
pollFiles();

// Almost always means a dashboard from an earlier terminal is still alive —
// it survives the shell that started it. Say so instead of dumping a stack.
server.on("error", (err) => {
  if (err.code !== "EADDRINUSE") throw err;
  console.error(`port ${PORT} is already in use — a dashboard is probably already running.`);
  console.error(`  open it:   http://localhost:${PORT}`);
  console.error(`  find it:   lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
  console.error(`  replace:   kill $(lsof -t -iTCP:${PORT} -sTCP:LISTEN) && node index.js`);
  console.error(`  or move:   SLACK_BRIDGE_PORT=4320 node index.js`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const config = store.readConfig();
  console.log(`slack-bridge dashboard  ->  http://localhost:${PORT}`);
  console.log(`  runs:      ${store.PATHS.runs}`);
  console.log(`  config:    ${store.PATHS.config}`);
  console.log(`  follow-up: ${jobs.resolveWorkdir(config)}  (model: ${config.followup.model})`);
  console.log(`\nPoller: ./scripts/install.sh cron   (launchd runs claude -p /scan-mentions)`);
});
