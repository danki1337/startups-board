import { getD1 } from "../db";
import type { Job } from "./jobs";
import { countryFlag } from "./countries";

// Shared by the /api/jobs route and the server-rendered first page, so the initial paint and every
// subsequent fetch apply exactly the same filter semantics. Previously the page shipped a 12-row
// demo fixture and only swapped in real data after a client round-trip.

// Deliberately the same shape the client renders, so the server-rendered first page and the
// client's later fetches are interchangeable without a mapping layer.
export type PublicJob = Job;

export type JobsPage = {
  jobs: PublicJob[];
  total: number;
  limit: number;
  nextCursor: string | null;
};

export const SORT_OPTIONS = ["newest", "oldest", "company"] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

export const POSTED_WITHIN_OPTIONS = [
  { label: "Any time", value: "" },
  { label: "Past 24 hours", value: "1" },
  { label: "Past week", value: "7" },
  { label: "Past 30 days", value: "30" },
  { label: "Past 90 days", value: "90" },
] as const;

type JobRow = {
  key: string;
  title: string;
  companyIdentifier: string;
  companyName: string | null;
  companyLogoUrl: string | null;
  location: string | null;
  country: string | null;
  workplace: Job["workplace"];
  employmentType: string | null;
  // The database stores these as free text; ingestion constrains them to the unions below, and
  // toPublicJob narrows with a fallback so an unexpected value cannot break rendering.
  category: Job["category"];
  provider: string;
  publishedAt: string | null;
  url: string;
};

const CATEGORIES: readonly Job["category"][] = [
  "Engineering", "AI & Research", "Product & Design", "Sales & Marketing", "Operations", "Other",
];

export const PROVIDER_LABELS: Record<string, string> = {
  ashby: "Ashby",
  bamboohr: "BambooHR",
  gem: "Gem",
  getro: "Getro",
  greenhouse: "Greenhouse",
  icims: "iCIMS",
  lever: "Lever",
  paylocity: "Paylocity",
  sparkhire: "Spark Hire",
  workday: "Workday",
};

const PROVIDER_BY_LABEL = new Map(
  Object.entries(PROVIDER_LABELS).map(([value, label]) => [label.toLowerCase(), value]),
);

export async function queryJobs(params: URLSearchParams): Promise<JobsPage> {
  const search = ftsQuery(params.get("search"));
  const conditions = ["j.is_active = 1"];
  const bindings: unknown[] = [];
  const from = search ? "jobs j JOIN jobs_fts ON jobs_fts.rowid = j.rowid" : "jobs j";

  if (search) {
    conditions.push("jobs_fts MATCH ?");
    bindings.push(search);
  }
  addLikeFilter(conditions, bindings, "lower(coalesce(j.location, ''))", params.get("location"));
  addLikeFilter(conditions, bindings, "lower(coalesce(j.company_name, j.company_identifier))", params.get("company"));
  // Role and company are separate fields: searching "stripe" as a role should not match every
  // posting at Stripe, and vice versa.
  addLikeFilter(conditions, bindings, "lower(j.title)", params.get("title"));

  // "anywhere" is remote-with-no-country, which is a distinct answer from "country unknown".
  const country = params.get("country");
  if (country === "anywhere") {
    conditions.push("j.country IS NULL AND j.workplace = 'Remote'");
  } else if (country) {
    addSetFilter(conditions, bindings, "j.country", country, (value) => value.toLowerCase());
  }

  // Filters accept comma-separated values so the UI can offer multi-select without extra requests.
  addSetFilter(conditions, bindings, "j.provider", params.get("provider"), (value) =>
    PROVIDER_BY_LABEL.get(value.toLowerCase()) ?? value.toLowerCase());
  addSetFilter(conditions, bindings, "j.workplace", params.get("workplace"));
  addSetFilter(conditions, bindings, "j.category", params.get("category"));
  addSetFilter(conditions, bindings, "j.employment_type", params.get("employmentType"));

  // Doubles as the staleness control: ~22% of active postings are older than 30 days, which is the
  // threshold ghost-job research treats as the first warning sign.
  const postedWithin = Number.parseInt(params.get("postedWithin") ?? "", 10);
  if (Number.isFinite(postedWithin) && postedWithin > 0) {
    conditions.push(`j.published_at >= datetime('now', ?)`);
    bindings.push(`-${Math.min(3650, postedWithin)} days`);
  }

  const sort = (SORT_OPTIONS as readonly string[]).includes(params.get("sort") ?? "")
    ? (params.get("sort") as SortOption)
    : "newest";

  const filterBindingCount = bindings.length;
  const cursor = decodeCursor(params.get("cursor"));
  if (cursor) {
    conditions.push(cursorCondition(sort));
    bindings.push(cursor.value, cursor.value, cursor.key);
  }

  const limit = clampInteger(params.get("limit"), 100, 1, 100);
  const where = conditions.join(" AND ");
  const db = getD1();
  const select = db.prepare(`
    SELECT
      j.key,
      j.title,
      j.company_identifier AS companyIdentifier,
      j.company_name AS companyName,
      coalesce(j.company_logo_url, c.logo_url) AS companyLogoUrl,
      j.location,
      j.country,
      j.workplace,
      j.employment_type AS employmentType,
      j.category,
      j.provider,
      j.published_at AS publishedAt,
      j.url
    FROM ${from}
    LEFT JOIN boards b ON b.key = j.board_key
    LEFT JOIN companies c ON c.key = b.company_key
    WHERE ${where}
    ORDER BY ${orderBy(sort)}
    LIMIT ?
  `).bind(...bindings, limit);

  // The count must ignore the cursor clause, otherwise the total shrinks as the user pages.
  const countConditions = conditions.slice(0, cursor ? -1 : undefined);
  const count = db.prepare(`SELECT count(*) AS total FROM ${from} WHERE ${countConditions.join(" AND ")}`)
    .bind(...bindings.slice(0, filterBindingCount));

  const [rowsResult, countResult] = await db.batch([select, count]);
  const rows = rowsResult.results as unknown as JobRow[];
  const total = Number((countResult.results[0] as { total?: number } | undefined)?.total ?? 0);
  const last = rows.at(-1);

  return {
    jobs: rows.map(toPublicJob),
    total,
    limit,
    nextCursor: rows.length === limit && last
      ? encodeCursor({ value: sortValue(last, sort), key: last.key })
      : null,
  };
}

