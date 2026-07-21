const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";

export const DEFAULT_FIRECRAWL_QUERIES = [
  "site:jobs.lever.co",
  "site:jobs.eu.lever.co",
  "site:boards.greenhouse.io",
  "site:job-boards.greenhouse.io",
  "site:jobs.ashbyhq.com",
];

export async function discoverWithFirecrawl(options = {}) {
  const {
    apiKey = process.env.FIRECRAWL_API_KEY,
    queries = DEFAULT_FIRECRAWL_QUERIES,
    limit = 50,
    creditBudget = 100,
    timeoutMs = 60_000,
    retries = 2,
    fetchImpl = fetch,
    onProgress = () => {},
  } = options;

  const perQueryCredits = Math.max(2, Math.ceil(limit / 10) * 2);
  const selectedQueries = queries.slice(0, Math.max(0, Math.floor(creditBudget / perQueryCredits)));
  const urls = new Set();
  const results = [];
  let creditsUsed = 0;

  for (let index = 0; index < selectedQueries.length; index += 1) {
    const query = selectedQueries[index];
    onProgress({ index: index + 1, total: selectedQueries.length, query });
    const payload = await firecrawlSearch(query, {
      apiKey,
      limit,
      timeoutMs,
      retries,
      fetchImpl,
    });
    const items = Array.isArray(payload.data?.web)
      ? payload.data.web
      : Array.isArray(payload.data)
        ? payload.data
        : [];

    for (const item of items) {
      if (item?.url) urls.add(item.url);
    }
    const queryCredits = Number(payload.creditsUsed ?? perQueryCredits);
    creditsUsed += Number.isFinite(queryCredits) ? queryCredits : perQueryCredits;
    results.push({ query, resultCount: items.length, creditsUsed: queryCredits });
  }

  return {
    urls: [...urls],
    creditsUsed,
    queries: results,
    estimatedMaximumCredits: selectedQueries.length * perQueryCredits,
  };
}

async function firecrawlSearch(query, options) {
  let lastError;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      const headers = { "content-type": "application/json" };
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
      const response = await options.fetchImpl(FIRECRAWL_SEARCH_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, limit: options.limit, sources: ["web"] }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.success !== false) return payload;

      const error = new Error(payload.error || `Firecrawl search failed with HTTP ${response.status}`);
      error.status = response.status;
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt >= options.retries) throw error;
      const retryAfter = Number(response.headers.get("retry-after"));
      await delay(Number.isFinite(retryAfter) ? retryAfter * 1_000 : 1_000 * 2 ** attempt);
      lastError = error;
    } catch (error) {
      lastError = error;
      if (attempt >= options.retries || error.status) throw error;
      await delay(1_000 * 2 ** attempt);
    }
  }
  throw lastError;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
