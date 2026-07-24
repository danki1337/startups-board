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
  // True when `total` was capped (a broad text search) rather than an exact count, so the UI can
  // render it as "5,000+" instead of an exact figure it would be expensive to compute.
  totalCapped: boolean;
  limit: number;
  nextCursor: string | null;
};

// Relevance tuning for text search. bm25 column weights follow the jobs_fts column order
// (title, company_identifier, company_name, location): a title hit far outweighs a location hit.
const SEARCH_WEIGHTS = "10.0, 4.0, 4.0, 1.0";
// Freshness nudge blended into the relevance score: days since posting (undated treated as ~180d,
// capped at a year) times this coefficient, so among comparably relevant hits the newer wins
// without letting recency override a clearly better title match.
const SEARCH_RECENCY = "min(max(julianday('now') - julianday(coalesce(j.published_at, date('now', '-180 days'))), 0), 365) * 0.004";
// Text searches are relevance-ranked, so they page by offset rather than the date keyset; this caps
// how deep that paging goes (each page re-ranks the whole match set, and the long tail is noise).
const SEARCH_RESULT_CAP = 300;
// Broad searches can match hundreds of thousands of rows; counting them exactly cost multiple
// seconds, so the count is bounded and anything at/above this renders as "N+".
const COUNT_CAP = 5000;

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
  city: string | null;
  roleFamily: string | null;
  companyIndustry: string | null;
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
  rippling: "Rippling",
  smartrecruiters: "SmartRecruiters",
  sparkhire: "Spark Hire",
  workday: "Workday",
};

const PROVIDER_BY_LABEL = new Map(
  Object.entries(PROVIDER_LABELS).map(([value, label]) => [label.toLowerCase(), value]),
);

