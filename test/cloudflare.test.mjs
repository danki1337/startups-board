import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  INVALID_CLOSE_STRIKES,
  isRateLimitError,
  nextSyncAt,
  PROVIDER_QUEUE_BINDINGS,
} from "../cloudflare/src/config.mjs";
import { applyBoardSnapshot, suppressDuplicatedAggregatorJobs } from "../cloudflare/src/database.mjs";
import { parseAtsUrl } from "../src/providers.mjs";

// A D1 stand-in that answers the two dedup probes from a fixed set of "active native" rows: the
// (provider, source_id) seek and the primary-key seek. It filters the bound params exactly as the
// real index-backed queries would, so the test exercises grouping, chunking, and key-vs-source-id
// routing rather than the SQL itself.
function stubNativeDb({ sourceIds = new Set(), keys = new Set(), inactiveKeys = new Set(), twinWinners = new Map() } = {}) {
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
          if (/min\(board_key\) AS winner/.test(sql)) {
            // The aggregator self-dedup probe: source_id -> smallest board_key holding it active.
            const [, ...ids] = bound;
            return {
              results: ids
                .filter((id) => twinWinners.has(String(id)))
                .map((id) => ({ sourceId: id, winner: twinWinners.get(String(id)) })),
            };
          }
          if (/SELECT key, is_active AS isActive FROM jobs/.test(sql)) {
            // The key probe deliberately carries no is_active predicate -- with one, the planner
            // scanned every active row through a covering index instead of probing the primary key
            // (1.48B rows read a day). The stub answers the way the real table does: a row per
            // existing key, active or not, and the caller filters.
            assert.doesNotMatch(sql, /is_active = 1/);
            return {
              results: bound
                .filter((key) => keys.has(key) || inactiveKeys.has(key))
                .map((key) => ({ key, isActive: inactiveKeys.has(key) ? 0 : 1 })),
            };
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
  // An active board rides a ladder keyed on how many consecutive refreshes found nothing, rather
  // than the flat 12h every board used to share. Measured on production, 69.2% of refreshes changed
  // no row at all, and the waste was stratified: 13,326 boards changed on none of their 6 refreshes
  // over 3 days while ~2,000 changed on every one.
  assert.equal(nextSyncAt("active", 0, now, 0), "2026-07-21T03:00:00.000Z", "just changed: look again soon");
  assert.equal(nextSyncAt("active", 0, now, 1), "2026-07-21T06:00:00.000Z");
  // 12h is the FLOOR of freshness, not a waypoint on the way to 48h. The ladder used to run on to
  // 24h and 48h, and 59% of active boards had settled on that last rung -- so a posting an employer
  // pulled just after a refresh stayed listed for up to two days. Quietness predicts that a board
  // will not ADD anything; it says nothing about whether it will close a role.
  assert.equal(nextSyncAt("active", 0, now, 2), "2026-07-21T12:00:00.000Z", "dormant: twice a day, and no slower");
  assert.equal(nextSyncAt("active", 0, now, 3), "2026-07-21T12:00:00.000Z");
  assert.equal(nextSyncAt("active", 0, now, 4), "2026-07-21T12:00:00.000Z");
  // Past the end of the ladder, and below its start, still land on a real rung. An out-of-range
  // index would make the interval NaN and the board unschedulable for good. Boards carrying a
  // quiet_syncs of 3 or 4 from the old five-rung ladder land here, which is why no migration is
  // needed to bring them back down.
  assert.equal(nextSyncAt("active", 0, now, 99), "2026-07-21T12:00:00.000Z");
  assert.equal(nextSyncAt("active", 0, now, -3), "2026-07-21T03:00:00.000Z");
  assert.equal(nextSyncAt("active", 0, now, Number.NaN), "2026-07-21T03:00:00.000Z");
  // Omitting the argument keeps the fast rung, so a caller that does not track quietness still
  // schedules something sane.
  assert.equal(nextSyncAt("active", 0, now), "2026-07-21T03:00:00.000Z");

  // The other statuses are unchanged -- the ladder is only for boards that are actually serving.
  assert.equal(nextSyncAt("empty", 0, now), "2026-07-25T00:00:00.000Z");
  assert.equal(nextSyncAt("invalid", 0, now), "2026-08-20T00:00:00.000Z");
  assert.equal(nextSyncAt("error", 2, now), "2026-07-21T01:00:00.000Z");
});

