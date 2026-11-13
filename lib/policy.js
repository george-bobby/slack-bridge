/**
 * The write policy and safety rails, as one pure function.
 *
 *   check(toolName, toolInput) -> null | { decision: "deny" | "ask", reason, category }
 *
 * Called by harness/hooks/guard.js before every tool call in every session the
 * harness launches, and by the tests. Pure apart from reading the policy
 * overrides in data/config.json, so the same answer comes back from the hook,
 * the test suite and the dashboard's Settings preview.
 *
 * Two families of rule:
 *
 *  1. Safety rails: never right, so `deny` with the safe alternative in the
 *     reason. Kill by pattern / process group, env dumps, process listings
 *     that print argv (tokens live there), reading .env files, `rm -rf` of a
 *     home or root.
 *
 *  2. Destructive git and outward writes: right only with the user's OK on the
 *     exact call, so `ask`. The dashboard renders an `ask` as an Allow/Deny
 *     card with the full payload, which makes the card the "OK on the exact
 *     text" the harness requires. Each outward category can be relaxed to
 *     `allow` in config (`harness.policy`); the defaults are below.
 *
 * Deliberately conservative about what it can't parse: a `kill` whose target
 * is a variable or a command substitution is not an exact PID, so it is denied.
 */

const fs = require("fs");
const path = require("path");

const USER = process.env.SLACK_USER_NAME || require("./env").slackUserName || "the user";
const CONFIG = path.join(process.env.SB_DATA_DIR || path.join(__dirname, "..", "data"), "config.json");

/**
 * What each outward category does by default.
 *
 * prComments is `allow` because /resolve replies to every review thread as
 * part of the PR workflow already in use, and gating each reply would
 * make /resolve unusable. Merging stays with the user. Opening a PR, pushing to
 * it and editing its description are not outward writes here: they are how
 * work is handed over for review.
 */
const DEFAULT_POLICY = {
  chat: "ask", // Slack posts, reactions, canvases, DMs
  tickets: "ask", // Linear and GitHub issue writes
  docs: "ask", // Notion, Google Workspace
  prComments: "allow", // review replies and PR comments (/resolve)
  prMerge: "ask", // merging or closing a PR
  otherWrites: "ask", // any other connector write, outbound POSTs
  destructiveGit: "ask", // force-push, reset --hard, branch -D, clean -f
};

const CATEGORY_LABEL = {
  chat: "an outward chat write",
  tickets: "a ticket write",
  docs: "a doc write",
  prComments: "a PR comment",
  prMerge: "merging/closing a PR",
  otherWrites: "an outward write",
  destructiveGit: "a destructive git command",
};

function loadPolicy() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    const over = (raw.harness && raw.harness.policy) || {};
    const out = { ...DEFAULT_POLICY };
    for (const k of Object.keys(DEFAULT_POLICY)) {
      // destructiveGit can be relaxed to allow, never below ask-or-allow; an
      // unknown value keeps the default rather than widening anything.
      if (over[k] === "allow" || over[k] === "ask") out[k] = over[k];
    }
    return out;
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

const deny = (reason, category = "safety") => ({ decision: "deny", reason, category });

function gate(category, what, policy) {
  if (policy[category] !== "ask") return null;
  return {
    decision: "ask",
    category,
    reason: `${what} is ${CATEGORY_LABEL[category]}: it needs ${USER}'s OK on this exact call (harness write policy).`,
  };
}

/* ------------------------------------------------------------------ bash */

/**
 * Split a shell command into simple commands, roughly. Not a shell parser:
 * quoting is respected only well enough that `echo "a; b"` stays one command.
 * Command substitutions are split out as their own commands, which is what
 * lets `$(gh auth token)` pass while a bare `gh auth token` is refused.
 */