export async function queryJobs(params: URLSearchParams): Promise<JobsPage> {
  const search = ftsQuery(params.get("search"));
  const isSearch = search !== null;
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
  addSetFilter(conditions, bindings, "j.city", params.get("city"));
  addSetFilter(conditions, bindings, "j.role_family", params.get("roleFamily"));
  addSetFilter(conditions, bindings, "j.company_industry", params.get("industry"));
  addSetFilter(conditions, bindings, "j.workplace", params.get("workplace"));
  addSetFilter(conditions, bindings, "j.category", params.get("category"));
  // Employment types are stored as each provider sent them ("Full-Time", "full time", "Full Time",
  // ...), so the filter matches case- and hyphen-insensitively; an exact IN matched almost nothing.
  addSetFilter(
    conditions,
    bindings,
    "lower(replace(j.employment_type, '-', ' '))",
    params.get("employmentType"),
    (value) => value.toLowerCase().replaceAll("-", " "),
  );

  // Company watchlist. Newline-separated (not comma) because company names frequently contain commas
  // ("Alphabet, Inc."), and capped so the clause and request URL stay bounded. Matched the same
  // lenient way as the single-company filter (substring against name-or-identifier) so a starred
  // company and its clickable link return the same jobs -- including Workday boards whose display
  // name is a humanized slice of a piped identifier ("Aaco" from "aaco|wd1|site").
  const companies = (params.get("companies") ?? "")
    .split("\n").map((entry) => entry.trim().toLowerCase()).filter(Boolean).slice(0, 60);
  if (companies.length) {
    const clause = companies
      .map(() => "lower(coalesce(j.company_name, j.company_identifier)) LIKE ?").join(" OR ");
    conditions.push(`(${clause})`);
    bindings.push(...companies.map((entry) => `%${entry}%`));
  }

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

  // All bindings so far belong to filters (shared by the row query and the count). The cursor
  // clause, added only for the keyset-paged browse path, must not leak into the count.
  const filterBindingCount = bindings.length;
  const cursor = decodeCursor(params.get("cursor"));

  // Text search is relevance-ranked and paged by offset; browse is date-keyset-paged. The two never
  // mix: a search request ignores any keyset cursor and vice versa.
  const offset = isSearch && cursor && "offset" in cursor
    ? Math.max(0, Math.min(cursor.offset, SEARCH_RESULT_CAP))
    : 0;
  if (!isSearch && cursor && "key" in cursor) pushCursorCondition(conditions, bindings, sort, cursor);

  const limit = clampInteger(params.get("limit"), 100, 1, 100);
  const where = conditions.join(" AND ");
  const searchScore = `bm25(jobs_fts, ${SEARCH_WEIGHTS}) + ${SEARCH_RECENCY}`;
  const innerOrder = isSearch ? `${searchScore}, j.key` : orderBy(sort);
  const db = getD1();
  // Rank-and-limit first, THEN resolve the company-logo fallback. When relevance is the sort order
  // the planner cannot satisfy it from an index, so it materializes every match -- and joining
  // boards+companies across the whole match set (720k rows for a broad term) rather than the final
  // page (100 rows) tripled the work. The logo join now runs only over the page the inner query
  // returns; browse queries are unaffected since the index already limits the inner scan early. The
  // inner carries its sort key (relScore for search, the sorted columns for browse) so the outer
  // join can restore the exact order the ranking produced.
  const select = db.prepare(`
    SELECT
      base.key,
      base.title,
      base.companyIdentifier,
      base.companyName,
      coalesce(base.logoRaw, c.logo_url) AS companyLogoUrl,
      base.location,
      base.country,
      base.city,
      base.roleFamily,
      base.companyIndustry,
      base.workplace,
      base.employmentType,
      base.category,
      base.provider,
      base.publishedAt,
      base.url
    FROM (
      SELECT
        j.key, j.title, j.company_identifier AS companyIdentifier, j.company_name AS companyName,
        j.company_logo_url AS logoRaw, j.board_key AS boardKey, j.location, j.country, j.city,
        j.role_family AS roleFamily, j.company_industry AS companyIndustry, j.workplace,
        j.employment_type AS employmentType, j.category, j.provider, j.published_at AS publishedAt, j.url
        ${isSearch ? `, ${searchScore} AS relScore` : ""}
      FROM ${from}
      WHERE ${where}
      ORDER BY ${innerOrder}
      LIMIT ?${isSearch ? " OFFSET ?" : ""}
    ) base
    LEFT JOIN boards b ON b.key = base.boardKey
    LEFT JOIN companies c ON c.key = b.company_key
    ORDER BY ${isSearch ? "base.relScore, base.key" : baseOrderBy(sort)}
  `).bind(...bindings, limit, ...(isSearch ? [offset] : []));

  // The count ignores the cursor clause, otherwise the total would shrink as the user pages. A
  // broad search can match hundreds of thousands of rows, so its count is bounded (LIMIT in a
  // subquery) and reported as "N+"; browse counts stay exact and index-backed.
  const countConditions = conditions.slice(0, !isSearch && cursor ? -1 : undefined);
  const countWhere = countConditions.join(" AND ");
  const countBindings = bindings.slice(0, filterBindingCount);
  const count = isSearch
    ? db.prepare(`SELECT count(*) AS total FROM (SELECT 1 FROM ${from} WHERE ${countWhere} LIMIT ${COUNT_CAP + 1})`).bind(...countBindings)
    : db.prepare(`SELECT count(*) AS total FROM ${from} WHERE ${countWhere}`).bind(...countBindings);

  const [rowsResult, countResult] = await db.batch([select, count]);
  const rows = rowsResult.results as unknown as JobRow[];
  const rawTotal = Number((countResult.results[0] as { total?: number } | undefined)?.total ?? 0);
  const totalCapped = isSearch && rawTotal > COUNT_CAP;
  const total = totalCapped ? COUNT_CAP : rawTotal;

  let next: string | null;
  if (isSearch) {
    const nextOffset = offset + limit;
    next = rows.length === limit && nextOffset < SEARCH_RESULT_CAP ? encodeCursor({ offset: nextOffset }) : null;
  } else {
    next = nextCursor(rows, rows.at(-1), limit, sort, cursor && "key" in cursor ? cursor : null);
  }

  return { jobs: rows.map(toPublicJob), total, totalCapped, limit, nextCursor: next };
}

// A full page continues from its last row. A short page in the newest sort's dated phase means the
// dated rows are exhausted, so hand off to the NULL-dated tail (phase 2) with a sentinel cursor
// rather than stopping -- otherwise the ~7% of undated jobs would be unreachable by scrolling.
function nextCursor(
  rows: JobRow[],
  last: JobRow | undefined,
  limit: number,
  sort: SortOption,
  cursor: { value: string | null; key: string } | null,
): string | null {
  // A full page continues from its last row; its published_at (date or null) selects the phase.
  if (rows.length === limit && last) return encodeCursor({ value: sortValue(last, sort), key: last.key });
  // A short page ends pagination -- except when a *dated cursor* page (not page one, whose nulls-last
  // ordering already surfaced any undated rows) has exhausted the dated rows: hand off to the NULL
  // tail so those jobs stay reachable. Restricted to dated cursor pages so nulls are never re-fetched.
  if (sort === "newest" && cursor !== null && cursor.value !== null) {
    return encodeCursor({ value: null, key: "" });
  }
  return null;
}

// Typeahead for the role-title field. Reads the small job_titles aggregate (~99k rows, one per
// distinct title) rather than the 511k-row jobs table, so a keystroke costs a fraction of a search.
// Prefix matches rank above mid-word ones so typing "eng" offers "Engineering Manager" before
// "Senior Software Engineer".
export async function queryTitleSuggestions(query: string, limit = 8) {
  const term = query.trim().toLowerCase().slice(0, 60);
  if (term.length < 2) return [];

  const escaped = term.replace(/[\\%_]/g, (character) => `\\${character}`);
  const rows = await getD1().prepare(`
    SELECT title, job_count AS jobCount
    FROM job_titles
    WHERE lower(title) LIKE ? ESCAPE '\\'
    ORDER BY CASE WHEN lower(title) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, job_count DESC
    LIMIT ?
  `).bind(`%${escaped}%`, `${escaped}%`, Math.min(20, limit)).all();

  return (rows.results ?? []) as { title: string; jobCount: number }[];
}