// The board UPDATE binds, in order: status, jobCount, now, nextSyncAt, quietSyncs, companyKey,
// now, key.
const boardUpdate = (db) => db.statements.find((entry) => /UPDATE boards SET\s+status/.test(entry.sql) && entry.args);

const snapshot = (jobs) => ({
  board: {
    key: "ashby:global:acme", provider: "ashby", identifier: "acme", status: "active",
    jobCount: jobs.length, syncedAt: "2026-07-21T00:00:00.000Z", error: null,
  },
  jobs,
});
const sampleJob = (id) => ({
  key: `ashby:global:acme:${id}`, sourceId: id, boardKey: "ashby:global:acme", provider: "ashby",
  companyIdentifier: "acme", title: "Engineer", url: `https://jobs.ashbyhq.com/acme/${id}`,
});

test("a refresh that finds nothing moves the board one rung down the ladder", async () => {
  // The board has already come back empty once; a second empty refresh takes it to rung 2 (12h),
  // which is the bottom of the ladder.
  const db = recordingDb(0, { quietSyncs: 1, changes: 0 });
  await applyBoardSnapshot(db, snapshot([]));
  const [, , , nextSyncAtArg, quiet] = boardUpdate(db).args;
  assert.equal(quiet, 2);
  assert.equal(nextSyncAtArg, "2026-07-21T12:00:00.000Z", "rung 2 is 12h out");
});

test("a refresh that writes something puts the board straight back on the fast rung", async () => {
  // Same board, same history -- but this snapshot writes a job, so the counter resets rather than
  // decaying one step at a time. That is the whole point: a board that starts posting again is
  // picked up on the next 3-hour cycle, not after climbing back up the ladder.
  const db = recordingDb(0, { quietSyncs: 4, changes: 1 });
  await applyBoardSnapshot(db, snapshot([sampleJob("a")]));
  const [, , , nextSyncAtArg, quiet] = boardUpdate(db).args;
  assert.equal(quiet, 0);
  assert.equal(nextSyncAtArg, "2026-07-21T03:00:00.000Z", "rung 0 is 3h out");
});

