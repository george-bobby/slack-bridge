#!/usr/bin/env node
/**
 * slack-bridge dashboard
 *
 * A zero-dependency local control panel for the Slack -> Claude Code fetch
 * pipeline. It does NOT talk to Slack and holds no Slack credentials. You paste
 * a Slack thread link; a Claude Code session reads the thread, replies and
 * files Linear tickets through the Slack / Linear MCP connectors it already
 * has. Nothing runs on a timer — every job here is one you started.
 *
 * What it owns:
 *   data/config.json    pipeline gates + job defaults (Settings writes it)
 *   data/runs/<id>.json one chat per Slack thread: transcript, phases, follow-ups
 *
 * Every chat has a composer: replying spawns a real Claude session against
 * the repo (see lib/jobs.js). That is why every mutating route below is
 * origin-checked and the listener is pinned to loopback — a page on the open
 * web must not be able to POST a follow-up into a session that runs with
 * permissions skipped.
 *
 * Run:  node index.js        (open http://localhost:4319)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const env = require("./lib/env");
const store = require("./lib/store");
const jobs = require("./lib/jobs");
const memory = require("./lib/memory");
const proposals = require("./lib/proposals");
const bus = require("./lib/bus");
const harness = require("./lib/harness");
const tasks = require("./lib/tasks");

const ROOT = __dirname;
// PORT stays supported for a one-off override; SLACK_BRIDGE_PORT in .env is
// the setting emit.sh also reads, so the two agree by default.
const PORT = Number(process.env.PORT) || env.port;
const PUBLIC = path.join(ROOT, "public");

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
  if (!origin) return true; // curl / a run's emit.sh send no Origin
  return /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i.test(origin);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  // The vendored editor is an ES module, and a browser refuses to run one
  // served as anything but a JavaScript type.
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
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
    cost: store.summariseCost(),
    jobs: { running: jobs.runningIds(), awaiting: jobs.awaitingIds() },
    inbox: harness.inbox().counts,
    // Only what the page actually draws: the repo a new chat's job would run
    // in, which the composer's picker opens on.
    meta: { workdir: jobs.resolveWorkdir(store.readConfig()) },
    now: Date.now(),
  };
}

/* ----------------------------------------------------------------- routes */

/**
 * The body of a proposed memory, which a run hands over by path.
 *
 * Confined to `data/runs/memories/`: this endpoint takes an unauthenticated
 * local POST, and "read me any file and store it" is a much larger door than a
 * narration route needs. Resolved and then re-checked, the same two-step
 * lib/memory.js uses — the pattern test rejects the obvious traversal, the
 * containment test is what still holds if the pattern is ever loosened.
 */
