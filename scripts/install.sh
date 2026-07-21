#!/usr/bin/env bash
#
# Set the project up on this machine.
#
# Two jobs, in this order:
#   1. Render templates/ into .claude/ with your .env baked in. The prompts are
#      read by a Claude session, which cannot see environment variables, so the
#      Slack ids, repo path and Linear parameters must be substituted in first.
#   2. Symlink the rendered command + skill into ~/.claude so they're invocable
#      from any Claude Code session — in particular one rooted at TARGET_REPO,
#      where the pipeline actually does its work.
#
# The templates always live here in the project; ~/.claude only gets pointers.
# Skip the symlinks entirely if you only ever run Claude Code from this folder:
# the project-local .claude/ directory is auto-discovered in that case.
#
#   ./scripts/install.sh            render + create/refresh the symlinks
#   ./scripts/install.sh render     render only (after editing .env or templates/)
#   ./scripts/install.sh uninstall  remove the symlinks (project files are left alone)
#   ./scripts/install.sh start      start the poller + dashboard under launchd
#   ./scripts/install.sh stop       stop them both (symlinks stay)
#
# And two the dashboard calls, which move the poller without touching the
# dashboard job it is itself running under:
#
#   ./scripts/install.sh poller-start
#   ./scripts/install.sh poller-stop

set -euo pipefail

# This script lives in scripts/; the project it installs is one level up.
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="$PROJ/scripts"

if [[ ! -f "$PROJ/.env" ]]; then
  echo "error: no .env — run: cp .env.example .env && \$EDITOR .env" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. "$PROJ/.env"
set +a

LABEL="${LAUNCHD_LABEL:-local.slack-bridge}"
PLIST_SRC="$SCRIPTS/launchd.plist.template"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

# The dashboard is a second, independent job under a derived label. The poller
# label must keep resolving to exactly one job — index.js greps for it to decide
# whether to draw the "cron installed" chip.
DASH_LABEL="$LABEL.dashboard"
DASH_PLIST_SRC="$SCRIPTS/dashboard.plist.template"
DASH_PLIST_DST="$HOME/Library/LaunchAgents/$DASH_LABEL.plist"
PORT="${SLACK_BRIDGE_PORT:-4319}"

# `launchctl bootout` returns before the job is actually gone — if it's mid-tick
# the teardown outlives the command, and the bootstrap that follows dies with
# "5: Input/output error", leaving NOTHING loaded. Wait for the service to
# really disappear, then bootstrap with a few retries.
bootout_wait() {
  local label="$1"
  launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  for _ in $(seq 1 40); do
    launchctl print "gui/$UID/$label" >/dev/null 2>&1 || break
    sleep 0.25
  done
}

reload_job() {
  local label="$1" plist="$2"
  bootout_wait "$label"
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$UID" "$plist" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "error: could not bootstrap $label" >&2
  launchctl bootstrap "gui/$UID" "$plist"  # run once more, unmuted, for the real message
}

CMD_SRC="$PROJ/.claude/commands/scan-mentions.md"
SKILL_SRC="$PROJ/.claude/skills/slack-fetch-pipeline"
CMD_DST="$HOME/.claude/commands/scan-mentions.md"
SKILL_DST="$HOME/.claude/skills/slack-fetch-pipeline"

# --- render templates/ -> .claude/ -----------------------------------------
# Always run before anything that reads .claude/, so an edited .env can never
# leave a stale prompt pointing at the previous workspace.
render() {
  echo "rendering templates with $PROJ/.env:"
  node "$PROJ/lib/render.js"
}

if [[ "${1:-}" == "render" ]]; then
  render
  exit 0
fi

# --- the poller: launchd runs `claude -p /scan-mentions` on an interval ----
# The poller half is kept separable from the dashboard half on purpose.
#
# The dashboard's Schedule panel toggles the poller by POSTing to /api/cron,
# which runs *this script as a child of the dashboard process*. So any path
# that boots out the dashboard job also kills the script running it, part-way
# through, before it can bootstrap the dashboard back — and since `bootout`
# removes the job outright, KeepAlive doesn't return it either. The dashboard
# just stays dead until someone runs `start` from a terminal.
#
# Hence `poller-start` / `poller-stop` below, which the API calls instead. That
# is also the more correct thing to ask for: the dashboard is by definition
# already running when it asks, so it has no business restarting itself.

