import { createHash } from "node:crypto";
import { aggregatorJobIdentity } from "../../src/providers.mjs";
import { CONSTRUCTED_LOGO_PROVIDERS } from "../../src/company-logo.mjs";
import { companyDisplayExpression } from "../../src/company-name.mjs";
import {
  ACTIVE_REFRESH_LADDER_HOURS,
  EMPTY_CLOSE_MIN_ACTIVE,
  INVALID_CLOSE_STRIKES,
  isRateLimitError,
  nextSyncAt,
  rateLimitNextSyncAt,
} from "./config.mjs";

// Providers that re-list other boards' jobs rather than hosting their own, so their snapshots are
// deduplicated against the native postings at ingestion.
const AGGREGATOR_PROVIDERS = new Set(["getro"]);
// D1 rejects a query with more than 100 bound parameters, so IN(...) probes chunk below this.
const D1_MAX_BIND = 100;
const DAY_MS = 24 * 60 * 60 * 1_000;

// Every timestamp in this schema is stored as an ISO-8601 string ("2026-07-24T10:00:00.000Z"), but
// SQLite's datetime() renders "2026-07-24 10:00:00" -- space separator, no fractional seconds, no
// trailing Z. Comparing the two is a plain string comparison that diverges at index 10, where "T"
// (0x54) sorts after " " (0x20), so a stored timestamp from the same calendar day always compared
// GREATER than a datetime() threshold. Every "older than N" window was silently rounded up to the
// next UTC midnight, and the two-hour stuck-queue reclaim below could not fire within a day at all
// -- a board whose queue message was lost stayed unreachable until midnight. Shifting the threshold
// in JS keeps both sides in the same ISO format.
function isoShift(iso, deltaMs) {
  return new Date(Date.parse(iso) + deltaMs).toISOString();
}

export async function enqueueDueBoards(env, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const limit = Math.min(2_000, Math.max(1, options.limit ?? 500));

  await env.DB.prepare(`
    UPDATE boards SET queue_state = 'idle', updated_at = ?
    WHERE queue_state = 'queued' AND updated_at < ?
  `).bind(now, isoShift(now, -2 * 60 * 60 * 1_000)).run();

  const result = await env.DB.prepare(`
    SELECT key, provider, identifier, region, board_url AS boardUrl, api_url AS apiUrl
    FROM boards
    WHERE queue_state = 'idle' AND next_sync_at <= ?
    ORDER BY next_sync_at, key
    LIMIT ?
  `).bind(now, limit).all();

  return result.results ?? [];
}

export async function markBoardsQueued(db, keys, now = new Date().toISOString()) {
  if (!keys.length) return [];
  const claimed = [];
  for (const group of chunks(keys, 50)) {
    const responses = await db.batch(group.map((key) => db.prepare(
      "UPDATE boards SET queue_state = 'queued', updated_at = ? WHERE key = ? AND queue_state = 'idle'",
    ).bind(now, key)));
    responses.forEach((response, index) => {
      if (Number(response.meta?.changes ?? 0) > 0) claimed.push(group[index]);
    });
  }
  return claimed;
}

