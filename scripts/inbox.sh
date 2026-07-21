#!/usr/bin/env bash
#
# inbox.sh — file the mentions a poll found into the dashboard inbox.
#
#   echo '{"mentions":[ … ]}' | inbox.sh
#
# Each mention: { "runId": "<slack ts>", "ts": "<slack ts>", "who": "…",
#                 "userId": "U…", "channel": "#…", "channelId": "C…",
#                 "threadTs": "…", "text": "…", "permalink": "…",
#                 "triage": "actionable" | "skip", "triageReason": "…" }
#
# Everything the search returned goes here, actionable or not — the inbox is
# the list of "things that mentioned you", and the triage verdict is a column
# in it, not a filter on it. A mention already worked is never downgraded;
# re-posting the same one on a later tick is a no-op.
#
# BEST EFFORT, ALWAYS: exits 0 whether or not the dashboard is listening, never
# blocks longer than 3s, prints nothing on success.

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
      (res) => res.resume()
    );
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.end(payload);
  });
' >/dev/null 2>&1

exit 0
