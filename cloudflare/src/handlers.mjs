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
  pruneSyncRuns,
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
      refreshTitleSuggestions(env.DB, dailyAt),
    );
  }
  ctx.waitUntil(Promise.all(work));
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
        await processBoardTask(env, message.body);
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
    try {
      for (const group of chunks(claimedBoards, 100)) {
        await targetQueue.sendBatch(group.map((board) => ({ body: { type: "board", board } })));
        queued += group.length;
      }
    } catch (error) {
      await releaseBoards(env.DB, claimedBoards.map((board) => board.key));
      throw error;
    }
  }
  return { selected: boards.length, queued };
}

async function processBoardTask(env, task) {
  if (!task?.board?.key) throw new Error("Queue task is missing a board");
  const result = await syncBoard(task.board, {
    timeoutMs: 30_000,
    retries: 2,
    syncedAt: new Date().toISOString(),
  });
  result.companyLogoUrl = await resolveLogoIfStale(env, task.board, result);
  const applied = await applyBoardSnapshot(env.DB, result);
  if (applied.retry) throw new Error(result.board.error || "ATS refresh failed");
  return applied;
}

// Most ATS job APIs carry no logo, so the board's own HTML is scraped for one. That is an extra
// request per board, which is only affordable because the answer is cached on the companies row and
// rechecked about once a month -- and skipped entirely when the payload already supplied a logo.
async function resolveLogoIfStale(env, board, result) {
  if (result.board.status === "error") return null;
  if (result.jobs?.some((job) => job.companyLogoUrl)) return null;

  const company = await env.DB.prepare(`
    SELECT c.logo_url AS logoUrl, c.logo_checked_at AS checkedAt
    FROM boards b LEFT JOIN companies c ON c.key = b.company_key
    WHERE b.key = ?
  `).bind(board.key).first();

  if (company?.logoUrl) return company.logoUrl;
  if (company?.checkedAt && Date.parse(company.checkedAt) > Date.now() - LOGO_RECHECK_MS) return null;

  try {
    return await resolveBoardLogo(board, (url) =>
      requestWithRetry(url, { timeoutMs: 15_000, retries: 1 }));
  } catch (error) {
    // A board that serves jobs but not a scrapable page is not a refresh failure.
    console.warn("Logo resolution failed", { board: board.key, error: error.message });
    return null;
  }
}

async function healthResponse(env) {
  const [jobs, boards, due, failures, providers] = await env.DB.batch([
    env.DB.prepare("SELECT count(*) AS count FROM jobs WHERE is_active = 1"),
    env.DB.prepare("SELECT count(*) AS count FROM boards"),
    env.DB.prepare("SELECT count(*) AS count FROM boards WHERE next_sync_at <= datetime('now')"),
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
