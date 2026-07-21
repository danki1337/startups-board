import assert from "node:assert/strict";
import test from "node:test";
import { discoverWithFirecrawl } from "../src/firecrawl.mjs";

test("discovers URLs within a fixed Firecrawl credit budget", async () => {
  const requests = [];
  const result = await discoverWithFirecrawl({
    apiKey: "fc-test",
    queries: ["site:jobs.ashbyhq.com", "site:jobs.lever.co", "unused"],
    limit: 20,
    creditBudget: 8,
    retries: 0,
    fetchImpl: async (_url, init) => {
      requests.push({ headers: init.headers, body: JSON.parse(init.body) });
      return Response.json({
        success: true,
        data: { web: [{ url: `https://jobs.ashbyhq.com/company-${requests.length}` }] },
        creditsUsed: 4,
      });
    },
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.authorization, "Bearer fc-test");
  assert.deepEqual(result.urls, [
    "https://jobs.ashbyhq.com/company-1",
    "https://jobs.ashbyhq.com/company-2",
  ]);
  assert.equal(result.creditsUsed, 8);
  assert.equal(result.estimatedMaximumCredits, 8);
});
