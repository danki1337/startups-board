import assert from "node:assert/strict";
import test from "node:test";
import {
  createDiscoveryState,
  getSampledPages,
  recordCrawlCoverage,
  summarizeCrawlCoverage,
} from "../src/discovery-state.mjs";

test("records and merges resumable crawl-page coverage", () => {
  const state = createDiscoveryState();
  const index = { id: "CC-MAIN-2026-25" };
  const target = { provider: "lever", pattern: "jobs.lever.co/*" };

  recordCrawlCoverage(state, index, target, {
    totalPages: 5,
    sampledPages: [0, 2],
  }, "2026-07-20T10:00:00.000Z");
  recordCrawlCoverage(state, index, target, {
    totalPages: 5,
    sampledPages: [1, 4],
  }, "2026-07-20T11:00:00.000Z");

  assert.deepEqual(getSampledPages(state, index, target), [0, 1, 2, 4]);
  assert.deepEqual(summarizeCrawlCoverage(state), {
    targets: 1,
    completedTargets: 0,
    totalPages: 5,
    sampledPages: 4,
    completion: 0.8,
  });
});
