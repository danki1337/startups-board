// Seed curated company boards straight into the production registry.
//
// Common Crawl discovery only finds a board if its URL appeared in the crawl shards we have
// scanned, so well-known companies can be missing simply because nobody we crawled linked to
// them. This script closes that gap: it reads data/seed-boards.json (a list of ATS board URLs),
// parses each with the same provider parsers discovery uses, validates the board against the
// live ATS API, and imports the valid ones via the admin endpoint. Imported boards enter as
// status "new" with next_sync_at = now, so the 15-minute cron crawls them automatically.
//
// Usage: npm run seed:boards          (reads ADMIN_TOKEN/WORKER_URL from .env.production or env)
//        node scripts/seed-boards.mjs --dry-run
import { readFile } from "node:fs/promises";
import { parseAtsUrl } from "../src/providers.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const root = new URL("..", import.meta.url);

async function loadEnv() {
  const env = { WORKER_URL: process.env.WORKER_URL, ADMIN_TOKEN: process.env.ADMIN_TOKEN };
  try {
    const raw = await readFile(new URL(".env.production", root), "utf8");
    for (const line of raw.split("\n")) {
      const match = /^([A-Z_]+)=(.+)$/.exec(line.trim());
      if (match && !env[match[1]]) env[match[1]] = match[2];
    }
  } catch {
    // No .env.production; rely on process env.
  }
  env.WORKER_URL ??= "https://startups-board.dilizarov8823.workers.dev";
  return env;
}

// A board is only imported when its ATS API answers, so a typo'd or retired slug cannot enter the
// registry (it would otherwise burn refresh cycles until the invalid backoff catches it).
async function validate(board) {
  try {
    const response = await fetch(board.apiUrl, {
      headers: { accept: "application/json", "user-agent": "StartupsBoardSeed/0.1" },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

const { boards: urls } = JSON.parse(await readFile(new URL("data/seed-boards.json", root), "utf8"));
const parsed = [];
for (const url of urls) {
  const board = parseAtsUrl(url);
  if (!board) {
    console.warn(`SKIP (unparseable): ${url}`);
    continue;
  }
  parsed.push(board);
}

const valid = [];
for (const board of parsed) {
  if (await validate(board)) {
    valid.push(board);
    console.log(`ok    ${board.key}`);
  } else {
    console.warn(`SKIP (API not answering): ${board.key} -> ${board.apiUrl}`);
  }
}

console.log(`\n${valid.length}/${urls.length} boards validated`);
if (DRY_RUN || valid.length === 0) {
  if (DRY_RUN) console.log("Dry run: nothing imported.");
  process.exit(0);
}

const env = await loadEnv();
if (!env.ADMIN_TOKEN) {
  console.error("ADMIN_TOKEN not found in env or .env.production; cannot import.");
  process.exit(1);
}

const response = await fetch(`${env.WORKER_URL}/api/internal/admin/import-boards`, {
  method: "POST",
  headers: { authorization: `Bearer ${env.ADMIN_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ boards: valid }),
});
const payload = await response.json();
if (!response.ok) {
  console.error("Import failed:", response.status, payload);
  process.exit(1);
}
// `inserted` counts new rows; already-registered boards upsert harmlessly (URL refresh only).
console.log(`Imported: ${payload.inserted} new of ${valid.length} submitted (rest already registered).`);
console.log("New boards are status=new and due immediately; the 15-minute cron will crawl them.");
