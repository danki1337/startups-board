import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function runUpdater(options = {}) {
  const {
    once = false,
    intervalMinutes = 120,
    discoveryIntervalHours = 168,
    skipInitialSync = false,
    skipInitialDiscovery = false,
    statePath = resolve("data/updater-state.json"),
    concurrency = 4,
    maxDiscoveryPages = 5,
  } = options;

  let state = await readState(statePath);
  let firstCycle = true;

  while (true) {
    const now = Date.now();
    const discoveryDue =
      !state.lastDiscoveryAt ||
      now - new Date(state.lastDiscoveryAt).valueOf() >= discoveryIntervalHours * 60 * 60 * 1_000;

    if (discoveryDue && !(firstCycle && skipInitialDiscovery)) {
      const args = [
        "discover",
        "--max-pages",
        String(maxDiscoveryPages),
        "--index-count",
        "4",
        "--merge-existing",
        "true",
      ];
      if (process.env.FIRECRAWL_API_KEY) args.push("--firecrawl", "true");
      await runCli(args);
      state.lastDiscoveryAt = new Date().toISOString();
      await writeState(statePath, state);
    }

    if (!(firstCycle && skipInitialSync)) {
      await runCli([
        "sync",
        "--adaptive",
        "true",
        "--concurrency",
        String(concurrency),
        "--output",
        "data/jobs-incremental.json",
        "--sync-output",
        "data/job-sync-incremental.json",
      ]);
      state.lastSyncAt = new Date().toISOString();
      await writeState(statePath, state);
    }

    if (once) return state;
    firstCycle = false;
    await delay(Math.max(1, intervalMinutes) * 60 * 1_000);
  }
}

async function runCli(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve("src/cli.mjs"), ...args], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Updater command failed with exit code ${code}: ${args.join(" ")}`));
    });
  });
}

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
