const test = require("node:test");
const assert = require("node:assert");
const { parseReport } = require("../lib/tasks");

test("parseReport reads the contract and is lenient about the rest", () => {
  const r = parseReport(`---
status: needs-input
pr: none (not opened)
---
## TL;DR
Half done.

## Open questions
- CSV or JSON? I recommend CSV
  because the export page already speaks it.
- Allow-list next=?

## Action requests
- None. Pushing was not requested; say so and I will push.
`);
  assert.equal(r.status, "needs-input");
  assert.equal(r.tldr, "Half done.");
  assert.equal(r.questions.length, 2);
  assert.match(r.questions[0], /because the export page/);
  assert.deepEqual(r.actions, []);
  assert.equal(r.fields.pr, "none (not opened)");

  assert.equal(parseReport("just prose, no frontmatter").status, "unknown");
  assert.deepEqual(parseReport("## Open questions\nNone\n").questions, []);
  assert.deepEqual(parseReport("## Action requests\n1. Post 'hi' in #eng\n").actions, ["Post 'hi' in #eng"]);
});
