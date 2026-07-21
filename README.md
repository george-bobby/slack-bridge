# Slack Bridge - Thread to PRs

When you're **@mentioned in Slack**, a local Claude Code session picks it up,
does the work end-to-end (context → root cause → Linear ticket → build → PR →
Codex review → resolve), and replies in the thread — gated by toggles you flip
from a small local dashboard.

**Nothing is added to any Slack channel.** Detection is a `search.messages` poll
with your own **user token**, from a plain Node script that costs nothing to run;
a Claude session starts only when there is a real mention to work. Replies and
Linear go through the **claude.ai Slack / Linear MCP connectors** you already
have.

The dashboard is a **chat client for your mentions**. Every mention is a thread
you can scroll back through, and every thread has a composer: type into it and a
real Claude Code session picks the work back up where the pipeline left off.

**One Slack thread is one chat.** A run is keyed by the thread's `ts`, never by
the message that mentioned you — so @Linear answering the ticket, a colleague
adding a screenshot and a build bot posting status all land in the chat that
already exists, mark it unread, and start nothing. Only a thread nobody has filed
opens a new one; the sole exception is an explicit `newRequest: true` from the
poller, which mints a sibling chat (`<thread_ts>-2`). Nothing infers it, so the
default can never quietly split a thread into half-worked tasks. **Delete** drops
the run file *and* the poller's `activity.json` entry — without the second half
the next sync mirrors it straight back — so it asks first and cannot be undone.
The Slack thread, PR and Linear issue are untouched.

## Start and stop

Two commands, and each covers **both** launchd agents — the poller and the
dashboard. They're separate jobs, and forgetting one is how you end up with a
dashboard serving stale data or a poller firing into nothing.

```bash
./scripts/install.sh start     # start everything
./scripts/install.sh stop      # stop everything
```

`start` is idempotent, so it's also the **restart**: it re-renders `templates/`
against your current `.env`, re-stamps the cadence from `data/config.json`, takes
the dashboard port back from anything already holding it, and reloads both jobs.
Re-run it after editing `.env`, a template, or anything under `lib/` — the
dashboard is a long-lived process and won't pick up code changes on its own.

