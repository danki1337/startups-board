#!/usr/bin/env node

import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { discoverTarget, getIndexes } from "./common-crawl.mjs";
import { getBoardSyncStates, importJobSnapshot } from "./database.mjs";
import {
  createDiscoveryState,
  getSampledPages,
  recordCrawlCoverage,
  summarizeCrawlCoverage,
} from "./discovery-state.mjs";
import { discoverWithFirecrawl } from "./firecrawl.mjs";
import { getDiscoveryTargets, listProviders } from "./providers.mjs";
import { addDiscoveredUrl, arrayToRegistry, registryToArray } from "./registry.mjs";
import { buildReport } from "./report.mjs";
import { createRemoteSync } from "./remote-sync.mjs";
import { startApiServer } from "./server.mjs";
import { summarizeSync, syncJobs } from "./jobs.mjs";
import { runUpdater } from "./updater.mjs";
import { selectValidationSample, validateBoards } from "./validation.mjs";

const command = process.argv[2] ?? "help";
const options = parseOptions(process.argv.slice(3));

try {
  if (command === "discover") await discoverCommand(options);
  else if (command === "validate") await validateCommand(options);
  else if (command === "sync") await syncCommand(options);
  else if (command === "database") await databaseCommand(options);
  else if (command === "watch") await watchCommand(options);
  else if (command === "serve") await serveCommand(options);
  else if (command === "system") await systemCommand(options);
  else if (command === "run") await runCommand(options);
  else printHelp(command !== "help");
} catch (error) {
  console.error(`\nError: ${error.message}`);
  process.exitCode = 1;
}

async function discoverCommand(options) {
  const output = resolve(options.output ?? "data/discovered-boards.json");
  const statePath = resolve(options.discoveryState ?? "data/discovery-state.json");
  const existing = asBoolean(options.mergeExisting, true) ? await readJsonIfExists(output) : null;
  const crawlState = asBoolean(options.resumeDiscovery, true)
    ? await readJsonIfExists(statePath)
    : null;
  const result = await discover({
    ...options,
    existingBoards: existing?.boards ?? [],
    crawlState,
    onDiscoveryCheckpoint: (checkpoint) => writeDiscoveryCheckpoint(checkpoint, output, statePath),
  });
  const { crawlState: nextCrawlState, ...discovery } = result;
  await writeJson(statePath, nextCrawlState);
  await writeJson(output, discovery);
  printDiscoverySummary(discovery, output, statePath);
}

async function validateCommand(options) {
  const input = resolve(options.input ?? "data/discovered-boards.json");
  const output = resolve(options.output ?? "data/validated-boards.json");
  const reportPath = resolve(options.report ?? "data/discovery-report.md");
  const discovery = JSON.parse(await readFile(input, "utf8"));
  // A ~55k-board registry cannot be validated inside one Actions job, so runs are sharded by
  // provider and their outputs merged afterwards.
  const selected = options.provider
    ? discovery.boards.filter((board) => board.provider === options.provider)
    : discovery.boards;
  if (options.provider) {
    console.log(`Filtered to ${selected.length} ${options.provider} boards`);
  }
  const boards = await validate(selected, options);

  await writeJson(output, { ...discovery, validatedAt: new Date().toISOString(), boards });
  await writeText(
    reportPath,
    buildReport(boards, {
      indexId: discovery.index?.id,
      discoveredBoardCount: discovery.boards.length,
    }),
  );
  printValidationSummary(boards, output, reportPath);
}