export async function releaseBoards(db, keys, now = new Date().toISOString()) {
  if (!keys.length) return;
  await db.batch(keys.map((key) => db.prepare(
    "UPDATE boards SET queue_state = 'idle', updated_at = ? WHERE key = ?",
  ).bind(now, key)));
}
// Hoisted out of applyBoardSnapshot and exported so a test can run it against a real SQLite rather
// than assert on the string. The repost rule below is date arithmetic inside a CASE inside an
// upsert -- exactly the shape that reads correct and behaves otherwise, and the recording-stub
// tests elsewhere in this file can only check what was passed, never what SQLite did with it.
export const JOB_UPSERT_SQL = `
        INSERT INTO jobs (
          key, source_id, board_key, provider, company_identifier, company_name,
          company_logo_url, title, location, country, city, role_family, company_industry, workplace,
          employment_type, category, published_at, url, fingerprint, seen_run_id, is_active,
          first_seen_at, updated_at, closed_at, reposted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL)
        ON CONFLICT(key) DO UPDATE SET
          source_id = excluded.source_id,
          board_key = excluded.board_key,
          provider = excluded.provider,
          company_identifier = excluded.company_identifier,
          company_name = excluded.company_name,
          company_logo_url = excluded.company_logo_url,
          title = excluded.title,
          location = excluded.location,
          country = excluded.country,
          city = excluded.city,
          role_family = excluded.role_family,
          company_industry = excluded.company_industry,
          workplace = excluded.workplace,
          employment_type = excluded.employment_type,
          category = excluded.category,
          -- A posting we had closed is back on the board. That is a new availability event, and if
          -- the ATS is re-serving the date it always carried, that date now understates the job:
          -- it would sink to wherever it sat months ago instead of surfacing as open again.
          --
          -- Two guards, both load-bearing.
          --
          -- The three-day floor is the important one. Reactivation does NOT mean "reposted" -- it
          -- much more often means WE closed it wrongly and recovered: a truncated page, a bot
          -- challenge answered with a 200, the Workday pagination bug that cost 1,509 boards
          -- everything past job 40. Those recover on the next refresh, which is now at most 12h
          -- away, so anything back inside three days is treated as a correction and its date is
          -- left exactly as it was. Without this, the day a fetch bug is fixed the whole front
          -- page fills with jobs claiming to be brand new that never went anywhere.
          --
          -- The second guard trusts the source when the source is doing its job: a repost that
          -- comes back carrying a date LATER than the closure has already been re-dated upstream,
          -- so that date wins. Only a date older than the closure gets overridden.
          published_at = CASE
            WHEN jobs.is_active = 0
             AND jobs.closed_at IS NOT NULL
             AND julianday(excluded.updated_at) - julianday(jobs.closed_at) >= 3
             AND (excluded.published_at IS NULL OR excluded.published_at < jobs.closed_at)
              THEN excluded.updated_at
            -- A later EDIT must not quietly undo the above. published_at is deliberately outside
            -- the fingerprint, so the next genuine content change would otherwise restore the stale
            -- source date and the repost would lose its freshness weeks after the fact.
            WHEN jobs.reposted_at IS NOT NULL
             AND (excluded.published_at IS NULL OR excluded.published_at < jobs.reposted_at)
              THEN jobs.published_at
            ELSE excluded.published_at
          END,
          -- Why published_at moved, kept separately so the override is auditable rather than
          -- indistinguishable from a date the ATS supplied.
          reposted_at = CASE
            WHEN jobs.is_active = 0
             AND jobs.closed_at IS NOT NULL
             AND julianday(excluded.updated_at) - julianday(jobs.closed_at) >= 3
              THEN excluded.updated_at
            ELSE jobs.reposted_at
          END,
          url = excluded.url,
          fingerprint = excluded.fingerprint,
          seen_run_id = excluded.seen_run_id,
          is_active = 1,
          updated_at = excluded.updated_at,
          closed_at = NULL
        WHERE jobs.fingerprint <> excluded.fingerprint
           OR jobs.is_active = 0
      `;