Both survive logout and reboot. Setting up for the first time? → [Setup](#setup).

```bash
launchctl list | grep slack-bridge   # loaded?
tail -f logs/cron.log                # what each tick did
```

## How it works

```
launchd → run-once.sh                                    (every 60s)
   1. probe.js  — search.messages with your user token      $0, no session
        nothing new? exit here. this is ~95% of ticks.
   2. claude -p "/scan-mentions"                            only if 1 found something
        triage → oldest actionable one → subagent runs slack-fetch-pipeline
        to completion (root-cause → @Linear ticket → build → PR → request
        Codex review → poll until it lands → /resolve → sweep the thread
        for follow-ups and fold them into the same PR → reply;
        too big to build blind → write a plan instead, stop before code)
   3. advance watermark, update activity.json
        ▲ reads config.json        ▼ writes state/activity
   dashboard (localhost:4319) ── flip toggles, watch live status
```

Detection is a **poll, not a real-time event**: Slack only delivers message
events to apps that are *members of the channel*, and this design joins none.
The trade-off is up to one interval of latency — and since an idle poll is free,
the interval is tuned for latency rather than cost.

Because the pipeline runs **to completion** (blocking 15–25 min on the Codex
poll), a tick that acts on a mention won't detect new ones until it finishes.
Mentions are handled one pipeline at a time, oldest first; the rest wait for
later ticks. The dashboard heartbeat shows amber **working: &lt;who&gt;** rather
than "stalled" during that window.

## Layout

**Source** at the root, **your values** in `.env`, **everything mutable** under
`data/`.

```
slack-bridge/
├── .env                  YOUR Slack ids, token, repo path, Linear team (gitignored)
├── .env.example          every key, documented — the only config reference (committed)
├── index.js              dashboard server (Node stdlib only — no npm install)
├── lib/
│   ├── env.js            reads .env; the single source for every tunable
│   ├── render.js         templates/ + .env  →  .claude/
│   ├── store.js          config/state/cost + the per-run chat records
│   ├── jobs.js           spawns follow-ups & manual runs, streams them back
│   ├── memory.js         reads/writes ~/.claude/projects/<repo>/memory/*.md
│   └── bus.js            server-sent events (the UI never polls)
├── public/               index.html + app.css + app.js + logo.png
│   └── vendor/           the Milkdown editor, pinned and committed (see below)
├── templates/            the prompts, with {{TOKENS}} where your values go
│   ├── scan-mentions.md                  the poller
│   └── slack-fetch-pipeline/SKILL.md     the per-mention workflow
├── .claude/              rendered from templates/ by install.sh  (gitignored)
├── scripts/
│   ├── vendor-milkdown.js  re-fetch public/vendor/ (only when bumping the editor)
│   ├── install.sh        render prompts, symlink into ~/.claude, start/stop both agents
│   ├── probe.js          free mention detection — the gate that decides a tick's cost
│   ├── run-once.sh       one headless tick (the cron runner, single-flighted)
│   ├── emit.sh           a run reports a stage    → POST /api/runs/:id/event
│   ├── inbox.sh          a poll files its mentions → POST /api/mentions
│   └── launchd.plist.template            launchd template for the poller
├── data/                 everything mutable        (gitignored, bar the example)
│   ├── config.json       toggles + poller settings (dashboard writes, poller reads)
│   ├── state.json        watermark + heartbeat     (probe + poller own)
│   ├── probe.json        last probe result — its findings, or why it found nothing
│   ├── activity.json     rolling log of processed mentions (poller owns)
│   ├── cost.json         per-tick $ ledger         (run-once.sh appends)
│   └── runs/<thread>.json  one chat per Slack thread: transcript, stages, follow-ups
└── logs/cron.log         what each tick did        (gitignored)
```

The prompts under `templates/` carry `{{TOKENS}}` (`{{SLACK_USER_ID}}`,
`{{TARGET_SCOPE}}`, `{{LINEAR_COMMAND}}`, …) because a running Claude session
can't read environment variables: `./scripts/install.sh` substitutes your values
in and writes the result to the gitignored `.claude/`. **Edit `templates/`, never
`.claude/`** — the next render overwrites it. `SLACK_USER_TOKEN` is deliberately
excluded from that substitution table, so the secret never lands in a rendered
prompt.

## Setup

**Prerequisites:** Node 18+, the [Claude Code CLI](https://claude.com/claude-code)
on your `PATH`, and the claude.ai **Slack** and **Linear** MCP connectors
authorized in your account. macOS, for the launchd poller.

**1. Configure.** Everything personal lives in one gitignored file:

```bash
cp .env.example .env
$EDITOR .env
```

`.env.example` documents every key inline — it is the only configuration
reference, and there is no second copy of it in this README. The four you must
fill in: `SLACK_USER_ID`, `SLACK_USER_TOKEN` (the `xoxp-` user token; the file
walks through creating the app), `TARGET_REPO` and `TARGET_SCOPE`.

Check the token before going further:

```bash
node scripts/probe.js --debug
```

**2. Install.**

```bash
./scripts/install.sh
```

Renders `templates/` into `.claude/` with your `.env` baked in, then symlinks
`scan-mentions` and `slack-fetch-pipeline` into `~/.claude/` so they're invocable
from any session — in particular one rooted at `TARGET_REPO`.

> Re-run `./scripts/install.sh render` whenever you change `.env` or a template.

**3. Start it** — `./scripts/install.sh start`, per [Start and
stop](#start-and-stop). Then open <http://localhost:4319>.

The first tick sets the watermark to "now"; it never replays old mentions.

## The poller

```bash
./scripts/run-once.sh          # one tick by hand, same environment
node scripts/probe.js --debug  # just the detection half, no session
```

Every tick runs `scripts/probe.js` first. Its exit code is the whole interface:

| exit | meaning | session? |
|---|---|---|
| `0` | new mentions, written to `data/probe.json` | yes — handed the results via `SLACK_BRIDGE_PREFETCH`, so it never re-searches |
| `10` | nothing to do, or a transient failure (429/5xx/DNS) | no — **$0** |
| `20` | broken: no token, bad auth, bad config | no, and it's logged |

**There is no fallback path.** The probe *is* mention detection; a broken one
means a blind poller, and that should look obviously wrong rather than quietly
expensive. A `20` withholds the heartbeat on purpose, so the dashboard goes
stale and you notice. A transient failure is a `10` rather than a `20` because
the watermark is untouched — the next tick re-asks and sees the same mentions,
losing nothing but latency.

Four gates decide "spend nothing" before any session starts: `mode: off`, the
active-hours window, the single-flight lock (a pipeline run blocks 15–25 min
while launchd keeps firing), and the probe.

### Running unattended

- **`PATH`** — launchd gives a job almost nothing. `node`, `claude` and `uvx`
  (which `mcp-modal` runs through) must be reachable; `EXTRA_PATH` in `.env`
  prepends their directories.
- **LaunchAgent, not LaunchDaemon** — it needs your logged-in session so the
  keychain is unlocked and the MCP connector tokens are readable. It does not
  poll while you're logged out.
- **Permissions** — a tick has nobody to answer a prompt, so `run-once.sh`
  passes `--dangerously-skip-permissions`. The blast radius is bounded only by
  the skill's own scope rules. You find out about a bad run from `cron.log` and
  the PR, not from a prompt.

## Cost

A `claude -p` tick is a fresh process with no prompt-cache reuse, so *starting*
one costs money whether or not it finds anything. Measured over 75 real ticks
before the probe existed, a tick that found nothing still ran a **median
$0.094** — purely to be told nothing happened. The probe removes that entirely:

| | before | now |
|---|---|---|
| tick that finds nothing | ~$0.094 | **$0.00** |
| a day of them (~1400 @ 60s) | ~$132/day | **$0.00** |
| tick that finds a mention | ~$0.094 + pipeline | ~$0.094 + pipeline |
| cadence | 300s, windowed, to save money | 60s, because latency is now the only cost |

Spend scales with **how often you're mentioned**, not how often you poll. A
handful of mentions a day is cents of triage plus whatever the pipelines you
actually dispatch cost — and `Watch` mode keeps that second number at zero until
you press Start.

`search.messages` is Tier 2 (20+/min), so a 60s cadence is well inside Slack's
budget; the [2025 rate-limit
changes](https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/) cover
`conversations.history`/`.replies` only, and exempt internal apps besides.

Triage runs on `SCAN_MODEL` (haiku); `/scan-mentions` escalates the dispatched
pipeline to `PIPELINE_MODEL` (opus), so cheap polling never means cheap code.

> **On a Pro/Max plan these are notional dollars.** Sessions authenticate
> through the CLI's OAuth login, so a tick draws down your plan's rolling
> allowance rather than billing anything. Every figure traces to
> `total_cost_usd` from the CLI's own result event — a local estimate from token
> counts × published prices, and a good proxy for how hard the poller is
> working. Point `ANTHROPIC_API_KEY` at it and the same number becomes a real
> charge. `run-once.sh` banks each tick into `data/cost.json`; the dashboard's
> **Spend** card splits today's total into *watching* vs *pipeline runs*.

## Two switches, not three modes

**Is anything watching Slack?** — Schedule → *Poller tick*. One switch that both
loads/unloads the launchd job **and** parks `config.mode` at `off`, because
launchd deciding to fire and `run-once.sh` deciding to spend are different gates
and leaving one behind gives you a job firing forever into an early `exit 0`.
Cadence lives next to it; saving a new one reloads the job, since launchd stamps
the interval into the plist at install time.

**Then what?** — the `Watch | Auto` switch in the top bar.

| mode | polls? | dispatches? | costs |
|---|---|---|---|
| **Watch** | yes | **no** | $0 while idle; you press **Start** on what you want |
| **Auto** | yes | yes, the oldest actionable one | $0 while idle, + pipeline runs |

In Watch mode the poller still triages and still records *why* it would have
skipped something — you just get the final say. Disagreeing with triage is the
whole point; a skip you can't see is a skip nobody can correct.

## The toggles (`data/config.json`)

| key | default | effect |
|---|---|---|
| `mode` | `auto` | `off` / `watch` / `auto`. `enabled` is kept in lockstep (`mode !== "off"`) because `run-once.sh`'s cheapest gate is a grep for it |
| `poller.*` | 60s, 08-20, 12345, haiku | cadence, active hours/days, triage model — read at the top of **every** tick. Cadence also needs the job reloaded (launchd owns `StartInterval`) |
| `followup.*` | opus, *(unset)*, bypassPermissions, *(auto)*, off | the **defaults** a new chat's job options start from. A chat overrides any of them from its composer, and its picks live on the run, not here |
| `reply` | `true` | post the verdict + PR/Linear links back in the thread |
| `createLinearIssue` | `false` | after the verdict, file a ticket via the @Linear bot and build from it; off = the thread is the spec |
| `codexReplies` | `true` | after PR opens, request Codex review + poll + run `/resolve`; off = stop at PR open |
| `saveToMemory` | `true` | let a run **propose** a memory into `data/runs/memories/` — never write one. Recurrence or your approval promotes it; see [Project memory](#project-memory) |

Flip them in the dashboard or edit the file — the poller reads current values at
the start of every tick.

## Follow-ups and manual starts

Typing into a chat, or pressing **Start** on an unworked mention, spawns a real
headless session (`claude -p --output-format stream-json --input-format
stream-json`) and streams it into the transcript. Continuity is by minted uuid:
the first job passes `--session-id <uuid>`, every later one `--resume <uuid>`,
so the expensive context preamble is written once per chat.

The prompt travels on **stdin** rather than in argv, because stdin has to stay
open anyway — it's the channel an answer goes back down when the session stops
to ask you something (see [Answering a session](#answering-a-session)). The cost
is that the child no longer exits by itself: `result` is what closes stdin, and
that's what makes a job end.

The chat header's **Terminal** chip hands that uuid over, running
`claude --resume <uuid>` in the repo the session was minted in — but *without*
`--dangerously-skip-permissions`, because in a terminal you're present to answer
prompts. It refuses while a job is running in that chat (two processes resuming
one session id is how a session gets corrupted). macOS + AppleScript only;
elsewhere the command lands on your clipboard.

The chips beside **Send** decide what the next job in *this* chat does:

| Chip | Becomes | Notes |
| --- | --- | --- |
| **Mode** — Plan | `--permission-mode plan` | Reads and investigates, writes nothing — then asks you to approve a plan. Approve it and the same session builds it. |
| **Mode** — Manual | `--permission-mode manual` | Asks before **every** tool call. Slow, completely supervised. |
| **Mode** — Edit | `--permission-mode acceptEdits` | Edits files freely, asks before each shell command. |
| **Mode** — Full access | `--dangerously-skip-permissions` | The default. Edits files, pushes commits, can post to Slack. Only stops for a question it genuinely can't answer. |
| **Model** | `--model <alias>` | opus / sonnet / haiku / fable. |
| **Thinking** | `--effort <level>` | *Auto* passes no flag. |
| **Capacity** | `--model <alias>[1m]` | The 1M-context variant. |
| **Repo** | the session's `cwd` | Filesystem picker (`GET /api/dirs`). |

> `--dangerously-skip-permissions` **outranks** `--permission-mode`: pass both
> and a "plan mode" session will happily edit files. They're mutually exclusive
> in `permissionArgs()`, and the narrowed modes never get the skip flag. Because
> the run is headless, the chosen mode is also restated in the prompt on every
> turn, not just the opening preamble.

## Answering a session

Every job also runs with `--permission-prompt-tool stdio`. That one flag is what
makes the dashboard a console rather than a viewer:

- a permission request arrives as a `control_request` on stdout **instead of
  being silently refused**, so you decide, mid-run, from the chat;
- it puts `AskUserQuestion`, `EnterPlanMode` and `ExitPlanMode` into the
  session's toolset. They are **absent** from a headless session otherwise —
  which is why plan mode used to be a dead end rather than a plan you approve.

Prompts reach you in **every** mode, including full access. Under
`bypassPermissions` nothing routes to you except tools that flatly require a
human (`requires_user_interaction`), so the default job is exactly as unattended
as it was — it just stops guessing when it needs a real decision, instead of
being told *"the user did not answer the questions"* and inventing one.

The card renders inline in the transcript, against the tool call it's about:

| The session calls | You get |
| --- | --- |
| `AskUserQuestion` | The question, with its named options as buttons, plus a free-text box. Multi-select collects and sends together. |
| `ExitPlanMode` | The rendered plan, **Approve — start building** / **Send it back**. Approving promotes the session out of plan mode and it continues into the work. |
| anything else | The tool, its arguments, why it was stopped — **Allow** / **Deny**. |

A refusal carries a **message** back to the model rather than a bare no. That
field matters more than it looks: denied with a reason, a run re-plans around
it; denied silently, it usually just tries the same thing again.

### How you find out

- **A desktop notification**, the moment the session blocks. **Clicking it
  focuses the tab, opens that chat and scrolls the card into view** — it lands
  you on the actual question, not on the dashboard's front page.
- **The tab title** becomes `(1) Needs you · Slack Bridge` — the only part of
  the page you can see while looking at something else.
- **The sidebar row** gets a pulsing amber pip, a `needs you` badge, and a
  one-line note of what it wants (`Write: …/api/export.js`).
- **A strip above the composer** in the open chat, with a jump to the card.

Notifications are the browser's own (`new Notification`, no service worker and
no server-side push — `localhost` is a secure context, so neither is needed).
They're **off until you turn them on**, from the *Notifications* row in Settings
or the **Notify me next time** button that appears on the waiting strip. The
choice is per browser, in `localStorage` under `sb-notify`, because the
permission it rides on is per browser too.

One notification per chat (`tag: ask-<runId>`), so a run that asks twice
replaces its own rather than stacking, and `requireInteraction` keeps it up
until you deal with it — the session is blocked either way, and a question that
auto-dismissed after four seconds is a question missed. Nothing is raised when
you already have that chat focused on screen.

> The trade-off is honest: with no tab open there is no notification. The tab
> title and the sidebar still carry it, and the run waits indefinitely either
> way. An earlier version posted from a macOS app bundle to cover that case;
> it was dropped because it could never do the one thing that matters most
> here — click through to the exact question.

An ask is a question a **live child process** is blocked on, and those children
die with the server — so `store.clearPendingAsks()` sweeps every `pendingAsk` at
boot. The step is marked *cancelled* rather than deleted, because it did happen,
and an unanswered ask is usually the explanation for whatever the run did next.

## Attachments

Screenshots and screen recordings render inline in the transcript, which needs
one thing the rest of the dashboard doesn't: this server actually fetching from
Slack. Every attachment lives behind `files.slack.com`, which serves nothing
without an `Authorization` header — so a browser can't load one and must not be
handed a token to try.

- **Metadata is free.** `scripts/probe.js` already receives `files[]` on every
  `search.messages` match; it records the handful of fields a bubble needs onto
  the message (`lib/slack.js`). No extra API call, ever.
- **Bytes go through `GET /api/slack/file?run=…&id=…`**, which attaches the
  token here and streams the response back. Addressed by file id rather than by
  URL, so it can only ever fetch something a message in that chat recorded —
  not an open proxy with a workspace credential on it. Range requests pass
  through, so seeking a 5-minute recording doesn't re-pull the file.
- **Needs `files:read`** on the user token, alongside `search:read`. Without it
  Slack answers with a *redirect to the login page* rather than an error; the
  card in the chat says so instead of showing a broken-image glyph, and the
  "Open in Slack" link still works because your browser is already signed in.

Slack's `search.messages` only returns messages that mention you, so attachments
are recorded on the mentions themselves — not on every reply in a thread.

## What the pipeline does

It **embodies the concepts of `/fetch` and `/root` rather than invoking them** —
both assume a human to steer, which hangs or under-delivers headless.

From **`/root`**, the diagnostic half: a **true/false-positive verdict before any
code is written**. A Slack bug report isn't proof of a bug, so the pipeline
traces the real code path, checks recent merged PRs as regression suspects, and
confirms or refutes the claim against **read-only** prod data. A false positive
ends in an explanation, not a PR — that's a success. Screenshots count as
primary evidence (they routinely contradict the prose), and the reply carries a
plain-language root cause.

From **`/fetch`**, the delivery half, written to **run to completion**: once it
opens a PR it requests the Codex review, **polls until it lands** (~5–15 min),
and runs `/resolve` on every thread.

Then — and this is the part a human doing it by hand always does and a script
never used to — it **goes back and reads the thread again**. A run takes 20–40
minutes, the Codex poll alone 5–15, and the thread is live the whole time: a
correction, a second case, a screenshot, "also can you make it X". Replying to
the message it read 40 minutes ago would ship a PR the conversation had already
moved past. So before the reply it diffs the thread against the high-water `ts`
it recorded at the start, discards its own footprint (the `@Linear` command and
the bot's answer) and the usual `+1`s, and for whatever is left decides
*already covered / needs code / a question / out of scope*. Anything needing
code is built onto the **same branch and the same PR** — never a second PR or a
second ticket — and then:

- **Codex is re-requested only if the follow-up work is genuinely big** (a new
  module, a new endpoint, a migration, an auth change, a rewrite of what Codex
  already read). A copy tweak or a bounded conditional does not buy another
  25-minute poll to be told nothing.
- **The Linear description and the PR description are both updated** — amended,
  not replaced, and with both **titles left frozen** (§7's rule survives
  `/resolve`, rebases and this step alike).
- Then it sweeps **again**, because fixing the follow-up took time too. Capped
  at three; past that it says in the reply that the thread is moving faster than
  the run can follow and hands it back.

A follow-up cannot authorise work the original mention couldn't: the
`TARGET_SCOPE` scope guard and the build-or-plan split still apply, so a
follow-up needing a schema change gets written up in the reply as needing a
steer rather than built at 2am. It shows in the dashboard as the **Follow-ups**
stage (`sweep`), and the Slack reply says both what the follow-ups changed and
what they deliberately didn't.

Follow-ups that arrive *after* the run ends are unchanged: the poller files them
into the same chat with an unread dot and never starts a second pipeline — you
pick those up from the composer, which resumes the same session.

It keeps `/fetch`'s **plan-mode escape hatch** with one redesign: plan mode waits
for an approval nobody is present to give, so here the **plan replaces the
mode**. Work too big to start blind — schema migration, auth surface, spans
services, ambiguous intent — is *not* built. The run writes the plan it would
have asked you to approve (including the open questions and its recommended
answer to each) to `data/runs/plans/<runId>.md`, emits it as the `plan` stage,
and posts one plain-language line to the thread. The ticket still gets filed,
because a plan living only in a run chat is exactly the untracked work a ticket
exists to prevent.

## Filing the Linear ticket

With `createLinearIssue` on, the pipeline does **what you do by hand**: it posts
the one-line command in the thread and lets the **@Linear bot** file the ticket
from the conversation.

```
<@$LINEAR_BOT_USER_ID> create an issue, project $LINEAR_PROJECT, prio $LINEAR_PRIORITY, assignee me, status $LINEAR_STATUS
```

It polls the thread (~10s, 2 min cap) for the bot's reply, pulls the issue URL
out of it, and **builds from that issue** — the same input `/fetch <linear-url>`
takes. Through the bot rather than the Linear MCP on purpose: the bot reads the
whole thread, so it writes a better title and description than a one-shot call,
and the ticket appears in-channel where the team looks for it.

**The gate matters more than the mechanism.** Only a fraction of mentions deserve
a ticket, so the skill requires all four:

1. **A durable product delta** — a named UI/behaviour change or reproducible
   defect in `TARGET_SCOPE`. Not an outage, a status question, a design debate,
   or praise.
2. **Unowned, and yours** — no other engineer has claimed the thread, no Linear
   link is already in it. `SLACK_PRODUCT_TEAM` requests convert;
   `SLACK_ENGINEER_TEAM` requests don't — they file their own.
3. **Still open right now** — not retracted, self-resolved, or already merged
   in-thread.
4. **Actually going to be built** — which is why this runs *after* the
   root-cause verdict. A false positive never creates a ticket.

The requester's own `[low]`/`[high]` tag is ignored: it doesn't predict ticketing
(urgent asks get fixed in-thread and never filed), and the command's priority is
a flat `LINEAR_PRIORITY` anyway. `LINEAR_PROJECT` is fixed per install because
picking the wrong project silently misroutes the issue into another team.

Two things worth knowing: this posts to Slack **even when `reply` is off**
(`reply` governs the final verdict message; this is work tracking), and if the
bot doesn't answer in 2 minutes the pipeline does **not** re-post — a duplicate
command means a duplicate ticket.

## Project memory

The 📖 button in the top bar (or `m`) opens the Claude Code memory for the repo a
job runs in — `~/.claude/projects/<repo>/memory/`, which is `MEMORY.md` plus one
file per remembered fact. That directory is read into **every** headless run, so
it is the fastest explanation for why the poller keeps making the same wrong
call, and the fastest place to fix it.

- **Which repo** is resolved server-side through the same `jobs.resolveWorkdir()`
  a job uses, so with a chat open you get that chat's repo and otherwise the
  default `TARGET_REPO`. The panel header names it either way.
- **Frontmatter is never edited.** The `name` / `description` / `type` block is
  split off before the editor sees it and restored byte-for-byte on save — a
  WYSIWYG pass over YAML writes back something the memory loader can't parse.
  It's shown as the caption above the prose instead, and `type` groups the list.
- **`[[cross-references]]`** are pulled out under the editor as chips you can
  follow; one pointing at a memory nobody has written yet is struck through.
- **Saving only touches files you edited.** The Save button is lit by comparing
  against the editor's *own* round-trip of the file, not the bytes on disk, so
  opening a memory never marks it dirty. Writes are `*.md` inside that one
  directory, and a memory is never unlinked — retiring one moves it to
  `.archive/`, and Restore brings it back.
- **Every row says what it has earned.** `lib/memuse.js` counts the `Read` calls
  on each memory across that repo's session transcripts, so "15 reads, last
  today" and "never read" are measured, not guessed. It is shown and never acted
  on: a memory for a rare case is *supposed* to sit unread until the case shows
  up. The scan is incremental — a couple of seconds cold over ~500 sessions, a
  few milliseconds after.
- **New** is one text box, not a form. Say the thing however you'd say it out
  loud; a **read-only** Claude session (`--permission-mode plan`, with
  `--add-dir` onto the memory folder) reads `MEMORY.md` and the memories behind
  it, then decides whether this ground is already remembered. Overlap becomes an
  **amendment** to the existing file — the whole file, rewritten to fold the new
  point in — and only genuinely new ground becomes a new memory. It comes back
  as a proposal, opens in the editor, and is written by the same validated path
  as everything else, so drafting can never itself touch `~/.claude`.

  That judgement is the part a form can't do. Naming and sectioning are easy;
  *"does one of these nineteen already say this?"* requires reading them, and
  twenty near-duplicates are worse than none because the index is loaded into
  every session and nothing dedupes it.

  The draft is returned as a one-line JSON decision plus the file between
  `<<<MEMORY` markers — not as JSON containing the file. A memory is multi-line
  prose full of quotes and backticks, and asking a model to escape all of that
  into a JSON string fails on the first apostrophe in the wrong place.
- **Drift is reported at the top.** A memory the index has stopped listing is
  still on disk and still good, but nothing loads it — and its read count then
  stays at zero forever, which makes it look like exactly the dead weight it
  isn't. The banner counts both directions (unlisted files, and index lines with
  no file); **Restore** re-lists one from its own frontmatter.

`Esc` closes, `⌘S` saves, and closing with unsaved edits asks first.

### Proposals — how a run remembers something (`saveToMemory`)

**A run never writes a memory. It files a proposal.** Writing a memory is cheap,
local and immediate; *reading* one is charged to every session from then on. A
step that fires per-run is therefore guaranteed to lose that trade over time —
which is exactly what the `/addmem` call this replaces did, banking PR-shaped
detail after every merge until the context it meant to improve was noise.

So a proposal lands in `data/runs/memories/`, which no session ever loads and
which costs nothing to be wrong about. Two things promote one:

- **Recurrence.** Each proposal names the `territory` it is about —
  `cache-invalidation`, not `pr-4281`. A *second* proposal in the same territory,
  from a different run, is the first evidence this is a pattern rather than an
  anecdote, and the promoted memory carries both citations. That is the shape the
  good hand-written ones already have: *"Codex P2s on PRs #4086, #4127, #4244"*.
- **You.** Any proposal can be approved from the panel at any time. Recurrence is
  the bar for doing it unattended, not a rule about what you may keep.

A proposal nobody promotes expires after 30 days. That is the intended outcome
for most of them, and it is free. **`skip` is recorded rather than dropped** —
it's the right answer for most runs, and a skip you can't see is a decision
nobody can correct, the same reasoning that keeps triage skips in the inbox.

Proposals appear above the memories, marked `ready` once they're ripe. Opening
one loads it into the same editor — **what you approve is what's in the editor**,
not what the run wrote, so the wording is yours before it becomes something every
future session reads. A proposal whose territory matches an existing memory is an
**amendment**, and is ripe at one sighting: it adds no new index line.

Turn the whole thing off with the **Propose memories** toggle in Settings.

### The vendored editor

`public/vendor/` holds [Milkdown](https://milkdown.dev) (Crepe) as one pinned,
self-contained ES module. It is committed rather than installed or hot-linked so
that `node index.js` still works with nothing installed and no network — this
page can start a session with `--dangerously-skip-permissions`, and it shouldn't
need a CDN to draw a text box. The 2.7MB of JS is imported on first open only.

Re-fetch it with `node scripts/vendor-milkdown.js` after bumping `VERSION` in
that script. It fails loudly if upstream starts importing something that isn't
vendored, or reaches for more of Node's `process` than the stub provides.

Because Milkdown re-serialises the whole document, a save rewrites the file in
remark's house style. `memNormalize()` in `app.js` puts back the parts that
would otherwise be damaging — chiefly the `\[\[escaped]]` wiki-links — and
LaTeX is switched off so `$` stays money. What survives is blank lines between
blocks; no text is altered. All 19 memory files in the reference repo round-trip
with identical content, 14 of them byte-for-byte.

## External dependencies (deliberately not vendored)

- **`/resolve`** — your existing personal command in `~/.claude/commands/`. The
  pipeline calls it by name after a PR opens; if you don't have it, turn
  `codexReplies` off.
- **MCP connectors** — claude.ai Slack + Linear (required for replies, threads
  and tickets), plus `mcp-modal` / Datadog / PostHog for log digging, and the
  GitHub MCP / `gh` CLI for PRs.
- **Your repo** — `TARGET_REPO` / `TARGET_SCOPE` is what the pipeline builds
  against. Never vendored, cloned or modified by `install.sh`.

## Security

- **`SLACK_USER_TOKEN` is a user token**: it can read everything you can read.
  It lives only in the gitignored `.env`, and `lib/render.js` omits it from the
  template substitution table so it can never reach a rendered prompt under
  `~/.claude`. Never put a real value in `.env.example` — that file is committed.
- **The app that issues it has no bot scopes**, so no bot user exists, nothing
  joins any channel, and the token grants no visibility you don't already have.
  Revoke it from the same **OAuth & Permissions** page that minted it.
- **`/api/slack/file` is the one route that fetches with the token**, and it
  takes a file id rather than a URL — it can only resolve to something a message
  in that chat already recorded. What comes back is served with the type *we*
  recorded, `nosniff`, `default-src 'none'; sandbox`, and `Content-Disposition:
  attachment` for anything that isn't plainly image/video/audio: attachments are
  bytes a colleague chose, and this origin is one that can start a session.
- **The server binds `127.0.0.1` only** and refuses cross-origin mutations — a
  POST here can start a session with `--dangerously-skip-permissions`, so a
  loopback `Host` *and* a same-origin `Origin` are both required.
- **Everything the poller writes is gitignored** (all of `data/`, plus `logs/`).
  Run records contain verbatim Slack message text and full session transcripts;
  keep them local.
- **Slack message text is untrusted data.** Both prompts say so explicitly and
  neither treats it as instructions.
- **Prod databases are read-only** to the pipeline — `SELECT` only, and fixes
  ship as a PR rather than a direct change.