async function runCommand(options) {
  const discoveryPath = resolve(options.discoveryOutput ?? "data/discovered-boards.json");
  const statePath = resolve(options.discoveryState ?? "data/discovery-state.json");
  const output = resolve(options.output ?? "data/validated-boards.json");
  const reportPath = resolve(options.report ?? "data/discovery-report.md");
  const existing = asBoolean(options.mergeExisting, true) ? await readJsonIfExists(discoveryPath) : null;
  const crawlState = asBoolean(options.resumeDiscovery, true)
    ? await readJsonIfExists(statePath)
    : null;
  const result = await discover({
    ...options,
    existingBoards: existing?.boards ?? [],
    crawlState,
    onDiscoveryCheckpoint: (checkpoint) => writeDiscoveryCheckpoint(
      checkpoint,
      discoveryPath,
      statePath,
    ),
  });
  const { crawlState: nextCrawlState, ...discovery } = result;
  await writeJson(statePath, nextCrawlState);
  await writeJson(discoveryPath, discovery);
  printDiscoverySummary(discovery, discoveryPath);

  const boards = await validate(discovery.boards, options);
  await writeJson(output, { ...discovery, validatedAt: new Date().toISOString(), boards });
  await writeText(
    reportPath,
    buildReport(boards, {
      indexId: discovery.index?.id,
      discoveredBoardCount: discovery.boards.length,
    }),
  );
  printValidationSummary(boards, output, reportPath);
}

async function syncCommand(options) {
  const input = resolve(options.input ?? "data/discovered-boards.json");
  const output = resolve(options.output ?? "data/jobs.json");
  const syncOutput = resolve(options.syncOutput ?? "data/job-sync.json");
  const discovery = JSON.parse(await readFile(input, "utf8"));
  const allBoards = Array.isArray(discovery.boards) ? discovery.boards : [];
  const requestedProviders = options.providers
    ? new Set(commaList(options.providers).map((provider) => provider.toLocaleLowerCase()))
    : null;
  let boards = requestedProviders
    ? allBoards.filter((board) => requestedProviders.has(board.provider))
    : allBoards;
  const eligibleBoardCount = boards.length;
  if (asBoolean(options.onlyNew, false)) {
    const states = await getBoardSyncStates(resolve(options.database ?? "data/jobs.db"));
    boards = allBoards.filter((board) => !states.has(board.key));
    if (requestedProviders) boards = boards.filter((board) => requestedProviders.has(board.provider));
    console.log(`New-board schedule selected ${boards.length} of ${eligibleBoardCount} eligible boards`);
  } else if (asBoolean(options.adaptive, false)) {
    const states = await getBoardSyncStates(resolve(options.database ?? "data/jobs.db"));
    boards = boards.filter((board) => isBoardDue(states.get(board.key)));
    console.log(`Adaptive schedule selected ${boards.length} of ${eligibleBoardCount} eligible boards`);
  }
  const limit = asInteger(options.syncLimit, boards.length);
  const remoteEnabled = asBoolean(options.remote, Boolean(process.env.REMOTE_SYNC_URL));
  const remoteSync = remoteEnabled ? createRemoteSync() : null;

  console.log(`Synchronizing jobs from ${Math.min(limit, boards.length)} of ${boards.length} boards`);
  const result = await syncJobs(boards, {
    limit,
    concurrency: asInteger(options.concurrency, 6),
    timeoutMs: asInteger(options.timeoutMs, 20_000),
    retries: asInteger(options.retries, 2),
    retainJobs: !remoteEnabled,
    onBoardSynced: remoteSync ? (result) => remoteSync.push(result) : undefined,
    onProgress: ({ index, total, board, result: boardResult }) => {
      console.log(
        `[${index}/${total}] ${board.provider}/${board.identifier}: ${boardResult.status} (${boardResult.jobCount} jobs)`,
      );
    },
  });
  const summary = summarizeSync(result);

  await writeJobsJson(output, {
    schemaVersion: 1,
    syncedAt: result.syncedAt,
    source: {
      input,
      discoveredAt: discovery.discoveredAt ?? null,
      index: discovery.index ?? null,
    },
    summary,
  }, result.jobs);
  await writeJson(syncOutput, {
    schemaVersion: 1,
    syncedAt: result.syncedAt,
    summary,
    boards: result.boards,
  });
  let databaseStats = null;
  if (!remoteEnabled && !asBoolean(options.skipDatabase, false)) {
    databaseStats = await importJobSnapshot({
      databasePath: resolve(options.database ?? "data/jobs.db"),
      jobsPath: output,
      syncPath: syncOutput,
    });
  }

  console.log(`\nSynchronized ${summary.jobCount} jobs from ${summary.boardCount} boards`);
  console.log(`Saved ${output}`);
  console.log(`Saved ${syncOutput}`);
  if (databaseStats) {
    console.log(
      `Database now contains ${databaseStats.activeJobs} active and ${databaseStats.closedJobs} closed jobs`,
    );
  }
  if (remoteEnabled) console.log("Uploaded each completed board to the hosted database");
}

