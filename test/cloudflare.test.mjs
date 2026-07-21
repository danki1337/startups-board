import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { nextSyncAt, PROVIDER_QUEUE_BINDINGS } from "../cloudflare/src/config.mjs";

test("production refresh cadence is adaptive", () => {
  const now = Date.UTC(2026, 6, 21, 0, 0, 0);
  assert.equal(nextSyncAt("active", 0, now), "2026-07-21T12:00:00.000Z");
  assert.equal(nextSyncAt("empty", 0, now), "2026-07-25T00:00:00.000Z");
  assert.equal(nextSyncAt("invalid", 0, now), "2026-08-20T00:00:00.000Z");
  assert.equal(nextSyncAt("error", 2, now), "2026-07-21T01:00:00.000Z");
});

test("every production ATS has an isolated queue binding", () => {
  assert.deepEqual(Object.keys(PROVIDER_QUEUE_BINDINGS).sort(), [
    "ashby", "bamboohr", "gem", "getro", "greenhouse", "icims", "lever", "paylocity", "sparkhire", "workday",
  ]);
});

test("production migration includes search, health, discovery, and failure state", async () => {
  const sql = await readFile(new URL("../cloudflare/migrations/0001_production.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS provider_health/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS discovery_pages/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS failed_tasks/);
});
