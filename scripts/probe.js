#!/usr/bin/env node
/**
 * probe.js — mention detection, for free.
 *
 * Every tick starts here: one `search.messages` call with a Slack user token,
 * answering "has anyone mentioned me since the watermark?" for $0. Only when
 * the answer is yes does `run-once.sh` start a Claude session. This is the
 * whole cost model — spend scales with how often you are mentioned, not with
 * how often you poll.
 *
 * A *user* token (`xoxp-`), not a bot: `search.messages` accepts nothing else,
 * and the app that issues it has no bot scopes, so no bot user exists and
 * there is nothing to add to any channel. The token sees exactly what you see.
 *
 * Exit codes are the whole interface — stdout is for humans:
 *   0   new mentions, written to data/probe.json — run the session
 *   10  nothing to do (no new mentions, or a transient failure) — skip, $0
 *   20  broken: no token, bad auth, bad config. Skip too, but loudly, and
 *       deliberately without a heartbeat so the dashboard goes stale and you
 *       find out. There is no fallback path — a broken probe means a blind
 *       poller, and that should look obviously wrong rather than quietly
 *       expensive.
 *
 * A transient failure (429, 5xx, DNS) is a 10, not a 20: the watermark is
 * untouched, so the next tick re-asks and sees the same mentions. Nothing is
 * lost but a tick of latency.
 *
 * It also decides, for free, which mentions are worth a session at all. A
 * follow-up inside a thread that has already been worked — @Linear confirming
 * the ticket the pipeline just asked for, a build bot, a colleague's "thanks" —
 * is filed straight into that thread's chat over loopback and never starts one.
 * See askDashboard(): that is where most of the remaining spend went, because
 * nearly half of the mentions this workspace sees are exactly that.
 *
 * Run it by hand any time:
 *   node scripts/probe.js          normal
 *   node scripts/probe.js --debug  print what it found, absorbed, and kept
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const env = require("../lib/env");
const slack = require("../lib/slack");

const ROOT = path.join(__dirname, "..");
const STATE = path.join(ROOT, "data", "state.json");
const OUT = path.join(ROOT, "data", "probe.json");

const DEBUG = process.argv.includes("--debug");

const EXIT_WORK = 0;
const EXIT_IDLE = 10;
const EXIT_BROKEN = 20;

/**
 * Keep the dashboard's heartbeat alive on the idle path.
 *
 * `state.lastRun` used to be written only by /scan-mentions §7, which was fine
 * when every tick started a session. Now the common tick doesn't, and the
 * dashboard goes "stalled" at `lastRun` + 2.5 cycles (public/app.js) — so
 * without this, a poller working perfectly and for free would render as a dead
 * one. The probe is the only thing that ran, so the probe reports in.
 *
 * Deliberately narrow: `lastRun`, `lastRunStatus`, and the two fields the
 * runner chip is built from. It never touches `lastTs`, `processed`, `mcpOk`
 * or `mcpNote` — the watermark is the session's to move, and this path never
 * spoke to the MCP connector so it has no news about it either way.
 *
 * Safe to write here: run-once.sh takes its single-flight lock *before* the
 * probe, so no session can be mid-write. The tmp+rename keeps a reader from
 * ever seeing a half-file even so.
 */
function heartbeat(status) {
  try {
    const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
    state.lastRun = Math.floor(Date.now() / 1000);
    state.lastRunStatus = status;
    state.runner = process.env.SLACK_BRIDGE_RUNNER || "cron";
    const iv = Number(process.env.SLACK_BRIDGE_INTERVAL);
    if (Number.isFinite(iv) && iv > 0) state.intervalSec = iv;
    writeState(state);
  } catch {
    // No state file, or unreadable. The session path rebuilds it; a missed
    // heartbeat is a cosmetic problem and must never fail a tick.
  }
}

/** tmp + rename, so a reader never catches a half-written file. */
function writeState(state) {
  const tmp = `${STATE}.probe.tmp`;
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE);
}

/** Everything this process learned, banked for the dashboard and for whoever
 *  is reading data/probe.json at 2am wondering why nothing fired. Written on
 *  every path out, including the failures. */