function segments(cmd) {
  const out = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"') {
        cur += c + (cmd[i + 1] || "");
        i++;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (c === "$" && cmd[i + 1] === "(") {
      out.push({ text: cur, sub: false });
      cur = "";
      i++;
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || c === "&" || c === "(" || c === ")" || c === "`") {
      out.push({ text: cur, sub: false });
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push({ text: cur, sub: false });
  return out.map((s) => s.text.trim()).filter(Boolean);
}

/** Whitespace tokens with surrounding quotes stripped, leading VAR=x dropped. */
function tokens(seg) {
  const t = (seg.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((x) => x.replace(/^(["'])(.*)\1$/, "$2"));
  while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t.shift();
  // Wrappers that run the next word as the command.
  while (t.length && ["sudo", "command", "exec", "nohup", "time", "builtin"].includes(t[0])) t.shift();
  return t;
}

const SIGNAL = /^-(\d{1,2}|[A-Z]{2,8}|SIG[A-Z]{2,8})$/;

function checkKill(t) {
  const args = t.slice(1);
  let i = 0;
  if (args[i] === "-s" || args[i] === "-n") i += 2;
  else if (args[i] && SIGNAL.test(args[i])) i += 1;
  if (args[i] === "-l" || args[i] === "-L") return null; // listing signals
  const targets = args.slice(i).filter((a) => a !== "--");
  if (!targets.length) return null;
  for (const a of targets) {
    if (!/^\d+$/.test(a)) {
      return deny(
        `kill target "${a}" is not an exact PID. Kill only an exact PID this session started (kill <pid>); never a pattern, a process group, a variable or a command substitution.`
      );
    }
    if (a === "0" || a === "1") return deny(`kill ${a} signals a whole process group or init. Kill only an exact PID this session started.`);
  }
  return null;
}

function checkPs(t) {
  const rest = t.slice(1).join(" ");
  const o = rest.match(/-o\s*(\S+)/);
  if (o) {
    const fields = o[1].split(",").map((f) => f.replace(/=.*$/, ""));
    if (fields.some((f) => /^(args|command|cmd|comm=.*args)$/.test(f))) {
      return deny("ps output fields include argv (args/command), which can hold tokens. Use `ps -o pid=,comm=` instead.");
    }
    return null;
  }
  if (!rest || /^-p\s*\d+$/.test(rest)) return deny("bare ps prints full command lines. Use `ps -o pid=,comm= [-p <pid>]`.");
  return deny("this ps form prints full command lines (argv can hold tokens). Use `ps -o pid=,comm=` (add -p <pid> or -A).");
}

const ENVFILE = /(^|\/)\.env(\.(?!example$|sample$|template$)[^/\s]+)?$/;

function checkBash(cmd, policy) {
  const c = String(cmd || "");

  // Anything piping into kill, or killing whatever a substitution printed.
  if (/\bxargs\b[^;&|\n]*\bkill\b/.test(c)) return deny("xargs kill is a kill by pattern. Look up the PID, then kill that exact PID.");
  if (/(^|[;&|\s(])kill\b[^;&|\n]*(\$\(|`|\$[A-Za-z_{])/.test(c)) {
    return deny("kill with a variable or command substitution is not an exact PID. Print the PID, check it is yours, then kill <pid>.");
  }
  // A bare token print. Inside $(...) it is consumed, not printed.
  if (/(^|[;&|\n]\s*)gh\s+auth\s+token\b/.test(c.trim()) && !/\$\(\s*gh\s+auth\s+token/.test(c)) {
    return deny("`gh auth token` on its own prints a secret. Use it only inside $(...) as GH_TOKEN=$(gh auth token --user <login>).");
  }

  for (const seg of segments(c)) {
    const t = tokens(seg);
    if (!t.length) continue;
    const [bin] = t;
    const base = path.basename(bin);

    if (base === "pkill" || base === "killall") {
      return deny(`${base} kills by pattern and can take down unrelated apps. Kill only an exact PID this session started.`);
    }
    if (base === "kill") {
      const v = checkKill(t);
      if (v) return v;
    }
    if (base === "printenv") return deny("printenv prints secret values. To check a variable, print its name and length: echo ${#VAR}.");
    if (base === "env" && (t.length === 1 || t.slice(1).every((a) => a.startsWith("-")))) {
      return deny("env with no command dumps every variable, secrets included. Check one with: echo ${#VAR}.");
    }
    if ((base === "export" && t[1] === "-p") || (base === "declare" && /^-[xp]/.test(t[1] || "")) || (base === "set" && t.length === 1)) {
      return deny(`${t.slice(0, 2).join(" ")} dumps variables, secrets included. Check one with: echo \${#VAR}.`);
    }
    if (base === "ps") {
      const v = checkPs(t);
      if (v) return v;
    }
    if (base === "pgrep" && t.some((a) => /^-[a-zA-Z]*[al]/.test(a))) {
      return deny("pgrep -a/-l prints command lines. Use plain `pgrep` (PIDs only), then `ps -o pid=,comm= -p <pid>`.");
    }
    if (["cat", "less", "more", "head", "tail", "grep", "rg", "sed", "awk", "bat", "strings", "xxd", "od"].includes(base)) {
      const f = t.slice(1).find((a) => !a.startsWith("-") && ENVFILE.test(a));
      // The one safe read: strip everything after `=` so only key names print.
      const namesOnly = base === "sed" && t.some((a) => /^s\/=\.\*\/\/p?$/.test(a));
      if (f && !namesOnly) return deny(`reading ${f} prints secret values. To check a key exists, print key names only: sed -n 's/=.*//p' ${f}.`);
    }
    if (base === "doppler" && t.includes("secrets") && !t.includes("--only-names")) {
      return deny("doppler secrets prints values. Use `doppler secrets --only-names`.");
    }
    if (base === "rm" && t.some((a) => /^-[a-zA-Z]*r/.test(a))) {
      const target = t.slice(1).find((a) => !a.startsWith("-"));
      if (target && /^(\/|~\/?|\$HOME\/?|\/Users\/[^/]+\/?|\.\.?\/?)$/.test(target)) {
        return deny(`rm -r ${target} would delete a home, root or the whole working directory.`);
      }
    }

    if (base === "git") {
      const v = checkGit(t, policy);
      if (v) return v;
    }
    if (base === "gh") {
      const v = checkGh(t, policy);
      if (v) return v;
    }
    if (base === "curl" || base === "wget" || base === "http") {
      const v = checkHttp(t, policy);
      if (v) return v;
    }
  }
  return null;
}

function checkGit(t, policy) {
  // Skip global options: git -C <dir> push ...
  let i = 1;
  while (t[i] && t[i].startsWith("-")) i += t[i] === "-C" || t[i] === "-c" ? 2 : 1;
  const sub = t[i];
  const args = t.slice(i + 1);
  const has = (re) => args.some((a) => re.test(a));
  const what = `git ${[sub, ...args].join(" ")}`.slice(0, 120);

  if (sub === "push") {
    if (has(/^(-f|--force|--force-with-lease.*|--force-if-includes|--mirror|--delete|-d|--prune)$/) || has(/^-[a-zA-Z]*f[a-zA-Z]*$/) || has(/^\+/) || has(/^:/)) {
      return gate("destructiveGit", what, policy);
    }
  }
  if (sub === "reset" && has(/^--hard$/)) return gate("destructiveGit", what, policy);
  if (sub === "clean" && has(/^-[a-zA-Z]*f/)) return gate("destructiveGit", what, policy);
  if (sub === "branch" && (has(/^-[a-zA-Z]*D/) || (has(/^(--delete|-d)$/) && has(/^(--force|-f)$/)))) return gate("destructiveGit", what, policy);
  if (sub === "worktree" && args[0] === "remove" && has(/^(--force|-f)$/)) return gate("destructiveGit", what, policy);
  if (sub === "filter-branch" || sub === "filter-repo" || (sub === "update-ref" && has(/^-d$/))) return gate("destructiveGit", what, policy);
  if (sub === "stash" && ["drop", "clear"].includes(args[0])) return gate("destructiveGit", what, policy);
  return null;
}

function checkGh(t, policy) {
  const [, group, verb] = t;
  const what = t.join(" ").slice(0, 140);
  if (group === "pr") {
    if (verb === "merge" || verb === "close") return gate("prMerge", what, policy);
    if (verb === "comment" || verb === "review") return gate("prComments", what, policy);
    return null; // create, edit, ready, view, checks, diff: the PR workflow
  }
  if (group === "issue" && ["create", "comment", "edit", "close", "delete", "reopen", "transfer", "lock"].includes(verb)) {
    return gate("tickets", what, policy);
  }
  if (group === "release" && ["create", "edit", "delete", "upload"].includes(verb)) return gate("otherWrites", what, policy);
  if (group === "repo" && ["create", "delete", "edit", "rename", "archive"].includes(verb)) return gate("otherWrites", what, policy);
  if (group === "api") {
    const method = (t.find((a, n) => (t[n - 1] === "-X" || t[n - 1] === "--method")) || "").toUpperCase();
    const implicitPost = t.some((a) => /^(-f|-F|--field|--raw-field|--input)$/.test(a));
    const write = (method && method !== "GET") || (!method && implicitPost);
    if (!write) return null;
    const endpoint = t.slice(2).find((a) => !a.startsWith("-") && /\//.test(a)) || "";
    if (/graphql/.test(endpoint)) return gate("otherWrites", what, policy);
    if (/\/merge\b/.test(endpoint)) return gate("prMerge", what, policy);
    if (/\/pulls\/\d+\/(comments|reviews)|\/comments\/\d+\/replies|\/pulls\/comments/.test(endpoint)) return gate("prComments", what, policy);
    if (/\/issues\/\d+\/comments/.test(endpoint)) return gate("prComments", what, policy);
    if (/\/issues/.test(endpoint)) return gate("tickets", what, policy);
    return gate("otherWrites", what, policy);
  }
  return null;
}

function checkHttp(t, policy) {
  const url = t.find((a) => /^https?:\/\//.test(a)) || "";
  if (!url || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(url + "/")) return null;
  const method = (t.find((a, n) => t[n - 1] === "-X" || t[n - 1] === "--request") || "").toUpperCase();
  const sendsBody = t.some((a) => /^(-d|--data.*|-F|--form|--json|-T|--upload-file)$/.test(a));
  if ((method && method !== "GET" && method !== "HEAD") || sendsBody) {
    return gate("otherWrites", `${t[0]} ${method || "POST"} ${url}`.slice(0, 140), policy);
  }
  return null;
}

/* ------------------------------------------------------------------- mcp */

const READ_VERB = /^(get|list|search|read|fetch|find|lookup|query|describe|inspect|view|check|analy[sz]e|aggregate|explain|estimate|summari[sz]e|rank|recommend|whoami|download|extract|validate|preview|export|discover|load|guide|ask|forecast|diff|explore|filter|pull|batch_get|retrieve|render|detect|score_profile|my_|can_|maven_studio|maven_check|ddsql_(get|read|schema|search|validate|run)|brain_|company_brain|customer_brain|talent_docs|mercor_docs|lit_|exa_|parallel_|nyne_|devin_(ask|read|list)|dd_)/;
// Servers whose writes stay on this machine or in the user's own private space.
const LOCAL_SERVER = /^(chrome-devtools|claude-vscode|claude_ai_Claude_Docs|skl|ide)$/;

function checkMcp(name, input, policy) {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(name);
  if (!m) return null;
  const [, server, tool] = m;
  if (LOCAL_SERVER.test(server)) return null;
  const t = tool.toLowerCase().replace(/-/g, "_");
  const what = `${tool}`;

  // Drafts are not sent; reading is not writing.
  if (/draft/.test(t) && !/send_message$/.test(t)) return null;

  if (/slack/.test(t)) {
    if (/(^|_)(read|list|search|get|lookup|download|open_conversation)/.test(t)) return null;
    return gate("chat", what, policy);
  }
  if (/^linear_/.test(t)) {
    if (/^linear_(get|list|search|extract|whoami)/.test(t)) return null;
    return gate("tickets", what, policy);
  }
  if (/^github_/.test(t)) {
    if (/^github_(get|list|search|pull_request_read|issue_read|ui_get|actions_get|actions_list|run_secret_scanning)/.test(t)) return null;
    if (/merge_pull_request/.test(t)) return gate("prMerge", what, policy);
    if (/reply_to_pull_request_comment|pull_request_review_write|add_comment_to_pending_review|request_copilot_review/.test(t)) return gate("prComments", what, policy);
    if (/create_pull_request$|update_pull_request(_branch)?$|create_branch|push_files|create_or_update_file/.test(t)) return null; // the PR workflow
    if (/issue|sub_issue/.test(t)) return gate("tickets", what, policy);
    return gate("otherWrites", what, policy);
  }
  if (/notion/.test(t)) {
    if (/notion_(fetch|search|get|list|query|view|read|download|memory_search|connector_search)/.test(t)) return null;
    return gate("docs", what, policy);
  }
  if (/^google_workspace_.*_call$/.test(t)) {
    // These multiplex reads and writes behind one tool; the method name says which.
    const method = String((input && (input.method || input.operation || input.name)) || "").toLowerCase();
    if (method && /(^|\.)(get|list|search|watch|export)$/.test(method.split(".").pop())) return null;
    return gate(/gmail|chat/.test(t) ? "chat" : "docs", what, policy);
  }
  if (/^send_|_send_|^launch_|^activate_|^deploy_|^run_modal|^manage_modal|^merge/.test(t)) return gate("otherWrites", what, policy);
  if (READ_VERB.test(t)) return null;
  if (/^(execute_sql|execute_code|datadog_execute_code|depot_ci_methods|upload_get_url|upload_list|upload_get_download_url)$/.test(t)) return null;
  return gate("otherWrites", what, policy);
}

/* ----------------------------------------------------------------- entry */

function check(toolName, toolInput = {}, { policy = loadPolicy() } = {}) {
  const name = String(toolName || "");
  const input = toolInput || {};
  if (name === "Bash") return checkBash(input.command, policy);
  if (name === "Read" || name === "Grep" || name === "NotebookRead") {
    const p = String(input.file_path || input.path || "");
    if (ENVFILE.test(p)) return deny(`reading ${path.basename(p)} prints secret values. Check key names only, never values.`);
    return null;
  }
  if (name.startsWith("mcp__")) return checkMcp(name, input, policy);
  return null;
}

module.exports = { check, loadPolicy, DEFAULT_POLICY, segments };
