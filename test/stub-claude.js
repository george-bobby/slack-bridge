#!/usr/bin/env node
/**
 * A fake `claude` for the harness tests. Speaks enough of the stream-json
 * protocol for lib/jobs.js and does what the brief tells it to, via
 * `stub:` directives, so every watcher outcome can be forced for free:
 *
 *   stub:report=<status>      write report.md with that status, then end the turn
 *   stub:question=<text>      (with report) add an open question
 *   stub:action=<text>        (with report) add an action request
 *   stub:noreport             end the turn without a report
 *   stub:report-on-nudge      write a ready-for-review report when nudged
 *   stub:stall=<seconds>      open a Bash call, go silent, then end
 *   stub:limit                end with a usage-limit error
 *   stub:exit                 die without a result
 *   stub:ask                  ask a permission question and wait for the answer
 *
 * Follow-up turns: an "[harness] <name> answered" message writes a
 * ready-for-review report; anything else repeats the brief's directives.
 * Every argv is appended to $STUB_LOG, so tests can check the flags.
 */

const fs = require("fs");

if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { SB_ROLE: process.env.SB_ROLE, SB_TASK_ID: process.env.SB_TASK_ID, SB_GUARD: process.env.SB_GUARD } }) + "\n");

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let waitingAnswer = null;

function directives(text) {
  const d = {};
  for (const m of String(text).matchAll(/stub:([a-z-]+)(?:=([^\n]*))?/g)) {
    if (d[m[1]] === undefined) d[m[1]] = m[2] === undefined ? true : m[2].trim();
    else d[m[1]] = [].concat(d[m[1]], m[2] === undefined ? true : m[2].trim());
  }
  return d;
}

function briefText(prompt) {
  const m = /Read (\S+brief\.md)/.exec(prompt);
  if (m) {
    try {
      return fs.readFileSync(m[1], "utf8");
    } catch {}
  }
  const report = process.env.SB_REPORT;
  if (report) {
    try {
      return fs.readFileSync(report.replace(/report\.md$/, "brief.md"), "utf8");
    } catch {}
  }
  return "";
}

function writeReport(status, d = {}) {
  const q = [].concat(d.question || []).filter((x) => x !== true);
  const a = [].concat(d.action || []).filter((x) => x !== true);
  const text = `---
status: ${status}
branch: stub-branch
---
## TL;DR
Stub worker finished with ${status}.

## Summary
Did the stub thing.

## Changes
- none

## Verification
- ran nothing (stub)

## Open questions
${q.length ? q.map((x) => `- ${x}`).join("\n") : "None"}

## Action requests
${a.length ? a.map((x) => `- ${x}`).join("\n") : "None"}

## Proposed commit/PR text
stub
`;
  fs.writeFileSync(process.env.SB_REPORT, text);
}

const say = (text) => out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const done = (text, extra = {}) => out({ type: "result", subtype: "success", result: text, total_cost_usd: 0, duration_ms: 5, num_turns: 1, usage: {}, ...extra });

async function turn(prompt) {
  out({ type: "system", subtype: "init", session_id: "stub" });
  if (/^\[harness\] (\S+ answered|\S+ approved|You were interrupted)/.test(prompt)) {
    writeReport("ready-for-review");
    say("Applied the answer.");
    return done("ok");
  }
  const d = directives(prompt.startsWith("[harness] You ended your turn") ? "" : briefText(prompt) + "\n" + prompt);
  if (/^\[harness\] You ended your turn/.test(prompt)) {
    const b = directives(briefText(prompt));
    if (b["report-on-nudge"]) writeReport("ready-for-review");
    say("Nudged.");
    return done("ok");
  }
  if (d.exit) process.exit(1);
  if (d.limit) {
    say("You've hit your usage limit. Resets at 5pm.");
    return done("You've hit your usage limit", { subtype: "error_during_execution" });
  }
  if (d.stall) {
    out({ type: "stream_event", event: { type: "message_start" } });
    out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "Bash" } } });
    await sleep(Number(d.stall) * 1000);
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } });
  }
  if (d.ask) {
    out({ type: "control_request", request_id: "rq1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "git push --force" }, tool_use_id: "tu-ask" } });
    const answer = await new Promise((r) => (waitingAnswer = r));
    say(`answer: ${answer.behavior}`);
  }
  if (d.report) writeReport(d.report, d);
  say("Stub turn done.");
  return done("stub done");
}

let buf = "";
let busy = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type === "control_response" && waitingAnswer) {
      const r = waitingAnswer;
      waitingAnswer = null;
      r(m.response.response);
    } else if (m.type === "user") {
      const content = typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content);
      busy = busy.then(() => turn(content));
    }
  }
});
process.stdin.on("end", () => busy.then(() => process.exit(0)));
