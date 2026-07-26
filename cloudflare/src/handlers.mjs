import {
  resolveBoardLogoCandidates,
  firstUsableLogo,
  verifyLogoShape,
  CONSTRUCTED_LOGO_PROVIDERS,
} from "../../src/company-logo.mjs";
import { parseAtsUrl } from "../../src/providers.mjs";
import { syncBoard } from "../../src/jobs.mjs";
import { requestWithRetry } from "../../src/validation.mjs";
import { isRateLimitError, queueForProvider, rateLimitNextSyncAt } from "./config.mjs";

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
  reconcileProviderHealth,
  refreshTitleSuggestions,
  refreshCompanySuggestions,
  releaseBoards,
  upsertDiscoveredBoards,
} from "./database.mjs";
import { processDiscoveryTask, seedDiscoveryTasks } from "./discovery.mjs";

export async function scheduled(controller, env, ctx) {
  const work = [];
  // Discovery is NOT seeded from a cron any more. The weekly seeding ran for weeks and wrote zero
  // discovery_pages rows and zero dead letters: Common Crawl throttles Cloudflare egress, the
  // skip-on-throttle path returns empty, and every task "succeeded" at nothing -- while still
  // burning queue operations and hammering CC's index endpoints. Discovery belongs to the GitHub
  // workflow (residential-ish runners CC actually answers); the admin /run endpoint can still
  // trigger a worker-side pass by hand if that ever changes.
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
      pruneFailedTasks(env.DB, dailyAt),
      refreshTitleSuggestions(env.DB, dailyAt),
      refreshCompanySuggestions(env.DB, dailyAt),
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

  // A rate limit is provider-wide: once one board in this batch has answered 429/530, the other
  // nine are going to as well, and fetching them anyway is exactly the traffic the provider just
  // asked us to stop sending. Boards behind a limit the batch has already seen are stepped aside
  // without touching the ATS -- rescheduled hours out, no failure recorded, because they were
  // never actually attempted.
  const rateLimited = new Set();
  for (const message of batch.messages) {
    const provider = message.body?.board?.provider;
    try {
      if (message.body?.type === "discovery") {
        await processDiscoveryTask(env, message.body);
      } else if (provider && rateLimited.has(provider)) {
        await stepAsideForRateLimit(env.DB, message.body.board);
      } else {
        // Only the first delivery advances the board.s failure ladder; the queue.s own retries of
        // the same refresh must not compound with it.
        await processBoardTask(env, message.body, { escalate: (message.attempts ?? 1) <= 1 });
      }
      message.ack();
    } catch (error) {
      if (error.rateLimited && provider) {
        // The failure and its hours-long backoff are already recorded on the board; a queue retry
        // would just walk back into the limit five more times. Acked, not retried.
        rateLimited.add(provider);
        message.ack();
        continue;
      }
      console.error("Queue task failed", { queue: batch.queue, error: error.message });
      message.retry({ delaySeconds: retryDelay(message.attempts ?? 1) });
    }
  }
}

async function stepAsideForRateLimit(db, board) {
  const now = new Date().toISOString();
  await db.prepare(
    "UPDATE boards SET queue_state = 'idle', next_sync_at = ?, updated_at = ? WHERE key = ?",
  ).bind(rateLimitNextSyncAt(1, Date.parse(now)), now, board.key).run();
}

