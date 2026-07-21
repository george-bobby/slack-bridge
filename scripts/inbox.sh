#!/usr/bin/env bash
#
# inbox.sh — file the mentions a poll found into the dashboard inbox.
#
#   echo '{"mentions":[ … ]}' | inbox.sh
#
# Each mention: { "runId": "<thread ts>", "ts": "<slack ts>", "who": "…",
#                 "userId": "U…", "channel": "#…", "channelId": "C…",
#                 "threadTs": "…", "text": "…", "permalink": "…",
#                 "triage": "actionable" | "skip", "triageReason": "…" }
#
# `runId` is the **thread** ts, not the message ts: one thread is one chat.
# `ts` stays the message's own, and is how a re-post of the same mention is
# recognised as a no-op rather than filed twice.
#
# Everything the search returned goes here, actionable or not — the inbox is
# the list of "things that mentioned you", and the triage verdict is a column
# in it, not a filter on it. A mention already worked is never downgraded;
# re-posting the same one on a later tick is a no-op.
#
# Prints the dashboard's reply on stdout — one `results` entry per mention:
#   { "ts", "runId", "created", "appended", "worked", "settled" }
# `worked: true` means a pipeline or job has actually run against that thread —
# a follow-up in an existing conversation rather than a new request, so
# /scan-mentions does not dispatch a second pipeline at it. `settled` is the
# weaker "already decided" (worked, or triaged out) that probe.js uses to skip
# starting a session at all.
#
# BEST EFFORT, ALWAYS: exits 0 whether or not the dashboard is listening, never
# blocks longer than 3s. A dashboard that is closed prints nothing, and the
# caller must treat that as "no information", never as "nothing was filed".

# The dashboard's port lives in .env, so this and index.js agree without
# either one hard-coding it. Already-set wins, as everywhere else.
_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${SLACK_BRIDGE_PORT:-}" ] && [ -f "$_ROOT/.env" ]; then
  SLACK_BRIDGE_PORT="$(sed -n 's/^[[:space:]]*SLACK_BRIDGE_PORT[[:space:]]*=[[:space:]]*//p' "$_ROOT/.env" | tail -n 1 | tr -d '"'"'"' \t\r')"
fi
export SLACK_BRIDGE_PORT

node -e '
  const http = require("http");
  let payload = "";
  process.stdin.on("data", (c) => (payload += c));
  process.stdin.on("end", () => {
    if (!payload.trim()) process.exit(0);
    try { JSON.parse(payload); } catch { process.exit(0); }  // never post junk
    const req = http.request(
      {
        host: "127.0.0.1",
        port: Number(process.env.SLACK_BRIDGE_PORT) || 4319,
        path: "/api/mentions",
        method: "POST",
        timeout: 3000,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        // Relayed so the caller can see where each mention landed. Anything
        // that is not a clean JSON body is swallowed — this is a side channel,
        // not a contract the tick may fail on.
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          try {
            JSON.parse(out);
            process.stdout.write(out);
          } catch {}
        });
      }
    );
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.end(payload);
  });
' 2>/dev/null

exit 0
