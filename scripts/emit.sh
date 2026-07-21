#!/usr/bin/env bash
#
# emit.sh — narrate a pipeline run into its dashboard chat.
#
#   emit.sh <runId> <phase> "<one line>" [key=value ...]
#
#   phase: queued | context | root-cause | verdict | linear | plan | build
#          | verify | pr | review | resolve | sweep | memory | reply | done
#          | error
#   keys:  prUrl, linearUrl, action, who, channel, channelId, userId,
#          permalink, threadTs, message
#   memory: verdict, territory, target, name, title, section, citation,
#           textFile  (a *.md filename inside data/runs/memories/)
#
# Every phase but `plan` carries a one-line summary. `plan` carries the whole
# plan document for work too big to build unattended — multi-line markdown is
# expected there, and the dashboard renders it as such.
#
# `memory` files a *proposal*, not a memory: it lands in data/runs/memories/,
# which no session ever loads, and is promoted into the repo's real memory only
# by a second run proposing the same `territory` or by an approval in the
# dashboard. See lib/proposals.js.
#
# Example:
#   emit.sh 1784560120.179279 verdict "True positive — the row wraps at <900px"
#   emit.sh 1784560120.179279 pr "Opened #4244" prUrl=https://github.com/…/4244
#
# BEST EFFORT, ALWAYS. It exits 0 whether or not the dashboard is listening,
# never blocks longer than 2s, and prints nothing on success. A headless tick
# must not fail, stall, or get chatty because a local UI happens to be closed.

RUN_ID="${1:-}"
PHASE="${2:-step}"
TEXT="${3:-}"
shift 3 2>/dev/null || true

[ -n "$RUN_ID" ] || exit 0

# The dashboard's port lives in .env, so this and index.js agree without
# either one hard-coding it. Already-set wins, as everywhere else.
_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${SLACK_BRIDGE_PORT:-}" ] && [ -f "$_ROOT/.env" ]; then
  SLACK_BRIDGE_PORT="$(sed -n 's/^[[:space:]]*SLACK_BRIDGE_PORT[[:space:]]*=[[:space:]]*//p' "$_ROOT/.env" | tail -n 1 | tr -d '"'"'"' \t\r')"
fi

PORT="${SLACK_BRIDGE_PORT:-4319}" \
RUN_ID="$RUN_ID" PHASE="$PHASE" TEXT="$TEXT" \
node -e '
  const http = require("http");
  const body = { phase: process.env.PHASE, text: process.env.TEXT };
  // Remaining args are key=value; the value keeps every "=" after the first.
  for (const arg of process.argv.slice(1)) {
    const i = arg.indexOf("=");
    if (i > 0) body[arg.slice(0, i)] = arg.slice(i + 1);
  }
  const payload = JSON.stringify(body);
  const req = http.request(
    {
      host: "127.0.0.1",
      port: Number(process.env.PORT) || 4319,
      path: "/api/runs/" + encodeURIComponent(process.env.RUN_ID) + "/event",
      method: "POST",
      timeout: 2000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    },
    (res) => res.resume()
  );
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
  req.end(payload);
' "$@" >/dev/null 2>&1

exit 0