function finish(code, status, extra = {}) {
  const payload = {
    ts: Math.floor(Date.now() / 1000),
    status,
    exit: code,
    mentions: [],
    ...extra,
  };
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  } catch {
    // A probe that can't write its own log still has a valid answer to give.
  }
  // Only the idle path: the other two start a session, and it writes its own
  // §7 heartbeat with a fuller picture than this one has.
  if (code === EXIT_IDLE) heartbeat(status);
  console.log(status);
  process.exit(code);
}

/** Slack ts values are "seconds.microseconds" strings. They are ordered
 *  lexically *only* while the integer part keeps its width, which it does for
 *  another 250 years — but Number() is exact here (a ts is ~16 significant
 *  digits, under the 17 a double holds) and says what it means. */
function tsNum(ts) {
  const n = Number(ts);
  return Number.isFinite(n) ? n : 0;
}

/** A threaded message's permalink carries the parent in its query string:
 *  …/archives/C123/p1784594563213089?thread_ts=1784594100.123456&cid=C123
 *  search.messages itself never returns thread_ts, and the pipeline needs it
 *  to read the conversation the mention lives in — so recover it from here and
 *  fall back to the message's own ts (a top-level message *is* its thread). */
function threadTsFrom(permalink, ownTs) {
  try {
    const t = new URL(permalink).searchParams.get("thread_ts");
    if (t) return t;
  } catch {
    // Not a URL we understand; the fallback is correct for top-level messages
    // and the pipeline re-resolves the thread from the channel + ts anyway.
  }
  return ownTs;
}

/**
 * Hand the survivors to the dashboard, and ask what it already knows about them.
 *
 * This is the whole of the "don't pay to be told nothing" fix. Nearly half of
 * the mentions this workspace sees are @Linear posting "Created issue EXP-388"
 * into a thread the pipeline just worked — a confirmation of work already done.
 * Every one of those used to start a session (median $0.094) purely so triage
 * could read it and skip it. The session was doing classification the dashboard
 * could already answer off disk.
 *
 * So ask it. POST /api/mentions files each mention *and* reports where it
 * landed, in one loopback round trip for nothing:
 *
 *   created                 a thread nobody has filed — real, new work
 *   settled && !created     a follow-up in a conversation already decided
 *
 * `settled` is deliberately narrower than "the poller wrote something about
 * it": a thread triage marked `actionable` but never dispatched (watch mode) is
 * *not* settled, because it is still owed an answer and the next message in it
 * may be the one that matters. See hasWorked/isSettled in lib/store.js.
 *
 * The settled case is the one that needs no session — and because the POST also
 * *filed* it, the message still lands in the thread's transcript with an unread
 * dot. You keep the Linear confirmation; you stop paying a session to be shown
 * it. Deliberately not a blocklist on the bot's user id: this catches a
 * colleague's "thanks!" and a build bot's status the same way, and it never has
 * to decide that some class of author is never worth reading.
 *
 * Best-effort, exactly like inbox.sh. A closed dashboard answers nothing, and
 * `null` means "no information" — every mention is kept and the session runs,
 * which is precisely the behaviour before this existed. A cost optimisation
 * must never be the reason a mention is missed.
 */
function askDashboard(mentions) {
  const payload = JSON.stringify({ mentions });
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: env.port,
        path: "/api/mentions",
        method: "POST",
        timeout: 3000,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(body);
            resolve(Array.isArray(json.results) ? json.results : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end(payload);
  });
}

/**
 * Bank what this tick resolved without a session.
 *
 * heartbeat() below says the watermark is the session's to move, and that was
 * right while the probe only ever *detected*. It now also *resolves* a class of
 * mention — nothing downstream will ever look at an absorbed follow-up again —
 * so without recording them it would re-examine the same bot post on every tick
 * forever, and `lastTs` would sit behind it permanently.
 *
 * `processed` takes every absorbed ts. `lastTs` only advances when nothing at
 * all is being handed on: while a session is about to run it still owns the
 * watermark, and two writers moving it in one tick is how a mention gets
 * skipped for real.
 */
