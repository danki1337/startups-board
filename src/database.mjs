import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { companyDisplayExpression, humanizeIdentifier } from "./company-name.mjs";

const SCHEMA = `
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS boards (
  key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  identifier TEXT NOT NULL,
  status TEXT NOT NULL,
  job_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_synced_at TEXT NOT NULL,
  last_success_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  key TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  board_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  company_identifier TEXT NOT NULL,
  company_name TEXT,
  company_logo_url TEXT,
  title TEXT NOT NULL,
  location TEXT,
  country TEXT,
  city TEXT,
  role_family TEXT,
  company_industry TEXT,
  workplace TEXT NOT NULL,
  employment_type TEXT,
  department TEXT,
  category TEXT NOT NULL,
  description_plain TEXT,
  published_at TEXT,
  url TEXT NOT NULL,
  apply_url TEXT NOT NULL,
  compensation_json TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  closed_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS jobs_active_published_idx
  ON jobs(is_active, published_at DESC);
CREATE INDEX IF NOT EXISTS jobs_provider_active_idx
  ON jobs(provider, is_active);
CREATE INDEX IF NOT EXISTS jobs_workplace_active_idx
  ON jobs(workplace, is_active);
CREATE INDEX IF NOT EXISTS jobs_category_active_idx
  ON jobs(category, is_active);
CREATE INDEX IF NOT EXISTS jobs_board_idx
  ON jobs(board_key);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  synced_at TEXT NOT NULL UNIQUE,
  board_count INTEGER NOT NULL,
  job_count INTEGER NOT NULL,
  active_boards INTEGER NOT NULL,
  empty_boards INTEGER NOT NULL,
  invalid_boards INTEGER NOT NULL,
  error_boards INTEGER NOT NULL
);
`;