test("the quiet counter cannot climb past the end of the ladder", async () => {
  const db = recordingDb(0, { quietSyncs: 99, changes: 0 });
  await applyBoardSnapshot(db, snapshot([]));
  const [, , , nextSyncAtArg, quiet] = boardUpdate(db).args;
  assert.equal(quiet, 2, "clamped to the last rung");
  assert.equal(nextSyncAtArg, "2026-07-21T12:00:00.000Z");
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
function recordingDb(failureCount = 0, options = {}) {
  const statements = [];
  // How many rows each write reports. applyBoardSnapshot sums these into changedJobs/closedJobs,
  // which is what decides whether the board looked busy or quiet this refresh.
  const changes = options.changes ?? 0;
  const statement = (sql) => ({
    sql,
    bind(...args) {
      statements.push({ sql, args });
      return this;
    },
    async run() {
      return { meta: { changes } };
    },
    async all() {
      return { results: [] };
    },
    async first() {
      // recordBoardFailure now also reads the board's current status: strikes only count while
      // consecutive failures are of the SAME kind. Tests that need a specific prior kind pass it
      // via options.boardStatus.
      return { failureCount, status: options.boardStatus ?? (failureCount > 0 ? "invalid" : "active") };
    },
  });
  return {
    statements,
    prepare(sql) {
      statements.push({ sql, args: null });
      return statement(sql);
    },
    async batch(list) {
      // The jobs read and the board's quiet_syncs probe share one batch, so the stub has to answer
      // both shapes. Everything else only cares about meta.changes.
      return list.map((entry) => ({
        meta: { changes },
        results: /quiet_syncs/.test(entry?.sql ?? "")
          ? [{ quietSyncs: options.quietSyncs ?? 0 }]
          : /FROM jobs WHERE board_key/.test(entry?.sql ?? "")
            ? options.currentJobs ?? []
            : [],
      }));
    },
  };
}

const ran = (db, pattern) => db.statements.some((entry) => pattern.test(entry.sql));

test("a refresh writes its sync_runs row once, with the final status", async () => {
  // The row used to be INSERTed as 'running' and UPDATEd at completion: two index-amplified writes
  // per refresh, ~113,000 times a day, to detect abandonment the queue already detects (an unacked
  // message redelivers; a stuck 'queued' board is reclaimed after 2 hours).
  const db = recordingDb(0, { changes: 1 });
  await applyBoardSnapshot(db, snapshot([sampleJob("a")]));
  const runs = db.statements.filter((entry) => /INTO sync_runs/.test(entry.sql) && entry.args);
  assert.equal(runs.length, 1);
  assert.match(runs[0].sql, /'complete'/);
  assert.equal(ran(db, /'running'/), false);
  assert.equal(ran(db, /UPDATE sync_runs/), false);
});

test("a rate-limited refresh backs off hours, not the error ladder's minutes", async () => {
  // Three prior failures on record; this 429 is the fourth. The 15-minute ladder would try again
  // in 4 hours at most and re-enter the same provider-wide limit -- production measured 45,687
  // Paylocity refreshes burned that way in a single day.
  const db = recordingDb(3, { boardStatus: "error" });
  await applyBoardSnapshot(db, {
    board: {
      key: "paylocity:global:x", provider: "paylocity", identifier: "x", status: "error",
      jobCount: 0, syncedAt: "2026-07-26T00:00:00.000Z", error: "HTTP 429 from recruiting.paylocity.com",
    },
    jobs: [],
  });
  const update = db.statements.find((entry) => /UPDATE boards SET status/.test(entry.sql) && entry.args);
  const hours = (Date.parse(update.args[3]) - Date.parse("2026-07-26T00:00:00.000Z")) / 3_600_000;
  // failure_count 4 doubles to a 16h base; the ±25% jitter is the point, so assert the band.
  assert.ok(hours >= 12 && hours <= 20, `expected ~16h jittered backoff, got ${hours.toFixed(1)}h`);
  // The failed run is also a single final-status INSERT.
  const runs = db.statements.filter((entry) => /INTO sync_runs/.test(entry.sql) && entry.args);
  assert.equal(runs.length, 1);
  assert.match(runs[0].sql, /'error'/);
});

test("rate-limit detection matches the messages production records", () => {
  assert.equal(isRateLimitError("HTTP 429 from recruiting.paylocity.com"), true);
  assert.equal(isRateLimitError("HTTP 530 from api.getro.com"), true);
  assert.equal(isRateLimitError("HTTP 404 from boards-api.greenhouse.io"), false);
  assert.equal(isRateLimitError("Expected Paylocity window.pageData"), false);
  assert.equal(isRateLimitError(null), false);
});

test("an inactive native twin does not suppress the aggregator's copy", async () => {
  // The key probe returns existing rows whether active or not (the is_active filter moved out of
  // the SQL to keep the primary key driving the plan) -- so the JS filter is what protects a job
  // whose native posting has closed: the aggregator's live copy must survive.
  const workdayBoard = parseAtsUrl("https://acme.wd5.myworkdayjobs.com/External");
  const db = stubNativeDb({ inactiveKeys: new Set([`${workdayBoard.key}:Engineer_R1`]) });
  const incoming = [{ url: "https://acme.wd5.myworkdayjobs.com/External/job/Berlin/Engineer_R1" }];
  const kept = await suppressDuplicatedAggregatorJobs(db, incoming);
  assert.equal(kept.length, 1);
});

test("wrangler.jsonc declares a producer and consumer for every provider binding", async () => {
  // The hardcoded-literal test above pins config.mjs; this one bridges to wrangler.jsonc, which is
  // what deploy actually demands. Rippling and SmartRecruiters once existed in wrangler and nowhere
  // else -- one drift event across three files, caught by none of them.
  const raw = await readFile(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
  const producerBindings = new Set(config.queues.producers.map((producer) => producer.binding));
  for (const binding of Object.values(PROVIDER_QUEUE_BINDINGS)) {
    assert.ok(producerBindings.has(binding), `wrangler.jsonc has no producer for ${binding}`);
  }
  const consumers = new Set(config.queues.consumers.map((consumer) => consumer.queue));
  for (const producer of config.queues.producers) {
    assert.ok(consumers.has(producer.queue), `queue ${producer.queue} has a producer but no consumer`);
  }
});

test("a hollow empty snapshot for a stocked board records a strike instead of closing", async () => {
  // Zero jobs in a 200 that parsed, for a board with 12 active postings: a bot challenge that
  // happened to be valid JSON, not a company that closed every role overnight. This used to walk
  // straight down the success path and close all 12 unwitnessed.
  const active = Array.from({ length: 12 }, (_, index) => ({
    key: `k${index}`, sourceId: `s${index}`, fingerprint: `f${index}`, isActive: 1,
  }));
  const db = recordingDb(0, { currentJobs: active, boardStatus: "active" });
  const result = await applyBoardSnapshot(db, snapshot([]));
  assert.equal(result.closedJobs, 0);
  assert.equal(ran(db, /UPDATE jobs SET is_active = 0/), false);
  assert.equal(ran(db, /UPDATE boards SET status[\s\S]*failure_count/), true, "recorded as a failure");
});

test("a small board emptying out still closes without ceremony", async () => {
  // Winding down to zero one posting at a time is how boards genuinely empty; below the guard
  // threshold the empty snapshot is accepted immediately.
  const active = Array.from({ length: 3 }, (_, index) => ({
    key: `k${index}`, sourceId: `s${index}`, fingerprint: `f${index}`, isActive: 1,
  }));
  const db = recordingDb(0, { currentJobs: active, changes: 1 });
  await applyBoardSnapshot(db, snapshot([]));
  assert.equal(ran(db, /UPDATE jobs SET is_active = 0/), true);
});

test("a failure-kind change restarts the strike count", async () => {
  // Two transient errors on record, then one bot-challenge page. As a running total that was
  // "three strikes, close the board" -- the single-response wipe the strikes exist to prevent.
  const db = recordingDb(2, { boardStatus: "error" });
  await applyBoardSnapshot(db, {
    board: {
      key: "greenhouse:global:acme", provider: "greenhouse", identifier: "acme",
      status: "invalid", jobCount: 0, syncedAt: "2026-07-24T10:00:00.000Z", error: "403",
    },
    jobs: [],
  });
  assert.equal(ran(db, /FROM jobs WHERE board_key/), false, "strike 1 of 3: no close pass");
  const update = db.statements.find((entry) => /UPDATE boards SET status/.test(entry.sql) && entry.args);
  assert.equal(update.args[1], 1, "failure_count restarted for the new kind");
});

test("an aggregator job is suppressed only when its twin lives on a smaller board key", async () => {
  // The deterministic winner rule: smallest board_key keeps the job. min == mine and min > mine
  // both keep; only min < mine suppresses. That asymmetry is what makes the outcome independent of
  // sync order and immune to two boards suppressing each other's copies in the same round.
  const incoming = [
    { url: "https://example.com/1", sourceId: "1", boardKey: "getro:global:mmm", provider: "getro" },
    { url: "https://example.com/2", sourceId: "2", boardKey: "getro:global:mmm", provider: "getro" },
    { url: "https://example.com/3", sourceId: "3", boardKey: "getro:global:mmm", provider: "getro" },
  ];
  const db = stubNativeDb({ twinWinners: new Map([
    ["1", "getro:global:aaa"],
    ["2", "getro:global:mmm"],
    ["3", "getro:global:zzz"],
  ]) });
  const kept = await suppressDuplicatedAggregatorJobs(db, incoming);
  assert.deepEqual(kept.map((job) => job.sourceId), ["2", "3"]);
});

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
