import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const configPath = resolve(root, "cloudflare/wrangler.jsonc");
const wranglerPath = resolve(root, "web/node_modules/wrangler/bin/wrangler.js");
const databaseName = "startups-board-production";
const bucketName = "startups-board-archive";
const queueNames = [
  "startups-board-jobs-ashby",
  "startups-board-jobs-bamboohr",
  "startups-board-jobs-gem",
  "startups-board-jobs-getro",
  "startups-board-jobs-greenhouse",
  "startups-board-jobs-icims",
  "startups-board-jobs-lever",
  "startups-board-jobs-paylocity",
  "startups-board-jobs-sparkhire",
  "startups-board-jobs-workday",
  "startups-board-discovery",
  "startups-board-dlq",
];

assertNodeVersion();
await configureDatabase();
allowExisting(["r2", "bucket", "create", bucketName, "--location", "eeur"]);
for (const queue of queueNames) {
  // Let Cloudflare select the account-plan default (24 hours on Free, four
  // days on Paid). Refresh messages are consumed immediately, so forcing the
  // paid-only 14-day maximum would make first-time provisioning brittle.
  allowExisting(["queues", "create", queue]);
}

run("npm", ["run", "build"], { cwd: resolve(root, "web") });
runWrangler(["d1", "migrations", "apply", databaseName, "--remote", "--config", configPath]);
const deployment = runWrangler(["deploy", "--config", configPath], { capture: true });
process.stdout.write(deployment);

const origin = process.env.PRODUCTION_URL || deployment.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
if (!origin) {
  throw new Error("Deployment succeeded, but its workers.dev URL was not found. Re-run with PRODUCTION_URL set.");
}

const adminToken = process.env.ADMIN_TOKEN || randomBytes(32).toString("base64url");
runWrangler(["secret", "put", "ADMIN_TOKEN", "--config", configPath], { input: `${adminToken}\n` });
const importUrl = `${origin.replace(/\/$/, "")}/api/internal/admin/import-boards`;
await writeFile(
  resolve(root, ".env.production"),
  `ADMIN_TOKEN=${adminToken}\nADMIN_IMPORT_URL=${importUrl}\nPRODUCTION_URL=${origin}\n`,
  { mode: 0o600 },
);

run(process.execPath, [resolve(root, "cloudflare/scripts/import-boards.mjs")], {
  env: { ...process.env, ADMIN_TOKEN: adminToken, ADMIN_IMPORT_URL: importUrl },
});
await queueBootstrap(origin, adminToken);

console.log(`\nProduction is live at ${origin}`);
console.log("The complete board registry is imported and queued for its first refresh.");
console.log("Operator credentials were saved to the ignored .env.production file.");

async function configureDatabase() {
  const databases = parseWranglerJson(runWrangler(["d1", "list", "--json"], { capture: true }));
  let database = databases.find((item) => item.name === databaseName);
  if (!database) {
    const output = runWrangler(["d1", "create", databaseName, "--location", "eeur"], { capture: true });
    process.stdout.write(output);
    const databaseId = output.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0];
    if (!databaseId) throw new Error("Could not read the new D1 database ID from Wrangler output");
    database = { uuid: databaseId };
  }
  const databaseId = database.uuid || database.id;
  if (!databaseId) throw new Error(`D1 database ${databaseName} did not include an ID`);
  const config = await readFile(configPath, "utf8");
  const updated = config.replace(/"database_id"\s*:\s*"[^"]+"/, `"database_id": "${databaseId}"`);
  if (updated === config && !config.includes(databaseId)) {
    throw new Error("Could not update database_id in cloudflare/wrangler.jsonc");
  }
  await writeFile(configPath, updated);
}

async function queueBootstrap(origin, token) {
  for (let page = 0; page < 20; page += 1) {
    const response = await fetch(`${origin.replace(/\/$/, "")}/api/internal/admin/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ limit: 2_000 }),
    });
    if (!response.ok) throw new Error(`Initial queue scheduling failed: ${response.status} ${await response.text()}`);
    const result = await response.json();
    console.log(`Queued initial refresh batch: ${result.queued}/${result.selected}`);
    if (!result.selected || !result.queued) return;
  }
  throw new Error("Initial queue scheduling exceeded the safety limit of 40,000 boards");
}

function allowExisting(args) {
  const result = runWrangler(args, { capture: true, allowFailure: true });
  if (result.status === 0) {
    process.stdout.write(result.output);
    return;
  }
  if (/already exists|already(?: been| is)? taken/i.test(result.output)) {
    console.log(`${args.at(0)} resource already exists: ${args.at(3) || args.at(2)}`);
    return;
  }
  throw new Error(result.output);
}

function runWrangler(args, options = {}) {
  return run(process.execPath, [wranglerPath, ...args], options);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: resolve(root, ".wrangler/logs"),
      WRANGLER_WRITE_LOGS: "false",
      ...options.env,
    },
    encoding: "utf8",
    input: options.input,
    // Wrangler's `secret put` uses an interactive prompt when attached to a
    // TTY. Pipe stdin whenever scripted input is provided so it consumes the
    // generated token instead of pausing provisioning.
    stdio: options.capture || options.allowFailure || options.input ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (options.allowFailure) return { status: result.status, output };
  if (result.status !== 0) throw new Error(output || `${command} exited with ${result.status}`);
  return options.capture ? output : undefined;
}

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`Cloudflare provisioning needs Node.js 22.13 or newer; found ${process.versions.node}`);
  }
}

function parseWranglerJson(output) {
  const arrayStart = output.indexOf("[");
  const arrayEnd = output.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return JSON.parse(output.slice(arrayStart, arrayEnd + 1));
  }
  const objectStart = output.indexOf("{");
  const objectEnd = output.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    return JSON.parse(output.slice(objectStart, objectEnd + 1));
  }
  throw new Error(`Wrangler did not return JSON: ${output.slice(0, 500)}`);
}