async function databaseCommand(options) {
  const stats = await importJobSnapshot({
    databasePath: resolve(options.database ?? "data/jobs.db"),
    jobsPath: resolve(options.input ?? "data/jobs.json"),
    syncPath: resolve(options.syncInput ?? "data/job-sync.json"),
  });
  console.log(
    `Database contains ${stats.activeJobs} active jobs, ${stats.closedJobs} closed jobs, and ${stats.activeBoards} active boards`,
  );
}

async function watchCommand(options) {
  await runUpdater({
    once: asBoolean(options.once, false),
    intervalMinutes: asInteger(options.intervalMinutes, 120),
    discoveryIntervalHours: asInteger(options.discoveryIntervalHours, 168),
    skipInitialSync: asBoolean(options.skipInitialSync, false),
    skipInitialDiscovery: asBoolean(options.skipInitialDiscovery, false),
    concurrency: asInteger(options.concurrency, 4),
    maxDiscoveryPages: asInteger(options.maxPages, 5),
  });
}

async function serveCommand(options) {
  startApiServer({
    port: asInteger(options.port, 3002),
    databasePath: resolve(options.database ?? "data/jobs.db"),
  });
}

async function systemCommand(options) {
  await serveCommand(options);
  await watchCommand(options);
}

async function discover(options) {
  const registry = arrayToRegistry(options.existingBoards ?? []);
  const crawlState = createDiscoveryState(options.crawlState);
  const providerNames = commaList(options.providers ?? listProviders().join(","));
  const importedUrls = options.urls ? await readUrlFile(resolve(options.urls)) : [];
  let index = null;
  let indexes = [];
  let firecrawl = null;
  const sampleSeed = options.sampleSeed === undefined
    ? Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1_000))
    : asInteger(options.sampleSeed, 0);
  const snapshot = () => ({
    schemaVersion: 1,
    discoveredAt: new Date().toISOString(),
    index,
    indexes,
    firecrawl,
    crawlCoverage: summarizeCrawlCoverage(crawlState),
    crawlState,
    sampleSeed,
    providers: providerNames,
    boards: registryToArray(registry),
  });

  for (const url of importedUrls) {
    addDiscoveredUrl(registry, url, { discoverySource: `file:${options.urls}` });
  }

  if (!asBoolean(options.skipCommonCrawl, false)) {
    indexes = options.index
      ? [{
          id: options.index,
          api: `https://index.commoncrawl.org/${options.index.replace(/-index$/, "")}-index`,
        }]
      : await getIndexes(asInteger(options.indexCount, 1));
    index = indexes[0] ?? null;

    for (const currentIndex of indexes) {
      console.log(`Using Common Crawl index ${currentIndex.id}`);

      for (const target of getDiscoveryTargets(providerNames)) {
        console.log(`Discovering ${target.provider} boards from ${target.pattern}`);
        const result = await discoverTarget(target, {
          index: currentIndex,
          maxPages: asInteger(options.maxPages, 5),
          pageSize: asInteger(options.pageSize, 1),
          maxUrls: asInteger(options.maxUrlsPerTarget, 25_000),
          sampleSeed: sampleSeed + stableHash(`${currentIndex.id}:${target.pattern}`),
          seenPages: asBoolean(options.resumeDiscovery, true)
            ? getSampledPages(crawlState, currentIndex, target)
            : undefined,
          onProgress: ({ page, totalPages }) =>
            console.log(`  reading sampled page ${page + 1} of ${totalPages}`),
        });

        for (const url of result.urls) {
          addDiscoveredUrl(registry, url, {
            provider: target.provider,
            discoverySource: `common-crawl:${currentIndex.id}:${target.pattern}`,
          });
        }

        recordCrawlCoverage(crawlState, currentIndex, target, result);
        await options.onDiscoveryCheckpoint?.(snapshot());

        console.log(`  found ${result.urls.length} URLs; registry now has ${registry.size} boards`);
      }
    }
  }

  if (asBoolean(options.firecrawl, Boolean(process.env.FIRECRAWL_API_KEY))) {
    console.log("Discovering ATS boards with Firecrawl search");
    firecrawl = await discoverWithFirecrawl({
      apiKey: process.env.FIRECRAWL_API_KEY,
      limit: asInteger(options.firecrawlLimit, 50),
      creditBudget: asInteger(options.firecrawlCreditBudget, 100),
      onProgress: ({ index: queryIndex, total, query }) =>
        console.log(`  [${queryIndex}/${total}] ${query}`),
    });
    for (const url of firecrawl.urls) {
      addDiscoveredUrl(registry, url, { discoverySource: "firecrawl:search" });
    }
    await options.onDiscoveryCheckpoint?.(snapshot());
    console.log(
      `  found ${firecrawl.urls.length} URLs using ${firecrawl.creditsUsed} credits; registry now has ${registry.size} boards`,
    );
  }

  return snapshot();
}