export async function importJobSnapshot(options = {}) {
  const databasePath = resolve(options.databasePath ?? "data/jobs.db");
  const jobsPath = resolve(options.jobsPath ?? "data/jobs.json");
  const syncPath = resolve(options.syncPath ?? "data/job-sync.json");
  await mkdir(dirname(databasePath), { recursive: true });
  await runSqlite(databasePath, SCHEMA);
  await ensureJobColumns(databasePath);

  const jobsFile = sqlString(jobsPath);
  const syncFile = sqlString(syncPath);
  const sql = `
BEGIN IMMEDIATE;

-- Workday site identifiers are case-insensitive in practice. Historical crawl
-- captures can contain both External and external; collapse those variants
-- before importing the next snapshot so they cannot double-count vacancies.
DELETE FROM jobs
WHERE provider = 'workday'
  AND rowid NOT IN (
    SELECT min(rowid)
    FROM jobs
    WHERE provider = 'workday'
    GROUP BY lower(board_key), source_id
  );
UPDATE jobs
SET key = lower(board_key) || ':' || source_id,
    board_key = lower(board_key)
WHERE provider = 'workday';

DELETE FROM boards
WHERE provider = 'workday'
  AND rowid NOT IN (
    SELECT min(rowid)
    FROM boards
    WHERE provider = 'workday'
    GROUP BY lower(key)
  );
UPDATE boards
SET key = lower(key)
WHERE provider = 'workday';

DROP TABLE IF EXISTS temp.incoming_jobs;
CREATE TEMP TABLE incoming_jobs AS
SELECT
  CASE
    WHEN json_extract(value, '$.provider') = 'workday'
      THEN lower(json_extract(value, '$.boardKey')) || ':' || json_extract(value, '$.sourceId')
    ELSE json_extract(value, '$.key')
  END AS key,
  json_extract(value, '$.sourceId') AS source_id,
  CASE
    WHEN json_extract(value, '$.provider') = 'workday'
      THEN lower(json_extract(value, '$.boardKey'))
    ELSE json_extract(value, '$.boardKey')
  END AS board_key,
  json_extract(value, '$.provider') AS provider,
  json_extract(value, '$.companyIdentifier') AS company_identifier,
  json_extract(value, '$.companyName') AS company_name,
  json_extract(value, '$.companyLogoUrl') AS company_logo_url,
  json_extract(value, '$.title') AS title,
  json_extract(value, '$.location') AS location,
  json_extract(value, '$.country') AS country,
  json_extract(value, '$.city') AS city,
  json_extract(value, '$.roleFamily') AS role_family,
  json_extract(value, '$.companyIndustry') AS company_industry,
  coalesce(json_extract(value, '$.workplace'), 'Unspecified') AS workplace,
  json_extract(value, '$.employmentType') AS employment_type,
  json_extract(value, '$.department') AS department,
  coalesce(json_extract(value, '$.category'), 'Other') AS category,
  json_extract(value, '$.descriptionPlain') AS description_plain,
  json_extract(value, '$.publishedAt') AS published_at,
  json_extract(value, '$.url') AS url,
  coalesce(json_extract(value, '$.applyUrl'), json_extract(value, '$.url')) AS apply_url,
  CASE
    WHEN json_type(value, '$.compensation') IS NULL THEN NULL
    ELSE value -> '$.compensation'
  END AS compensation_json,
  json_extract(value, '$.syncedAt') AS synced_at
FROM json_each(CAST(readfile(${jobsFile}) AS TEXT), '$.jobs');
DELETE FROM incoming_jobs
WHERE rowid NOT IN (SELECT min(rowid) FROM incoming_jobs GROUP BY key);
CREATE UNIQUE INDEX incoming_jobs_key_idx ON incoming_jobs(key);

INSERT INTO jobs (
  key, source_id, board_key, provider, company_identifier, company_name,
  company_logo_url, title, location, country, city, role_family, company_industry,
  workplace, employment_type, department, category, description_plain,
  published_at, url, apply_url, compensation_json, first_seen_at, last_seen_at,
  closed_at, is_active
)
SELECT
  key, source_id, board_key, provider, company_identifier, company_name,
  company_logo_url, title, location, country, city, role_family, company_industry,
  workplace, employment_type, department, category, description_plain,
  published_at, url, apply_url, compensation_json, synced_at, synced_at,
  NULL, 1
FROM incoming_jobs
WHERE true
ON CONFLICT(key) DO UPDATE SET
  source_id = excluded.source_id,
  board_key = excluded.board_key,
  provider = excluded.provider,
  company_identifier = excluded.company_identifier,
  company_name = excluded.company_name,
  company_logo_url = excluded.company_logo_url,
  title = excluded.title,
  location = excluded.location,
  country = excluded.country,
  city = excluded.city,
  role_family = excluded.role_family,
  company_industry = excluded.company_industry,
  workplace = excluded.workplace,
  employment_type = excluded.employment_type,
  department = excluded.department,
  category = excluded.category,
  description_plain = excluded.description_plain,
  published_at = excluded.published_at,
  url = excluded.url,
  apply_url = excluded.apply_url,
  compensation_json = excluded.compensation_json,
  last_seen_at = excluded.last_seen_at,
  closed_at = NULL,
  is_active = 1;

DROP TABLE IF EXISTS temp.incoming_boards;
CREATE TEMP TABLE incoming_boards AS
SELECT
  CASE
    WHEN json_extract(value, '$.provider') = 'workday'
      THEN lower(json_extract(value, '$.key'))
    ELSE json_extract(value, '$.key')
  END AS key,
  json_extract(value, '$.provider') AS provider,
  json_extract(value, '$.identifier') AS identifier,
  json_extract(value, '$.status') AS status,
  coalesce(json_extract(value, '$.jobCount'), 0) AS job_count,
  json_extract(value, '$.syncedAt') AS synced_at,
  json_extract(value, '$.error') AS error
FROM json_each(CAST(readfile(${syncFile}) AS TEXT), '$.boards');
DELETE FROM incoming_boards
WHERE rowid NOT IN (SELECT min(rowid) FROM incoming_boards GROUP BY key);
CREATE UNIQUE INDEX incoming_boards_key_idx ON incoming_boards(key);

INSERT INTO boards (
  key, provider, identifier, status, job_count, first_seen_at,
  last_synced_at, last_success_at, error
)
SELECT
  key, provider, identifier, status, job_count, synced_at, synced_at,
  CASE WHEN status = 'error' THEN NULL ELSE synced_at END, error
FROM incoming_boards
WHERE true
ON CONFLICT(key) DO UPDATE SET
  provider = excluded.provider,
  identifier = excluded.identifier,
  status = excluded.status,
  job_count = excluded.job_count,
  last_synced_at = excluded.last_synced_at,
  last_success_at = CASE
    WHEN excluded.status = 'error' THEN boards.last_success_at
    ELSE excluded.last_synced_at
  END,
  error = excluded.error;

UPDATE jobs
SET
  is_active = 0,
  closed_at = coalesce(
    closed_at,
    (SELECT synced_at FROM incoming_boards WHERE incoming_boards.key = jobs.board_key)
  )
WHERE is_active = 1
  AND board_key IN (SELECT key FROM incoming_boards WHERE status <> 'error')
  AND key NOT IN (SELECT key FROM incoming_jobs);

INSERT INTO sync_runs (
  synced_at, board_count, job_count, active_boards, empty_boards,
  invalid_boards, error_boards
)
SELECT
  json_extract(payload, '$.syncedAt'),
  coalesce(json_extract(payload, '$.summary.boardCount'), 0),
  coalesce(json_extract(payload, '$.summary.jobCount'), 0),
  coalesce(json_extract(payload, '$.summary.statuses.active'), 0),
  coalesce(json_extract(payload, '$.summary.statuses.empty'), 0),
  coalesce(json_extract(payload, '$.summary.statuses.invalid'), 0),
  coalesce(json_extract(payload, '$.summary.statuses.error'), 0)
FROM (SELECT CAST(readfile(${syncFile}) AS TEXT) AS payload)
WHERE true
ON CONFLICT(synced_at) DO NOTHING;

COMMIT;
PRAGMA optimize;
`;

  await runSqlite(databasePath, sql);
  return getDatabaseStats(databasePath);
}

