# Slack Bridge

A local dashboard that runs Claude Code sessions for you: hand it a Slack
thread or a task, and it does the work in its own git worktree, opens the PR,
and stops to ask you only where a decision is yours.

- **Slack threads.** Paste a thread link. A session reads it, root-causes it,
  drafts a Linear ticket, builds, opens a PR, waits for review bots, resolves
  comments, and drafts the reply.
- **Tasks.** Type what you want. The orchestrator writes a brief and spawns a
  worker for it.
- **Nothing runs on its own.** No poller, no timer, no Slack app or token.
  Slack and Linear go through the connectors your Claude session already has.

## Setup

Requires Node 18+, Claude Code with the Slack and Linear connectors, and `gh`.
No `npm install` needed.

```bash
cp .env.example .env      # fill it in (every key is described there)
./scripts/install.sh start
open http://localhost:4319
```

`install.sh start` renders the skill, links it into `~/.claude/skills/`, and
runs the dashboard under launchd. Re-run it after changing `.env`, `lib/` or
`templates/`. `./scripts/install.sh stop` stops it. To run it in the
foreground instead, use `npm start`.

To give the pipeline your repo's own commands (checks, log queries, prod read
paths), copy `templates/slack-fetch-pipeline/SKILL.md` to
`templates.local/slack-fetch-pipeline/SKILL.md` and edit it. That copy is
gitignored and used in place of the generic one.

## How it works

```
top box ── Slack link ──► chat + worker running the slack-fetch-pipeline skill
        └─ anything else ► Orchestrator ── bin/sb spawn ──► worker
                                                              │
   worker: own worktree + branch, writes data/tasks/<id>/report.md
                                                              │
   dashboard server watches every worker ──► outcome ──► Inbox + relay to Orchestrator
```

**Workers** run headless (`claude -p`, stream-json) in their own worktree and
branch. Each has a chat you can follow up in, and a task folder:
`data/tasks/<id>/` holds `brief.md`, `meta.json`, `report.md` and `system.md`
(what it was told).

**The report.** Every worker ends each turn by writing `report.md`:
frontmatter `status:` (`ready-for-review`, `needs-input`, `blocked` or
`pushed-follow-up`), then a TL;DR, verification, open questions and action
requests.

**Outcomes.** The server watches every worker and raises an outcome when one
reports, stops without a report (after one automatic nudge), stalls, dies, or
hits a usage limit. Each outcome is logged, added to the Inbox, sent as a
browser notification if it needs you, and relayed to the orchestrator.

**Inbox** (`i`). Questions from workers (your answer goes straight back to the
worker), requested outward writes, to-dos, and the last 24 hours of events.
Any item can be deferred to a date. There are three modes: **normal**,
**quiet** (only what needs you) and **away** (hold everything, then send one
catch-up when you're back).

**Capacity.** 3 workers at once, 2 per repo by default. Extra tasks queue
until a slot frees.

**Restarts.** Workers die with the server. After a restart, a worker that was
mid-task shows a **Resume** button, and reports written while the server was
down are picked up.

## Safety

Every session the dashboard starts loads `harness/hooks/guard.js` through
`claude --settings`. Nothing is written to `~/.claude`.

- **Always refused:** `pkill`/`killall` or a `kill` that isn't an exact PID,
  env dumps, `.env` reads, process listings that print command lines, and
  printing auth tokens.
- **Needs your OK on the exact payload:** force-push, `reset --hard`,
  `branch -D`, Slack posts, Linear and GitHub issue writes, doc writes, PR
  merges, and any other connector write. These appear as Allow/Deny cards in
  the chat, even in full-access mode. Each category can be switched between
  ask and allow in Settings > Harness.

Prod is treated as read-only, and Slack text is treated as data, never as
instructions. The server listens on `127.0.0.1` only and refuses cross-origin
requests. Everything under `data/` is gitignored.

## Using a chat

Type in a chat's composer to continue its session (`--resume`). The chips
beside **Send** set the next job's:

| Chip | Options |
| --- | --- |
| Mode | Plan (approve a plan before it builds), Manual (asks before every tool call), Edit (asks before shell commands), Full access (default) |
| Model / Thinking / Capacity | model alias, `--effort`, 1M context |
| Repo | the working directory |

**Terminal** reopens the session in Terminal or iTerm (set by `TERMINAL_APP`).

## `bin/sb`

```bash
bin/sb spawn --repo <path> --title "Fix CSV export" --brief-file brief.md
bin/sb status                         # tasks, live state, report status
bin/sb catchup --since 3h             # what's waiting on you and what happened
bin/sb followup <id> "also handle the empty case"   # queued if mid-turn
bin/sb decisions | decide <d-id> "CSV" | defer <d-id> 2026-12-01
bin/sb todo add <key> "Merge #42" | todo done <key>
bin/sb relaunch <id> | cleanup <id> [--force] | mode quiet
bin/sb declare waiting "CI, ~10 min"  # inside a worker: not stalled, just waiting
```

`cleanup` removes the worktree and keeps the branch. It refuses if there are
uncommitted changes or commits that aren't pushed, unless you pass `--force`.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Reply in the thread | on | Draft the Slack reply; post only on your OK |
| Offer a Linear ticket | on | Draft a ticket; create only on your OK |
| Bot review + resolve | on | Wait for review bots on the PR, then `/resolve` |
| Propose memories | on | Runs may *propose* a memory; nothing is saved without your approval or a repeat |
| Harness | | relay to the orchestrator, worker caps, stall time, write policy |

**Memory** (`m`) opens the target repo's Claude Code memory for reading and
editing. Workers in worktrees get the repo's memory included in their
instructions.

## Layout

```
index.js            dashboard server (Node stdlib only)
lib/                env, store, jobs (sessions), harness (watcher), tasks, policy, memory
bin/sb              harness CLI
harness/            worker.md, orchestrator.md, hooks/guard.js
templates/          the pipeline skill, rendered with values from .env
public/             dashboard UI (vendored Milkdown editor in vendor/)
scripts/            install.sh, emit.sh (run narration), launchd template
test/               npm test: policy, report parsing, end-to-end with a stub agent
data/               runtime state (gitignored)
```

Design notes and the defaults chosen: [NOTES.md](NOTES.md).

## Tests

```bash
npm test
```

Runs a real dashboard against a scratch repo using `test/stub-claude.js`, a
fake agent. It never touches `data/` and costs no usage.