export async function applyBoardSnapshot(db, result, options = {}) {
  const now = result.board.syncedAt;
  const runId = options.runId ?? crypto.randomUUID();
  const board = result.board;
  let changedJobs = 0;
  let closedJobs = 0;

  // sync_runs is written ONCE, at the end, with its final status. It used to be INSERTed as
  // 'running' up front and UPDATEd at completion -- two statements and ~9 index-amplified rows per
  // refresh, ~113,000 times a day, purely so abandoned runs could be detected. But the queue
  // already owns that: a consumer that dies never acks, the message redelivers, and the 2-hour
  // queued-state reclaim in enqueueDueBoards unsticks the board. The 'running' row was a second,
  // more expensive copy of bookkeeping the system already had.

  if (board.status === "error") {
    await recordBoardFailure(db, board, runId, { escalate: options.escalate });
    return { runId, changedJobs, closedJobs, retry: true };
  }

  // An "invalid" board answered, but with something that is not a job list: a 4xx, a bot challenge,
  // an HTML interstitial, a body truncated by a proxy. That is a FAILED refresh, and it used to
  // fall through to the success path below carrying `jobs: []` -- which read as "this board now has
  // zero jobs" and closed every posting on it, reset failure_count to 0, and backed the board off
  // for 30 days, by which point the archive sweep had deleted the rows. One transient 403 in front
  // of a big Greenhouse board silently destroyed its entire listing.
  //
  // So invalid now records a failure and leaves the previous snapshot alone. A board that is really
  // dead still gets cleaned up, just on evidence rather than on a single response: only once it has
  // come back invalid INVALID_CLOSE_STRIKES times in a row do we accept the empty snapshot and let
  // the close pass run.
  // Set when a failure row has already been INSERTed under `runId` and the refresh then falls
  // through to the close pass. The completion row must take a fresh id in that case: sync_runs.id
  // is a primary key, and re-using runId made the final batch throw UNIQUE, roll back the boards/
  // provider_health bookkeeping AFTER the close loop had already run, and dead-letter the message
  // -- the deliberate cleanup path failed 100% of the time, destructively.
  let failureRecorded = false;
  if (board.status === "invalid") {
    const strikes = await recordBoardFailure(db, board, runId, { status: "invalid", escalate: options.escalate });
    if (strikes < INVALID_CLOSE_STRIKES) {
      return { runId, changedJobs, closedJobs, retry: false };
    }
    failureRecorded = true;
  }

  // Batched with the jobs read rather than issued on its own: the refresh interval now depends on
  // the board's own quiet_syncs, and this runs on every one of ~92,000 refreshes a day, so a second
  // round trip for one integer is latency nothing needs. Two statements, one trip.
  const [currentResult, boardResult] = await db.batch([
    db.prepare(`
      SELECT key, source_id AS sourceId, fingerprint, is_active AS isActive
      FROM jobs WHERE board_key = ?
    `).bind(board.key),
    db.prepare("SELECT quiet_syncs AS quietSyncs FROM boards WHERE key = ?").bind(board.key),
  ]);
  const quietSyncs = Number(boardResult.results?.[0]?.quietSyncs ?? 0);
  const currentBySourceId = new Map(
    (currentResult.results ?? []).map((job) => [String(job.sourceId), job]),
  );
  const previouslyActive = (currentResult.results ?? [])
    .filter((job) => Number(job.isActive) === 1).length;

  // A response that PARSED but contained zero jobs, for a board that has real active ones, gets
  // the same corroboration an invalid response gets -- because at that scale it almost never means
  // "the company closed every role at once"; it means a bot challenge that happened to be valid
  // JSON, a search backend answering an empty shard, or a sitemap index the extractor read as
  // empty. The invalid guard above existed for exactly this failure and status "empty" walked
  // straight past it: one hollow 200 closed the whole board, unwitnessed, and 30 days later the
  // archive sweep made it permanent. Small boards (under 10 actives) still close immediately --
  // winding down to zero one posting at a time is how boards genuinely empty out.
  if (!failureRecorded && result.jobs.length === 0 && previouslyActive >= EMPTY_CLOSE_MIN_ACTIVE) {
    const strikes = await recordBoardFailure(db, {
      ...board,
      error: `Empty snapshot for a board with ${previouslyActive} active jobs`,
    }, runId, { status: "invalid", escalate: options.escalate });
    if (strikes < INVALID_CLOSE_STRIKES) {
      return { runId, changedJobs, closedJobs, retry: false };
    }
    failureRecorded = true;
  }

  let incoming = result.jobs.map(compactJob);
  // A Getro board re-lists jobs that also live on the company's own ATS board (Greenhouse, Ashby,
  // Workday, ...). Drop those whose native posting already exists so we don't show the same job
  // twice. Dropping them from `incoming` (rather than writing them inactive) means an already-open
  // duplicate lands in keysToClose and any that reappear on later crawls are simply never
  // reactivated -- so the suppression sticks with zero write churn.
  if (AGGREGATOR_PROVIDERS.has(board.provider)) {
    incoming = await suppressDuplicatedAggregatorJobs(db, incoming);
  }
  const companyName = incoming.find((job) => job.companyName)?.companyName ?? null;
  // A logo can come from the job payload (Getro, Spark Hire, Paylocity) or from scraping the board
  // page (resolved upstream, on the result). A CONSTRUCTED logo -- Workday's assumed tenant path --
  // must never win here: resolveLogoIfStale verifies constructed URLs and scrapes when they fail,
  // but this coalesce used to take the payload value first, so the unverified guess overwrote the
  // verified answer on every refresh and stamped logo_checked_at, closing the recheck gate on it.
  const payloadLogoUrl = CONSTRUCTED_LOGO_PROVIDERS.has(board.provider)
    ? null
    : incoming.find((job) => job.companyLogoUrl)?.companyLogoUrl ?? null;
  const companyLogoUrl = payloadLogoUrl ?? result.companyLogoUrl ?? null;
  // Stamp logo_checked_at only when a logo actually arrived or a scrape genuinely ran this refresh
  // (result.logoChecked). Binding `now` unconditionally kept refreshing the stamp on every sync, so
  // the "recheck after 30 days" gate upstream never opened and a failed first scrape was permanent.
  const logoCheckedAt = companyLogoUrl || result.logoChecked ? now : null;
  // Always create the companies row, even when no provider supplied a name. It is what caches the
  // logo lookup, so gating it on companyName would leave those boards rescraped on every refresh.
  const companyKey = `company:${board.key}`;
  await db.prepare(`
    INSERT INTO companies (key, name, logo_url, logo_checked_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      -- ? rather than excluded.name so a refresh that happens to omit the name does not overwrite
      -- a real one with the identifier fallback.
      name = coalesce(?, companies.name),
      logo_url = coalesce(excluded.logo_url, companies.logo_url),
      -- Stamped when a check ran even if nothing was found, so unscrapable boards back off a month.
      logo_checked_at = coalesce(excluded.logo_checked_at, companies.logo_checked_at),
      updated_at = excluded.updated_at
  `).bind(
    companyKey, companyName ?? board.identifier, companyLogoUrl, logoCheckedAt, now, now,
    companyName,
  ).run();
  const incomingSourceIds = new Set(incoming.map((job) => job.sourceId));
  // Counting every active row per provider on each refresh scales quadratically with the
  // registry, so provider_health tracks a per-board delta and is reconciled once a day.
  const activeJobsDelta = incoming.length - previouslyActive;
  const jobsToWrite = incoming.filter((job) => {
    const existing = currentBySourceId.get(job.sourceId);
    return !existing || Number(existing.isActive) !== 1 || existing.fingerprint !== job.fingerprint;
  });

  for (const group of chunks(jobsToWrite, 35)) {
    const responses = await db.batch(group.map((job) => {
      return db.prepare(JOB_UPSERT_SQL).bind(
        job.key, job.sourceId, job.boardKey, job.provider,
        job.companyIdentifier, job.companyName, job.companyLogoUrl, job.title, job.location,
        job.country, job.city, job.roleFamily, job.companyIndustry, job.workplace,
        job.employmentType, job.category, job.publishedAt,
        job.url, job.fingerprint, runId, now, now,
      );
    }));
    changedJobs += responses.reduce((sum, response) => sum + Number(response.meta?.changes ?? 0), 0);
  }

  const keysToClose = (currentResult.results ?? [])
    .filter((job) => Number(job.isActive) === 1 && !incomingSourceIds.has(String(job.sourceId)))
    .map((job) => job.key);
  for (const group of chunks(keysToClose, 50)) {
    const responses = await db.batch(group.map((key) => db.prepare(`
      UPDATE jobs SET is_active = 0, closed_at = ?, updated_at = ?
      WHERE key = ? AND is_active = 1
    `).bind(now, now, key)));
    closedJobs += responses.reduce((sum, response) => sum + Number(response.meta?.changes ?? 0), 0);
  }

  // A refresh that wrote nothing moves the board one rung down the ladder; one that wrote anything
  // puts it straight back on the fast rung. Clamped to the last rung so a board dormant for months
  // cannot run the counter away.
  //
  // `changedJobs` counts rows actually written and `closedJobs` rows actually closed, so this asks
  // "did anything real happen", not "did we look". Workday's drifting publishedAt is deliberately
  // outside the fingerprint, which is what stops a quarter of the index from claiming it changed on
  // every single refresh.
  const nextQuietSyncs = changedJobs + closedJobs > 0
    ? 0
    : Math.min(quietSyncs + 1, ACTIVE_REFRESH_LADDER_HOURS.length - 1);

  await db.batch([
    db.prepare(`
      UPDATE boards SET
        status = ?, queue_state = 'idle', job_count = ?, failure_count = 0,
        last_synced_at = ?, next_sync_at = ?, last_error = NULL, quiet_syncs = ?,
        company_key = coalesce(?, company_key), updated_at = ?
      WHERE key = ?
    `).bind(
      board.status, board.jobCount, now,
      nextSyncAt(board.status, 0, Date.parse(now), nextQuietSyncs), nextQuietSyncs,
      companyKey, now, board.key,
    ),
    db.prepare(`
      INSERT INTO sync_runs (id, board_key, provider, status, job_count, changed_jobs,
        closed_jobs, started_at, completed_at)
      VALUES (?, ?, ?, 'complete', ?, ?, ?, ?, ?)
    `).bind(
      // A fresh id when a failure row already holds runId (the invalid/empty fall-through): both
      // rows are real history, and re-using the primary key made this whole batch throw UNIQUE and
      // roll back AFTER the close loop had run.
      failureRecorded ? crypto.randomUUID() : runId,
      board.key, board.provider, board.jobCount, changedJobs, closedJobs, now, now,
    ),
    db.prepare(`
      INSERT INTO provider_health (provider, successful_runs, failed_runs, active_jobs, last_success_at, updated_at)
      VALUES (?, 1, 0, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        successful_runs = successful_runs + 1,
        active_jobs = max(0, active_jobs + ?),
        last_success_at = excluded.last_success_at,
        updated_at = excluded.updated_at
    `).bind(board.provider, incoming.length, now, now, activeJobsDelta),
    // A board that dead-lettered on an earlier refresh but now succeeds is no longer a live
    // failure, so its open failed_tasks rows are resolved. Without this, unresolvedFailures only
    // ever climbs -- a recovered board would keep inflating the count forever.
    db.prepare(`
      UPDATE failed_tasks SET resolved_at = ? WHERE board_key = ? AND resolved_at IS NULL
    `).bind(now, board.key),
  ]);

  return { runId, changedJobs, closedJobs, retry: false };
}

