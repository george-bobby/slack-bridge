/**
 * The .env layer.
 *
 * Everything that is specific to *one* person's Slack workspace, Linear team
 * and repo lives in `.env` — never in the code, and never in a committed file.
 * `.env.example` documents every key; `.env` is gitignored.
 *
 * Hand-rolled rather than `dotenv` on purpose: this project has zero npm
 * dependencies and `node index.js` is meant to work with nothing installed.
 * Node's own `--env-file` would do, but it is a flag on every entry point
 * (including the ones launchd and the dashboard spawn), so a 40-line parser
 * that just works is the cheaper contract.
 *
 * Precedence: a real environment variable always wins over `.env`, so a
 * launchd plist or a one-off `SLACK_BRIDGE_PORT=4400 node index.js` still
 * overrides the file.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = process.env.SLACK_BRIDGE_ENV_FILE || path.join(ROOT, ".env");

/** KEY=value, one per line. `#` comments, blank lines, optional `export `,
 *  and single/double quotes around the value. Nothing more — a .env file that
 *  needs more than this wants to be a config file. */
function parse(text) {
  const out = {};
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    } else {
      // An unquoted trailing comment is the one convenience worth having.
      // `KEY=   # note` is an empty value, not the note.
      const hash = value.startsWith("#") ? 0 : value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

let fileEnv = {};
try {
  fileEnv = parse(fs.readFileSync(ENV_FILE, "utf8"));
} catch {
  // No .env is a valid state: every getter below has a default, and the
  // defaults are a working single-user setup minus the workspace-specific ids.
}

// Real env wins, so nothing here can shadow what launchd or a shell set.
for (const [k, v] of Object.entries(fileEnv)) {
  if (process.env[k] === undefined) process.env[k] = v;
}

function str(key, fallback = "") {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : String(v);
}

function num(key, fallback) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}

/** `Name:U123,Other:U456` -> [{ name, id }]. Used for the roster the pipeline
 *  weighs when deciding whether a thread earns a Linear ticket. */
function roster(key) {
  return str(key)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.lastIndexOf(":");
      return i < 0
        ? { name: entry, id: "" }
        : { name: entry.slice(0, i).trim(), id: entry.slice(i + 1).trim() };
    })
    .filter((p) => p.name);
}

/**
 * Every value the prompts and the code are parameterised on, resolved once.
 *
 * This is also the substitution table for `templates/` — see lib/render.js —
 * so a `{{SLACK_USER_ID}}` in a prompt and `env.slackUserId` in the server can
 * never drift apart.
 */
const env = {
  // --- who the bridge acts as ---------------------------------------------
  slackUserId: str("SLACK_USER_ID"),
  slackUserName: str("SLACK_USER_NAME", "the user"),
  githubLogin: str("GITHUB_LOGIN"),
  // owner/name of the repo PRs are opened against.
  githubRepo: str("GITHUB_REPO"),

  // --- what the pipeline works on ----------------------------------------
  targetRepo: str("TARGET_REPO"),
  targetScope: str("TARGET_SCOPE"),
  // Where a run creates its git worktree. Empty means a sibling folder of the
  // repo named `<repo>-worktrees`.
  worktreeRoot: str("WORKTREE_ROOT"),
  productName: str("PRODUCT_NAME", "the product"),
  productUrl: str("PRODUCT_URL"),

  // --- Linear -------------------------------------------------------------
  linearWorkspace: str("LINEAR_WORKSPACE"),
  linearTeam: str("LINEAR_TEAM"),
  linearProject: str("LINEAR_PROJECT"),
  linearIssuePrefix: str("LINEAR_ISSUE_PREFIX", "ISSUE"),

  // --- who gets a ticket filed for them, and who doesn't ------------------
  productTeam: roster("SLACK_PRODUCT_TEAM"),
  engineerTeam: roster("SLACK_ENGINEER_TEAM"),

  // --- runtime ------------------------------------------------------------
  port: num("SLACK_BRIDGE_PORT", 4319),
  launchdLabel: str("LAUNCHD_LABEL", "local.slack-bridge"),
  // launchd hands a job /usr/bin:/bin:/usr/sbin:/sbin and nothing else, so the
  // directories holding `claude` and `uvx` have to be named somewhere. The
  // dashboard runs under launchd and spawns every job, so its jobs inherit this.
  extraPath: str("EXTRA_PATH", `${process.env.HOME || "~"}/.local/bin:/opt/homebrew/bin`),
  // Which app "Open in terminal" drives. Only the two with an AppleScript
  // surface are wired up (see lib/jobs.js); anything else falls back to
  // handing you the command to paste.
  terminalApp: str("TERMINAL_APP", "Terminal"),
  pipelineModel: str("PIPELINE_MODEL", "opus"),

  // --- the harness --------------------------------------------------------
  // Branch names for tasks the harness spawns: `<prefix>/<slug>`. Defaults to
  // the GitHub login.
  branchPrefix: str("BRANCH_PREFIX", str("GITHUB_LOGIN", "task")),
  // Everything mutable. Overridden by the tests so they never touch the real
  // chats, tasks or config.
  dataDir: path.resolve(str("SB_DATA_DIR", path.join(ROOT, "data"))),
  // The agent binary. The tests point this at test/stub-claude.js, which
  // speaks the same stream-json and costs nothing.
  claudeBin: str("CLAUDE_BIN", "claude"),

  // Named in lib/render.js's "you haven't set this yet" error, so the message
  // points at the file the reader actually has to edit.
  ENV_FILE,
};

module.exports = env;
