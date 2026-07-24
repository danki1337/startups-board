import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { INVALID_CLOSE_STRIKES, nextSyncAt, PROVIDER_QUEUE_BINDINGS } from "../cloudflare/src/config.mjs";
import { applyBoardSnapshot, suppressDuplicatedAggregatorJobs } from "../cloudflare/src/database.mjs";
import { parseAtsUrl } from "../src/providers.mjs";

// A D1 stand-in that answers the two dedup probes from a fixed set of "active native" rows: the
// (provider, source_id) seek and the primary-key seek. It filters the bound params exactly as the
// real index-backed queries would, so the test exercises grouping, chunking, and key-vs-source-id
// routing rather than the SQL itself.
function stubNativeDb({ sourceIds = new Set(), keys = new Set() } = {}) {
  return {
    prepare(sql) {
      let bound = [];
      const statement = {
        bind(...args) {
          // D1 rejects a query with more than 100 bound parameters; mirror that so a too-large
          // IN(...) chunk fails the test the way it fails production rather than passing silently.
          assert.ok(args.length <= 100, `query exceeded D1's 100 bound-parameter limit: ${args.length}`);
          bound = args;
          return statement;
        },
        // eslint-disable-next-line require-await
        async all() {
          if (/SELECT key FROM jobs/.test(sql)) {
            return { results: bound.filter((key) => keys.has(key)).map((key) => ({ key })) };
          }
          const [provider, ...ids] = bound;
          return {
            results: ids
              .filter((id) => sourceIds.has(`${provider}:${id}`))
              .map((sourceId) => ({ sourceId })),
          };
        },
      };
      return statement;
    },
  };
}

test("production refresh cadence is adaptive", () => {
  const now = Date.UTC(2026, 6, 21, 0, 0, 0);
  assert.equal(nextSyncAt("active", 0, now), "2026-07-21T12:00:00.000Z");
  assert.equal(nextSyncAt("empty", 0, now), "2026-07-25T00:00:00.000Z");
  assert.equal(nextSyncAt("invalid", 0, now), "2026-08-20T00:00:00.000Z");
  assert.equal(nextSyncAt("error", 2, now), "2026-07-21T01:00:00.000Z");
});

test("every production ATS has an isolated queue binding", () => {
  assert.deepEqual(Object.keys(PROVIDER_QUEUE_BINDINGS).sort(), [
    "ashby", "bamboohr", "gem", "getro", "greenhouse", "icims", "lever", "paylocity",
    "rippling", "smartrecruiters", "sparkhire", "workday",
  ]);
});

test("aggregator ingestion drops jobs whose native ATS twin is already active", async () => {
  const workdayBoard = parseAtsUrl("https://acme.wd5.myworkdayjobs.com/External");
  const db = stubNativeDb({
    sourceIds: new Set(["greenhouse:111", "ashby:uuid-a"]),
    keys: new Set([`${workdayBoard.key}:Engineer_R1`]),
  });
  const incoming = [
    { url: "https://boards.greenhouse.io/acme/jobs/111" }, // dupe: gh 111 is active
    { url: "https://boards.greenhouse.io/rebrand/jobs/999" }, // unique: gh 999 not active
    { url: "https://jobs.ashbyhq.com/acme/uuid-a" }, // dupe
    { url: "https://acme.wd5.myworkdayjobs.com/External/job/Berlin/Engineer_R1" }, // dupe: key match
    { url: "https://acme.wd5.myworkdayjobs.com/External/job/Berlin/Engineer_R2" }, // unique
    { url: "https://www.amazon.jobs/en/jobs/5/swe" }, // unique: career site we don't crawl
  ];

  const kept = await suppressDuplicatedAggregatorJobs(db, incoming);

  assert.deepEqual(kept.map((job) => job.url), [
    "https://boards.greenhouse.io/rebrand/jobs/999",
    "https://acme.wd5.myworkdayjobs.com/External/job/Berlin/Engineer_R2",
    "https://www.amazon.jobs/en/jobs/5/swe",
  ]);
});

test("aggregator dedup chunks large boards under D1's bind-parameter limit", async () => {
  // A single Getro board can carry hundreds of same-provider jobs; the (provider, source_id) probe
  // must split so no query binds provider + more than 99 ids (the boundary that broke in prod).
  const total = 250;
  const active = new Set();
  const incoming = [];
  for (let i = 0; i < total; i += 1) {
    incoming.push({ url: `https://boards.greenhouse.io/acme/jobs/${i}` });
    if (i % 2 === 0) active.add(`greenhouse:${i}`); // even ids have an active native twin
  }

  const kept = await suppressDuplicatedAggregatorJobs(stubNativeDb({ sourceIds: active }), incoming);

  // Only the odd ids (no native twin) survive.
  assert.equal(kept.length, total / 2);
  assert.ok(kept.every((job) => Number(job.url.split("/").at(-1)) % 2 === 1));
});

test("production migration includes search, health, discovery, and failure state", async () => {
  const sql = await readFile(new URL("../cloudflare/migrations/0001_production.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS provider_health/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS discovery_pages/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS failed_tasks/);
});

// A D1 stand-in that records every statement it is asked to run, so a test can assert on what the
// ingestion path *did* rather than on its return value. `first` answers the failure-count probe.
function recordingDb(failureCount = 0) {
  const statements = [];
  const statement = (sql) => ({
    bind(...args) {
      statements.push({ sql, args });
      return this;
    },
    async run() {
      return { meta: { changes: 0 } };
    },
    async all() {
      return { results: [] };
    },
    async first() {
      return { failureCount };
    },
  });
  return {
    statements,
    prepare(sql) {
      statements.push({ sql, args: null });
      return statement(sql);
    },
    async batch(list) {
      return list.map(() => ({ meta: { changes: 0 } }));
    },
  };
}

const ran = (db, pattern) => db.statements.some((entry) => pattern.test(entry.sql));

test("an invalid board response never closes the board's jobs", async () => {
  // "invalid" covers a 4xx, a bot challenge and a proxy-truncated body as well as a genuinely dead
  // board. Acting on one of them used to close every posting on the board.
  const db = recordingDb(0);
  const result = await applyBoardSnapshot(db, {
    board: {
      key: "greenhouse:global:acme", provider: "greenhouse", identifier: "acme",
      status: "invalid", jobCount: 0, syncedAt: "2026-07-24T10:00:00.000Z", error: "403",
    },
    jobs: [],
  });

  assert.equal(result.closedJobs, 0);
  assert.equal(result.retry, false);
  // It must not even read the board's current jobs, let alone write closures.
  assert.equal(ran(db, /FROM jobs WHERE board_key/), false);
  assert.equal(ran(db, /UPDATE jobs SET[\s\S]*is_active = 0/), false);
  // It is recorded as a failure, so repeated invalids can eventually justify a close.
  assert.equal(ran(db, /UPDATE boards SET[\s\S]*failure_count/), true);
});

test("a board that is invalid often enough does accept the empty snapshot", async () => {
  // At the strike threshold the close pass is allowed to run, so a genuinely dead board is still
  // cleaned up -- just on corroborated evidence rather than a single bad response.
  const db = recordingDb(INVALID_CLOSE_STRIKES - 1);
  await applyBoardSnapshot(db, {
    board: {
      key: "greenhouse:global:acme", provider: "greenhouse", identifier: "acme",
      status: "invalid", jobCount: 0, syncedAt: "2026-07-24T10:00:00.000Z", error: "404",
    },
    jobs: [],
  });

  assert.equal(ran(db, /FROM jobs WHERE board_key/), true);
});
