/**
 * Candidate memories, held outside the memory directory until they earn a place.
 *
 * The failure mode this exists to prevent is the one `/addmem` had: a run that
 * banks a memory on every PR spends context forever on detail that mattered
 * once. The asymmetry is the whole problem — writing a memory is cheap, local
 * and immediate, while reading one is charged to every session from then on, so
 * a trigger that fires per-run is guaranteed to lose money over time.
 *
 * So a run never writes a memory. It writes a **proposal** here, under
 * `data/runs/memories/`, which no session ever loads and which therefore costs
 * nothing to be wrong about. Two things can then promote one:
 *
 *   - **Recurrence.** A proposal names the `territory` it is about. A second
 *     proposal in the same territory, from a different run, is the evidence
 *     that this is a pattern rather than an anecdote — and the promoted memory
 *     carries both citations, which is the shape the good hand-written ones
 *     already have ("Codex P2s on PRs #4086, #4127, #4244").
 *   - **You.** The dashboard can promote any proposal at any time. Recurrence
 *     is the bar for doing it unattended, not a rule about what you may keep.
 *
 * A proposal nobody promotes expires quietly. That is the intended outcome for
 * most of them, and it is free.
 */

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "data", "runs", "memories");

// How long a lone proposal waits for a second sighting before it is dropped.
// Long enough to span the gap between two runs hitting the same problem, short
// enough that the pile stays readable.
const EXPIRE_DAYS = 30;

// Proposals needed in one territory before it is ripe unattended. Two, because
// one is an anecdote and the second is the first evidence of a pattern.
const RECURRENCE = 2;

const VERDICTS = ["skip", "update", "create"];

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function safe(id) {
  return /^[A-Za-z0-9._-]+$/.test(String(id || "")) ? String(id) : "";
}

/** A territory is matched by exact string, so it has to be normalised on the
 *  way in — `Cache Invalidation` and `cache-invalidation` are the same ground,
 *  and a matcher that disagrees silently never finds the recurrence. */
function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function file(id) {
  return path.join(DIR, `${id}.json`);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeAtomic(p, value) {
  ensureDir();
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

/**
 * File one candidate from a run.
 *
 * `verdict: "skip"` is recorded rather than dropped: it is the answer for most
 * runs, and a skip you cannot see is a decision nobody can correct — the same
 * reasoning that keeps the poller's triage skips in the inbox.
 */
function propose(runId, p = {}) {
  const id = safe(runId);
  if (!id) throw new Error("bad run id");
  const verdict = VERDICTS.includes(p.verdict) ? p.verdict : "skip";
  const territory = slug(p.territory);
  if (verdict !== "skip" && !territory) throw new Error("a proposal needs a territory");
  if (verdict !== "skip" && !String(p.text || "").trim()) throw new Error("a proposal needs text");

  const record = {
    runId: id,
    proposedAt: Math.floor(Date.now() / 1000),
    status: "pending",
    verdict,
    territory,
    reason: String(p.reason || ""),
    // What this is evidence of: a PR, a thread, a ticket. Promotion concatenates
    // these, so a memory born of three runs cites all three.
    citation: String(p.citation || ""),
    workdir: String(p.workdir || ""),
    // For `update`: which memory this amends. For `create`: what to call it.
    target: String(p.target || ""),
    name: String(p.name || ""),
    title: String(p.title || ""),
    section: String(p.section || ""),
    text: String(p.text || ""),
  };
  writeAtomic(file(id), record);
  return record;
}

function all() {
  ensureDir();
  const out = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith(".json") || f.includes(".tmp-")) continue;
    const rec = readJson(path.join(DIR, f));
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => b.proposedAt - a.proposedAt);
}

function get(runId) {
  const id = safe(runId);
  return id ? readJson(file(id)) : null;
}

function setStatus(runId, status) {
  const rec = get(runId);
  if (!rec) throw new Error(`no such proposal: ${runId}`);
  rec.status = status;
  rec.resolvedAt = Math.floor(Date.now() / 1000);
  writeAtomic(file(rec.runId), rec);
  return rec;
}

/**
 * Resolve every pending proposal covering the same ground.
 *
 * Approving one consumes the evidence for all of them: the memory just written
 * is *about* that territory and cites the runs that argued for it. Leaving the
 * siblings pending would show the territory as "seen once, waiting for a second
 * run" immediately after it was remembered, and approving one again would fail
 * on a name that now exists.
 */
function resolveTerritory(territory, status) {
  const t = slug(territory);
  const touched = [];
  if (!t) return touched;
  for (const rec of all()) {
    if (rec.status !== "pending" || rec.territory !== t) continue;
    rec.status = status;
    rec.resolvedAt = Math.floor(Date.now() / 1000);
    writeAtomic(file(rec.runId), rec);
    touched.push(rec.runId);
  }
  return touched;
}

/**
 * Pending proposals grouped by the ground they cover.
 *
 * `ripe` is the unattended bar: either this territory has been proposed more
 * than once, or it amends a memory that already exists — an update is not new
 * context, so it does not need a second sighting to justify itself.
 */
function territories(existing = []) {
  const live = new Set(existing);
  const groups = new Map();
  for (const rec of all()) {
    if (rec.status !== "pending" || rec.verdict === "skip") continue;
    const g = groups.get(rec.territory) || { territory: rec.territory, proposals: [] };
    g.proposals.push(rec);
    groups.set(rec.territory, g);
  }
  return [...groups.values()]
    .map((g) => {
      const amends = g.proposals.find((p) => p.verdict === "update" && live.has(p.target));
      return {
        ...g,
        count: g.proposals.length,
        amends: amends ? amends.target : "",
        ripe: g.proposals.length >= RECURRENCE || !!amends,
        citations: g.proposals.map((p) => p.citation).filter(Boolean),
        newest: Math.max(...g.proposals.map((p) => p.proposedAt)),
      };
    })
    .sort((a, b) => Number(b.ripe) - Number(a.ripe) || b.newest - a.newest);
}

/**
 * Drop pending proposals nobody promoted.
 *
 * Only `pending` ones, and only by age: a proposal is a note about a run that
 * has already shipped, so losing it costs nothing that is not still in the PR,
 * the thread and the run's own transcript. This is the one thing here that is
 * safe to do automatically, which is exactly why it is the only thing that is.
 */
function expire(days = EXPIRE_DAYS) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const dropped = [];
  for (const rec of all()) {
    if (rec.status !== "pending" || rec.proposedAt >= cutoff) continue;
    try {
      fs.unlinkSync(file(rec.runId));
      dropped.push(rec.runId);
    } catch {
      /* already gone */
    }
  }
  return dropped;
}

module.exports = {
  propose,
  all,
  get,
  setStatus,
  resolveTerritory,
  territories,
  expire,
  slug,
  DIR,
  RECURRENCE,
  EXPIRE_DAYS,
};