export async function getDatabaseStats(databasePath = "data/jobs.db") {
  const resolved = resolve(databasePath);
  const rows = await querySqlite(
    resolved,
    `
    SELECT
      (SELECT count(*) FROM jobs WHERE is_active = 1) AS activeJobs,
      (SELECT count(*) FROM jobs WHERE is_active = 0) AS closedJobs,
      (SELECT count(*) FROM boards WHERE status = 'active') AS activeBoards,
      (SELECT max(synced_at) FROM sync_runs) AS lastSyncedAt;
    `,
  );
  return rows[0] ?? { activeJobs: 0, closedJobs: 0, activeBoards: 0, lastSyncedAt: null };
}

export async function getBoardSyncStates(databasePath = "data/jobs.db") {
  try {
    const rows = await querySqlite(
      resolve(databasePath),
      "SELECT key, status, last_synced_at AS lastSyncedAt FROM boards;",
    );
    return new Map(rows.map((row) => [row.key, row]));
  } catch (error) {
    if (/no such table|unable to open database/i.test(error.message)) return new Map();
    throw error;
  }
}

// Local counterpart of the D1 job_titles lookup. The local snapshot is small enough to group on
// demand, so it queries `jobs` directly rather than maintaining a separate aggregate.
// Mirrors canonicalTitle/collapseTitles in web/app/jobs-query.ts -- keep the two in sync. Job
// titles arrive from a dozen ATSs with every qualifier bolted on, so a search for "product designer"
// returned ten near-identical rows and pushed genuinely different roles off the list. Only the
// suggestion list is folded; the title filter is a substring match, so picking the folded title
// still matches every variant it stood for.
// Words that are never part of a role name -- an engagement type or a work arrangement. These can
// strip a title all the way down to one word: "Designer Contract" is a Designer.
const HARD_QUALIFIERS = new Set([
  "freelance", "freelancer", "contract", "contractor", "temp", "temporary",
  "permanent", "perm", "ftc", "parttime", "fulltime", "part-time", "full-time",
  "remote", "hybrid", "onsite", "on-site", "internship", "coop", "co-op",
]);

// Words that usually qualify a role but can also BE one -- "Design Lead", "Design Intern". These
// only strip while at least two words would remain.
const SOFT_QUALIFIERS = new Set([
  "jr", "jr.", "junior", "sr", "sr.", "senior", "lead", "principal", "staff",
  "pleno", "s\u00eanior", "j\u00fanior", "intern", "apprentice", "trainee",
]);

const TRAILING_MODIFIERS = new Set([...HARD_QUALIFIERS, ...SOFT_QUALIFIERS]);

