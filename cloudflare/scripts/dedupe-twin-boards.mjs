// Deletes non-canonical case-twin boards and every job they carry, then reconciles the counts.
//
// The defect, measured on production 2026-07-26: 1,779 SmartRecruiters twin pairs (plus 6
// Greenhouse, 11 Rippling) -- "AccorHotel" beside "accorhotel", each syncing the same feed, each
// holding the same 5,744 jobs -- ~107,000 postings shown twice, 5.6% of the index. The mixed-case
// boards were imported on 2026-07-23 with pre-lowercasing code; the canonical lowercase twins
// arrived with the 2026-07-25 registry refresh. The import endpoint now re-derives every board
// through parseAtsUrl, so this class cannot re-enter; this script removes what already did.
//
// Keeps the LOWERCASE board (the canonical form parseAtsUrl produces today), deletes the
// mixed-case one and its jobs/companies/failed_tasks rows, then recounts provider_health so the
// homepage total is honest immediately rather than after the daily reconcile.
//
// Run:  node cloudflare/scripts/dedupe-twin-boards.mjs          (dry run: counts only)
//       node cloudflare/scripts/dedupe-twin-boards.mjs --apply  (do it)
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const wranglerPath = resolve(root, "web/node_modules/wrangler/bin/wrangler.js");
const apply = process.argv.includes("--apply");

// Lever is deliberately absent: its slugs are genuinely case-sensitive (pinned by a test).
const TWIN_BOARDS =
  "SELECT key FROM boards WHERE provider IN ('smartrecruiters','greenhouse','rippling')" +
  " AND identifier <> lower(identifier)";

function d1(sql) {
  const output = execFileSync(process.execPath, [
    wranglerPath, "d1", "execute", "startups-board-production", "--remote",
    "--config", resolve(root, "cloudflare/wrangler.jsonc"), "--json", "--command", sql,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(output)[0];
}

const boards = d1(`SELECT count(*) AS n FROM boards WHERE key IN (${TWIN_BOARDS})`).results[0].n;
const jobs = d1(`SELECT count(*) AS n FROM jobs WHERE board_key IN (${TWIN_BOARDS})`).results[0].n;
console.log(`${boards} non-canonical twin boards holding ${jobs} duplicate jobs`);
if (!apply) {
  console.log("Dry run. Re-run with --apply to delete them.");
  process.exit(0);
}

// Chunked: one statement deleting 100k jobs (x ~14 index/FTS rows each) trips D1's CPU ceiling.
let deleted = 0;
for (;;) {
  const pass = d1(
    `DELETE FROM jobs WHERE rowid IN (SELECT rowid FROM jobs WHERE board_key IN (${TWIN_BOARDS}) LIMIT 1500)`,
  ).meta.changes;
  deleted += pass;
  console.log(`  deleted ${deleted}/${jobs} jobs`);
  if (pass < 1_500) break;
}
console.log("companies rows:",
  d1(`DELETE FROM companies WHERE key IN (SELECT 'company:' || key FROM boards WHERE key IN (${TWIN_BOARDS}))`).meta.changes);
console.log("failed_tasks rows:", d1(`DELETE FROM failed_tasks WHERE board_key IN (${TWIN_BOARDS})`).meta.changes);
console.log("boards:", d1(`DELETE FROM boards WHERE key IN (${TWIN_BOARDS})`).meta.changes);

const now = new Date().toISOString();
for (const provider of ["smartrecruiters", "greenhouse", "rippling"]) {
  d1(`UPDATE provider_health SET active_jobs = (SELECT count(*) FROM jobs WHERE provider = '${provider}' AND is_active = 1), updated_at = '${now}' WHERE provider = '${provider}'`);
  console.log(`${provider} provider_health reconciled`);
}
console.log("Done. The Company dropdown and title aggregates rebuild at the 04:00 UTC cron.");
