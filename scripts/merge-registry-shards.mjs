#!/usr/bin/env node
// Combine per-provider discovery shards back into data/discovered-boards.json.
//
// The harvest used to run every provider inside one job and walk them in a fixed order, so once the
// job hit its time limit the providers at the end of the list were never reached at all -- which is
// why Getro sat at 4 boards and Spark Hire at 0 despite both having Common Crawl coverage. Each
// provider now harvests in its own matrix job and drops a shard here.
//
//   node scripts/merge-registry-shards.mjs data/shards/*.json

import { readFile, writeFile } from "node:fs/promises";
import { arrayToRegistry, registryToArray } from "../src/registry.mjs";

const REGISTRY_PATH = new URL("../data/discovered-boards.json", import.meta.url);

async function readBoards(path) {
  const payload = JSON.parse(await readFile(path, "utf8"));
  const boards = Array.isArray(payload) ? payload : payload.boards;
  if (!Array.isArray(boards)) throw new Error(`${path} does not contain a boards array`);
  return boards;
}

const shardPaths = process.argv.slice(2);
if (!shardPaths.length) throw new Error("Pass at least one shard file to merge");

const existing = JSON.parse(await readFile(REGISTRY_PATH, "utf8"));
if (!Array.isArray(existing?.boards)) {
  throw new Error("Expected data/discovered-boards.json to contain a boards array");
}

const before = existing.boards.length;
// arrayToRegistry keys by canonical board key and unions discoverySources/sampleUrls, so shards
// that rediscover the same board merge rather than duplicate.
const combined = [...existing.boards];
for (const path of shardPaths) {
  const boards = await readBoards(path);
  combined.push(...boards);
  console.log(`${path}: ${boards.length} boards`);
}

const merged = registryToArray(arrayToRegistry(combined));
const counts = {};
for (const board of merged) counts[board.provider] = (counts[board.provider] ?? 0) + 1;

console.log(`\nregistry: ${before} -> ${merged.length} boards (+${merged.length - before})`);
console.table(counts);

await writeFile(REGISTRY_PATH, `${JSON.stringify({
  ...existing,
  shardMergedAt: new Date().toISOString(),
  boards: merged,
}, null, 2)}\n`);
console.log(`wrote ${REGISTRY_PATH.pathname}`);