// Returns the aggregator's incoming jobs minus any whose native ATS twin is already active. Each
// job's URL points at the underlying posting; aggregatorJobIdentity turns that into either a
// (provider, source_id) probe -- matched via the jobs(provider, source_id) index -- or, for
// Workday whose req ids repeat across tenants, the exact native job key (a primary-key lookup).
export async function suppressDuplicatedAggregatorJobs(db, incoming) {
  const identities = incoming.map((job) => aggregatorJobIdentity(job.url));

  // (provider, source_id) probes, grouped by provider so each native ATS is one batched seek.
  const sourceIdsByProvider = new Map();
  // Full native job keys (Workday), matched by primary key.
  const keys = new Set();
  for (const identity of identities) {
    if (!identity) continue;
    if (identity.key) {
      keys.add(identity.key);
    } else {
      if (!sourceIdsByProvider.has(identity.provider)) sourceIdsByProvider.set(identity.provider, new Set());
      sourceIdsByProvider.get(identity.provider).add(identity.sourceId);
    }
  }

  const activeSourceIds = new Map(); // provider -> Set of source_ids that exist as active natives
  for (const [provider, ids] of sourceIdsByProvider) {
    const found = new Set();
    // D1 caps a query at 100 bound parameters; the leading provider bind leaves room for 99 ids.
    for (const group of chunks([...ids], D1_MAX_BIND - 1)) {
      const placeholders = group.map(() => "?").join(",");
      const rows = await db.prepare(`
        SELECT source_id AS sourceId FROM jobs
        WHERE provider = ? AND is_active = 1 AND source_id IN (${placeholders})
      `).bind(provider, ...group).all();
      for (const row of rows.results ?? []) found.add(String(row.sourceId));
    }
    activeSourceIds.set(provider, found);
  }

  const activeKeys = new Set();
  for (const group of chunks([...keys], D1_MAX_BIND)) {
    const placeholders = group.map(() => "?").join(",");
    // is_active is filtered HERE, not in the SQL. With `is_active = 1 AND key IN (...)` the planner
    // chose jobs_active_published_idx -- it covers `key`, so scanning every active entry looked
    // cheaper to it than probing the primary key -- and each probe read ~1.6M rows instead of ~100.
    // At 900 runs a day that one plan was 1.48 BILLION rows read, ~80% of the entire D1 read bill.
    // With `key` alone in the WHERE, the primary key is the only usable index.
    const rows = await db.prepare(`
      SELECT key, is_active AS isActive FROM jobs WHERE key IN (${placeholders})
    `).bind(...group).all();
    for (const row of rows.results ?? []) {
      if (Number(row.isActive) === 1) activeKeys.add(String(row.key));
    }
  }

  const nativeSuppressed = incoming.filter((_, index) => {
    const identity = identities[index];
    if (!identity) return true;
    if (identity.key) return !activeKeys.has(identity.key);
    return !activeSourceIds.get(identity.provider)?.has(identity.sourceId);
  });

  return suppressCrossBoardAggregatorTwins(db, nativeSuppressed);
}

