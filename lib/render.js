#!/usr/bin/env node
/**
 * Render `templates/` into `.claude/` with this machine's .env baked in.
 *
 * The poller command and the pipeline skill are prompts, not code: a running
 * Claude session cannot read `process.env`, so the Slack ids, the repo path and
 * the Linear parameters have to be *substituted in* before the session starts.
 * `./install.sh` calls this, then symlinks the result into `~/.claude`.
 *
 * That is why `templates/` is committed and `.claude/commands|skills` are
 * gitignored — the templates are the source, the rendered copies are yours.
 *
 * A `{{TOKEN}}` with no value is a hard error, not an empty string: a prompt
 * that silently searched Slack for `<@>` would poll forever and find nothing.
 * The two optional-by-design blocks are handled explicitly below.
 */

const fs = require("fs");
const path = require("path");

const env = require("./env");

const ROOT = path.join(__dirname, "..");
const TEMPLATES = path.join(ROOT, "templates");
const OUT = {
  "scan-mentions.md": path.join(ROOT, ".claude", "commands", "scan-mentions.md"),
  "slack-fetch-pipeline/SKILL.md": path.join(
    ROOT,
    ".claude",
    "skills",
    "slack-fetch-pipeline",
    "SKILL.md"
  ),
};

/** A roster as a prose list the prompt can read: `Alice \`U01\`, Bob \`U02\``. */
function rosterLine(people, ifEmpty) {
  if (!people.length) return ifEmpty;
  return people.map((p) => `${p.name} \`${p.id}\``).join(", ");
}

function table() {
  const scope = env.targetScope || "the whole repo";
  return {
    PROJECT_DIR: ROOT,
    SLACK_USER_ID: env.slackUserId,
    SLACK_USER_NAME: env.slackUserName,
    GITHUB_LOGIN: env.githubLogin,
    TARGET_REPO: env.targetRepo,
    TARGET_SCOPE: scope,
    PRODUCT_NAME: env.productName,
    PRODUCT_URL: env.productUrl,
    PIPELINE_MODEL: env.pipelineModel,
    LINEAR_BOT_USER_ID: env.linearBotUserId,
    LINEAR_WORKSPACE: env.linearWorkspace,
    LINEAR_PROJECT: env.linearProject,
    LINEAR_PRIORITY: env.linearPriority,
    LINEAR_STATUS: env.linearStatus,
    LINEAR_ISSUE_PREFIX: env.linearIssuePrefix,
    // The exact message the pipeline posts. Assembled here so the skill's
    // "send that verbatim" is a single token it cannot paraphrase.
    LINEAR_COMMAND: `<@${env.linearBotUserId}> create an issue, project ${env.linearProject}, prio ${env.linearPriority}, assignee me, status ${env.linearStatus}`,
    PRODUCT_TEAM_LIST: rosterLine(
      env.productTeam,
      "(no product-side roster configured — judge by the request itself)"
    ),
    ENGINEER_TEAM_LIST: rosterLine(
      env.engineerTeam,
      "(no engineering roster configured — judge by the request itself)"
    ),
  };
}

function render(text, values, file) {
  const missing = new Set();
  const out = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, key) => {
    const v = values[key];
    if (v === undefined || v === "") {
      missing.add(key);
      return whole;
    }
    return String(v);
  });
  if (missing.size) {
    throw new Error(
      `${file}: no value for ${[...missing].join(", ")} — set ${missing.size > 1 ? "them" : "it"} in ${env.ENV_FILE} (see .env.example)`
    );
  }
  return out;
}

function main() {
  const values = table();
  const written = [];
  for (const [rel, dest] of Object.entries(OUT)) {
    const src = path.join(TEMPLATES, rel);
    const text = fs.readFileSync(src, "utf8");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, render(text, values, rel));
    written.push(dest);
  }
  return written;
}

if (require.main === module) {
  try {
    for (const f of main()) console.log(`  rendered ${path.relative(ROOT, f)}`);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { render, table, main };