export async function handleOperatorRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") return healthResponse(env);
  if (!url.pathname.startsWith("/api/internal/admin/")) return null;

  const expected = env.ADMIN_TOKEN;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual || !timingSafeEqualString(actual, expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (url.pathname === "/api/internal/admin/run" && request.method === "POST") {
    const payload = await request.json().catch(() => ({}));
    if (payload.discovery) {
      return Response.json({ ok: true, queued: await seedDiscoveryTasks(env, payload) });
    }
    return Response.json({ ok: true, ...(await scheduleDueBoards(env, payload)) });
  }

  if (url.pathname === "/api/internal/admin/import-boards" && request.method === "POST") {
    const payload = await request.json().catch(() => ({}));
    if (!Array.isArray(payload.boards)) {
      return Response.json({ error: "boards must be an array" }, { status: 400 });
    }
    // Re-derived through parseAtsUrl HERE, not trusted from the payload. The import script already
    // canonicalizes, but the endpoint accepting whatever it was sent is how 1,779 SmartRecruiters
    // case-twin boards (AccorHotel next to accorhotel) got back in after the 07-23 cleanup -- an
    // import run with pre-fix data re-created them, and every twin pair duplicated its company's
    // entire listing (~107k twice-shown jobs). Boards whose URL no parser claims are dropped, and
    // the response says how many, so a bad input file is visible instead of silent.
    const canonical = new Map();
    for (const board of payload.boards.slice(0, 5_000)) {
      const parsed = parseAtsUrl(board.boardUrl || board.apiUrl, board.provider);
      if (parsed) canonical.set(parsed.key, parsed);
    }
    const inserted = await upsertDiscoveredBoards(env.DB, [...canonical.values()]);
    return Response.json({ ok: true, inserted, accepted: canonical.size, rejected: payload.boards.length - canonical.size });
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
    if (!targetQueue) {
      // A provider with no queue binding (added to the registry before its queue shipped, or a
      // typo'd import) must not just be skipped: its boards stay idle with next_sync_at in the
      // past, sort FIRST in enqueueDueBoards forever, and silently consume the whole 2,000-board
      // window -- the registry stops refreshing with no error anywhere. Parked a day ahead so the
      // window stays clear and they resurface if the binding appears.
      const now = new Date().toISOString();
      const parkedUntil = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
      for (const group of chunks(providerBoards, 50)) {
        await env.DB.batch(group.map((board) => env.DB.prepare(
          "UPDATE boards SET next_sync_at = ?, updated_at = ? WHERE key = ?",
        ).bind(parkedUntil, now, board.key)));
      }
      console.error("No queue binding for provider; boards parked 24h", { provider, boards: providerBoards.length });
      continue;
    }
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
  if (applied.retry) {
    const error = new Error(result.board.error || "ATS refresh failed");
    // Read by the queue handler: a rate-limited refresh is acked (its long backoff is already on
    // the board) and poisons the provider for the rest of the batch.
    error.rateLimited = isRateLimitError(result.board.error);
    throw error;
  }
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

  // A payload-supplied logo short-circuits everything below -- but only when the provider actually
  // published it. Workday's is CONSTRUCTED from the tenant URL, assumed rather than verified, and
  // measured across 13 production tenants it was usable exactly zero times: twelve website header
  // banners and a 404. Because it is non-null it also won the coalesce against companies.logo_url
  // in the read path, so it suppressed the scrape that would have worked. Constructed URLs now have
  // to prove themselves, and a failure falls through to the same HTML scrape every other provider
  // uses rather than being stored unverified.
  const payloadLogo = result.jobs?.find((job) => job.companyLogoUrl)?.companyLogoUrl ?? null;
  if (payloadLogo && !CONSTRUCTED_LOGO_PROVIDERS.has(board.provider)) {
    return { url: null, checked: false };
  }

  const company = await env.DB.prepare(`
    SELECT c.logo_url AS logoUrl, c.logo_checked_at AS checkedAt
    FROM boards b LEFT JOIN companies c ON c.key = b.company_key
    WHERE b.key = ?
  `).bind(board.key).first();

  // Both branches now hang off the same staleness gate. Previously a stored logo returned
  // immediately whatever its age, so a company that once resolved to a banner could never be
  // re-examined -- the recheck window only ever applied to companies that had NO logo. Gating both
  // on freshness means a bad stored logo gets another look on the normal monthly cycle, and
  // clearing logo_checked_at is enough to force one without destroying good values.
  const fresh = company?.checkedAt && Date.parse(company.checkedAt) > Date.now() - LOGO_RECHECK_MS;
  if (fresh) return { url: company?.logoUrl ?? null, checked: false };

  const fetchImage = (target) =>
    requestWithRetry(target, {
      timeoutMs: 10_000,
      retries: 1,
      requestInit: { headers: { accept: "image/*,*/*;q=0.8" } },
    });

  try {
    // A constructed candidate gets one chance to prove it is a real, square-ish image. When it
    // passes, that is the cheapest possible answer -- no scrape at all.
    if (payloadLogo) {
      const verified = await verifyLogoShape(payloadLogo, fetchImage);
      if (verified) return { url: verified, checked: true };
    }

    const candidates = await resolveBoardLogoCandidates(board, (target) =>
      requestWithRetry(target, {
        timeoutMs: 15_000,
        retries: 1,
        // The default accept is application/json (right for the job APIs); this fetch wants the
        // board's HTML page.
        requestInit: { headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" } },
      }));
    // Each candidate is verified, best-priority first, and the first real square-ish image wins.
    // og:image is a social-share banner by design, and the boards that fall through to it are the
    // ones whose own favicon we reject as a vendor asset -- so taking the top pick on trust threw
    // away a usable icon further down the list. Sampled on Lever, 30 of 32 stored logos were
    // banners the browser was always going to reject.
    const url = await firstUsableLogo(candidates, fetchImage);
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

// Constant-time string comparison for the bearer token. `!==` short-circuits at the first
// differing character, which leaks how much of a guess was right through response timing. The XOR
// accumulator touches every character regardless; comparing against a length-matched slice keeps
// the loop bound independent of the guess's length too.
export function timingSafeEqualString(a, b) {
  const left = String(a);
  const right = String(b);
  let mismatch = left.length === right.length ? 0 : 1;
  for (let index = 0; index < right.length; index += 1) {
    mismatch |= (left.charCodeAt(index % left.length) || 0) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}