function orderBy(sort: SortOption) {
  if (sort === "oldest") return "coalesce(j.published_at, '') ASC, j.key";
  if (sort === "company") return "lower(coalesce(j.company_name, j.company_identifier)) ASC, j.key";
  // Raw column (not coalesce) so the (is_active, published_at DESC, key) index satisfies the sort
  // with a covering scan instead of reading and sorting the whole table. SQLite orders NULLs last in
  // DESC, which matches the old coalesce('')-to-last behaviour for undated rows.
  return "j.published_at DESC, j.key";
}

// orderBy re-expressed over the outer query's aliased columns, so the join-for-logo wrapper restores
// the exact browse order the inner subquery produced.
function baseOrderBy(sort: SortOption) {
  if (sort === "oldest") return "coalesce(base.publishedAt, '') ASC, base.key";
  if (sort === "company") return "lower(coalesce(base.companyName, base.companyIdentifier)) ASC, base.key";
  return "base.publishedAt DESC, base.key";
}

// Keyset pagination. For the default newest sort this is null-aware so the ~7% of rows with no
// publish date (which sort last) stay reachable while the comparison remains index-friendly.
function pushCursorCondition(
  conditions: string[],
  bindings: unknown[],
  sort: SortOption,
  cursor: { value: string | null; key: string },
) {
  if (sort === "newest") {
    if (cursor.value === null) {
      // Phase 2: the trailing NULL-dated rows, walked by key. Scoped by the other filters, so this
      // reads only the matching NULL rows rather than the whole 82k tail.
      conditions.push("(j.published_at IS NULL AND j.key > ?)");
      bindings.push(cursor.key);
    } else {
      // Phase 1: older dates, ties broken by key. Pure index range seek -- no NULL scan per page.
      conditions.push("(j.published_at < ? OR (j.published_at = ? AND j.key > ?))");
      bindings.push(cursor.value, cursor.value, cursor.key);
    }
    return;
  }
  const column = sort === "company"
    ? "lower(coalesce(j.company_name, j.company_identifier))"
    : "coalesce(j.published_at, '')";
  conditions.push(`(${column} > ? OR (${column} = ? AND j.key > ?))`);
  bindings.push(cursor.value ?? "", cursor.value ?? "", cursor.key);
}

function sortValue(row: JobRow, sort: SortOption): string | null {
  if (sort === "company") return (row.companyName || row.companyIdentifier || "").toLowerCase();
  if (sort === "newest") return row.publishedAt ?? null; // null preserved so the cursor knows the tail
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

// Build the FTS5 MATCH expression: each meaningful token becomes a quoted prefix term, AND-ed so
// every word must appear. Tokens are split on the same boundaries the unicode61 tokenizer uses --
// runs of letters/digits only -- so a query term always corresponds to a real indexed term. Matching
// the index this way is what stops "c++" from collapsing to the term "c" and prefix-matching every
// posting that starts with c; "front-end" likewise becomes front AND end, both of which exist.
// Single-character tokens are dropped: a bare "a" prefix-matches almost everything, which is useless
// and pathologically slow, so a query of only a lone letter yields null (no text filter, plain browse).
export function ftsQuery(value: string | null) {
  const tokens = value?.trim().toLowerCase().match(/[\p{L}\p{N}]+/gu)
    ?.filter((token) => token.length >= 2)
    .slice(0, 8) ?? [];
  if (!tokens.length) return null;
  return tokens.map((token) => `"${token}"*`).join(" AND ");
}

// A cursor is either a keyset position for browse ({value, key}) or an offset for relevance search
// ({offset}); the two paths never share one, so the opaque token just round-trips whichever applies.
type KeysetCursor = { value: string | null; key: string };
type OffsetCursor = { offset: number };

function encodeCursor(value: KeysetCursor | OffsetCursor) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
}

function decodeCursor(value: string | null): KeysetCursor | OffsetCursor | null {
  if (!value) return null;
  try {
    const cursor = JSON.parse(decodeURIComponent(escape(atob(value))));
    if (typeof cursor.offset === "number" && Number.isFinite(cursor.offset)) return { offset: cursor.offset };
    const validValue = typeof cursor.value === "string" || cursor.value === null;
    return validValue && typeof cursor.key === "string" ? cursor : null;
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
    city: job.city ?? null,
    roleFamily: job.roleFamily ?? null,
    companyIndustry: job.companyIndustry ?? null,
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