async function writeDiscoveryCheckpoint(checkpoint, output, statePath) {
  const { crawlState, ...discovery } = checkpoint;
  await writeJson(statePath, crawlState);
  await writeJson(output, discovery);
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function validate(boards, options) {
  const limit = asInteger(options.validationLimit, boards.length);
  const selected = selectValidationSample(boards, Math.max(0, limit));
  console.log(`Validating ${selected.length} of ${boards.length} discovered boards`);

  return validateBoards(selected, {
    concurrency: asInteger(options.concurrency, 4),
    timeoutMs: asInteger(options.timeoutMs, 15_000),
    retries: asInteger(options.retries, 2),
    onProgress: ({ index, total, board, validation }) => {
      console.log(
        `[${index}/${total}] ${board.provider}/${board.identifier}: ${validation.status} (${validation.jobCount} jobs)`,
      );
    },
  });
}

async function readUrlFile(path) {
  const text = await readFile(path, "utf8");
  if (path.endsWith(".json")) {
    const parsed = JSON.parse(text);
    const values = Array.isArray(parsed) ? parsed : parsed.urls;
    if (!Array.isArray(values)) throw new Error("JSON URL input must be an array or an object with a urls array");
    return values;
  }
  return text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function writeJobsJson(path, metadata, jobs) {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "w");

  try {
    await file.write("{\n");
    for (const [key, value] of Object.entries(metadata)) {
      const serialized = JSON.stringify(value, null, 2).replaceAll("\n", "\n  ");
      await file.write(`  ${JSON.stringify(key)}: ${serialized},\n`);
    }
    await file.write('  "jobs": [\n');
    for (let index = 0; index < jobs.length; index += 1) {
      const comma = index + 1 < jobs.length ? "," : "";
      await file.write(`    ${JSON.stringify(jobs[index])}${comma}\n`);
    }
    await file.write("  ]\n}\n");
  } finally {
    await file.close();
  }
}

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

function printDiscoverySummary(result, output, statePath) {
  console.log(`\nDiscovered ${result.boards.length} unique boards`);
  if (result.crawlCoverage) {
    console.log(
      `Crawl coverage: ${result.crawlCoverage.sampledPages}/${result.crawlCoverage.totalPages} index pages `
      + `across ${result.crawlCoverage.targets} targets`,
    );
  }
  console.log(`Saved ${output}`);
  if (statePath) console.log(`Saved ${statePath}`);
}

function printValidationSummary(boards, output, report) {
  const active = boards.filter((board) => board.validation?.status === "active");
  const jobs = active.reduce((total, board) => total + board.validation.jobCount, 0);
  console.log(`\nValidated ${boards.length} boards: ${active.length} active, representing ${jobs} jobs`);
  console.log(`Saved ${output}`);
  console.log(`Saved ${report}`);
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);

    const [rawKey, inlineValue] = argument.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = args[index + 1];
    if (inlineValue !== undefined) options[key] = inlineValue;
    else if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else options[key] = true;
  }
  return options;
}