function bank(absorbed, { advance }) {
  if (!absorbed.length) return;
  try {
    const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
    const processed = Array.isArray(state.processed) ? state.processed : [];
    for (const m of absorbed) if (!processed.includes(m.ts)) processed.push(m.ts);
    state.processed = processed.slice(-200);
    if (advance) {
      const high = absorbed.reduce((a, m) => (tsNum(m.ts) > tsNum(a) ? m.ts : a), state.lastTs);
      state.lastTs = high;
    }
    const tmp = `${STATE}.probe.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE);
  } catch {
    // Unwritable state means the worst case is re-asking the dashboard next
    // tick, which is free. Never fail a tick over bookkeeping.
  }
}

async function main() {
  const token = env.slackUserToken;
  const userId = env.slackUserId;

  if (!token) {
    return finish(EXIT_BROKEN, "no SLACK_USER_TOKEN — the poller cannot detect mentions", {
      hint: "see .env.example → SLACK_USER_TOKEN for how to mint one",
    });
  }
  if (!token.startsWith("xoxp-")) {
    // A bot token here would 'work' right up until it silently returned no
    // results: search.messages is user-token-only, and a bot can only see
    // channels it joined — the exact thing this design avoids.
    return finish(EXIT_BROKEN, "SLACK_USER_TOKEN is not a user token (expected xoxp-…)", {
      hint: "search.messages accepts user tokens only; a bot token cannot search",
    });
  }
  if (!userId || !/^U[A-Z0-9]+$/i.test(userId)) {
    return finish(EXIT_BROKEN, `SLACK_USER_ID looks wrong (${userId || "unset"})`);
  }

  // --- watermark ----------------------------------------------------------
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    // No state yet — that's first-run, handled just below.
  }
  const lastTs = String(state.lastTs || "0");
  const processed = new Set(Array.isArray(state.processed) ? state.processed : []);

  // First run: start the watermark at *now*, so an install never replays
  // months of old mentions as if they just arrived. The probe owns this
  // because nothing else runs on a first tick — there is no session to defer
  // it to. Costs nothing and happens exactly once.
  if (lastTs === "0") {
    state.lastTs = `${Math.floor(Date.now() / 1000)}.000000`;
    if (!Array.isArray(state.processed)) state.processed = [];
    writeState(state);
    return finish(EXIT_IDLE, "initialized — watching from now");
  }

  // --- ask Slack ----------------------------------------------------------
  // `after:` is a query modifier, not a parameter, and its granularity is a
  // whole day in the *workspace's* timezone. Two days of pad makes the
  // timezone question moot; the exact cut is the ts comparison below, which is
  // to the microsecond. Its only job is to keep the result set small.
  const since = new Date((tsNum(lastTs) - 2 * 86400) * 1000).toISOString().slice(0, 10);
  const query = `<@${userId}> after:${since}`;

  // Newest-first, not oldest-first: `after:` only resolves to a day, so an
  // ascending page of 20 could be entirely stale messages from that day while
  // the mention we want sits on page 2. Descending guarantees the newest are
  // in hand; ascending order is restored after filtering.
  const params = new URLSearchParams({
    query,
    sort: "timestamp",
    sort_dir: "desc",
    count: "20",
  });

  let res;
  let body;
  try {
    res = await fetch(`https://slack.com/api/search.messages?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    body = await res.json();
  } catch (err) {
    // Network, DNS, timeout. Watermark untouched → the next tick re-asks and
    // sees the same mentions. Nothing is lost by not spending here.
    return finish(EXIT_IDLE, `probe unreachable (${err.name || "error"}) — skipping this tick`, {
      error: String(err.message || err).slice(0, 200),
    });
  }

  if (res.status === 429) {
    const retry = res.headers.get("retry-after") || "?";
    return finish(EXIT_IDLE, `rate limited (retry-after ${retry}s) — skipping this tick`);
  }

  if (!body || body.ok !== true) {
    const err = String((body && body.error) || `http ${res.status}`);
    // Credential and scope problems don't fix themselves on the next tick, so
    // they alone are loud (20). Everything else is treated as weather (10).
    const credential = [
      "invalid_auth",
      "not_authed",
      "token_revoked",
      "token_expired",
      "account_inactive",
      "missing_scope",
      "not_allowed_token_type",
      "no_permission",
    ].includes(err);
    return credential
      ? finish(EXIT_BROKEN, `Slack rejected the token (${err}) — the poller is blind`, {
          hint: "re-check the search:read user scope, then reinstall the app",
        })
      : finish(EXIT_IDLE, `search failed (${err}) — skipping this tick`);
  }

  // --- filter -------------------------------------------------------------
  const matches = (body.messages && body.messages.matches) || [];
  const cut = tsNum(lastTs);
  const seen = new Set();
  const kept = [];

  for (const m of matches) {
    const ts = String(m.ts || "");
    if (!ts) continue;
    if (tsNum(ts) <= cut) continue; // at or behind the watermark
    if (processed.has(ts)) continue; // already worked in an earlier tick
    if (seen.has(ts)) continue; // search can repeat a match across pages
    if (m.user && m.user === userId) continue; // your own message quoting yourself
    if (m.user === "USLACKBOT") continue; // reminders, not people
    seen.add(ts);

    const permalink = String(m.permalink || "");
    const channel = m.channel || {};
    // The run id is the *thread*, not this message: one thread is one chat, and
    // a reply inside a thread that already has one belongs to it rather than
    // opening a second. `ts` stays the message's own — it is what the watermark
    // and `state.processed` are keyed by, so a thread can still receive many
    // messages without any of them being reprocessed.
    const threadTs = threadTsFrom(permalink, ts);
    kept.push({
      runId: threadTs,
      ts,
      who: String(m.username || m.user || "unknown"),
      userId: String(m.user || ""),
      channel: channel.name ? `#${String(channel.name).replace(/^#/, "")}` : String(channel.id || ""),
      channelId: String(channel.id || ""),
      threadTs,
      text: String(m.text || ""),
      permalink,
      // Free: the match already carries its attachments, and this is the only
      // moment anything in the system sees them. Nothing else here has a token
      // with `search:read`, and the chat has no other way to learn that the
      // message it is showing had a screen recording under it.
      files: slack.filesOf(m),
    });
  }

  // Oldest first — the skill walks in ascending ts order and dispatches the
  // first actionable one, so the order it receives them in is load-bearing.
  kept.sort((a, b) => tsNum(a.ts) - tsNum(b.ts));

  if (!kept.length) {
    return finish(EXIT_IDLE, "idle", { scanned: matches.length, watermark: lastTs });
  }

  // --- which of these actually need a session? -----------------------------
  const results = await askDashboard(kept);
  const verdict = new Map((results || []).map((r) => [String(r.ts), r]));
  const work = [];
  const absorbed = [];
  for (const m of kept) {
    const v = verdict.get(m.ts);
    // No answer at all (dashboard closed) leaves `v` undefined, and undefined
    // means keep — the safe direction.
    if (v && v.settled && !v.created) absorbed.push({ ...m, chat: v.runId });
    else work.push(m);
  }

  if (DEBUG) {
    console.error(`query: ${query}`);
    console.error(
      `matched ${matches.length}, kept ${kept.length}, absorbed ${absorbed.length}, needs a session ${work.length} (watermark ${lastTs})`
    );
    if (!results) console.error("  dashboard did not answer — keeping everything");
    for (const m of absorbed) console.error(`  – ${m.ts}  ${m.who}  filed into ${m.chat}: ${m.text.slice(0, 60)}`);
    for (const m of work) console.error(`  > ${m.ts}  ${m.who}  ${m.channel}  ${m.text.slice(0, 60)}`);
  }

  bank(absorbed, { advance: !work.length });
  const banked = absorbed.map((m) => ({ ts: m.ts, who: m.who, chat: m.chat }));

  if (!work.length) {
    const n = absorbed.length;
    return finish(EXIT_IDLE, n ? `${n} follow-up${n === 1 ? "" : "s"} filed, no session needed` : "idle", {
      scanned: matches.length,
      watermark: lastTs,
      absorbed: banked,
    });
  }

  return finish(EXIT_WORK, `${work.length} new mention${work.length === 1 ? "" : "s"}`, {
    mentions: work,
    scanned: matches.length,
    watermark: lastTs,
    absorbed: banked,
  });
}

main().catch((err) => {
  // Loud, not silent: a crashed probe means nothing is watching Slack.
  finish(EXIT_BROKEN, `probe crashed (${String(err.message || err).slice(0, 120)})`);
});