export function canonicalTitle(title) {
  let result = String(title ?? "");

  // Anything parenthesised or bracketed is a qualifier, never the role: "(UI/UX)", "(Contract)",
  // "(m/w/d)". Safe to drop outright.
  result = result.replace(/[([{][^)\]}]*[)\]}]?/g, " ").replace(/\s+/g, " ").trim();

  // Everything from the first separator onward is a suffix -- but only when a whole role already
  // stands in front of it. "Product Designer, App Store" is a Product Designer; "Engineer, Machine
  // Learning" and "UI/UX Designer" are not simply an Engineer or a UI. Requiring two words in the
  // head is what separates those cases. A hyphen must be followed by a space so "Front-End" and
  // "on-site" survive, but "Product Designer- San Francisco" does not.
  const SEPARATOR = /\s*[:|/–—]\s*|\s*,\s*|\s+&\s+|\s+and\s+|\s*-\s+/i;
  const head = result.split(SEPARATOR)[0].trim();
  const suffix = result.slice(head.length).replace(SEPARATOR, "").trim();
  // Two words in the head means the role is already complete and the rest is a qualifier. With a
  // one-word head the suffix usually carries the specialty ("Engineer, Machine Learning"), so it
  // only folds when the suffix is itself pure boilerplate -- a duration or an engagement word.
  const suffixIsBoilerplate = suffix.length > 0 && (
    /^\d+\s*(?:month|months|mo|week|weeks|year|years|hr|hrs|hour|hours)\b/i.test(suffix)
    || suffix.split(/\s+/).every((word) => TRAILING_MODIFIERS.has(word.toLowerCase().replace(/[.,;:]+$/, "")))
  );
  if (head && (head.split(/\s+/).length >= 2 || suffixIsBoilerplate)) result = head;

  // Strip trailing level and engagement words, repeatedly ("Product Designer Contract II"), but
  // never down to a single word -- "Design Lead" is a role, "Product Designer Lead" is a variant.
  let words = result.split(/\s+/).filter(Boolean);
  while (words.length > 1) {
    const last = words[words.length - 1].toLowerCase().replace(/[.,;:]+$/, "");
    // A pure level code ("II", "3", "L4") is never part of a role name, so it can strip a title all
    // the way down to one word -- "Designer II" is a Designer. A seniority WORD cannot: "Design
    // Lead" is a role, so those still need two words to survive.
    const isLevelCode = /^(?:l|lvl|level)?\d+$/.test(last) || /^(?:i{1,3}|iv|v|vi{1,3}|ix|x)$/.test(last);
    if (isLevelCode) { words = words.slice(0, -1); if (words[words.length - 1]?.toLowerCase() === "level") words = words.slice(0, -1); continue; }
    if (HARD_QUALIFIERS.has(last)) { words = words.slice(0, -1); continue; }
    if (words.length > 2 && SOFT_QUALIFIERS.has(last)) { words = words.slice(0, -1); continue; }
    break;
  }
  result = words.join(" ");

  return result.replace(/[\s\-–—/|:,&.]+$/, "").replace(/\s+/g, " ").trim();
}