poller_start() {
  [[ -f "$PLIST_SRC" ]] || { echo "error: missing $PLIST_SRC" >&2; exit 1; }
  render
  chmod +x "$SCRIPTS/run-once.sh" "$SCRIPTS/emit.sh" "$SCRIPTS/inbox.sh"
  mkdir -p "$HOME/Library/LaunchAgents" "$PROJ/logs" "$PROJ/data"

  # Stamp the cadence from data/config.json. run-once.sh reads the other poller
  # settings itself on every tick, but StartInterval is launchd's — the only
  # way the dashboard's cadence field can mean anything is to re-stamp and
  # reload, which is exactly what the Settings drawer's button calls.
  INTERVAL="$(node -e '
    const fs = require("fs");
    let v = Number(process.argv[2]) || 300;
    try { v = Number(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).poller.intervalSec) || v; } catch {}
    process.stdout.write(String(Math.min(86400, Math.max(30, v))));
  ' "$PROJ/data/config.json" "${POLL_INTERVAL_SEC:-300}" 2>/dev/null || echo 300)"

  sed -e "s|__PROJ__|$PROJ|g" \
      -e "s|__LABEL__|$LABEL|g" \
      -e "s|__INTERVAL__|$INTERVAL|g" \
      -e "s|__ACTIVE_HOURS__|${POLL_ACTIVE_HOURS-08-20}|g" \
      -e "s|__ACTIVE_DAYS__|${POLL_ACTIVE_DAYS:-12345}|g" \
      -e "s|__SCAN_MODEL__|${SCAN_MODEL:-haiku}|g" \
      "$PLIST_SRC" >"$PLIST_DST"

  reload_job "$LABEL" "$PLIST_DST"
}

poller_stop() {
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  [[ -f "$PLIST_DST" ]] && rm "$PLIST_DST" && echo "removed $PLIST_DST"
  # Explicit: a missing plist makes the line above return non-zero, and as the
  # last statement of a function `set -e` would read that as the call failing.
  return 0
}

dashboard_start() {
  [[ -f "$DASH_PLIST_SRC" ]] || { echo "error: missing $DASH_PLIST_SRC" >&2; exit 1; }
  mkdir -p "$HOME/Library/LaunchAgents" "$PROJ/logs"

  # launchd runs jobs with a near-empty PATH, so resolve node here. Follow the
  # symlink: ~/.local/bin shims can disappear on a version switch, and a dead
  # ProgramArguments[0] just makes launchd fail the job silently.
  NODE_BIN="$(command -v node || true)"
  [[ -n "$NODE_BIN" ]] || { echo "error: node not found in PATH" >&2; exit 1; }
  NODE_BIN="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")"

  # Stop the old dashboard job BEFORE freeing the port — under KeepAlive it
  # would just respawn onto the port we're about to clear.
  bootout_wait "$DASH_LABEL"

  # Anything still holding the port — typically a `node index.js` you started
  # by hand in a terminal — would make the new job crash-loop against EADDRINUSE
  # under KeepAlive. Hand the port over instead.
  if OLD_PIDS="$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)" && [[ -n "$OLD_PIDS" ]]; then
    echo "port $PORT was held by pid(s) $(echo "$OLD_PIDS" | tr '\n' ' ')— stopping, launchd takes over."
    kill $OLD_PIDS 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      lsof -t -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
      sleep 0.3
    done
    kill -9 $OLD_PIDS 2>/dev/null || true
  fi

  sed -e "s|__PROJ__|$PROJ|g" \
      -e "s|__LABEL__|$LABEL|g" \
      -e "s|__NODE__|$NODE_BIN|g" \
      -e "s|__PORT__|$PORT|g" \
      "$DASH_PLIST_SRC" >"$DASH_PLIST_DST"

  reload_job "$DASH_LABEL" "$DASH_PLIST_DST"

  # KeepAlive means "running" is the steady state, so a port that never opens is
  # a real failure worth surfacing now rather than at first use.
  for _ in $(seq 1 20); do
    curl -fs -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" 2>/dev/null && DASH_UP=1 && break
    sleep 0.5
  done
  return 0
}

