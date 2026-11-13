const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");
const path = require("path");

const { check, DEFAULT_POLICY } = require("../lib/policy");

const P = { policy: { ...DEFAULT_POLICY } };
const bash = (command) => check("Bash", { command }, P);
const verdict = (command) => (bash(command) || { decision: "pass" }).decision;

test("kill: exact PIDs pass, everything else is denied", () => {
  for (const ok of ["kill 12345", "kill -9 12345", "kill -TERM 12345 12346", "kill -s KILL 4242", "kill -l", "lsof -t -iTCP:4319"]) {
    assert.equal(verdict(ok), "pass", ok);
  }
  for (const bad of [
    "pkill -f node",
    "killall Finder",
    "kill 0",
    "kill -9 -1",
    "kill -- -4242",
    "kill $PID",
    "kill $(lsof -t -iTCP:4319)",
    "kill `cat pid`",
    "lsof -t -i:3000 | xargs kill -9",
    "sudo pkill node",
    "kill %1",
    "cd /tmp && pkill -f vite",
  ]) {
    assert.equal(verdict(bad), "deny", bad);
  }
});

test("secrets: env dumps, process argv and .env reads are denied", () => {
  for (const bad of ["env", "env | grep TOKEN", "printenv", "printenv GITHUB_TOKEN", "export -p", "set", "ps aux", "ps -ef", "ps -o pid,args", "pgrep -fl node", "cat .env", "grep KEY ../.env.local", "gh auth token", "doppler secrets"]) {
    assert.equal(verdict(bad), "deny", bad);
  }
  for (const ok of ["env FOO=1 node x.js", "echo ${#GITHUB_TOKEN}", "ps -o pid=,comm= -p 123", "pgrep node", "cat .env.example", "sed -n 's/=.*//p' .env", "GH_TOKEN=$(gh auth token --user me) gh pr view 1", "doppler secrets --only-names"]) {
    assert.equal(verdict(ok), "pass", ok);
  }
  assert.equal(check("Read", { file_path: "/x/repo/.env" }, P).decision, "deny");
  assert.equal(check("Read", { file_path: "/x/repo/.env.example" }, P), null);
});

test("destructive git asks; ordinary git passes", () => {
  for (const ask of ["git push --force", "git push -f origin x", "git push --force-with-lease", "git push origin +main", "git push origin :old", "git reset --hard origin/main", "git clean -fdx", "git branch -D feat", "git -C /r worktree remove --force /w", "git stash drop"]) {
    assert.equal(verdict(ask), "ask", ask);
  }
  for (const ok of ["git push -u origin feat", "git push", "git reset HEAD~1", "git branch -d merged", "git worktree remove /w", "git status", "git commit -m 'fix: kill the flake'"]) {
    assert.equal(verdict(ok), "pass", ok);
  }
});

test("gh: PR workflow passes, merges and issue writes ask, review replies follow policy", () => {
  for (const ok of ["gh pr create --fill", "gh pr edit 12 --body x", "gh pr view 12", "gh api repos/o/r/pulls/12", "gh pr comment 12 -b hi", "gh api -X POST repos/o/r/pulls/12/comments/9/replies -f body=x"]) {
    assert.equal(verdict(ok), "pass", ok);
  }
  for (const ask of ["gh pr merge 12 --squash", "gh pr close 12", "gh issue create -t x", "gh api -X PATCH repos/o/r/issues/3 -f state=closed", "gh api graphql -f query=x", "curl -X POST https://hooks.slack.com/x -d '{}'"]) {
    assert.equal(verdict(ask), "ask", ask);
  }
  assert.equal(verdict("curl -s http://127.0.0.1:4319/api/state"), "pass");
});

test("policy overrides relax a category without touching the rails", () => {
  const relaxed = { policy: { ...DEFAULT_POLICY, prComments: "ask", chat: "allow" } };
  assert.equal(check("Bash", { command: "gh pr comment 1 -b x" }, relaxed).decision, "ask");
  assert.equal(check("mcp__acme__slack_send_message", { text: "hi" }, relaxed), null);
  assert.equal(check("Bash", { command: "pkill node" }, relaxed).decision, "deny");
});

test("mcp: reads pass, outward writes ask, local servers pass", () => {
  const ask = (n) => (check(n, {}, P) || { decision: "pass" }).decision;
  for (const n of ["mcp__acme__slack_send_message", "mcp__acme__slack_add_reaction", "mcp__acme__linear_save_issue", "mcp__acme__linear_save_comment", "mcp__acme__github_merge_pull_request", "mcp__acme__notion_notion-update-page", "mcp__acme__create_campaign", "mcp__mcp-modal__deploy_modal_app", "mcp__acme__send_slack_dm_as_maven"]) {
    assert.equal(ask(n), "ask", n);
  }
  for (const n of ["mcp__acme__slack_read_thread", "mcp__acme__slack_search_public_and_private", "mcp__acme__linear_get_issue", "mcp__acme__linear_list_issues", "mcp__acme__github_get_file_contents", "mcp__acme__github_create_pull_request", "mcp__datadog__search_datadog_logs", "mcp__acme__execute_sql", "mcp__chrome-devtools__click", "mcp__acme__slack_create-message-draft", "mcp__acme__get_project"]) {
    assert.equal(ask(n), "pass", n);
  }
});

test("the hook script speaks the PreToolUse protocol and fails open", () => {
  const hook = path.join(__dirname, "..", "harness", "hooks", "guard.js");
  const run = (stdin) => spawnSync(process.execPath, [hook], { input: stdin, encoding: "utf8" });

  const denied = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "pkill -f node" } }));
  assert.equal(denied.status, 0);
  const out = JSON.parse(denied.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, "PreToolUse");
  assert.equal(out.permissionDecision, "deny");

  const passed = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "kill 4242" } }));
  assert.equal(passed.status, 0);
  assert.equal(passed.stdout, "");

  const garbage = run("not json");
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, "");
});