function collapseTitles(rows, limit) {
  const labels = [];
  const seen = new Set();
  for (const row of rows) {
    const label = canonicalTitle(row.title);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  // Counted by containment and then ordered by that count, because that is what the title filter
  // does and what the dropdown shows -- see the note in web/app/jobs-query.ts.
  return labels
    .slice(0, limit)
    .map((label) => {
      const needle = label.toLowerCase();
      let jobCount = 0;
      for (const row of rows) {
        if (String(row.title).toLowerCase().includes(needle)) jobCount += Number(row.jobCount);
      }
      return { title: label, jobCount };
    })
    .sort((a, b) => b.jobCount - a.jobCount || a.title.localeCompare(b.title));
}

export async function queryTitleSuggestions(query, databasePath = "data/jobs.db", limit = 8) {
  const term = String(query ?? "").trim().toLowerCase().slice(0, 60);
  const cap = clampInteger(limit, 8, 1, 300);
  const readCap = Math.min(2_000, Math.max(cap * 8, 400));

  // No (or too-short) query: the most common titles, so the dropdown opens on a list to pick from
  // rather than an empty box. Mirrors the D1 path's job_titles lookup.
  if (term.length < 2) {
    return collapseTitles(await querySqlite(
      resolve(databasePath),
      `
        SELECT title, count(*) AS jobCount
        FROM jobs
        WHERE is_active = 1
        GROUP BY title
        ORDER BY jobCount DESC
        LIMIT ${readCap};
      `,
    ), cap);
  }

  const like = sqlLike(term);
  const prefix = sqlString(`${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`);
  return collapseTitles(await querySqlite(
    resolve(databasePath),
    `
      SELECT title, count(*) AS jobCount
      FROM jobs
      WHERE is_active = 1 AND lower(title) LIKE ${like} ESCAPE '\\'
      GROUP BY title
      ORDER BY CASE WHEN lower(title) LIKE ${prefix} ESCAPE '\\' THEN 0 ELSE 1 END, jobCount DESC
      LIMIT ${readCap};
    `,
  ), cap);
}

export async function queryActiveJobs(filters = {}, databasePath = "data/jobs.db") {
  const conditions = ["is_active = 1"];
  if (filters.search) {
    const term = sqlLike(filters.search);
    conditions.push(
      `lower(title || ' ' || company_identifier || ' ' || coalesce(company_name, '') || ' ' || coalesce(department, '')) LIKE ${term} ESCAPE '\\'`,
    );
  }
  if (filters.location) conditions.push(`lower(coalesce(location, '')) LIKE ${sqlLike(filters.location)} ESCAPE '\\'`);
  if (filters.company) {
    conditions.push(
      `lower(coalesce(company_name, company_identifier)) LIKE ${sqlLike(filters.company)} ESCAPE '\\'`,
    );
  }
  // Comma-separated sets mirror the production route so the local API answers the same UI.
  // The UI sends display labels ("Spark Hire", "BambooHR"); stored providers are lowercase and
  // unspaced, so "Spark Hire" must collapse to "sparkhire" rather than "spark hire".
  addSetCondition(conditions, "provider", filters.provider, (value) =>
    value.toLowerCase().replace(/\s+/g, ""));
  if (filters.title) conditions.push(`lower(title) LIKE ${sqlLike(filters.title)} ESCAPE '\\'`);
  // "anywhere" means remote with no resolvable country, which is different from country unknown.
  if (filters.country === "anywhere") {
    conditions.push("country IS NULL AND workplace = 'Remote'");
  } else {
    addSetCondition(conditions, "country", filters.country, (value) => value.toLowerCase());
  }
  addSetCondition(conditions, "city", filters.city);
  addSetCondition(conditions, "role_family", filters.roleFamily);
  addSetCondition(conditions, "company_industry", filters.industry);
  addSetCondition(conditions, "workplace", filters.workplace);
  addSetCondition(conditions, "category", filters.category);
  // Stored values keep each provider's casing/hyphenation ("Full-Time", "full time", ...), so the
  // match is case- and hyphen-insensitive; an exact IN matched almost nothing.
  addSetCondition(
    conditions,
    "lower(replace(employment_type, '-', ' '))",
    filters.employmentType,
    (value) => value.toLowerCase().replaceAll("-", " "),
  );

  // Company watchlist. Newline-separated because company names frequently contain commas, which the
  // comma-based set filters would split on. Matched the same lenient way as the single-company
  // filter (substring against name-or-identifier), so a starred company and its clickable link
  // return exactly the same jobs -- including Workday boards whose display name is a humanized slice
  // of a piped identifier ("Aaco" from "aaco|wd1|site").
  const companies = String(filters.companies ?? "")
    .split("\n").map((entry) => entry.trim()).filter(Boolean).slice(0, 60);
  if (companies.length) {
    const clauses = companies.map(
      (entry) => `lower(coalesce(company_name, company_identifier)) LIKE ${sqlLike(entry)} ESCAPE '\\'`,
    );
    conditions.push(`(${clauses.join(" OR ")})`);
  }

  const postedWithin = Number.parseInt(filters.postedWithin ?? "", 10);
  if (Number.isFinite(postedWithin) && postedWithin > 0) {
    conditions.push(`published_at >= datetime('now', '-${Math.min(3650, postedWithin)} days')`);
  }

  const order = filters.sort === "oldest"
    ? "coalesce(published_at, '') ASC, key"
    : filters.sort === "company"
      ? "lower(coalesce(company_name, company_identifier)) ASC, key"
      // Raw column so the (is_active, published_at DESC) index satisfies the sort; SQLite orders
      // NULLs last in DESC, matching the previous coalesce('')-to-last behaviour.
      : "published_at DESC, key";

  const limit = clampInteger(filters.limit, 50, 1, 100);
  const offset = clampInteger(filters.offset, 0, 0, 1_000_000);
  const where = conditions.join(" AND ");
  const resolved = resolve(databasePath);
  // The sqlite3 CLI opens files read-write unless told otherwise. Two concurrent
  // CLI readers can both try to recover an iCloud-restored WAL and race into
  // SQLITE_BUSY, so keep API reads explicitly read-only and sequential.
  const jobs = await querySqlite(
    resolved,
    `
      SELECT
        key, title, company_identifier AS companyIdentifier,
        company_name AS companyName, company_logo_url AS companyLogoUrl,
        location, country, city, role_family AS roleFamily, company_industry AS companyIndustry, workplace,
        employment_type AS employmentType, category, provider,
        published_at AS publishedAt, url, description_plain AS description
      FROM jobs
      WHERE ${where}
      ORDER BY ${order}
      LIMIT ${limit} OFFSET ${offset};
    `,
  );
  const countRows = await querySqlite(
    resolved,
    `SELECT count(*) AS total FROM jobs WHERE ${where};`,
  );

  return { jobs, total: Number(countRows[0]?.total ?? 0), limit, offset };
}

async function ensureJobColumns(databasePath) {
  const columns = new Set((await querySqlite(databasePath, "PRAGMA table_info(jobs);")).map((column) => column.name));
  const migrations = [];
  if (!columns.has("company_name")) migrations.push("ALTER TABLE jobs ADD COLUMN company_name TEXT;");
  if (!columns.has("company_logo_url")) migrations.push("ALTER TABLE jobs ADD COLUMN company_logo_url TEXT;");
  if (!columns.has("country")) migrations.push("ALTER TABLE jobs ADD COLUMN country TEXT;");
  if (!columns.has("city")) migrations.push("ALTER TABLE jobs ADD COLUMN city TEXT;");
  if (!columns.has("role_family")) migrations.push("ALTER TABLE jobs ADD COLUMN role_family TEXT;");
  if (!columns.has("company_industry")) migrations.push("ALTER TABLE jobs ADD COLUMN company_industry TEXT;");
  if (migrations.length) await runSqlite(databasePath, migrations.join("\n"));
}

async function querySqlite(databasePath, sql) {
  const output = await runSqlite(databasePath, sql, {
    json: true,
    readonly: true,
    busyTimeoutMs: 5_000,
  });
  return output.trim() ? JSON.parse(output) : [];
}

async function runSqlite(databasePath, sql, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      ...(options.readonly ? ["-readonly"] : []),
      ...(options.json ? ["-json"] : []),
      ...(options.busyTimeoutMs ? ["-cmd", `.timeout ${Math.trunc(options.busyTimeoutMs)}`] : []),
      databasePath,
    ];
    const child = spawn("sqlite3", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`sqlite3 exited with code ${code}: ${stderr.trim() || "unknown error"}`));
    });
    child.stdin.end(sql);
  });
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlLike(value) {
  const escaped = String(value)
    .toLocaleLowerCase()
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
  return sqlString(`%${escaped}%`);
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

// Accepts a single value or a comma-separated set, matching the production /api/jobs contract.
function addSetCondition(conditions, column, value, normalize = (input) => input) {
  const values = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map(normalize);
  if (!values.length) return;
  conditions.push(`${column} IN (${values.map((entry) => sqlString(entry)).join(", ")})`);
}

// Mirrors queryCompanySuggestions in web/app/jobs-query.ts. D1 has a job_companies aggregate
// rebuilt daily; the local snapshot has no such table, so this groups the jobs table live -- fine
// on a dev-sized database and the same shape of answer.
export async function queryCompanySuggestions(query, databasePath = "data/jobs.db", limit = 50) {
  const term = String(query ?? "").trim().toLowerCase().slice(0, 60);
  const cap = clampInteger(limit, 50, 1, 1000);
  // The shared display expression, so the local dropdown offers exactly what the D1 one does.
  const display = companyDisplayExpression();
  const where = term.length >= 2 ? `AND lower(${display}) LIKE ${sqlLike(term)} ESCAPE '\\'` : "";
  const rows = await querySqlite(resolve(databasePath), `
    SELECT ${display} AS company, count(*) AS jobCount, max(company_logo_url) AS logoUrl
    FROM jobs
    WHERE is_active = 1 AND ${display} IS NOT NULL ${where}
    GROUP BY company
    ORDER BY jobCount DESC
    LIMIT ${cap};
  `);
  return rows.map((row) => ({
    company: /[a-z]/.test(row.company) && !/\s/.test(row.company)
      ? humanizeIdentifier(String(row.company), "")
      : row.company,
    jobCount: Number(row.jobCount),
    logoUrl: row.logoUrl ?? null,
  }));
}
