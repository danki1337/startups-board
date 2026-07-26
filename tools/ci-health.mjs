#!/usr/bin/env node
// A standing read of what GitHub Actions is actually doing, so "I get so many fails" becomes a
// question with an answer instead of an inbox.
//
// The point is the CLASSIFICATION, not the listing -- `gh run list` already lists. Most failures in
// this repo are one upstream (Common Crawl throttling us) and are self-healing; treating them the
// same as a broken build is what buried the real ones. This separates the two and only reports
// something as needing attention when it fails repeatedly or fails for a reason we own.
//
// Run: npm run ci:health          (add --json for machine output, --limit N to widen the window)

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const limit = Number(args[args.indexOf("--limit") + 1]) || 40;

// Failure causes that are upstream and self-healing. A run that fails only for these is noise; one
// that keeps failing for them is a rate-limit problem worth a config change, which the repeat
// counting below catches.
const TRANSIENT = [
  { pattern: /HTTP 503|HTTP 429|rate.?limit/i, cause: "upstream throttling (Common Crawl)" },
  { pattern: /Error: terminated|ECONNRESET|ETIMEDOUT|socket hang up/i, cause: "connection dropped mid-fetch" },
  { pattern: /The operation was canceled|cancelled/i, cause: "cancelled" },
];

const gh = (...argv) => execFileSync("gh", argv, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

function runs() {
  return JSON.parse(gh("run", "list", "--limit", String(limit), "--json",
    "databaseId,name,conclusion,status,headBranch,createdAt,event,workflowName"));
}

function classify(id) {
  let log = "";
  try {
    log = gh("run", "view", String(id), "--log-failed");
  } catch {
    // A run whose logs have expired cannot be classified; say so rather than guessing.
    return { cause: "logs unavailable", transient: false };
  }
  for (const { pattern, cause } of TRANSIENT) {
    if (pattern.test(log)) return { cause, transient: true };
  }
  const line = log.split("\n").find((l) => /##\[error\]|Error:/.test(l))?.trim();
  return { cause: line ? line.slice(-160) : "unknown", transient: false };
}

// A run can report `success` while jobs inside it failed: `continue-on-error: true` (the harvest
// shards use it, deliberately) makes GitHub swallow the job's failure at run level. Filtering on
// run conclusion alone therefore reported every discovery run as clean -- including one where all
// twelve shards died -- which is the exact blind spot this tool was written to remove. Jobs are
// the unit that fails; runs are just their envelope.
function failedJobs(runId) {
  try {
    const payload = JSON.parse(gh("run", "view", String(runId), "--json", "jobs"));
    return (payload.jobs ?? []).filter((job) => job.conclusion === "failure");
  } catch {
    return [];
  }
}

const all = runs();
const finished = all.filter((r) => r.status === "completed");
const failed = finished.filter((r) => r.conclusion === "failure");
// Green runs whose jobs failed under continue-on-error, counted alongside the red ones.
const greenWithFailedJobs = finished
  .filter((r) => r.conclusion === "success")
  .map((run) => ({ run, jobs: failedJobs(run.databaseId) }))
  .filter(({ jobs }) => jobs.length > 0);

const findings = [
  ...failed.map((run) => ({
    id: run.databaseId,
    workflow: run.workflowName,
    createdAt: run.createdAt,
    ...classify(run.databaseId),
  })),
  ...greenWithFailedJobs.map(({ run, jobs }) => ({
    id: run.databaseId,
    workflow: `${run.workflowName} (${jobs.length} shard${jobs.length === 1 ? "" : "s"} failed inside a green run)`,
    createdAt: run.createdAt,
    ...classify(run.databaseId),
  })),
];

// Same workflow failing the same way more than once is the thing worth acting on.
const repeats = new Map();
for (const f of findings) {
  const key = `${f.workflow} :: ${f.transient ? f.cause : "real"}`;
  repeats.set(key, (repeats.get(key) ?? 0) + 1);
}

const actionable = findings.filter((f) => !f.transient);
const summary = {
  window: `${finished.length} completed runs`,
  failed: findings.length,
  transient: findings.length - actionable.length,
  actionable: actionable.length,
  byWorkflow: Object.fromEntries(repeats),
  needsAttention: actionable.map(({ id, workflow, cause }) => ({ id, workflow, cause })),
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`\nLast ${finished.length} completed runs: ${findings.length} failed (${greenWithFailedJobs.length} hidden inside green runs)`);
  console.log(`  ${summary.transient} transient (upstream, self-healing)`);
  console.log(`  ${summary.actionable} need attention\n`);
  for (const [key, count] of repeats) console.log(`  ${String(count).padStart(3)}x  ${key}`);
  if (actionable.length) {
    console.log("\nNeeds attention:");
    for (const f of actionable) console.log(`  ${f.workflow} (run ${f.id})\n      ${f.cause}`);
  } else {
    console.log("\nNothing needs attention — every failure in this window was upstream.");
  }
}

// Exit non-zero only for failures we own, so this can gate a scheduled check without crying wolf.
process.exit(actionable.length ? 1 : 0);