function readProposalText(textFile) {
  if (!textFile) return "";
  const file = path.resolve(proposals.DIR, String(textFile));
  if (path.dirname(file) !== path.resolve(proposals.DIR)) throw new Error("proposal text must live in data/runs/memories/");
  if (!file.endsWith(".md")) throw new Error("proposal text must be a .md file");
  return fs.readFileSync(file, "utf8");
}

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
    // Seed the new tab so it never renders an empty shell waiting for a push.
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    res.write(
      `event: runs\ndata: ${JSON.stringify({ runs: store.listRunSummaries() })}\n\n`
    );
    res.write(`event: inbox\ndata: ${JSON.stringify(harness.inbox())}\n\n`);
    return;
  }

  // --- the harness ---------------------------------------------------------
  // What bin/sb and the Inbox talk to. Same origin rules as every other route.
  if (p === "/api/tasks" || p.startsWith("/api/tasks/") || p === "/api/inbox" || p === "/api/catchup" || p.startsWith("/api/decisions/") || p.startsWith("/api/todos") || p === "/api/mode") {
    try {
      const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
      const ok = (extra) => sendJson(res, 200, { ok: true, ...extra });

      if (req.method === "GET" && p === "/api/tasks") return ok({ tasks: harness.status(), working: harness.workingCount().total, harness: store.readConfig().harness });
      if (req.method === "POST" && p === "/api/tasks") {
        return ok(await harness.spawnTask({ repo: body.repo, title: body.title, brief: body.brief, branch: body.branch, opts: body.opts, start: body.start !== false }));
      }
      if (req.method === "GET" && p === "/api/inbox") return ok(harness.inbox());
      if (req.method === "GET" && p === "/api/catchup") return ok(harness.catchup(url.searchParams.get("since") || "8h"));
      if (req.method === "POST" && p === "/api/mode") return ok({ harness: harness.setMode(String(body.mode || "")) });
      if (req.method === "POST" && p === "/api/todos") {
        if (!String(body.text || "").trim()) throw new Error("a to-do needs text");
        const out = tasks.addTodo({ key: body.key, text: body.text, taskId: body.taskId || "", url: body.url || "" });
        bus.broadcast("inbox", harness.inbox());
        return ok(out);
      }
      if (req.method === "POST" && p === "/api/todos/done") {
        const out = tasks.doneTodo(String(body.key || ""));
        bus.broadcast("inbox", harness.inbox());
        return ok({ todo: out });
      }
      const dm = p.match(/^\/api\/decisions\/([A-Za-z0-9-]+)$/);
      if (req.method === "POST" && dm) {
        const out = harness.decide(dm[1], { answer: String(body.answer || "").slice(0, 8000), action: body.action || "answer" });
        bus.broadcast("inbox", harness.inbox());
        return ok({ decision: out });
      }
      const tm = p.match(/^\/api\/tasks\/([^/]+)(?:\/(\w+))?$/);
      if (tm) {
        const id = tasks.safeTaskId(decodeURIComponent(tm[1]));
        if (!id || !tasks.exists(id)) return sendJson(res, 404, { ok: false, error: "no such task" });
        const verb = tm[2];
        if (req.method === "GET" && !verb) {
          const pth = tasks.paths(id);
          const read = (f) => {
            try {
              return fs.readFileSync(f, "utf8");
            } catch {
              return "";
            }
          };
          const report = tasks.readReport(id);
          const meta = tasks.readMeta(id);
          return ok({
            meta,
            brief: read(pth.brief),
            report: report ? report.text : "",
            parsed: report ? { ...report.parsed, sections: undefined } : null,
            paths: pth,
            worktree: meta.worktree && meta.status !== "cleaned" ? await tasks.inspectWorktree(meta.worktree) : null,
            live: jobs.isRunning(id),
          });
        }
        if (req.method === "POST" && verb === "declare") return ok({ meta: harness.declare(id, String(body.state || ""), String(body.text || "").slice(0, 300)) });
        if (req.method === "POST" && verb === "relaunch") {
          harness.relaunch(id, String(body.note || "").slice(0, 2000));
          return ok({});
        }
        if (req.method === "POST" && verb === "cleanup") return ok(await harness.cleanup(id, { force: !!body.force }));
      }
      return sendJson(res, 404, { ok: false, error: `no harness route for ${req.method} ${p}` });
    } catch (e) {
      return sendJson(res, e.refused ? 409 : 400, { ok: false, error: String(e.message || e) });
    }
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

  // --- project memory ------------------------------------------------------
  // What Claude Code was told about the repo a job runs in: `MEMORY.md` and the
  // one-fact-per-file memories beside it. The workdir is resolved through the
  // same jobs.resolveWorkdir() a job would use — pass a chat's id and you get
  // that chat's repo, pass nothing and you get the default one — so the panel
  // can never show the memory of a repo the run wouldn't have read.
  if (p === "/api/memory" || p.startsWith("/api/memory/")) {
    try {
      const body =
        req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : Object.fromEntries(url.searchParams);
      const runId = store.safeId(String(body.runId || ""));
      const workdir = jobs.resolveWorkdir(store.readConfig(), runId ? store.loadRun(runId) : null);
      const verb = p.slice("/api/memory".length);
      const ok = (extra) => sendJson(res, 200, { ok: true, workdir, ...extra });

      // A proposal names the run it came from, and that run names the repo.
      // Resolving the workdir from it rather than trusting the one recorded on
      // the proposal keeps every route here answering about the same directory.
      const forProposal = (id) => {
        const rec = proposals.get(id);
        if (!rec) throw new Error(`no such proposal: ${id}`);
        const run = store.safeId(rec.runId) ? store.loadRun(rec.runId) : null;
        return { rec, dir: jobs.resolveWorkdir(store.readConfig(), run) };
      };

      if (req.method === "GET" && verb === "") {
        ok(memory.list(workdir));
      } else if (req.method === "GET" && verb === "/file") {
        ok(memory.read(workdir, body.name));
      } else if (req.method === "GET" && verb === "/proposals") {
        // Grouped by territory, with the live memory names so an amendment to
        // something that already exists is marked ripe without a second run.
        const live = memory.list(workdir, { usage: false }).files.map((f) => f.name);
        ok({ territories: proposals.territories(live), all: proposals.all() });
      } else if (req.method === "POST" && verb === "/file") {
        ok(memory.write(workdir, body.name, body.text));
      } else if (req.method === "POST" && verb === "/approve") {
        // The one place a proposal becomes a memory. `update` carries the whole
        // amended file rather than a patch, which is what the editor showed you
        // before you pressed the button.
        const { rec, dir } = forProposal(body.id);
        const wrote =
          rec.verdict === "update"
            ? memory.write(dir, rec.target, body.text || rec.text)
            : memory.create(dir, rec.name, body.text || rec.text, { title: rec.title, section: rec.section });
        // Every proposal for this ground, not just the one on screen — the
        // memory just written is what all of them were arguing for.
        proposals.setStatus(rec.runId, "approved");
        proposals.resolveTerritory(rec.territory, "approved");
        // `dir`, not the request's workdir: a proposal is approved from
        // wherever the panel happens to be pointed, and reporting the caller's
        // repo for a write that landed in the run's would be a lie the UI
        // then repeats.
        sendJson(res, 200, { ok: true, workdir: dir, ...wrote, verdict: rec.verdict });
      } else if (req.method === "POST" && verb === "/discard") {
        // The row you pressed this on is a territory, not a single proposal, so
        // discarding it drops the whole case rather than one run's half of it.
        const rec = proposals.setStatus(String(body.id || ""), "discarded");
        proposals.resolveTerritory(rec.territory, "discarded");
        ok(rec);
      } else if (req.method === "POST" && verb === "/archive") {
        ok(memory.archive(workdir, body.name));
      } else if (req.method === "POST" && verb === "/restore") {
        ok(memory.restore(workdir, body.name));
      } else if (req.method === "POST" && verb === "/draft") {
        // You type the point; a read-only session decides whether the repo
        // already remembers it and writes the file properly either way. What
        // comes back is a proposal — reviewed in the same editor, written by
        // the same validated path — so drafting can never itself touch
        // ~/.claude.
        const info = memory.list(workdir, { usage: false });
        const draft = await jobs.draftMemory(body.text, {
          config: store.readConfig(),
          run: runId ? store.loadRun(runId) : null,
          memoryDir: info.dir,
          project: info.project,
        });
        // Keyed by a synthetic id, not a run: this came from you, not a
        // mention, and it must not collide with a run's own proposal.
        const id = `draft-${Date.now().toString(36)}`;
        const rec = proposals.propose(id, {
          ...draft,
          citation: "typed in the dashboard",
          workdir,
          // Yours is ripe immediately — the recurrence bar exists to stop
          // unattended runs banking noise, and you are neither.
          ripeNow: true,
        });
        ok({ ...rec, draftedFrom: String(body.text || "").slice(0, 200) });
      } else if (req.method === "POST" && verb === "/relist") {
        ok(memory.relist(workdir, body.name, { section: body.section }));
      } else {
        sendJson(res, 404, { ok: false, error: `no memory route for ${req.method} ${p}` });
      }
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  // --- sidebar -------------------------------------------------------------
  if (req.method === "GET" && p === "/api/runs") {
    sendJson(res, 200, { runs: store.listRunSummaries() });
    return;
  }

  // --- a chat from a pasted Slack link --------------------------------------
  // The only way a chat is born from the dashboard. Pasting a link to a thread
  // that already has a chat opens that chat rather than minting a second one;
  // `start` runs the pipeline on it straight away unless a job already ran.
  if (req.method === "POST" && p === "/api/runs") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const { run, created } = store.createFromLink(body.url);
      applyOpts(run.runId, body.opts);
      let started = false;
      const fresh = store.loadRun(run.runId);
      let queued = false;
      if (body.start && !jobs.isRunning(run.runId) && !fresh.sessionId && fresh.action !== "running") {
        const out = harness.startSlack(run.runId);
        started = out.state === "started";
        queued = out.state === "queued";
      }
      bus.broadcast("runs", { runs: store.listRunSummaries() });
      sendJson(res, 200, { ok: true, runId: run.runId, created, started, queued });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
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
      // No `running` alongside it: the page tracks live jobs through the
      // `jobs` event on the SSE stream, which is pushed the moment one starts
      // or ends rather than only when a chat happens to be fetched.
      sendJson(res, 200, { run });
      return;
    }

    // The pipeline narrates itself through here. Best-effort by design:
    // `emit.sh` swallows failures, so a dashboard that isn't running never
    // blocks or breaks a run started from a terminal.
    if (req.method === "POST" && verb === "event") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const run = store.loadRun(id) || store.blankRun(id, body);
        // The pipeline read the thread through the Slack connector; `message`
        // is the opening ask. Seed it once, at the top of the transcript, so
        // the chat starts where Slack did even though this server never saw it.
        if (body.message && !run.messages.some((m) => m.role === "slack")) {
          const ask = {
            id: `slack-${run.runId}`,
            ts: Math.floor(Number(run.rootTs || run.threadTs) || Date.now() / 1000),
            role: "slack",
            author: body.who || run.who,
            text: String(body.message),
            permalink: body.permalink || run.permalink || "",
          };
          run.messages.unshift(ask);
          run.text = ask.text;
        }
        for (const k of ["who", "channel", "channelId", "userId", "permalink", "threadTs", "prUrl", "linearUrl", "action"]) {
          if (body[k]) run[k] = body[k];
        }
        const phase = String(body.phase || "step");
        // A pipeline run records its worktree for cleanup and status.
        if (body.worktree || body.branch || body.prUrl) {
          const patch = {};
          if (body.worktree && path.isAbsolute(String(body.worktree))) patch.worktree = String(body.worktree);
          if (body.branch) patch.branch = String(body.branch).slice(0, 120);
          if (body.prUrl) patch.prUrl = String(body.prUrl);
          if (Object.keys(patch).length && tasks.safeTaskId(id)) tasks.writeMeta(id, { kind: "slack", repo: env.targetRepo, ...patch });
        }

        // A `memory` event is a *proposal*, never a memory: it lands in
        // data/runs/memories/, which no session loads, and is promoted only by
        // recurrence or by you (see lib/proposals.js §8.7 of the skill). Filed
        // through the narration route on purpose — emit.sh stays the single way
        // a headless run talks to the dashboard, and a proposal that fails to
        // parse must not cost the run its stage line.
        if (phase === "memory") {
          try {
            proposals.propose(id, {
              verdict: body.verdict,
              territory: body.territory,
              reason: String(body.detail || body.text || ""),
              citation: body.citation,
              target: body.target,
              name: body.name,
              title: body.title,
              section: body.section,
              workdir: jobs.resolveWorkdir(store.readConfig(), run),
              // The memory itself is passed by path, since it is a whole file
              // and `text` is already this event's one-line summary. Confined
              // to the proposals directory so a POST here cannot read the disk.
              text: readProposalText(body.textFile),
            });
          } catch (e) {
            store.appendMessage(run, { role: "event", phase, text: `memory proposal rejected: ${e.message}` });
          }
        }

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
        const msg = jobs.startFollowup(id, text, { config: store.readConfig(), queue: !!body.queue });
        sendJson(res, 200, { ok: true, message: msg, queued: !!(msg && msg.queued) });
      } catch (e) {
        sendJson(res, 409, { ok: false, error: String(e.message || e) });
      }
      return;
    }

    // Run the pipeline on a chat that hasn't had one yet.
    if (req.method === "POST" && verb === "start") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        applyOpts(id, body.opts);
        const out = harness.startSlack(id);
        bus.broadcast("runs", { runs: store.listRunSummaries() });
        sendJson(res, 200, { ok: true, ...out });
      } catch (e) {
        sendJson(res, 409, { ok: false, error: String(e.message || e) });
      }
      return;
    }

    // Answer whatever the running session stopped to ask — a permission
    // request, a question, or a plan waiting for approval. The session is
    // blocked until this lands, which is why it is the one route that reaches
    // straight into a live child process rather than going through the run file.
    if (req.method === "POST" && verb === "answer") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const askId = String(body.askId || "");
        if (!askId) throw new Error("which question?");
        const out = jobs.answerAsk(id, askId, {
          behavior: body.behavior,
          message: body.message,
          answers: body.answers,
        });
        sendJson(res, 200, out);
      } catch (e) {
        // 409, not 400: the usual cause is a second tab (or a stale one) having
        // answered it already, which is a race rather than a bad request.
        sendJson(res, 409, { ok: false, error: String(e.message || e) });
      }
      return;
    }

    if (req.method === "POST" && verb === "stop") {
      sendJson(res, 200, { ok: jobs.stop(id) });
      return;
    }

    // Same chat, same session, real terminal. The dashboard is the better
    // place to *watch* a run; it is a worse place to take one over, and until
    // now the only way out was to go digging for the session id by hand.
    if (req.method === "POST" && verb === "terminal") {
      try {
        sendJson(res, 200, { ok: true, ...(await jobs.openTerminal(id, { config: store.readConfig() })) });
      } catch (e) {
        sendJson(res, 409, { ok: false, error: String(e.message || e) });
      }
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
      if (id === harness.ORCH) {
        sendJson(res, 409, { ok: false, error: "the orchestrator chat can't be deleted" });
        return;
      }
      if (jobs.isRunning(id)) {
        sendJson(res, 409, { ok: false, error: "stop the running job first" });
        return;
      }
      store.deleteRun(id);
      bus.broadcast("runs", { runs: store.listRunSummaries() });
      sendJson(res, 200, { ok: true });
      return;
    }
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

  // --- static --------------------------------------------------------------
  if (req.method === "GET") {
    serveStatic(res, p);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

/* ---------------------------------------------------- watching the files */

// config.json can be edited by hand while the dashboard is open; stat-polling
// one small file costs nothing and keeps every tab honest.
let configStamp = 0;

function pollFiles() {
  let mtime = 0;
  try {
    mtime = fs.statSync(store.PATHS.config).mtimeMs;
  } catch {}
  if (mtime !== configStamp) {
    configStamp = mtime;
    bus.broadcast("state", snapshot());
  }
}

/* -------------------------------------------------------------------- go */

store.ensureRunsDir();
// Every session we could have been asked a question by died when this process
// did, so nothing on disk is still waiting for an answer. Sweep before the
// first render or the sidebar comes up claiming chats need you.
store.clearPendingAsks();
// After the sweep: recovery reads the run files and the task folders, re-arms
// nothing (the server is the watcher) and turns whatever died with the last
// process into an outcome you can resume from.
harness.start();
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
  console.log(`\nPaste a Slack thread link into the dashboard to start a run.`);
});