// The aggregator-vs-AGGREGATOR half of the dedup: the same Getro job id is re-listed on several
// network boards (measured: 5,563 active twin groups -- "HR Executive at Hipvan" verbatim on both
// readbetweenthelines and storyhousereview). The native-ATS pass above cannot see these, because
// the twin is another Getro row, not a native one.
//
// The winner is the lexicographically SMALLEST board_key, and that rule is what makes this safe:
// a job is suppressed only when an active twin lives on a smaller key, so the smallest board can
// never suppress its own copy, two boards can never suppress each other in the same round, and the
// outcome is identical whatever order the boards happen to sync in. Suppression works exactly like
// the native pass -- dropped from `incoming`, so an already-open duplicate falls into keysToClose
// and reappearing ones are never reactivated.
async function suppressCrossBoardAggregatorTwins(db, incoming) {
  const boardKey = incoming[0]?.boardKey;
  const provider = incoming[0]?.provider;
  if (!boardKey || !provider) return incoming;

  const losers = new Set();
  for (const group of chunks(incoming.map((job) => String(job.sourceId)), D1_MAX_BIND - 1)) {
    const placeholders = group.map(() => "?").join(",");
    // min(board_key) over the active twins; served by jobs(provider, source_id, is_active).
    const rows = await db.prepare(`
      SELECT source_id AS sourceId, min(board_key) AS winner FROM jobs
      WHERE provider = ? AND is_active = 1 AND source_id IN (${placeholders})
      GROUP BY source_id
    `).bind(provider, ...group).all();
    for (const row of rows.results ?? []) {
      if (String(row.winner) < boardKey) losers.add(String(row.sourceId));
    }
  }
  return incoming.filter((job) => !losers.has(String(job.sourceId)));
}

