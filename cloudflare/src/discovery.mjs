import { discoverTarget, getIndexes } from "../../src/common-crawl.mjs";
import { getDiscoveryTargets, parseAtsUrl } from "../../src/providers.mjs";
import { chunks, upsertDiscoveredBoards } from "./database.mjs";

export async function seedDiscoveryTasks(env, options = {}) {
  const indexes = await getIndexes(options.indexCount ?? 4);
  const targets = getDiscoveryTargets();
  const messages = [];
  const week = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1_000));
  for (const index of indexes) {
    for (const target of targets) {
      for (let sample = 0; sample < (options.samplesPerTarget ?? 5); sample += 1) {
        messages.push({ body: { type: "discovery", index, target, seed: week + sample } });
      }
    }
  }
  for (const group of chunks(messages, 100)) await env.QUEUE_DISCOVERY.sendBatch(group);
  return messages.length;
}

export async function processDiscoveryTask(env, task) {
  const { index, target, seed } = task;
  const seen = await env.DB.prepare(`
    SELECT page FROM discovery_pages
    WHERE index_id = ? AND provider = ? AND pattern = ?
  `).bind(index.id, target.provider, target.pattern).all();
  const result = await discoverTarget(target, {
    index,
    maxPages: 1,
    maxUrls: 50_000,
    sampleSeed: seed,
    seenPages: (seen.results ?? []).map((row) => row.page),
  });
  const boards = new Map();
  for (const url of result.urls) {
    const board = parseAtsUrl(url, target.provider);
    if (board) boards.set(board.key, board);
  }
  const now = new Date().toISOString();
  const inserted = await upsertDiscoveredBoards(env.DB, [...boards.values()], now);
  for (const page of result.sampledPages) {
    const key = `${index.id}:${target.provider}:${target.pattern}:${page}`;
    await env.DB.prepare(`
      INSERT OR REPLACE INTO discovery_pages
        (key, index_id, provider, pattern, page, total_pages, url_count, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      key, index.id, target.provider, target.pattern, page,
      result.totalPages, result.urls.length, now,
    ).run();
  }
  return { discovered: boards.size, inserted, pages: result.sampledPages };
}