function orderBy(sort: SortOption) {
  if (sort === "oldest") return "coalesce(j.published_at, '') ASC, j.key";
  if (sort === "company") return "lower(coalesce(j.company_name, j.company_identifier)) ASC, j.key";
  return "coalesce(j.published_at, '') DESC, j.key";
}

function cursorCondition(sort: SortOption) {
  const column = sort === "company"
    ? "lower(coalesce(j.company_name, j.company_identifier))"
    : "coalesce(j.published_at, '')";
  const comparison = sort === "newest" ? "<" : ">";
  return `(${column} ${comparison} ? OR (${column} = ? AND j.key > ?))`;
}

function sortValue(row: JobRow, sort: SortOption) {
  if (sort === "company") return (row.companyName || row.companyIdentifier || "").toLowerCase();
  return row.publishedAt ?? "";
}

function addLikeFilter(conditions: string[], bindings: unknown[], column: string, value: string | null) {
  const normalized = value?.trim().toLowerCase().slice(0, 48);
  if (!normalized) return;
  conditions.push(`${column} LIKE ?`);
  bindings.push(`%${normalized}%`);
}

function addSetFilter(
  conditions: string[],
  bindings: unknown[],
  column: string,
  value: string | null,
  normalize: (value: string) => string = (input) => input,
) {
  const values = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map(normalize);
  if (!values.length) return;
  conditions.push(`${column} IN (${values.map(() => "?").join(", ")})`);
  bindings.push(...values);
}

function ftsQuery(value: string | null) {
  const tokens = value?.trim().toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._+#-]*/gu)?.slice(0, 8) ?? [];
  if (!tokens.length) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

function encodeCursor(value: { value: string; key: string }) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
}

function decodeCursor(value: string | null) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(decodeURIComponent(escape(atob(value))));
    return typeof cursor.value === "string" && typeof cursor.key === "string" ? cursor : null;
  } catch {
    return null;
  }
}

function toPublicJob(job: JobRow): PublicJob {
  const company = job.companyName || humanizeIdentifier(job.companyIdentifier, job.provider);
  return {
    id: job.key,
    title: job.title,
    company,
    companyMark: initials(company),
    companyLogoUrl: job.companyLogoUrl,
    companyColor: companyColor(company),
    location: job.location || "Location not specified",
    country: job.country ?? null,
    countryFlag: countryFlag(job.country),
    workplace: job.workplace,
    employmentType: job.employmentType,
    category: CATEGORIES.includes(job.category) ? job.category : "Other",
    source: (PROVIDER_LABELS[job.provider] ?? titleCase(job.provider)) as Job["source"],
    publishedAt: job.publishedAt,
    description: "",
    skills: [],
    url: job.url,
  };
}

function humanizeIdentifier(value: string, provider: string) {
  let identifier = value || "Unknown company";
  if (provider === "workday") identifier = identifier.split("|")[0];
  if (provider === "icims") identifier = identifier.replace(/^(?:careers|jobs)[.-]/i, "");
  if (provider === "paylocity" && /^[a-f0-9-]{8,}$/i.test(identifier)) {
    return `Paylocity employer ${identifier.slice(0, 6).toUpperCase()}`;
  }
  return identifier.replace(/^www\./, "").replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function titleCase(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function companyColor(value: string) {
  const colors = [
    "bg-[#ebe7ff] text-[#5436a8]", "bg-[#ffe8dc] text-[#9b3d0a]",
    "bg-[#e1f1ef] text-[#15645a]", "bg-[#e8eefc] text-[#294f9f]",
    "bg-[#f4e5ef] text-[#8c326d]", "bg-[#f1eadb] text-[#76551f]",
    "bg-[#e5efe3] text-[#386a31]", "bg-[#e7ecf0] text-[#34495b]",
  ];
  let hash = 0;
  for (const character of value) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  return colors[hash % colors.length];
}

function clampInteger(value: string | null, fallback: number, minimum: number, maximum: number) {
  const number = Number.parseInt(value ?? "", 10);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}
