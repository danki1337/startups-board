import { resolveBoardLogo } from "../../src/company-logo.mjs";
import { syncBoard } from "../../src/jobs.mjs";
import { requestWithRetry } from "../../src/validation.mjs";
import { queueForProvider } from "./config.mjs";

const LOGO_RECHECK_MS = 30 * 24 * 60 * 60 * 1_000;
import {
  applyBoardSnapshot,
  archiveAndCleanupClosedJobs,
  chunks,
  enqueueDueBoards,
  markBoardsQueued,
  pruneFailedTasks,
  pruneSyncRuns,
  reconcileFailedTasks,
  reconcileStuckSyncRuns,
  reconcileProviderHealth,
  refreshTitleSuggestions,
  releaseBoards,
  upsertDiscoveredBoards,
} from "./database.mjs";
import { processDiscoveryTask, seedDiscoveryTasks } from "./discovery.mjs";

export async function scheduled(controller, env, ctx) {
  const work = [];
  // controller.cron is the literal string from wrangler.jsonc, which uses SUN rather than 0.
  if (controller.cron !== "*/15 * * * *") work.push(seedDiscoveryTasks(env));
  // 2,000 per 15 minutes is ~192k refreshes/day, enough headroom for a ~60k-board registry.
  work.push(scheduleDueBoards(env, { limit: 2_000 }));
  // The 15-minute cron fires four times inside hour 4, so pin daily work to the top of the hour.
  const scheduledAt = new Date(controller.scheduledTime);
  if (scheduledAt.getUTCHours() === 4 && scheduledAt.getUTCMinutes() < 15) {
    const dailyAt = scheduledAt.toISOString();
    work.push(
      archiveAndCleanupClosedJobs(env, dailyAt),
      reconcileProviderHealth(env.DB, dailyAt),
      pruneSyncRuns(env.DB, dailyAt),
      reconcileFailedTasks(env.DB, dailyAt),
      reconcileStuckSyncRuns(env.DB, dailyAt),
      pruneFailedTasks(env.DB, dailyAt),
      refreshTitleSuggestions(env.DB, dailyAt),
    );
  }
  // allSettled, not all: the daily tasks are independent, and Promise.all rejects on the first
  // failure, which settles waitUntil and lets the runtime tear the isolate down mid-flight. One R2
  // hiccup in the archive step could cancel the job_titles rebuild after its DELETE had run,
  // leaving the title typeahead empty for a day with nothing to retry it.
  ctx.waitUntil(Promise.allSettled(work).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") console.error("Scheduled task failed", result.reason);
    }
  }));
}

export async function queue(batch, env) {
  if (batch.queue === "startups-board-dlq") {
    for (const message of batch.messages) {
      await recordDeadLetter(env.DB, message.body, message.attempts ?? 1, "Queue retries exhausted");
      message.ack();
    }
    return;
  }

  for (const message of batch.messages) {
    try {
      if (message.body?.type === "discovery") {
        await processDiscoveryTask(env, message.body);
      } else {
        // Only the first delivery advances the board.s failure ladder; the queue.s own retries of
        // the same refresh must not compound with it.
        await processBoardTask(env, message.body, { escalate: (message.attempts ?? 1) <= 1 });
      }
      message.ack();
    } catch (error) {
      console.error("Queue task failed", { queue: batch.queue, error: error.message });
      message.retry({ delaySeconds: retryDelay(message.attempts ?? 1) });
    }
  }
}

