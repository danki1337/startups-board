import { getProvider, InvalidPayloadError } from "./providers.mjs";
import { requestWithRetry } from "./validation.mjs";

// Tuned per provider rather than globally: a shared pool lets one slow ATS starve every other.
// The Workday/Greenhouse/Lever/iCIMS/BambooHR/Ashby/Paylocity figures match the pools the reference
// aggregator runs in production against the same APIs, which is how it sustains a daily full-registry
// crawl. Gem, Getro and Spark Hire have no reference counterpart; Getro stays low because it is the
// one provider already returning HTTP 530 under our current, much gentler load.
export const DEFAULT_PROVIDER_CONCURRENCY = Object.freeze({
  ashby: 5,
  bamboohr: 10,
  gem: 6,
  getro: 2,
  greenhouse: 30,
  icims: 30,
  lever: 30,
  paylocity: 5,
  sparkhire: 3,
  workday: 50,
});

export async function syncJobs(boards, options = {}) {
  const {
    concurrency = 6,
    timeoutMs = 20_000,
    retries = 2,
    limit = boards.length,
    providerConcurrency = DEFAULT_PROVIDER_CONCURRENCY,
    fetchImpl = fetch,
    onProgress = () => {},
    onBoardSynced = async () => {},
    retainJobs = true,
  } = options;

  const selectedBoards = selectSyncBoards(boards, Math.max(0, limit));
  const syncedAt = new Date().toISOString();
  const boardResults = new Array(selectedBoards.length);
  const jobsByKey = new Map();
  let totalJobCount = 0;
  const globalLimit = Math.max(1, Math.min(concurrency, selectedBoards.length || 1));
  const pending = selectedBoards.map((board, index) => ({ board, index }));
  const activeByProvider = new Map();

  await new Promise((resolvePromise, reject) => {
    let active = 0;
    let completed = 0;
    let stopped = false;

    function schedule() {
      if (stopped) return;
      if (completed === selectedBoards.length) {
        resolvePromise();
        return;
      }

      while (active < globalLimit && pending.length) {
        const pendingIndex = pending.findIndex(({ board }) => {
          const providerLimit = Math.max(
            1,
            Number(providerConcurrency[board.provider] ?? globalLimit),
          );
          return (activeByProvider.get(board.provider) ?? 0) < providerLimit;
        });
        if (pendingIndex < 0) return;

        const [{ board, index }] = pending.splice(pendingIndex, 1);
        active += 1;
        activeByProvider.set(board.provider, (activeByProvider.get(board.provider) ?? 0) + 1);

        syncBoard(board, { timeoutMs, retries, fetchImpl, syncedAt })
          .then(async (result) => {
            await onBoardSynced(result);
            boardResults[index] = result.board;
            totalJobCount += result.jobs.length;
            if (retainJobs) {
              for (const job of result.jobs) jobsByKey.set(job.key, job);
            }
            onProgress({
              index: index + 1,
              total: selectedBoards.length,
              board,
              result: result.board,
            });
          })
          .catch((error) => {
            stopped = true;
            reject(error);
          })
          .finally(() => {
            active -= 1;
            completed += 1;
            activeByProvider.set(board.provider, activeByProvider.get(board.provider) - 1);
            schedule();
          });
      }
    }

    schedule();
  });

  return {
    syncedAt,
    boards: boardResults,
    jobs: [...jobsByKey.values()].sort(compareJobs),
    totalJobCount,
  };
}

export async function syncBoard(board, options = {}) {
  const {
    timeoutMs = 20_000,
    retries = 2,
    fetchImpl = fetch,
    syncedAt = new Date().toISOString(),
  } = options;
  const provider = getProvider(board.provider);
  if (!provider?.fetchJobs || !provider?.normalizeJob) {
    throw new Error(`Provider ${board.provider} does not support job synchronization`);
  }

  try {
    const rawJobs = await provider.fetchJobs(board, (url, requestInit) =>
      requestWithRetry(url, { timeoutMs, retries, fetchImpl, requestInit }),
    );
    const jobs = rawJobs.map((job) => provider.normalizeJob(board, job, syncedAt));

    return {
      board: {
        key: board.key,
        provider: board.provider,
        identifier: board.identifier,
        status: jobs.length > 0 ? "active" : "empty",
        jobCount: jobs.length,
        syncedAt,
        error: null,
      },
      jobs,
    };
  } catch (error) {
    return {
      board: {
        key: board.key,
        provider: board.provider,
        identifier: board.identifier,
        status: isPermanentBoardFailure(error) ? "invalid" : "error",
        jobCount: 0,
        syncedAt,
        error: error.message,
      },
      jobs: [],
    };
  }
}

// 404/410 are the obvious dead-board signals, but the larger source of wasted retries is a stale
// identifier whose ATS still answers 200 with something that is not a board (BambooHR alone
// accounted for ~35% of all failed runs). Both back off for 30 days instead of every 15 minutes.
function isPermanentBoardFailure(error) {
  if (error.status === 404 || error.status === 410) return true;
  return error instanceof InvalidPayloadError;
}

export function summarizeSync(result) {
  const summary = {
    boardCount: result.boards.length,
    jobCount: result.totalJobCount ?? result.jobs.length,
    statuses: {},
    providers: {},
  };

  for (const board of result.boards) {
    summary.statuses[board.status] = (summary.statuses[board.status] ?? 0) + 1;
    const provider = (summary.providers[board.provider] ??= { boards: 0, jobs: 0 });
    provider.boards += 1;
    provider.jobs += board.jobCount;
  }

  return summary;
}

function compareJobs(left, right) {
  const dateComparison = String(right.publishedAt ?? "").localeCompare(String(left.publishedAt ?? ""));
  if (dateComparison) return dateComparison;
  return left.key.localeCompare(right.key);
}

function selectSyncBoards(boards, limit) {
  if (limit <= 0) return [];
  const groups = new Map();
  for (const board of boards) {
    groups.set(board.provider, [...(groups.get(board.provider) ?? []), board]);
  }

  const selected = [];
  const providerGroups = [...groups.values()];
  let row = 0;
  while (selected.length < Math.min(limit, boards.length)) {
    let added = false;
    for (const group of providerGroups) {
      if (group[row] && selected.length < limit) {
        selected.push(group[row]);
        added = true;
      }
    }
    if (!added) break;
    row += 1;
  }
  return selected;
}
