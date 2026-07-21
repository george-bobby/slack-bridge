#!/usr/bin/env bash
#
# One headless tick of the poller: `claude -p /scan-mentions`.
#
# This is the poller. launchd calls it every SLACK_BRIDGE_INTERVAL seconds;
# see scripts/launchd.plist.template. The dashboard's "Poll now" button calls
# the same script (so it takes the same lock) — nothing else should.
#
# Verified: the claude.ai Slack + Linear connectors DO load under a stripped
# launchd-style environment (`env -i`), and a real
# slack_search_public_and_private call returns results. Two things make that
# work, and both are handled below:
#   1. PATH — launchd gives you /usr/bin:/bin:/usr/sbin:/sbin and nothing else.
#      claude typically lives in ~/.local/bin; uvx (which mcp-modal is spawned
#      through) in /opt/homebrew/bin. Without those, mcp-modal fails to connect
#      and the pipeline loses its Modal logs. Set EXTRA_PATH in .env if yours
#      live somewhere else.
#   2. The login keychain must be unlocked — i.e. you are logged in to the
#      Mac. This runs as a LaunchAgent (Aqua session), not a LaunchDaemon,
#      for exactly that reason.
#
# Run it by hand any time to test:  ./scripts/run-once.sh

set -uo pipefail

# This script lives in scripts/; everything it reads and writes is relative to
# the project root one level up. Resolved from BASH_SOURCE rather than $PWD so
# launchd (which starts it from WorkingDirectory) and a hand-run from anywhere
# agree.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Machine-specific settings live in .env (gitignored). `set -a` exports every
# assignment so the values reach `claude` and its MCP servers too. Anything
# already in the environment — the plist, or a shell that set it — wins, which
# is why the file is sourced into a subshell-free `if` rather than blindly.
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

export PATH="${EXTRA_PATH:-$HOME/.local/bin:/opt/homebrew/bin}:/usr/bin:/bin:/usr/sbin:/sbin"

# launchd leaves this at the default; the dashboard's "Poll now" sets
# "dashboard". Either way the tick came through this script, so it holds the
# lock below and cannot race the job. Only a hand-run `claude -p
# /scan-mentions` can — that one reports itself as "manual" and the dashboard
# raises a warning.
export SLACK_BRIDGE_RUNNER="${SLACK_BRIDGE_RUNNER:-cron}"

CONFIG="$ROOT/data/config.json"
LOG="$ROOT/logs/cron.log"
LOCK="$ROOT/data/.run.lock"
COST="$ROOT/data/cost.json"

mkdir -p "$ROOT/logs" "$ROOT/data"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

