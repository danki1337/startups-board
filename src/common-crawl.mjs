const COLLINFO_URL = "https://index.commoncrawl.org/collinfo.json";

export async function getLatestIndex(fetchImpl = fetch) {
  const indexes = await getIndexes(1, fetchImpl);
  return indexes[0];
}

export async function getIndexes(maximum = 4, fetchImpl = fetch) {
  const response = await fetchImpl(COLLINFO_URL, {
    headers: { "user-agent": userAgent() },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) throw new Error(`Common Crawl index lookup failed with HTTP ${response.status}`);

  const indexes = await response.json();
  if (!Array.isArray(indexes) || !indexes[0]?.id) {
    throw new Error("Common Crawl returned an unexpected index list");
  }

  return indexes.slice(0, Math.max(0, maximum)).map((index) => ({
    id: index.id,
    api: index["cdx-api"] ?? `https://index.commoncrawl.org/${index.id}-index`,
  }));
}

export async function discoverTarget(target, options = {}) {
  const {
    index,
    maxPages = 5,
    pageSize = 1,
    maxUrls = 25_000,
    sampleSeed,
    seenPages,
    fetchImpl = fetch,
    onProgress = () => {},
  } = options;

  if (!index?.api) throw new Error("A Common Crawl index API URL is required");

  const baseParams = new URLSearchParams({
    // Domain targets cover ATS products that assign each customer a subdomain;
    // prefix targets remain much cheaper for providers with a shared jobs host.
    url: target.query ?? target.pattern.replace(/\*$/, ""),
    matchType: target.matchType ?? "prefix",
    output: "json",
    pageSize: String(pageSize),
    filter: "status:200",
    collapse: "urlkey",
  });

  const countUrl = `${index.api}?${baseParams}&showNumPages=true`;
  const countResponse = await fetchCommonCrawl(countUrl, fetchImpl, { allowNoCaptures: true });
  if (!countResponse) return { urls: [], totalPages: 0, sampledPages: [] };
  const countPayload = await countResponse.json();
  const totalPages = Math.max(0, Number(countPayload.pages ?? 0));
  const pages = Array.isArray(seenPages)
    ? selectUnseenPages(totalPages, maxPages, seenPages, sampleSeed)
    : sampleSeed === undefined
      ? selectEvenlySpacedPages(totalPages, maxPages)
      : selectRotatingPages(totalPages, maxPages, sampleSeed);
  const urls = [];

  for (const page of pages) {
    onProgress({ type: "page", provider: target.provider, pattern: target.pattern, page, totalPages });
    const pageParams = new URLSearchParams(baseParams);
    pageParams.set("page", String(page));

    const response = await fetchCommonCrawl(`${index.api}?${pageParams}`, fetchImpl, {
      allowNoCaptures: true,
    });
    if (!response) continue;
    const text = await response.text();

    for (const line of text.split("\n")) {
      if (!line.trim()) continue;

      try {
        const record = JSON.parse(line);
        if (record.url) urls.push(record.url);
      } catch {
        // A malformed archive line should not invalidate the rest of the discovery run.
      }

      if (urls.length >= maxUrls) return { urls, totalPages, sampledPages: pages };
    }
  }

  return { urls, totalPages, sampledPages: pages };
}

export function selectEvenlySpacedPages(totalPages, maximum) {
  if (totalPages <= 0 || maximum <= 0) return [];
  if (totalPages <= maximum) return Array.from({ length: totalPages }, (_, index) => index);
  if (maximum === 1) return [Math.floor((totalPages - 1) / 2)];

  const selected = new Set();
  for (let index = 0; index < maximum; index += 1) {
    selected.add(Math.round((index * (totalPages - 1)) / (maximum - 1)));
  }
  return [...selected].sort((left, right) => left - right);
}

export function selectRotatingPages(totalPages, maximum, seed = 0) {
  if (totalPages <= maximum) return selectEvenlySpacedPages(totalPages, maximum);
  if (totalPages <= 0 || maximum <= 0) return [];
  if (maximum === 1) return [positiveModulo(seed, totalPages)];

  const start = positiveModulo(seed, totalPages);
  const step = totalPages / maximum;
  const selected = new Set();
  for (let index = 0; index < maximum; index += 1) {
    selected.add(Math.floor((start + index * step) % totalPages));
  }
  return [...selected].sort((left, right) => left - right);
}

export function selectUnseenPages(totalPages, maximum, seenPages = [], seed = 0) {
  if (totalPages <= 0 || maximum <= 0) return [];
  const seen = new Set(
    seenPages
      .map(Number)
      .filter((page) => Number.isInteger(page) && page >= 0 && page < totalPages),
  );
  const unseen = Array.from({ length: totalPages }, (_, page) => page)
    .filter((page) => !seen.has(page));
  if (unseen.length <= maximum) return unseen;
  return selectRotatingPages(unseen.length, maximum, seed).map((index) => unseen[index]);
}

function positiveModulo(value, divisor) {
  return ((Math.trunc(Number(value) || 0) % divisor) + divisor) % divisor;
}

async function fetchCommonCrawl(url, fetchImpl, options = {}) {
  const retries = options.retries ?? 3;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { "user-agent": userAgent() },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      if (attempt < retries) {
        await delay(1_000 * 2 ** attempt);
        continue;
      }
      throw error;
    }

    if (response.status === 404 && options.allowNoCaptures) return null;
    if (response.ok) return response;

    const body = await response.text();
    const transientProxyFailure = response.status === 400
      && /connection aborted|remote.?disconnected|timed?\s*out|temporar(?:y|ily)/i.test(body);
    const retryable = response.status === 429 || response.status >= 500 || transientProxyFailure;
    if (retryable && attempt < retries) {
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      await delay(Number.isFinite(retryAfter) ? retryAfter * 1_000 : 1_000 * 2 ** attempt);
      continue;
    }

    throw new Error(`Common Crawl request failed with HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  throw new Error("Common Crawl request failed after retries");
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function userAgent() {
  return "StartupsBoardDiscovery/0.1 (+https://startups.board; respectful research prototype)";
}
