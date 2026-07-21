import assert from "node:assert/strict";
import test from "node:test";
import {
  addDiscoveredUrl,
  arrayToRegistry,
  createRegistry,
  registryToArray,
} from "../src/registry.mjs";

test("deduplicates job URLs belonging to the same board", () => {
  const registry = createRegistry();

  addDiscoveredUrl(registry, "https://jobs.lever.co/example/first", {
    discoverySource: "crawl-a",
    discoveredAt: "2026-01-01T00:00:00.000Z",
  });
  addDiscoveredUrl(registry, "https://jobs.lever.co/example/second", {
    discoverySource: "crawl-b",
    discoveredAt: "2026-01-02T00:00:00.000Z",
  });

  const records = registryToArray(registry);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].discoverySources, ["crawl-a", "crawl-b"]);
  assert.equal(records[0].sampleUrls.length, 2);
  assert.equal(records[0].firstDiscoveredAt, "2026-01-01T00:00:00.000Z");
});

test("deduplicates case variants of an Ashby board", () => {
  const registry = createRegistry();

  addDiscoveredUrl(registry, "https://jobs.ashbyhq.com/G2/first");
  addDiscoveredUrl(registry, "https://jobs.ashbyhq.com/g2/second");

  assert.equal(registry.size, 1);
  assert.equal(registryToArray(registry)[0].sampleUrls.length, 2);
});

test("canonicalizes Workday case variants when loading an existing registry", () => {
  const records = [
    {
      key: "workday:global:acme|wd5|External",
      provider: "workday",
      identifier: "acme|wd5|External",
      boardUrl: "https://acme.wd5.myworkdayjobs.com/External",
      discoverySources: ["crawl-a"],
      sampleUrls: ["https://acme.wd5.myworkdayjobs.com/External"],
    },
    {
      key: "workday:global:acme|wd5|external",
      provider: "workday",
      identifier: "acme|wd5|external",
      boardUrl: "https://acme.wd5.myworkdayjobs.com/external",
      discoverySources: ["crawl-b"],
      sampleUrls: ["https://acme.wd5.myworkdayjobs.com/external"],
    },
  ];

  const registry = arrayToRegistry(records);
  const [record] = registryToArray(registry);
  assert.equal(registry.size, 1);
  assert.equal(record.key, "workday:global:acme|wd5|external");
  assert.deepEqual(record.discoverySources, ["crawl-a", "crawl-b"]);
});