dashboard_stop() {
  launchctl bootout "gui/$UID/$DASH_LABEL" 2>/dev/null || true
  [[ -f "$DASH_PLIST_DST" ]] && rm "$DASH_PLIST_DST" && echo "removed $DASH_PLIST_DST"
  return 0
}

# --- both agents: what you run from a terminal ------------------------------
if [[ "${1:-}" == "start" ]]; then
  poller_start
  dashboard_start

  echo
  echo "loaded $LABEL — polling every ${INTERVAL}s, headless."
  echo "  logs:   $PROJ/logs/cron.log"
  echo "  status: launchctl print gui/$UID/$LABEL | head -20"
  echo
  if [[ "${DASH_UP:-}" == "1" ]]; then
    echo "loaded $DASH_LABEL — dashboard on http://localhost:$PORT"
  else
    echo "loaded $DASH_LABEL — but nothing is answering on port $PORT yet."
    echo "  check:  tail $PROJ/logs/dashboard.err.log"
  fi
  echo "  logs:   $PROJ/logs/dashboard.{out,err}.log"
  echo
  echo "Both survive logout and reboot. Stop them with: ./scripts/install.sh stop"
  exit 0
fi

if [[ "${1:-}" == "stop" ]]; then
  dashboard_stop
  poller_stop
  echo "poller and dashboard stopped — nothing is watching Slack now."
  exit 0
fi

# --- poller only: what the dashboard's Schedule panel calls -----------------
# Never touches the dashboard job. See the note above poller_start().
if [[ "${1:-}" == "poller-start" ]]; then
  poller_start
  echo "loaded $LABEL — polling every ${INTERVAL}s. Dashboard untouched."
  exit 0
fi

if [[ "${1:-}" == "poller-stop" ]]; then
  poller_stop
  echo "poller stopped — nothing is watching Slack. Dashboard untouched."
  exit 0
fi

if [[ "${1:-}" == "uninstall" ]]; then
  # Only remove them if they're symlinks — never delete a real file.
  [[ -L "$CMD_DST" ]] && rm "$CMD_DST" && echo "unlinked $CMD_DST"
  [[ -L "$SKILL_DST" ]] && rm "$SKILL_DST" && echo "unlinked $SKILL_DST"
  echo "done — project files untouched at $PROJ"
  exit 0
fi

# No argument means the default install. Anything left here is a typo, and now
# that there are commands worth mistyping, silently re-running the symlink
# install is a worse answer than saying so.
if [[ -n "${1:-}" ]]; then
  echo "error: unknown command '$1'" >&2
  echo "usage: ./scripts/install.sh [render|start|stop|poller-start|poller-stop|uninstall]" >&2
  exit 2
fi

render

for src in "$CMD_SRC" "$SKILL_SRC"; do
  if [[ ! -e "$src" ]]; then
    echo "error: missing $src — did the render step fail?" >&2
    exit 1
  fi
done

mkdir -p "$HOME/.claude/commands" "$HOME/.claude/skills"

# Refuse to clobber a real file that isn't one of our links.
for dst in "$CMD_DST" "$SKILL_DST"; do
  if [[ -e "$dst" && ! -L "$dst" ]]; then
    echo "error: $dst exists and is not a symlink — move it aside first." >&2
    exit 1
  fi
done

ln -sfn "$CMD_SRC" "$CMD_DST"
ln -sfn "$SKILL_SRC" "$SKILL_DST"

echo
echo "linked:"
echo "  $CMD_DST   -> $CMD_SRC"
echo "  $SKILL_DST -> $SKILL_SRC"
echo
echo "next:"
echo "  ./scripts/install.sh start  # starts the poller AND the dashboard under launchd"
echo "                             # dashboard: http://localhost:$PORT"
