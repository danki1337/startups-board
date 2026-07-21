import { InvalidPayloadError, getProvider } from "./providers.mjs";

export async function validateBoards(boards, options = {}) {
  const {
    concurrency = 4,
    timeoutMs = 15_000,
    retries = 2,
    fetchImpl = fetch,
    onProgress = () => {},
  } = options;

  const results = new Array(boards.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= boards.length) return;

      const candidate = boards[index];
      const validation = await validateBoard(candidate, { timeoutMs, retries, fetchImpl });
      results[index] = { ...candidate, validation };
      onProgress({ index: index + 1, total: boards.length, board: candidate, validation });
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, boards.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function selectValidationSample(boards, limit) {
  if (limit >= boards.length) return boards;
  if (limit <= 0) return [];

  const groups = new Map();
  for (const board of boards) {
    groups.set(board.provider, [...(groups.get(board.provider) ?? []), board]);
  }

  const providerGroups = [...groups.values()];
  const selected = [];
  let row = 0;

  while (selected.length < limit) {
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

export async function validateBoard(candidate, options = {}) {
  const { timeoutMs = 15_000, retries = 2, fetchImpl = fetch } = options;
  const provider = getProvider(candidate.provider);
  if (!provider) throw new Error(`Unsupported provider: ${candidate.provider}`);

  const checkedAt = new Date().toISOString();

  try {
    const providerResult = await provider.validate(candidate, (url, requestInit) =>
      requestWithRetry(url, { timeoutMs, retries, fetchImpl, requestInit }),
    );

    return {
      status: providerResult.jobCount > 0 ? "active" : "empty",
      checkedAt,
      ...providerResult,
    };
  } catch (error) {
    return {
      status: classifyError(error),
      checkedAt,
      jobCount: 0,
      error: error.message,
    };
  }
}

export async function requestWithRetry(url, options) {
  const { timeoutMs, retries, fetchImpl, requestInit = {} } = options;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let timeout;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      const response = await fetchImpl(url, {
        ...requestInit,
        headers: {
          accept: "application/json",
          "user-agent": "StartupsBoardDiscovery/0.1 (+https://startups.board)",
          ...requestInit.headers,
        },
        signal: controller.signal,
      });

      if (response.ok) return response;

      const error = new HttpError(response.status, `HTTP ${response.status} from ${new URL(url).hostname}`);
      if (!isRetryableStatus(response.status) || attempt === retries) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (error instanceof HttpError && !isRetryableStatus(error.status)) throw error;
      if (attempt === retries) throw error;
    } finally {
      clearTimeout(timeout);
    }

    const baseDelay = 300 * 2 ** attempt;
    await delay(baseDelay * (0.5 + Math.random()));
  }

  throw lastError;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function classifyError(error) {
  if (error instanceof HttpError && (error.status === 404 || error.status === 410)) return "invalid";
  if (error instanceof InvalidPayloadError || error instanceof SyntaxError) return "invalid";
  return "error";
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
