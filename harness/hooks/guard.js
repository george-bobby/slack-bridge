#!/usr/bin/env node
/**
 * PreToolUse guard for every session the harness launches (workers, the
 * pipeline, the orchestrator, and the terminal hand-off).
 *
 * It is loaded per session with `claude --settings <json>` rather than written
 * into ~/.claude/settings.json, so it never touches user-level config and never
 * affects a Claude session the harness didn't start.
 *
 * Three verdicts, chosen by lib/policy.js:
 *
 *   deny   the command can never be right here: a kill by pattern, an env
 *          dump, a process listing that prints argv, reading a .env file.
 *          The reason goes back to the model so it can do the safe version.
 *   ask    allowed only with the user's OK on this exact call: destructive git
 *          and every outward write (Slack posts, Linear edits, PR merges, ...).
 *          Under the dashboard's `--permission-prompt-tool stdio` this becomes
 *          an Allow/Deny card showing the exact payload, even in full-access
 *          mode; in a terminal it is the normal permission prompt.
 *   (none) everything else falls through to the session's own permission mode.
 *
 * Fails open on a malformed hook payload (prints nothing, exits 0): a guard
 * that crashes on input it didn't expect would block every tool call in
 * every session. Its own tests live in test/guard.test.js.
 */

const policy = require("../../lib/policy");

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    process.exit(0);
  }
  const verdict = policy.check(input.tool_name, input.tool_input || {}, { role: process.env.SB_ROLE || "" });
  if (!verdict) process.exit(0);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: verdict.decision,
        permissionDecisionReason: verdict.reason,
      },
    })
  );
  process.exit(0);
});
