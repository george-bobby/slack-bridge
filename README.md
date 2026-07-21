# slack-bridge

When you're **@mentioned in Slack**, a local Claude Code session picks it up,
does the work end-to-end (context → root cause → Linear ticket → build → PR →
Codex review → resolve), and replies in the thread — gated by toggles you flip
from a small local dashboard.

There is **no custom Slack app, no bot token, no Socket Mode**. Detection,
replies, and Linear all go through the **claude.ai Slack / Linear MCP
connectors** you already have.

The dashboard is a **chat client for your mentions**. Every mention is a thread
you can scroll back through, and every thread has a composer: type into it and a
real Claude Code session picks the work back up where the pipeline left off.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Slack Bridge    ● live · 2m   ▶ every 300s   $0.11 today  [Watch Auto]  ⚙ │
├───────────────┬──────────────────────────────────┬─────────────────────────┤
│ search        │  Ashley Wong · #team-studio-eng  │  RUN STATUS             │
│ All Needs-you │  ────────────────────────────────│  ✓ Gathering context    │
│ Running Done  │  "can you flatten the edited…"   │  ✓ Root cause           │
│               │    context  Read 14 messages     │  ✓ Verdict              │
│ ▸ Ashley Wong │    verdict  True positive        │  – Linear ticket    off │
│ ▸ Krish P   ● │    pr       Opened #4244         │  ✓ Build            2m  │
│ ▸ Eyal Foni   │  ┌ acted ─ Shipped ────────────┐ │  ◍ Codex review     6m  │
│ ▸ Linear(bot) │  │ Flattened the metadata row… │ │  ··· Resolve threads    │
│               │  └─────────────────────────────┘ │  ··· Reply in Slack     │
│ [Poll now]    │  [ Follow up…             Send ] │  [ Stop this run ]      │
└───────────────┴──────────────────────────────────┴─────────────────────────┘
```

- **Left — every mention, not just the handled ones.** The poller files
  everything it sees, including what it triaged out, with its reason. A mention
  nobody has worked gets a **Start** button.
- **Middle — the conversation.** The Slack message, each stage the pipeline
  reported, the outcome, then your follow-ups and what Claude did about them.
  Thinking and tool calls are kept, folded away.
- **Right — where the run actually is.** ✓ done · ◍ spinning · ··· pending ·
  – off or skipped · ✕ cancelled. A Codex poll runs 5–15 minutes, and this is
  what tells you it is waiting rather than hung.

## Layout — everything lives in this folder

Three top-level directories carry the whole split: **source** at the root,
**your values** in `.env`, **everything mutable** under `data/`.

```
slack-bridge/
├── .env                  YOUR Slack ids, repo path, Linear team   (gitignored)
├── .env.example          every key, documented                    (committed)
├── index.js              dashboard server (Node stdlib only — no npm install)
├── lib/
│   ├── env.js            reads .env; the single source for every tunable
│   ├── render.js         templates/ + .env  →  .claude/
│   ├── store.js          config/state/cost + the per-run chat records
│   ├── jobs.js           spawns follow-ups & manual runs, streams them back
│   └── bus.js            server-sent events (the UI never polls)
├── public/               index.html + app.css + app.js
├── templates/            the prompts, with {{TOKENS}} where your values go
│   ├── scan-mentions.md                  the poller
│   └── slack-fetch-pipeline/SKILL.md     the per-mention workflow
├── .claude/              rendered from templates/ by install.sh  (gitignored)
├── scripts/
│   ├── install.sh        render prompts, symlink into ~/.claude, install cron
│   ├── run-once.sh       one headless tick (the cron runner, single-flighted)
│   ├── emit.sh           a run reports a stage    → POST /api/runs/:id/event
│   ├── inbox.sh          a poll files its mentions → POST /api/mentions
│   └── launchd.plist.template            launchd template for cron mode
├── data/                 everything mutable        (gitignored, bar the example)
│   ├── config.json       toggles + poller settings (dashboard writes, poller reads)
│   ├── config.example.json   its shape, documented     (committed)
│   ├── state.json        watermark + heartbeat     (poller owns)
│   ├── activity.json     rolling log of processed mentions (poller owns)
│   ├── cost.json         per-tick $ ledger         (run-once.sh appends)
│   ├── .run.lock/        the poller's single-flight lock
│   └── runs/<ts>.json    one chat per mention: transcript, stages, follow-ups
└── logs/cron.log         what each tick did        (gitignored)
```

Everything a run writes lands in `data/`, so `.gitignore` needs one rule
(`data/*`, minus the committed example) instead of five that drift apart as
files are added. It also makes the question "is this source or state?"
answerable by looking at the path — which matters because `data/runs/` holds
verbatim Slack message text and full session transcripts.

| piece | role |
|---|---|
| `templates/scan-mentions.md` | one poll: search Slack MCP for new mentions, file them all, triage, dispatch |
| `templates/slack-fetch-pipeline/` | self-contained headless workflow: gather → root-cause → file the Linear ticket → build → verify → PR → Codex review → resolve → reply |
| `index.js` + `lib/` + `public/` | the dashboard: owns the toggle/state files, the chat records, and the jobs you start |

Everything that is specific to *one* Slack workspace, Linear team and repo
lives in `.env` — nothing is hardcoded, and nothing personal is committed. The
prompts under `templates/` carry `{{TOKENS}}` (`{{SLACK_USER_ID}}`,
`{{TARGET_SCOPE}}`, `{{LINEAR_COMMAND}}`, …) because a running Claude session
can't read environment variables: `./scripts/install.sh` substitutes your values in and
writes the result to the gitignored `.claude/`. **Edit `templates/`, never
`.claude/`** — the next render overwrites it.

`data/activity.json` stays the poller's write contract, unchanged. It is mirrored

**into** `data/runs/` on every change, never the other way — so a chat still shows
its outcome and links if the pipeline emitted no stage events at all (an older
poller, a dashboard that was closed, a run that crashed). The stage events are
enrichment; they are never the source of truth for *did this happen*.

## Two switches, not three modes

Automation is two independent questions, and the UI asks them separately:

**Is anything watching Slack?** — Schedule → *Poller tick*. One switch that
writes both halves: it loads/unloads the launchd job **and** parks `config.mode`
at `off`, because launchd deciding to fire and `run-once.sh` deciding to spend
are two different gates and leaving one behind gives you a job that fires every
five minutes forever into an early `exit 0`. Cadence lives next to it, and
saving a new one reloads the job for you — launchd stamps the interval into the
plist at install time, so a cadence you didn't reload was never real.

**Then what?** — the `Watch | Auto` switch in the top bar.

| mode | polls? | dispatches? | costs |
|---|---|---|---|
| **Watch** | yes | **no** | one tick per interval; you press **Start** on what you want |
| **Auto** | yes | yes, the oldest actionable one | ticks + pipeline runs |

`config.mode` still has three values — `off` is what the tick switch writes, and
`run-once.sh` still reads it the same way. It just isn't a third button in the
top bar any more, because "Off" and "stop the tick" were always one intent
wearing two hats.

In Watch mode the poller still triages, and still records *why* it would have
skipped something — you just get the final say. Disagreeing with triage is the
whole point; a skip you can't see is a skip nobody can correct.

## Follow-ups and manual starts

Typing into a chat, or pressing **Start** on an unworked mention, spawns a real
headless session (`claude -p --output-format stream-json`) and streams it into
the transcript.

Session continuity is by minted uuid: the first job in a chat passes
`--session-id <uuid>`, every later one passes `--resume <uuid>`. So follow-up #2
already knows what #1 did, and the expensive context preamble is written exactly
once per chat.

### How a job runs is picked in the composer

The row of chips beside **Send** decides what the next job in *this* chat does.
Each pick is stored on the run, so chats don't share settings; Settings →
*Job defaults* only supplies what a chat starts from, and moving a default still
moves every chat that never overrode that particular option.

| Chip | Becomes | Notes |
| --- | --- | --- |
| **Mode** — Plan | `--permission-mode plan` | Reads and investigates, writes nothing. |
| **Mode** — Edit | `--permission-mode acceptEdits` | Edits files, but **Bash is refused** — no tests, commits or pushes. |
| **Mode** — Full access | `--dangerously-skip-permissions` | The original behaviour, and still the default. |
| **Model** | `--model <alias>` | opus / sonnet / haiku / fable. |
| **Thinking** | `--effort <level>` | *Auto* passes no flag at all. |
| **Capacity** | `--model <alias>[1m]` | The 1M-context variant of whichever model is picked. |
| **Repo** | the session's `cwd` | Chosen with a filesystem picker (`GET /api/dirs`), since a browser can't hand back an absolute path. |

> `--dangerously-skip-permissions` **outranks** `--permission-mode`: pass both and
> a "plan mode" session will happily edit files. So the two are mutually
> exclusive in `permissionArgs()`, and the narrowed modes never get the skip flag.

The narrowed modes are genuinely narrow *because* the run is headless — a
permission prompt nobody can answer is a denied tool — so the chosen mode is also
restated in the prompt, on every turn, rather than only in the opening preamble.

> **Full access runs with `--dangerously-skip-permissions`, exactly like a poller
> tick.** It edits files, pushes commits and can post to Slack; there is nobody
> to answer a prompt. That is why the server binds loopback only and refuses
> cross-origin mutations.

The pipeline **embodies the concepts of `/fetch` and `/root` rather than invoking
them** — both assume a human to steer (plan mode, "wait for my steer", "draft a
reply for me to send"), which hangs or under-delivers in a headless run.

From **`/root`** it takes the diagnostic half:

- **A true/false-positive verdict before any code is written.** A Slack bug
  report isn't proof of a bug. The pipeline traces the real code path, checks
  recent merged PRs as regression suspects, and confirms or refutes the claim
  against **read-only** prod data. A false positive ends in an explanation, not
  a PR — that's a success, not a failure.
- **Screenshots as primary evidence** — they routinely contradict the prose.
- **Plain-language root cause** in the reply, written for a non-engineer.
- **Hard guardrail: prod is read-only.** SELECT only, `LIMIT`, no PII in output.
  Fixes ship as a PR, never as a direct prod change. This matters more here than
  in `/root`, because nobody is watching.

From **`/fetch`** it takes the delivery half, and it's written to **run to
completion**: once it opens a PR it requests the Codex review, **polls until the
review lands** (~5–15 min), runs `/resolve` on every thread, and only then
replies. It never stops at PR-open.

It also keeps `/fetch`'s **plan-mode escape hatch**, which is the one place the
headless constraint forces a real redesign rather than a straight port. `/fetch`
flips into plan mode when a request is too big to start coding blind; plan mode
itself waits for an approval nobody is present to give, so here the **plan
replaces the mode**. Work that trips the same trigger — schema migration, auth
surface, spans services, ambiguous intent — is *not* built. The run writes the
plan it would have asked you to approve, including the open questions
`AskUserQuestion` would have raised and its own recommended answer to each,
saves it to `data/runs/plans/<runId>.md`, and emits it as the `plan` stage. The Slack
thread gets one plain-language line; the plan itself is **dashboard-only**. A
sharp plan and no code is the success case for a big ask, not a bail-out — and
the ticket still gets filed, because a plan living only in a run chat is exactly
the untracked work a ticket exists to prevent.

## How it works

```
launchd → run-once.sh → claude -p "/scan-mentions"   (every 300s, headless)
   every tick:
     1. read .env + config.json   (master enable + 4 toggles)
     2. Slack MCP search "<@$SLACK_USER_ID>"  after the watermark
     3. triage new mentions       (skip small talk, act on real work)
     4. oldest actionable one → subagent runs slack-fetch-pipeline to completion
          (root-cause → @Linear ticket → build → PR → request Codex review
           → poll until it lands → /resolve → reply;
           too big to build blind → write a plan instead, stop before code)
     5. advance watermark, update activity.json
        ▲ reads config          ▼ writes state/activity
   dashboard (localhost:4319) ── flip toggles, watch live status
```

Mention detection is a **search poll**, not a real-time event — Slack only
delivers real-time mention events to apps that are *members of the channel*, and
this design deliberately joins **no channels**. Trade-off: up to one poll
interval of latency.

Because the pipeline runs **to completion** (and blocks 15–25 min on the Codex
poll), a tick that acts on a mention won't detect new ones until it finishes —
mentions are handled one pipeline at a time, oldest first, and the rest wait for
later ticks. During that window the dashboard heartbeat shows amber
**working: &lt;who&gt;** rather than "stalled".

## Setup

**Prerequisites:** Node 18+, the [Claude Code CLI](https://claude.com/claude-code)
on your `PATH`, and the claude.ai **Slack** and **Linear** MCP connectors
authorized in your account. macOS, for the launchd poller.

**1. Configure.** Everything personal lives in one gitignored file:

```bash
cp .env.example .env
$EDITOR .env
```

The three you must fill in are `SLACK_USER_ID` (whose mentions to watch — Slack
profile → ⋮ → *Copy member ID*), `TARGET_REPO` (the repo the pipeline builds
against) and `TARGET_SCOPE` (the subdirectory it is allowed to touch). Every
other key is documented inline and has a working default.

**2. Install.**

```bash
./scripts/install.sh
```

That renders `templates/` into `.claude/` with your `.env` baked in, then
symlinks `scan-mentions` and `slack-fetch-pipeline` into `~/.claude/` so they're
invocable from **any** session — in particular one rooted at `TARGET_REPO`,
where the pipeline actually works. The rendered files stay here; the links are
just pointers (`./scripts/install.sh uninstall` removes them).

> Re-run `./scripts/install.sh render` whenever you change `.env` or a template —
> otherwise the poller keeps using the previously rendered prompt.

> Skip the symlinks entirely if you'd rather run Claude Code **from this folder**
> — the project-local `.claude/` is auto-discovered, and then nothing at all
> lives outside this directory. You'd need `--add-dir` for `TARGET_REPO` so the
> pipeline can reach your code.

**3. Start it** — one command, no terminal to keep open:

```bash
./scripts/install.sh cron
```

That loads two launchd agents: the **poller** (`run-once.sh` on an interval) and
the **dashboard** (`node index.js`, kept alive). Both start at login and survive
reboot. Open <http://localhost:4319> (or whatever `SLACK_BRIDGE_PORT` you set).

The first tick just sets the watermark to "now" (it never replays your old
mentions); later ticks act on new ones.

Re-run the same command any time to apply a changed `.env`, template, or poll
cadence — it re-renders, reloads both jobs, and takes the port back from any
dashboard you'd started by hand. `./scripts/install.sh cron-off` stops both.

> The two jobs are independent. The dashboard is only a viewer over the files the
> poller writes — stop it and mentions are still processed. No `npm install`
> either way; it's pure Node stdlib.

## The poller

launchd runs `run-once.sh` on an interval, which runs
`claude -p "/scan-mentions"`. That is the only runner — there is no
live-session mode to keep open.

```bash
./scripts/install.sh cron      # render, install + load the LaunchAgent
./scripts/install.sh cron-off  # unload and remove it
tail -f logs/cron.log          # what each tick did
./scripts/run-once.sh          # one tick by hand, same environment
```

The dashboard shows a chip next to the heartbeat, built from `runner` +
`intervalSec`, which `/scan-mentions` writes on **every** state write —
including the mid-run heartbeat while a pipeline is in flight, so the chip
stays honest through a 25-minute Codex poll. The UI sizes its "stalled"
threshold from `intervalSec` (2.5 cycles), so changing the cadence doesn't mean
editing the HTML.

| chip | meaning |
|---|---|
| `⏱ launchd · every 60s` | normal — the job is polling |
| `✋ manual run` | someone ran `/scan-mentions` by hand; with the job also loaded you get a race warning |
| `● job loaded · no tick yet` | installed, hasn't reported in |
| `● not installed` | run `./scripts/install.sh cron` |

### Why headless works

The claude.ai Slack and Linear connectors load
fine under a stripped launchd environment, verified with a live
`slack_search_public_and_private` call. Three things make it work, all handled
by `run-once.sh` and the plist:

- **`PATH`** — launchd gives you almost nothing. `claude` is usually in
  `~/.local/bin` and `uvx` (which `mcp-modal` runs through) in
  `/opt/homebrew/bin`. Miss those and `mcp-modal` fails to connect, silently
  costing the pipeline its Modal logs. Slack/Linear were never the problem.
  `EXTRA_PATH` in `.env` overrides the pair if yours live elsewhere.
- **LaunchAgent, not LaunchDaemon** — it has to run in your logged-in Aqua
  session so the login keychain is unlocked and the connector tokens are
  readable. It does not poll while you're logged out.
- **A lock** — a tick that dispatches the pipeline blocks for 15–25 minutes
  while launchd keeps firing every 60s. `run-once.sh` single-flights on an
  atomic `mkdir` lock with stale-PID reclaim.

The real cost of running unattended is **permissions**: a tick has nobody to
answer a prompt, so `run-once.sh` passes `--dangerously-skip-permissions` and
the blast radius is bounded only by the skill's own scope rules. You find out
about a bad run from `cron.log` and the PR, not from a prompt.

If the Slack connector ever fails to load on a tick, the poller records
`mcpOk: false` and the dashboard shows a red banner rather than reporting a
misleading `idle`.

## Configuration (`.env`)

One gitignored file holds everything workspace-specific. `.env.example` is the
committed documentation; these are the keys worth knowing about.

| key | what it decides |
|---|---|
| `SLACK_USER_ID` | **required** — the member id whose `@mentions` are searched for |
| `SLACK_USER_NAME` | how you're referred to in the prompts |
| `GITHUB_LOGIN` | the account `gh` pushes and assigns PRs with |
| `TARGET_REPO` | absolute path to the repo the pipeline builds against; also the default working directory for follow-ups |
| `TARGET_SCOPE` | the subdirectory it may touch — a **hard** scope guard, not a hint. A mention about anything else stops rather than widening |
| `PRODUCT_NAME` / `PRODUCT_URL` | what triage recognises as "about our thing" |
| `LINEAR_BOT_USER_ID` | the @Linear bot's Slack id — see [Filing the Linear ticket](#filing-the-linear-ticket) |
| `LINEAR_WORKSPACE` / `LINEAR_PROJECT` / `LINEAR_PRIORITY` / `LINEAR_STATUS` / `LINEAR_ISSUE_PREFIX` | the parameters of the one-line command, and the issue-key prefix used in branches and PR titles |
| `SLACK_PRODUCT_TEAM` / `SLACK_ENGINEER_TEAM` | `Name:MemberID` rosters. Requests from the first list convert into tickets; requests from the second don't — engineers file their own |
| `SLACK_BRIDGE_PORT` | dashboard port, also read by `emit.sh` and `inbox.sh` |
| `LAUNCHD_LABEL` | the LaunchAgent's label and filename |
| `EXTRA_PATH` | directories prepended to launchd's bare `PATH` |
| `POLL_*` / `SCAN_MODEL` / `PIPELINE_MODEL` | poller defaults — see [Cost](#cost). `data/config.json` overrides all of them once it exists |

Precedence, narrowest first: **`data/config.json`** (what the dashboard wrote) →
**the plist environment** (baked in at `./scripts/install.sh cron` time) → **`.env`**.
So the Settings drawer always wins over the file, and the file always wins over
the built-in defaults.

Changing `.env` requires `./scripts/install.sh render` to take effect in the prompts —
the values are substituted into `.claude/` ahead of time, because a running
Claude session cannot read environment variables.

## Cost

Every tick is a fresh `claude -p` process. There is no prompt-cache reuse
between runs, so a tick that finds **nothing** still pays to load the system
prompt and tool schemas. Measured on this machine with a do-nothing prompt:

| per idle tick | cost | cache-write tokens |
|---|---|---|
| opus, all MCP servers | **$0.274** | 27,347 |
| haiku, all MCP servers | **$0.019** | 8,639 |
| haiku + `--tools` restricted to what a scan needs | $0.045 | 22,180 |

Two things follow. Opus at a 60s cadence is **~$394/day to watch an empty
inbox** — that is the trap. And restricting `--tools` makes it *worse*, because
naming tools forces their schemas inline instead of letting them load on
demand; don't do it.

So the shipped defaults are: **haiku**, **300s**, **08–20 on weekdays**, and
three gates in `run-once.sh` that decide "spend nothing" without starting a
session at all:

| gate | saves |
|---|---|
| `config.enabled` is false | the Automation toggle used to still cost a full session per tick while "paused" — paused is now genuinely $0 |
| outside `SLACK_BRIDGE_ACTIVE_HOURS` / `_ACTIVE_DAYS` | ~64% of ticks at the defaults |
| a pipeline already running (the lock) | every tick during a 15–25 min run |

Triage runs on `SCAN_MODEL`; `/scan-mentions` §5 escalates the dispatched
pipeline to `PIPELINE_MODEL` via the Agent tool's `model`, so cheap polling
never means cheap code. Tune from the dashboard's Schedule panel, or in `.env`:

```ini
POLL_INTERVAL_SEC   300      # cadence — the biggest lever
POLL_ACTIVE_HOURS   08-20    # local 24h window; empty polls around the clock
POLL_ACTIVE_DAYS    12345    # 1=Mon .. 7=Sun
SCAN_MODEL          haiku    # triage
PIPELINE_MODEL      opus     # the run that writes code
```

The first four are stamped into the plist by `./scripts/install.sh cron` and read from
`data/config.json` on every tick, so the dashboard can move them without a reload —
except the cadence, which launchd owns (`StartInterval`), and which the panel's
button re-stamps for you.

`run-once.sh` records `total_cost_usd` for every tick into `data/cost.json`, and the
dashboard's **Spend** card shows today's actual, split into *watching* vs
*pipeline runs*, plus a watching-per-day figure. It uses the median tick to
classify, so one $4 pipeline run doesn't get extrapolated into a $100/day
projection — and once there's a full day of history it reports actual spend
rather than extrapolating an hour, which would overstate a windowed poller by
~2x.

### Why not webhooks?

Worth being clear, because it looks like it should be easy: **Slack has no
event for "a user was mentioned."** `app_mention` fires only for mentions of
*your app*. To see mentions of a human you need `message.channels` and the app
must be a **member of every channel** — which is exactly what this design
avoids, and what makes it installable without workspace-admin buy-in.

The paths that genuinely reach $0-when-idle all require creating a Slack app:

- **Socket Mode** — a local daemon holds a WebSocket, no public URL. Cheapest
  and lowest-latency, but needs an app-level token and the app in every channel.
- **Events API → public endpoint** — same channel-membership requirement, plus
  somewhere to host it. Your Mac isn't reachable, so it would need a relay
  (Modal) and the Mac would poll *that* — free in tokens, but more moving parts.
- **User token + `search.messages`** — still polling, but from a shell script
  at zero token cost, gating whether `claude -p` runs at all. Keeps the
  no-channels property, needs a user token with `search:read`.

That last one is the natural next step if the gates above aren't enough: a free
gate that only spins up Claude when the search returns something new.

## The toggles (`data/config.json`)

| key | default | effect |
|---|---|---|
| `mode` | `auto` | `off` / `watch` / `auto` — see [Three modes](#three-modes-one-switch). `enabled` is kept in lockstep (`mode !== "off"`) because `run-once.sh`'s cheapest gate is a grep for it |
| `poller.*` | 300s, 08-20, 12345, haiku | cadence, active hours/days, triage model — read at the top of **every** tick, so the Schedule panel changes real behaviour. Cadence also needs the job reloaded (launchd owns `StartInterval`; the panel's button re-stamps the plist) |
| `followup.*` | opus, *(unset)*, bypassPermissions, *(auto)*, off | the **defaults** a new chat's job options start from — model, working directory, permission mode, effort, 1M context. A chat overrides any of them from its composer, and its picks live on the run, not here — see [How a job runs](#how-a-job-runs-is-picked-in-the-composer) |
| `enabled` | `true` | derived from `mode`; kept for older pollers |
| `reply` | `true` | post the verdict + PR/Linear links back in the thread |
| `createLinearIssue` | `false` | after the verdict, post `@Linear create an issue, …` in the thread and build from the returned issue; off = thread is the spec — see [Filing the Linear ticket](#filing-the-linear-ticket) |
| `codexReplies` | `true` | after PR opens, request Codex review + poll + run `/resolve`; off = stop at PR open |
| `saveToMemory` | `true` | let the run bank durable lessons via `/addmem` |

Flip them in the dashboard (writes `data/config.json` instantly) or edit the file —
the poller reads current values at the start of every tick.

## Filing the Linear ticket

With `createLinearIssue` on, the pipeline stops short of writing code and instead
does **what you do by hand**: it replies in the thread with the one-line command
and lets the **@Linear bot** file the ticket from the conversation.

```
<@$LINEAR_BOT_USER_ID> create an issue, project $LINEAR_PROJECT, prio $LINEAR_PRIORITY, assignee me, status $LINEAR_STATUS
```

It then polls the thread (~10s, 2 min cap) for the bot's reply, pulls the
`linear.app/$LINEAR_WORKSPACE/issue/$LINEAR_ISSUE_PREFIX-NNN/…` URL out of it,
and **builds from that issue** — the same input `/fetch <linear-url>` takes. The
issue title becomes the PR title, its description becomes the PR body's
backbone, and the URL lands in the activity log and the final Slack reply.

It files the ticket through the bot rather than the Linear MCP on purpose: the
bot reads the whole thread, so it writes a better title and description than a
one-shot MCP call, and the ticket appears in-channel where the team looks for it.

**The gate matters more than the mechanism.** Only a fraction of mentions deserve
a ticket, so §3.5a of the skill requires all four:

1. **A durable product delta** — a named UI/behaviour change or a reproducible
   defect in `TARGET_SCOPE`. Not an outage, a status question, an unsettled
   design debate, praise, or anything rooted outside the codebase.
2. **Unowned, and yours** — no other engineer has claimed the thread and no
   Linear link is already in it. Requests from `SLACK_PRODUCT_TEAM` convert;
   requests from `SLACK_ENGINEER_TEAM` don't — they file their own. Both
   rosters live in `.env`; leave them empty and the pipeline judges by the
   request itself.
3. **Still open right now** — not retracted, self-resolved, or already merged
   in-thread by the time the pipeline gets there.
4. **Actually going to be built** — which is why this runs *after* the root-cause
   verdict, not before. A false positive or an already-built ask never creates a
   ticket.

The requester's own `[low]` / `[Med]` / `[high]` tag is deliberately ignored. It
doesn't predict ticketing (urgent asks tend to get fixed in-thread and never
filed; low-priority ones get parked in Linear precisely because nobody will do
them today), and the command's priority is a flat `LINEAR_PRIORITY` regardless.

`LINEAR_PROJECT` is likewise fixed per install rather than chosen per run —
picking the wrong project name silently misroutes the issue into another team,
which is exactly the failure you don't notice until someone asks where the
ticket went.

Two things worth knowing:

- This posts to Slack **even when `reply` is off**. `reply` governs the final
  verdict message; this is work tracking.
- If the bot doesn't answer in 2 minutes the pipeline does **not** re-post — a
  duplicate command means a duplicate ticket. It falls back to a Linear MCP
  lookup, and failing that carries on with the thread as the spec and says so in
  the reply.

## External dependencies (deliberately not vendored here)

The pipeline calls into things that are part of your wider setup, not this
project — they stay where they are:

- **`/resolve` and `/addmem`** — your existing personal commands in
  `~/.claude/commands/`. The pipeline calls them by name after a PR opens; if
  you don't have them, turn `codexReplies` and `saveToMemory` off.
- **MCP connectors** — claude.ai Slack + Linear (required), plus `mcp-modal` /
  Datadog / PostHog for log digging, and the GitHub MCP / `gh` CLI for PRs.
- **Your repo** — `TARGET_REPO` / `TARGET_SCOPE` is what the pipeline builds
  against. It is never vendored, cloned or modified by `install.sh`.

## Security

- **The server binds `127.0.0.1` only**, and refuses cross-origin mutations —
  a POST here can start a session with `--dangerously-skip-permissions`, so a
  loopback `Host` *and* a same-origin `Origin` are both required.
- **`.env` is gitignored**, and so is everything the poller writes
  (all of `data/`, plus `logs/`).
  Run records contain Slack message text and transcripts; keep them local.
- **Slack message text is untrusted data.** Both prompts say so explicitly and
  neither treats it as instructions.
- **Prod databases are read-only** to the pipeline — `SELECT` only, and fixes
  ship as a PR rather than a direct change. That guardrail is stated in the
  skill and repeated in every follow-up prompt.
