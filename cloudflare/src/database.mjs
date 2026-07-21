import { createHash } from "node:crypto";
import { nextSyncAt } from "./config.mjs";

export async function enqueueDueBoards(env, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const limit = Math.min(2_000, Math.max(1, options.limit ?? 500));

  await env.DB.prepare(`
    UPDATE boards SET queue_state = 'idle', updated_at = ?
    WHERE queue_state = 'queued' AND updated_at < datetime(?, '-2 hours')
  `).bind(now, now).run();

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

export async function applyBoardSnapshot(db, result, options = {}) {
  const now = result.board.syncedAt;
  const runId = options.runId ?? crypto.randomUUID();
  const board = result.board;
  let changedJobs = 0;
  let closedJobs = 0;

  await db.prepare(`
    INSERT INTO sync_runs (id, board_key, provider, status, job_count, started_at)
    VALUES (?, ?, ?, 'running', 0, ?)
  `).bind(runId, board.key, board.provider, now).run();

  if (board.status === "error") {
    await recordBoardFailure(db, board, runId);
    return { runId, changedJobs, closedJobs, retry: true };
  }

  const currentResult = await db.prepare(`
    SELECT key, source_id AS sourceId, fingerprint, is_active AS isActive
    FROM jobs WHERE board_key = ?
  `).bind(board.key).all();
  const currentBySourceId = new Map(
    (currentResult.results ?? []).map((job) => [String(job.sourceId), job]),
  );
  const incoming = result.jobs.map(compactJob);
  const companyName = incoming.find((job) => job.companyName)?.companyName ?? null;
  // A logo can come from the job payload (Getro, Spark Hire), from a constructible tenant URL
  // (Workday), or from scraping the board page (resolved upstream and passed in on the result).
  const companyLogoUrl = incoming.find((job) => job.companyLogoUrl)?.companyLogoUrl
    ?? result.companyLogoUrl
    ?? null;
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
      -- Stamped even when nothing was found, so boards without a logo are not rescraped daily.
      logo_checked_at = coalesce(excluded.logo_checked_at, companies.logo_checked_at),
      updated_at = excluded.updated_at
  `).bind(
    companyKey, companyName ?? board.identifier, companyLogoUrl, now, now, now,
    companyName,
  ).run();
  const incomingSourceIds = new Set(incoming.map((job) => job.sourceId));
  // Counting every active row per provider on each refresh scales quadratically with the
  // registry, so provider_health tracks a per-board delta and is reconciled once a day.
  const previouslyActive = (currentResult.results ?? [])
    .filter((job) => Number(job.isActive) === 1).length;
  const activeJobsDelta = incoming.length - previouslyActive;
  const jobsToWrite = incoming.filter((job) => {
    const existing = currentBySourceId.get(job.sourceId);
    return !existing || Number(existing.isActive) !== 1 || existing.fingerprint !== job.fingerprint;
  });

  for (const group of chunks(jobsToWrite, 35)) {
    const responses = await db.batch(group.map((job) => {
      return db.prepare(`
        INSERT INTO jobs (
          key, source_id, board_key, provider, company_identifier, company_name,
          company_logo_url, title, location, country, city, role_family, workplace, employment_type,
          category, published_at, url, fingerprint, seen_run_id, is_active, first_seen_at, updated_at,
          closed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
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
          workplace = excluded.workplace,
          employment_type = excluded.employment_type,
          category = excluded.category,
          published_at = excluded.published_at,
          url = excluded.url,
          fingerprint = excluded.fingerprint,
          seen_run_id = excluded.seen_run_id,
          is_active = 1,
          updated_at = excluded.updated_at,
          closed_at = NULL
        WHERE jobs.fingerprint <> excluded.fingerprint
           OR jobs.is_active = 0
      `).bind(
        job.key, job.sourceId, job.boardKey, job.provider,
        job.companyIdentifier, job.companyName, job.companyLogoUrl, job.title, job.location,
        job.country, job.city, job.roleFamily, job.workplace, job.employmentType, job.category,
        job.publishedAt,
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

  await db.batch([
    db.prepare(`
      UPDATE boards SET
        status = ?, queue_state = 'idle', job_count = ?, failure_count = 0,
        last_synced_at = ?, next_sync_at = ?, last_error = NULL,
        company_key = coalesce(?, company_key), updated_at = ?
      WHERE key = ?
    `).bind(
      board.status, board.jobCount, now, nextSyncAt(board.status, 0, Date.parse(now)),
      companyKey, now, board.key,
    ),
    db.prepare(`
      UPDATE sync_runs SET status = 'complete', job_count = ?, changed_jobs = ?,
        closed_jobs = ?, completed_at = ? WHERE id = ?
    `).bind(board.jobCount, changedJobs, closedJobs, now, runId),
    db.prepare(`
      INSERT INTO provider_health (provider, successful_runs, failed_runs, active_jobs, last_success_at, updated_at)
      VALUES (?, 1, 0, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        successful_runs = successful_runs + 1,
        active_jobs = max(0, active_jobs + ?),
        last_success_at = excluded.last_success_at,
        updated_at = excluded.updated_at
    `).bind(board.provider, incoming.length, now, now, activeJobsDelta),
  ]);

  return { runId, changedJobs, closedJobs, retry: false };
}

async function recordBoardFailure(db, board, runId) {
  const current = await db.prepare("SELECT failure_count AS failureCount FROM boards WHERE key = ?")
    .bind(board.key).first();
  const failureCount = Number(current?.failureCount ?? 0) + 1;
  const now = board.syncedAt;
  await db.batch([
    db.prepare(`
      UPDATE boards SET status = 'error', queue_state = 'idle', failure_count = ?,
        last_synced_at = ?, next_sync_at = ?, last_error = ?, updated_at = ? WHERE key = ?
    `).bind(failureCount, now, nextSyncAt("error", failureCount, Date.parse(now)), board.error, now, board.key),
    db.prepare(`
      UPDATE sync_runs SET status = 'error', error = ?, completed_at = ? WHERE id = ?
    `).bind(board.error, now, runId),
    db.prepare(`
      INSERT INTO provider_health (provider, successful_runs, failed_runs, active_jobs, last_failure_at, last_error, updated_at)
      VALUES (?, 0, 1, 0, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET failed_runs = failed_runs + 1,
        last_failure_at = excluded.last_failure_at, last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).bind(board.provider, now, board.error, now),
  ]);
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

export async function cleanupClosedJobs(db, now = new Date().toISOString()) {
  return db.prepare(`
    DELETE FROM jobs WHERE key IN (
      SELECT key FROM jobs
      WHERE is_active = 0 AND closed_at < datetime(?, '-30 days')
      LIMIT 5000
    )
  `).bind(now).run();
}

export async function archiveAndCleanupClosedJobs(env, now = new Date().toISOString()) {
  const rows = await env.DB.prepare(`
    SELECT * FROM jobs
    WHERE is_active = 0 AND closed_at < datetime(?, '-30 days')
    ORDER BY closed_at
    LIMIT 5000
  `).bind(now).all();
  if (!rows.results?.length) return { archived: 0 };

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
  return { archived: rows.results.length };
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
export async function pruneSyncRuns(db, now = new Date().toISOString(), retentionDays = 14) {
  let deleted = 0;
  for (let pass = 0; pass < 20; pass += 1) {
    const result = await db.prepare(`
      DELETE FROM sync_runs WHERE id IN (
        SELECT id FROM sync_runs WHERE started_at < datetime(?, ?) LIMIT 5000
      )
    `).bind(now, `-${retentionDays} days`).run();
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
    workplace: job.workplace ?? "Unspecified",
    employmentType: job.employmentType ?? null,
    category: job.category ?? "Other",
    publishedAt: job.publishedAt ?? null,
    url: job.url,
  };
  return {
    ...values,
    fingerprint: createHash("sha256").update(JSON.stringify(values)).digest("hex"),
  };
}

export function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
