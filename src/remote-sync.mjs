import { createHash } from "node:crypto";

export function createRemoteSync(options = {}) {
  const endpoint = options.endpoint ?? process.env.REMOTE_SYNC_URL;
  const token = options.token ?? process.env.REMOTE_SYNC_TOKEN;
  const sitesToken = options.sitesToken ?? process.env.REMOTE_SITES_TOKEN;
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 3;

  if (!endpoint) throw new Error("REMOTE_SYNC_URL is required for remote synchronization");
  if (!token) throw new Error("REMOTE_SYNC_TOKEN is required for remote synchronization");

  return {
    async push(result) {
      const payload = {
        board: result.board,
        jobs: result.jobs.map(compactJob),
      };
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        let timeout;
        try {
          const controller = new AbortController();
          timeout = setTimeout(() => controller.abort(), 120_000);
          timeout.unref?.();
          const response = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              ...(sitesToken ? { "OAI-Sites-Authorization": `Bearer ${sitesToken}` } : {}),
              "content-type": "application/json",
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
          if (response.ok) return response.json();
          const message = await response.text();
          const error = new Error(`Remote sync failed with HTTP ${response.status}: ${message.slice(0, 300)}`);
          error.status = response.status;
          if (![408, 429, 500, 502, 503, 504].includes(response.status)) throw error;
          lastError = error;
        } catch (error) {
          lastError = error;
          if (error.status && ![408, 429, 500, 502, 503, 504].includes(error.status)) throw error;
        } finally {
          clearTimeout(timeout);
        }
        if (attempt < retries) await delay(1_000 * 2 ** attempt + Math.floor(Math.random() * 500));
      }
      throw lastError;
    },
  };
}

function compactJob(job) {
  const values = {
    key: job.key,
    sourceId: job.sourceId,
    boardKey: job.boardKey,
    provider: job.provider,
    companyIdentifier: job.companyIdentifier,
    companyName: job.companyName,
    companyLogoUrl: job.companyLogoUrl,
    title: job.title,
    location: job.location,
    workplace: job.workplace,
    employmentType: job.employmentType,
    category: job.category,
    publishedAt: job.publishedAt,
    url: job.url,
  };
  return {
    ...values,
    fingerprint: createHash("sha256").update(JSON.stringify(values)).digest("hex"),
  };
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