export async function handleOperatorRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") return healthResponse(env);
  if (!url.pathname.startsWith("/api/internal/admin/")) return null;

  const expected = env.ADMIN_TOKEN;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || actual !== expected) return Response.json({ error: "Unauthorized" }, { status: 401 });

  if (url.pathname === "/api/internal/admin/run" && request.method === "POST") {
    const payload = await request.json().catch(() => ({}));
    if (payload.discovery) {
      return Response.json({ ok: true, queued: await seedDiscoveryTasks(env, payload) });
    }
    return Response.json({ ok: true, ...(await scheduleDueBoards(env, payload)) });
  }

  if (url.pathname === "/api/internal/admin/import-boards" && request.method === "POST") {
    const payload = await request.json();
    if (!Array.isArray(payload.boards)) {
      return Response.json({ error: "boards must be an array" }, { status: 400 });
    }
    const inserted = await upsertDiscoveredBoards(env.DB, payload.boards.slice(0, 5_000));
    return Response.json({ ok: true, inserted });
  }

  if (url.pathname === "/api/internal/admin/failures" && request.method === "GET") {
    const failures = await env.DB.prepare(`
      SELECT * FROM failed_tasks WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 200
    `).all();
    return Response.json({ failures: failures.results ?? [] });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

export async function scheduleDueBoards(env, options = {}) {
  let boards = await enqueueDueBoards(env, options);
  if (options.provider) boards = boards.filter((board) => board.provider === options.provider);
  const groups = new Map();
  for (const board of boards) groups.set(board.provider, [...(groups.get(board.provider) ?? []), board]);
  let queued = 0;

  for (const [provider, providerBoards] of groups) {
    const targetQueue = queueForProvider(env, provider);
    if (!targetQueue) continue;
    const claimedKeys = new Set(await markBoardsQueued(env.DB, providerBoards.map((board) => board.key)));
    const claimedBoards = providerBoards.filter((board) => claimedKeys.has(board.key));
    // Release only what was never sent. Releasing every claimed board on a mid-way failure left
    // the already-sent ones both queued and selectable, so the next cron enqueued them a second
    // time -- two invocations then applied snapshots to the same board concurrently, double-counting
    // provider_health and letting one run close a job the other had just reopened.
    const pending = [...claimedBoards];
    try {
      for (const group of chunks(claimedBoards, 100)) {
        await targetQueue.sendBatch(group.map((board) => ({ body: { type: "board", board } })));
        pending.splice(0, group.length);
        queued += group.length;
      }
    } catch (error) {
      await releaseBoards(env.DB, pending.map((board) => board.key));
      throw error;
    }
  }
  return { selected: boards.length, queued };
}

async function processBoardTask(env, task, options = {}) {
  if (!task?.board?.key) throw new Error("Queue task is missing a board");
  const result = await syncBoard(task.board, {
    timeoutMs: 30_000,
    retries: 2,
    syncedAt: new Date().toISOString(),
  });
  const logo = await resolveLogoIfStale(env, task.board, result);
  result.companyLogoUrl = logo.url;
  result.logoChecked = logo.checked;
  const applied = await applyBoardSnapshot(env.DB, result, { escalate: options.escalate });
  if (applied.retry) throw new Error(result.board.error || "ATS refresh failed");
  return applied;
}

// Most ATS job APIs carry no logo, so the board's own HTML is scraped for one. That is an extra
// request per board, which is only affordable because the answer is cached on the companies row and
// rechecked about once a month -- and skipped entirely when the payload already supplied a logo.
//
// Returns { url, checked }: `checked` is true only when a scrape actually ran this refresh, so the
// snapshot writer can stamp logo_checked_at for real attempts alone. Stamping unconditionally kept
// pushing the timestamp forward on every refresh, which meant the monthly recheck never fired and a
// board whose single first-sync scrape failed stayed logo-less forever.
async function resolveLogoIfStale(env, board, result) {
  if (result.board.status === "error") return { url: null, checked: false };
  if (result.jobs?.some((job) => job.companyLogoUrl)) return { url: null, checked: false };

  const company = await env.DB.prepare(`
    SELECT c.logo_url AS logoUrl, c.logo_checked_at AS checkedAt
    FROM boards b LEFT JOIN companies c ON c.key = b.company_key
    WHERE b.key = ?
  `).bind(board.key).first();

  if (company?.logoUrl) return { url: company.logoUrl, checked: false };
  if (company?.checkedAt && Date.parse(company.checkedAt) > Date.now() - LOGO_RECHECK_MS) {
    return { url: null, checked: false };
  }

  try {
    const url = await resolveBoardLogo(board, (target) =>
      requestWithRetry(target, {
        timeoutMs: 15_000,
        retries: 1,
        // The default accept is application/json (right for the job APIs); this fetch wants the
        // board's HTML page.
        requestInit: { headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" } },
      }));
    return { url, checked: true };
  } catch (error) {
    // A board that serves jobs but not a scrapable page is not a refresh failure; still counts as
    // a check so an unscrapable site backs off for a month rather than being re-fetched daily.
    console.warn("Logo resolution failed", { board: board.key, error: error.message });
    return { url: null, checked: true };
  }
}

async function healthResponse(env) {
  // activeJobs comes from provider_health, which is maintained incrementally and reconciled daily
  // for exactly this purpose. It used to be count(*) over every active job: a full index scan on
  // each call, on an endpoint that is public, uncached, and typically polled by an uptime monitor --
  // ~720M rows read per day at a 60s interval, against a 25B/month allowance, for a liveness check.
  const now = new Date().toISOString();
  const [jobs, boards, due, failures, providers] = await env.DB.batch([
    env.DB.prepare("SELECT coalesce(sum(active_jobs), 0) AS count FROM provider_health"),
    env.DB.prepare("SELECT count(*) AS count FROM boards"),
    // Bound as ISO, not datetime('now'): the stored values are ISO strings and the two formats do
    // not compare correctly (see isoShift in database.mjs).
    env.DB.prepare("SELECT count(*) AS count FROM boards WHERE next_sync_at <= ?").bind(now),
    env.DB.prepare("SELECT count(*) AS count FROM failed_tasks WHERE resolved_at IS NULL"),
    env.DB.prepare("SELECT * FROM provider_health ORDER BY provider"),
  ]);
  const count = (result) => Number(result.results?.[0]?.count ?? 0);
  return Response.json({
    ok: true,
    activeJobs: count(jobs),
    boards: count(boards),
    dueBoards: count(due),
    unresolvedFailures: count(failures),
    providers: providers.results ?? [],
    checkedAt: new Date().toISOString(),
  }, { headers: { "cache-control": "no-store" } });
}

async function recordDeadLetter(db, payload, attempts, error) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO failed_tasks (id, task_type, provider, board_key, payload, error, attempts, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(), payload?.type ?? "unknown", payload?.board?.provider ?? payload?.target?.provider ?? null,
    payload?.board?.key ?? null, JSON.stringify(payload), error, attempts, now,
  ).run();
}

function retryDelay(attempt) {
  return Math.min(43_200, 30 * 2 ** Math.max(0, attempt - 1));
}