function commaList(value) {
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function asInteger(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number < 0) throw new Error(`Expected a non-negative integer, got: ${value}`);
  return number;
}

function asBoolean(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`Expected true or false, got: ${value}`);
}

function stableHash(value) {
  let result = 0;
  for (const character of String(value)) {
    result = (result * 31 + character.codePointAt(0)) >>> 0;
  }
  return result;
}

function isBoardDue(state, now = Date.now()) {
  if (!state) return true;
  const lastSyncedAt = new Date(state.lastSyncedAt).valueOf();
  if (!Number.isFinite(lastSyncedAt)) return true;
  const ageHours = (now - lastSyncedAt) / (60 * 60 * 1_000);
  if (state.status === "invalid") return ageHours >= 168;
  if (state.status === "empty") return ageHours >= 24;
  return true;
}

function printHelp(isError) {
  const text = `
Startups.board ATS discovery proof of concept

Usage:
  npm run discover -- [options]
  npm run validate -- [options]
  npm run sync -- [options]
  npm run database -- [options]
  npm run watch -- [options]
  npm run serve -- [options]
  npm run system -- [options]
  npm run poc -- [options]

Common options:
  --providers lever,greenhouse,ashby  Providers to discover or synchronize
  --max-pages 5                       Evenly sampled Common Crawl pages per target
  --index-count 1                     Recent Common Crawl snapshots to query
  --page-size 1                       Common Crawl blocks per page
  --max-urls-per-target 25000         URL safety limit for each target
  --sample-seed 0                     Rotate sampled Common Crawl pages deterministically
  --resume-discovery true             Skip Common Crawl pages harvested in prior runs
  --discovery-state data/discovery-state.json  Crawl-page coverage checkpoint
  --merge-existing true               Preserve prior board identifiers
  --firecrawl true                    Add optional Firecrawl search discovery
  --firecrawl-limit 50                Search results per provider query
  --firecrawl-credit-budget 100       Maximum estimated credits per discovery
  --urls path/to/urls.txt             Also import URLs from a text or JSON file
  --skip-common-crawl                 Only use imported URLs
  --validation-limit 100              Validate only the first N boards
  --sync-limit 100                    Synchronize only a balanced sample of N boards
  --only-new true                     Synchronize boards absent from SQLite
  --remote true                       Stream each board to REMOTE_SYNC_URL
  --adaptive true                     Refresh boards according to their last status
  --concurrency 4                     Concurrent validation requests
  --timeout-ms 15000                  Request timeout
  --database data/jobs.db             Persistent SQLite job history
  --interval-minutes 120              Job refresh cadence for watch/system
  --discovery-interval-hours 168      Company discovery cadence
  --skip-initial-sync true            Start serving before the next refresh
  --skip-initial-discovery true       Start serving before the next discovery

Examples:
  npm run poc -- --max-pages 2 --validation-limit 25
  npm run discover -- --urls ./boards.txt --skip-common-crawl
  npm run validate -- --input data/discovered-boards.json
  npm run sync -- --input data/discovered-boards.json --sync-limit 100
  npm run database
  npm run system -- --skip-initial-sync true --skip-initial-discovery true
`;
  (isError ? console.error : console.log)(text.trim());
  if (isError) process.exitCode = 1;
}