# --- config.json first, then the plist environment, then .env ---------------
# The dashboard's Settings drawer writes config.json, and it would be a lying
# control panel if the plist's baked-in environment silently outranked it. The
# one setting config.json cannot change on its own is the *cadence*: launchd
# owns when this script fires (StartInterval), so intervalSec here only tells
# the dashboard what to expect. `./install.sh start` re-stamps the plist from
# config.json — that is what the drawer's "Apply cadence" button runs.
#
# One node call, five lines out: a per-key helper would pay node's ~30ms
# startup five times per tick for nothing. An absent key prints __UNSET__, so a
# deliberately empty activeHours ("never mind the window") stays
# distinguishable from "not configured, fall back to the plist".
#
# Read with a `while read` loop, NOT `mapfile`/`readarray`: those are bash 4
# builtins and macOS ships bash 3.2 as /bin/bash. launchd's PATH has no
# homebrew in it, so `#!/usr/bin/env bash` resolves to 3.2 and mapfile fails
# with "command not found" — which left _cfg empty, every setting silently
# falling back to the plist, and config.json (the thing the dashboard writes)
# doing nothing at all. Keep this loop 3.2-compatible.
_cfg_raw="$(node -e '
  const fs = require("fs");
  let c = {};
  try { c = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
  const p = c.poller || {};
  const get = (k) => (p[k] === undefined || p[k] === null ? "__UNSET__" : String(p[k]));
  // mode: off | watch | auto. Configs written before watch mode existed only
  // have the boolean, so derive it.
  const mode = c.mode || (c.enabled === false ? "off" : "auto");
  process.stdout.write(
    [get("intervalSec"), get("activeHours"), get("activeDays"), get("scanModel"), mode].join("\n") + "\n"
  );
' "$CONFIG" 2>/dev/null)"

# A herestring feeds the loop in the *current* shell (a pipe would subshell it
# and throw the array away). Only parse when node actually produced something:
# on an empty string the herestring still yields one empty line, which would
# read as a configured-but-blank intervalSec rather than "not configured".
_cfg=()
if [[ -n "$_cfg_raw" ]]; then
  _i=0
  while IFS= read -r _line; do
    _cfg[$_i]="$_line"
    _i=$((_i + 1))
  done <<<"$_cfg_raw"
fi

_interval="${_cfg[0]-__UNSET__}"; _hours="${_cfg[1]-__UNSET__}"
_days="${_cfg[2]-__UNSET__}";     _model="${_cfg[3]-__UNSET__}"
_mode="${_cfg[4]:-auto}"

# Three fallbacks deep, narrowest first: what the dashboard wrote, then what
# the plist baked in, then .env. The `-` (not `:-`) on hours is deliberate — an
# explicitly empty window means "poll around the clock" and must survive.
[[ "$_interval" == "__UNSET__" ]] && _interval="${SLACK_BRIDGE_INTERVAL:-${POLL_INTERVAL_SEC:-300}}"
[[ "$_hours"    == "__UNSET__" ]] && _hours="${SLACK_BRIDGE_ACTIVE_HOURS-${POLL_ACTIVE_HOURS-08-20}}"
[[ "$_days"     == "__UNSET__" ]] && _days="${SLACK_BRIDGE_ACTIVE_DAYS:-${POLL_ACTIVE_DAYS:-12345}}"
[[ "$_model"    == "__UNSET__" ]] && _model="${SLACK_BRIDGE_SCAN_MODEL:-${SCAN_MODEL:-haiku}}"

export SLACK_BRIDGE_INTERVAL="$_interval"

# off    nothing runs — the gate below exits before a session starts, $0.
# watch  the scan runs and files every mention into the dashboard inbox, but
#        never dispatches the pipeline; you press Start on the ones you want.
#        Costs a tick, buys you the list.
# auto   scan, triage, and dispatch the oldest actionable one.
export SLACK_BRIDGE_MODE="$_mode"

# Starting a session costs money whether or not it finds anything: fresh
# process, no cache reuse between runs. Measured here, a tick that found
# nothing still ran a median $0.094 on haiku — ~$27/day at 300s. That is what
# gate 3 (probe.js) exists to avoid; it answers "is there anything at all?"
# over plain HTTP for $0, and nothing below it runs unless the answer is yes.
# Triage is easy classification work, so the scan runs on haiku and the
# *pipeline* is escalated back to opus by /scan-mentions when it dispatches.
export SLACK_BRIDGE_SCAN_MODEL="$_model"

# Outside these hours (local, 24h) nothing polls. ACTIVE_DAYS is the days to
# poll on (1=Mon .. 7=Sun). An empty ACTIVE_HOURS disables the window.
ACTIVE_HOURS="$_hours"
ACTIVE_DAYS="$_days"

# --- Free gates: everything here decides "don't spend anything" without ----
# --- starting a session. Each one saves a full tick's cost. ---------------

# 1. Master switch. Pausing used to still cost a full session per tick; now
#    paused is genuinely free. Watch mode deliberately does NOT stop here —
#    it is the mode where you want the mention list without the autopilot.
if [[ "$_mode" == "off" ]]; then
  exit 0
fi

# 2. Working-hours window. Mentions outside it are picked up by the first tick
#    after the window opens — the watermark means nothing is lost, only
#    delayed. A dashboard "Poll now" sets FORCE and ignores the window: you
#    are sitting right there, so the whole point of the gate is moot.
if [[ -n "$ACTIVE_HOURS" && "${SLACK_BRIDGE_FORCE:-0}" != "1" ]]; then
  hour=$(date +%H); day=$(date +%u)
  start="${ACTIVE_HOURS%%-*}"; end="${ACTIVE_HOURS##*-}"
  if [[ "$ACTIVE_DAYS" != *"$day"* ]] || (( 10#$hour < 10#$start || 10#$hour >= 10#$end )); then
    exit 0
  fi
fi

# --- Single-flight ---------------------------------------------------------
# A tick that dispatches the pipeline blocks for 15-25 min waiting on Codex,
# while launchd keeps firing every 60s. Without this lock those overlapping
# runs would race on state.json and double-process the same mention.
# mkdir is atomic on every filesystem we care about; a PID file inside it lets
# us reclaim the lock if a run was killed (reboot, crash) without releasing.
if ! mkdir "$LOCK" 2>/dev/null; then
  prev="$(cat "$LOCK/pid" 2>/dev/null || echo "")"
  if [[ -n "$prev" ]] && kill -0 "$prev" 2>/dev/null; then
    log "skip: run $prev still active"
    exit 0
  fi
  log "reclaiming stale lock (pid ${prev:-unknown} is gone)"
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || { log "skip: lost lock race"; exit 0; }
fi
echo "$$" >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

# 3. The probe: "has anyone mentioned you since the watermark?", asked over
#    plain HTTP with a Slack user token, for $0. This is the gate that decides
#    the tick's cost — a session starts only when it says there is real work.
#    It sits *after* the lock so a tick that's going to be skipped anyway
#    (pipeline still running, 15-25 min) doesn't spend an API call to find out.
#
#    Exit codes, defined in probe.js:
#      0   new mentions, written to data/probe.json — run the session
#      10  nothing to do — skip, $0
#      20  broken (no token, bad auth) — skip too, but log it
#
#    A non-zero code never starts a session. There is no fallback: the probe IS
#    mention detection now, and a broken one means the poller is blind. That
#    shows up as a stale heartbeat on the dashboard (probe.js withholds the
#    heartbeat on 20) plus the log line below — which is what you want, rather
#    than silently reverting to ~$0.09 a tick.
probe_out="$(cd "$ROOT" && node scripts/probe.js 2>>"$LOG")"
probe_status=$?

if [[ "$probe_status" -ne 0 ]]; then
  # 10 is the overwhelmingly common case and is deliberately not logged: at a
  # 60s cadence it fires ~1400x/day and would bury every line that matters.
  # Anything else is a real problem and gets a line.
  [[ "$probe_status" -ne 10 ]] && log "probe broken (exit=$probe_status): $probe_out"
  exit 0
fi

# Hand the session what the probe already found, so /scan-mentions reads a
# local file instead of re-running the search through the MCP connector.
export SLACK_BRIDGE_PREFETCH="$ROOT/data/probe.json"
log "probe: $probe_out"

# --- The tick --------------------------------------------------------------
# --dangerously-skip-permissions is required, not optional: an unattended run
# has nobody to answer a permission prompt, and the pipeline it dispatches
# edits files, runs git/gh and opens PRs. The blast radius is bounded only by
# the skill's own scope rules — read cron.log if a run surprises you.
log "tick start (mode=$_mode interval=${SLACK_BRIDGE_INTERVAL}s model=${SLACK_BRIDGE_SCAN_MODEL})"
out="$(cd "$ROOT" && claude -p "/scan-mentions" \
  --model "$SLACK_BRIDGE_SCAN_MODEL" \
  --dangerously-skip-permissions \
  --output-format json \
  </dev/null 2>&1)"
status=$?

# Bank what the tick actually cost. Guessing at spend is how this gets away
# from you; cost.json is a rolling per-tick ledger the dashboard totals up.
summary="$(node -e '
  const fs = require("fs");
  let cost = 0, result = "";
  try {
    const j = JSON.parse(process.argv[1]);
    cost = j.total_cost_usd || 0;
    result = String(j.result || "").slice(0, 160);
  } catch { result = "(unparsed) " + process.argv[1].slice(-160); }
  const file = process.argv[2];
  let led = [];
  try { led = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  led.unshift({ ts: Math.floor(Date.now() / 1000), cost });
  // ~1 month of ticks at the default cadence; the dashboard only sums today.
  fs.writeFileSync(file, JSON.stringify(led.slice(0, 10000)));
  console.log("$" + cost.toFixed(4) + " :: " + result.replace(/\s+/g, " "));
' "$out" "$COST" 2>/dev/null)" || summary="ledger write failed"
log "tick end (exit=$status): $summary"

# Keep the log from growing without bound.
if [[ -f "$LOG" ]] && [[ "$(wc -l <"$LOG")" -gt 2000 ]]; then
  tail -n 800 "$LOG" >"$LOG.trim" && mv "$LOG.trim" "$LOG"
fi

exit "$status"