// Records a failed refresh and returns the board's new consecutive-failure count. `status` is
// "error" for a transient failure (retried on the short exponential ladder) or "invalid" for a
// response that was not a job list (backed off 30 days). Either way the board's jobs are left
// exactly as they were -- this function never closes anything.
async function recordBoardFailure(db, board, runId, options = {}) {
  const status = options.status === "invalid" ? "invalid" : "error";
  const current = await db.prepare("SELECT failure_count AS failureCount, status FROM boards WHERE key = ?")
    .bind(board.key).first();
  // The queue retries a failed refresh up to five times on its own short ladder, and every one of
  // those attempts used to also advance failure_count -- so the two backoffs compounded. A 12-minute
  // ATS outage burned all five retries inside the outage, left the board at failure_count 6, and
  // pushed next_sync_at out by 16 hours: a brief blip consumed the whole escalation ladder. Only the
  // first delivery of a refresh escalates; its retries record the error without advancing the count.
  // Consecutive failures OF THE SAME KIND. failure_count used to carry over across kinds, so two
  // transient 502s followed by one bot-challenge page counted as three "invalid strikes" and the
  // board's whole listing was closed on its FIRST invalid response -- the exact single-response
  // wipe the strike mechanism exists to prevent. A kind change restarts the count (which also
  // restarts the error ladder from the bottom -- correct: it is a different failure).
  const consecutive = current?.status === status ? Number(current?.failureCount ?? 0) : 0;
  const failureCount = consecutive + (options.escalate === false ? 0 : 1);
  const now = board.syncedAt;
  // A rate limit is the provider pushing back on the whole fleet, not this board failing: the
  // 15-minute error ladder walked straight back into it (45,687 Paylocity refreshes 429ed in one
  // day), so 429/530 boards step aside for hours, jittered so they do not all come back at once.
  const retryAt = isRateLimitError(board.error)
    ? rateLimitNextSyncAt(failureCount, Date.parse(now))
    : nextSyncAt(status, failureCount, Date.parse(now));
  await db.batch([
    db.prepare(`
      UPDATE boards SET status = ?, queue_state = 'idle', failure_count = ?,
        last_synced_at = ?, next_sync_at = ?, last_error = ?, updated_at = ? WHERE key = ?
    `).bind(status, failureCount, now, retryAt, board.error, now, board.key),
    db.prepare(`
      INSERT INTO sync_runs (id, board_key, provider, status, job_count, error, started_at, completed_at)
      VALUES (?, ?, ?, 'error', 0, ?, ?, ?)
    `).bind(runId, board.key, board.provider, board.error, now, now),
    db.prepare(`
      INSERT INTO provider_health (provider, successful_runs, failed_runs, active_jobs, last_failure_at, last_error, updated_at)
      VALUES (?, 0, 1, 0, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET failed_runs = failed_runs + 1,
        last_failure_at = excluded.last_failure_at, last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).bind(board.provider, now, board.error, now),
  ]);
  return failureCount;
}

export async function upsertDiscoveredBoards(db, boards, now = new Date().toISOString()) {
  let inserted = 0;
  for (const group of chunks(boards, 35)) {
    const responses = await db.batch(group.map((board) => db.prepare(`
      INSERT INTO boards (
        key, provider, identifier, region, board_url, api_url, status, queue_state,
        next_sync_at, discovered_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'new', 'idle', ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET board_url = excluded.board_url, api_url = excluded.api_url,
        updated_at = excluded.updated_at
    `).bind(
      board.key, board.provider, board.identifier, board.region ?? "global",
      board.boardUrl, board.apiUrl, now, now, now,
    )));
    inserted += responses.reduce((sum, response) => sum + Number(response.meta?.changes ?? 0), 0);
  }
  return inserted;
}

export async function archiveAndCleanupClosedJobs(env, now = new Date().toISOString()) {
  // Passes, not one batch -- the same rule pruneSyncRuns states: the pass cap has to clear the
  // write rate or the table still grows. A single 5,000-row pass against ~10-20k daily closures
  // meant the >30-day backlog grew without bound (134k inactive rows and climbing when caught);
  // ten passes clear 50k/day, comfortably above any real close rate.
  let archived = 0;
  for (let pass = 0; pass < 10; pass += 1) {
    const rows = await env.DB.prepare(`
      SELECT * FROM jobs
      WHERE is_active = 0 AND closed_at < ?
      ORDER BY closed_at
      LIMIT 5000
    `).bind(isoShift(now, -30 * DAY_MS)).all();
    if (!rows.results?.length) break;

    const body = `${rows.results.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const stream = new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"));
    const day = now.slice(0, 10);
    await env.ARCHIVE.put(`closed-jobs/${day}/${crypto.randomUUID()}.ndjson.gz`, stream, {
      httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
      customMetadata: { rowCount: String(rows.results.length), archivedAt: now },
    });
    for (const group of chunks(rows.results.map((row) => row.key), 50)) {
      await env.DB.batch(group.map((key) => env.DB.prepare("DELETE FROM jobs WHERE key = ?").bind(key)));
    }
    archived += rows.results.length;
    if (rows.results.length < 5_000) break;
  }
  return { archived };
}

// Rebuilt daily rather than maintained per write: the typeahead only needs approximate counts, and
// one grouped scan a day is far cheaper than touching an aggregate on every job upsert.
export async function refreshTitleSuggestions(db, now = new Date().toISOString()) {
  // One batch, not two round trips. As separate statements an interruption between them -- an
  // isolate torn down after a sibling task rejected, a D1 timeout -- left job_titles empty, and the
  // role-title typeahead returned nothing until the next daily run. db.batch is the only
  // transactional primitive D1 offers, and it is exactly what this needs.
  const [, result] = await db.batch([
    db.prepare("DELETE FROM job_titles"),
    db.prepare(`
      INSERT INTO job_titles (title, job_count, updated_at)
      SELECT title, count(*) AS job_count, ?
      FROM jobs WHERE is_active = 1 AND title IS NOT NULL AND title <> ''
      GROUP BY title
    `).bind(now),
  ]);
  return { titles: Number(result.meta?.changes ?? 0) };
}

// The Company dropdown's options, rebuilt on the same schedule and for the same reason as the
// titles above. Grouped on the display name, because the company filter matches with a substring
// LIKE against company_name/company_identifier -- so the value offered has to be a value the filter
// can actually find. Boards that never supplied a name fall back to their identifier, which is what
// the table renders for them too.
export async function refreshCompanySuggestions(db, now = new Date().toISOString()) {
  const [, result] = await db.batch([
    db.prepare("DELETE FROM job_companies"),
    db.prepare(`
      INSERT INTO job_companies (company, job_count, logo_url, logo_board_key, updated_at)
      SELECT
        -- The shared expression, not a local copy of it. This used to be written out here AND in
        -- jobs-query.ts, and the two drifted: this one handled the Workday tenant pipe but not the
        -- iCIMS careers prefix, so the dropdown offered "Careers Commonspirit" (5,465 jobs) as if
        -- that were a company. See src/company-name.mjs.
        -- min(), not the bare expression: the group is case-folded below, and min() picks the
        -- variant that starts with an uppercase letter ('Zola' < 'zola' in ASCII) -- i.e. a real
        -- provider-supplied name beats an identifier fallback. Without the fold, a company whose
        -- boards disagreed on casing appeared TWICE in the dropdown, titlecased into two
        -- identical-looking entries with the job count split between them.
        min(${companyDisplayExpression()}) AS company,
        count(*) AS job_count,
        -- One logo per company: max() over the group picks any non-null one, and every board of a
        -- company resolves to the same employer logo anyway.
        max(company_logo_url) AS logo_url,
        -- The board that logo belongs to, so the dropdown can request it through /api/logo. Scoped
        -- to rows that actually HAVE a logo, or max() would happily return a board with none and
        -- the proxy would answer 404 for a company whose logo we hold.
        max(CASE WHEN company_logo_url IS NOT NULL AND company_logo_url <> '' THEN board_key END) AS logo_board_key,
        ?
      FROM jobs
      WHERE is_active = 1 AND coalesce(nullif(company_name, ''), company_identifier) IS NOT NULL
      GROUP BY lower(${companyDisplayExpression()})
    `).bind(now),
  ]);
  return { companies: Number(result.meta?.changes ?? 0) };
}

// The per-refresh delta in applyBoardSnapshot can drift when a board fails midway or rows are
// archived out from under it, so the true counts are recomputed once a day instead of per board.
export async function reconcileProviderHealth(db, now = new Date().toISOString()) {
  const counts = await db.prepare(`
    SELECT provider, count(*) AS activeJobs FROM jobs WHERE is_active = 1 GROUP BY provider
  `).all();
  const rows = counts.results ?? [];
  if (!rows.length) return { reconciled: 0 };
  await db.batch(rows.map((row) => db.prepare(
    "UPDATE provider_health SET active_jobs = ?, updated_at = ? WHERE provider = ?",
  ).bind(Number(row.activeJobs ?? 0), now, row.provider)));
  return { reconciled: rows.length };
}

// One sync_runs row is written per board refresh and nothing removed them, so the table grew
// without bound. Two weeks is enough history to debug a bad crawl.
//
// The pass cap has to clear the write rate or the table still grows: the */15 cron can enqueue
// 2,000 boards, so 96 runs a day is up to 192,000 new rows, and 20 passes of 5,000 only removed
// 100,000. 50 passes covers the ceiling with headroom. Migration 0010 adds the started_at index the
// delete needs -- without it each pass scanned the table to find its batch.
export async function pruneSyncRuns(db, now = new Date().toISOString(), retentionDays = 14) {
  let deleted = 0;
  for (let pass = 0; pass < 50; pass += 1) {
    const result = await db.prepare(`
      DELETE FROM sync_runs WHERE id IN (
        SELECT id FROM sync_runs WHERE started_at < ? LIMIT 5000
      )
    `).bind(isoShift(now, -retentionDays * DAY_MS)).run();
    const changes = Number(result.meta?.changes ?? 0);
    deleted += changes;
    if (changes < 5_000) break;
  }
  return { deleted };
}

// A dead-lettered board only clears itself via the recovery path in applyBoardSnapshot, which fires
// on a *successful* refresh. A board classified `invalid` (permanent 404/HTML) backs off for 30
// days and may never succeed again, so its open failed_tasks rows would linger as phantom
// "unresolved" failures indefinitely. Once a day, resolve any open row whose board is no longer in
// the live `error` state -- error is the only status that represents an active, retrying failure.
export async function reconcileFailedTasks(db, now = new Date().toISOString()) {
  // NOT IN of the error boards, rather than IN of the non-error ones: the two differ exactly for
  // rows whose board no longer EXISTS (deleted twins, cleaned-up registries). Those matched
  // neither side of the old IN, so they stayed "unresolved" forever and the failure count only
  // ever climbed.
  const result = await db.prepare(`
    UPDATE failed_tasks SET resolved_at = ?
    WHERE resolved_at IS NULL
      AND board_key NOT IN (
        SELECT key FROM boards WHERE status = 'error'
      )
  `).bind(now).run();
  return { resolved: Number(result.meta?.changes ?? 0) };
}

// Resolved dead-letter rows are kept only long enough to be seen in the ops view, then removed so
// failed_tasks does not grow without bound the way sync_runs did. Unresolved rows are never pruned
// -- they are the live backlog and should stay visible until the board recovers or is fixed.
export async function pruneFailedTasks(db, now = new Date().toISOString(), retentionDays = 7) {
  let deleted = 0;
  for (let pass = 0; pass < 20; pass += 1) {
    const result = await db.prepare(`
      DELETE FROM failed_tasks WHERE id IN (
        SELECT id FROM failed_tasks
        WHERE resolved_at IS NOT NULL AND resolved_at < ?
        LIMIT 5000
      )
    `).bind(isoShift(now, -retentionDays * DAY_MS)).run();
    const changes = Number(result.meta?.changes ?? 0);
    deleted += changes;
    if (changes < 5_000) break;
  }
  return { deleted };
}

function compactJob(job) {
  const values = {
    key: job.key,
    sourceId: String(job.sourceId),
    boardKey: job.boardKey,
    provider: job.provider,
    companyIdentifier: job.companyIdentifier,
    companyName: job.companyName ?? null,
    companyLogoUrl: job.companyLogoUrl ?? null,
    title: job.title,
    location: job.location ?? null,
    country: job.country ?? null,
    city: job.city ?? null,
    roleFamily: job.roleFamily ?? null,
    companyIndustry: job.companyIndustry ?? null,
    workplace: job.workplace ?? "Unspecified",
    employmentType: job.employmentType ?? null,
    category: job.category ?? "Other",
    url: job.url,
  };
  return {
    ...values,
    publishedAt: job.publishedAt ?? null,
    // publishedAt is deliberately NOT part of the fingerprint. Workday only publishes relative
    // dates ("Posted 3 Days Ago"), so the derived absolute date drifts on every refresh; with it
    // in the hash, every Workday job rewrote twice a day -- 5.6M of the 6M daily row writes, the
    // dominant D1 cost. A date-only drift changes nothing user-meaningful; any real edit still
    // differs in some other field, and that update carries the fresh publishedAt with it.
    fingerprint: createHash("sha256").update(JSON.stringify(values)).digest("hex"),
  };
}

export function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
