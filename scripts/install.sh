#!/usr/bin/env bash
#
# Set the project up on this machine.
#
#   1. Render templates/ into .claude/ with your .env baked in. The skill is
#      read by a Claude session, which cannot see environment variables, so the
#      repo path, Slack id and Linear parameters must be substituted in first.
#   2. Symlink the rendered skill into ~/.claude so `/slack-fetch-pipeline
#      <slack-url>` works from any Claude Code session — in particular one
#      rooted at TARGET_REPO, where the pipeline actually does its work.
#   3. Optionally run the dashboard under launchd, so it is always there to
#      paste a Slack link into.
#
# Nothing here watches Slack or runs on a timer. Every run is one you start.
#
#   ./scripts/install.sh            render + create/refresh the symlink
#   ./scripts/install.sh render     render only (after editing .env or templates/)
#   ./scripts/install.sh start      render + link + start the dashboard under launchd
#   ./scripts/install.sh stop       stop the dashboard (the symlink stays)
#   ./scripts/install.sh uninstall  remove the symlink (project files are left alone)

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
DASH_LABEL="$LABEL.dashboard"
DASH_PLIST_SRC="$SCRIPTS/dashboard.plist.template"
DASH_PLIST_DST="$HOME/Library/LaunchAgents/$DASH_LABEL.plist"
PORT="${SLACK_BRIDGE_PORT:-4319}"

# Earlier versions installed a launchd poller under the bare label and a
# /scan-mentions command. Both are gone; clear them out if they're still here.
OLD_POLLER_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
OLD_CMD_DST="$HOME/.claude/commands/scan-mentions.md"

SKILL_SRC="$PROJ/.claude/skills/slack-fetch-pipeline"
SKILL_DST="$HOME/.claude/skills/slack-fetch-pipeline"

# `launchctl bootout` returns before the job is actually gone — if it's busy
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
  for _ in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$UID" "$plist" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "error: could not bootstrap $label" >&2
  launchctl bootstrap "gui/$UID" "$plist"  # run once more, unmuted, for the real message
}

remove_old_poller() {
  if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 || [[ -f "$OLD_POLLER_PLIST" ]]; then
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
    rm -f "$OLD_POLLER_PLIST"
    echo "removed the old launchd poller ($LABEL)"
  fi
  if [[ -L "$OLD_CMD_DST" ]]; then
    rm "$OLD_CMD_DST"
    echo "unlinked the old $OLD_CMD_DST"
  fi
  return 0
}

# --- render templates/ -> .claude/ -----------------------------------------
# Always run before anything that reads .claude/, so an edited .env can never
# leave a stale prompt pointing at the previous repo.
render() {
  echo "rendering templates with $PROJ/.env:"
  node "$PROJ/lib/render.js"
}

link() {
  render
  [[ -e "$SKILL_SRC" ]] || { echo "error: missing $SKILL_SRC — did the render step fail?" >&2; exit 1; }
  mkdir -p "$HOME/.claude/skills"
  # Refuse to clobber a real directory that isn't our link.
  if [[ -e "$SKILL_DST" && ! -L "$SKILL_DST" ]]; then
    echo "error: $SKILL_DST exists and is not a symlink — move it aside first." >&2
    exit 1
  fi
  ln -sfn "$SKILL_SRC" "$SKILL_DST"
  chmod +x "$SCRIPTS/emit.sh"
  echo "linked $SKILL_DST -> $SKILL_SRC"
}

dashboard_start() {
  [[ -f "$DASH_PLIST_SRC" ]] || { echo "error: missing $DASH_PLIST_SRC" >&2; exit 1; }
  mkdir -p "$HOME/Library/LaunchAgents" "$PROJ/logs"

  # launchd runs jobs with a near-empty PATH, so resolve node here. Follow the
  # symlink: version-manager shims can disappear on a switch, and a dead
  # ProgramArguments[0] just makes launchd fail the job silently.
  NODE_BIN="$(command -v node || true)"
  [[ -n "$NODE_BIN" ]] || { echo "error: node not found in PATH" >&2; exit 1; }
  NODE_BIN="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")"

  # Stop the old dashboard job BEFORE freeing the port — under KeepAlive it
  # would just respawn onto the port we're about to clear.
  bootout_wait "$DASH_LABEL"

  # Anything still holding the port — typically a `node index.js` you started
  # by hand — would make the new job crash-loop against EADDRINUSE under
  # KeepAlive. Hand the port over instead.
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

case "${1:-}" in
  render)
    render
    ;;
  start)
    remove_old_poller
    link
    dashboard_start
    echo
    if [[ "${DASH_UP:-}" == "1" ]]; then
      echo "dashboard on http://localhost:$PORT — paste a Slack thread link to start a run."
    else
      echo "loaded $DASH_LABEL — but nothing is answering on port $PORT yet."
      echo "  check:  tail $PROJ/logs/dashboard.err.log"
    fi
    echo "  logs:   $PROJ/logs/dashboard.{out,err}.log"
    echo "  stop:   ./scripts/install.sh stop"
    echo "Or from any Claude Code session: /slack-fetch-pipeline <slack-thread-url>"
    ;;
  stop)
    dashboard_stop
    remove_old_poller
    echo "dashboard stopped."
    ;;
  uninstall)
    # Only remove it if it's a symlink — never delete a real directory.
    [[ -L "$SKILL_DST" ]] && rm "$SKILL_DST" && echo "unlinked $SKILL_DST"
    remove_old_poller
    echo "done — project files untouched at $PROJ"
    ;;
  "")
    remove_old_poller
    link
    echo
    echo "next:"
    echo "  ./scripts/install.sh start   # the dashboard, on http://localhost:$PORT"
    echo "  or in any Claude Code session: /slack-fetch-pipeline <slack-thread-url>"
    ;;
  *)
    echo "error: unknown command '$1'" >&2
    echo "usage: ./scripts/install.sh [render|start|stop|uninstall]" >&2
    exit 2
    ;;
esac
