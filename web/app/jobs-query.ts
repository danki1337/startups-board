import { getD1 } from "../db";
import type { Job } from "./jobs";
import { countryFlag } from "./countries";
import {
  companyMatchExpression,
  humanizeIdentifier,
  normalizeCompanyValue,
} from "../../src/company-name.mjs";

// Shared by the /api/jobs route and the server-rendered first page, so the initial paint and every
// subsequent fetch apply exactly the same filter semantics. Previously the page shipped a 12-row
// demo fixture and only swapped in real data after a client round-trip.

// Deliberately the same shape the client renders, so the server-rendered first page and the
// client's later fetches are interchangeable without a mapping layer.
export type PublicJob = Job;

export type JobsPage = {
  jobs: PublicJob[];
  // null on a cursor page: only the first page of a result set counts, since the client keeps the
  // total it already has and paying for count(*) again on every scroll is the request's most
  // expensive statement. Distinct from 0, which means "this filter matches nothing".
  total: number | null;
  // True when `total` was capped (a broad text search) rather than an exact count, so the UI can
  // render it as "5,000+" instead of an exact figure it would be expensive to compute.
  totalCapped: boolean;
  // Set when a near-empty search was spell-corrected: these results are for `correctedTo`, offered
  // in place of the user's `correctedFrom` so the UI can show "Showing results for …".
  correctedFrom?: string;
  correctedTo?: string;
  limit: number;
  nextCursor: string | null;
};

// Below this many hits a text search is treated as a possible typo and a spelling correction is
// tried. Set generously because a misspelling often appears in a handful of real postings too
// (people mistype in job titles); the "8x more common" guard in correctQuery is what prevents a
// legitimately niche term from being over-corrected.
const CORRECTION_THRESHOLD = 60;

// Relevance tuning for text search. bm25 column weights follow the jobs_fts column order
// (title, company_identifier, company_name, location): a title hit far outweighs a location hit.
const SEARCH_WEIGHTS = "10.0, 4.0, 4.0, 1.0";
// Freshness nudge blended into the relevance score: days since posting (undated treated as ~180d,
// capped at a year) times this coefficient. The coefficient has to be read against bm25's actual
// spread, which is far narrower than it looks: across the top matches for "software engineer" the
// scores run -11.78 to -11.66, a range of ~0.12. At the old 0.004 the nudge spanned 1.46 over a
// year and so decided the order outright; at 0.0012 it spans 0.44, which still separates a fresh
// posting from a year-old one but no longer outranks a better title match.
const SEARCH_RECENCY = "min(max(julianday('now') - julianday(coalesce(j.published_at, date('now', '-180 days'))), 0), 365) * 0.0012";
// Exact-title bonus, and the reason searches feel right rather than merely relevant. bm25 rewards
// term frequency, so "Associate Software Engineer Software Engineer" (each term twice) outscored a
// plain "Software Engineer" by 0.12 -- a hairline in score terms but plainly wrong to a reader. The
// tiers are far larger than that spread, so an exact title wins, a title that starts with the query
// comes next, and one that merely contains it comes after; everything else falls back to bm25.
// Hyphens and slashes are spaces on both sides, so "front-end engineer" and "front end engineer"
// each match the title "Front-End Engineer".
const SEARCH_TITLE_NORM = "lower(replace(replace(j.title, '-', ' '), '/', ' '))";
const SEARCH_EXACTNESS =
  `CASE WHEN ${SEARCH_TITLE_NORM} = ? THEN -4.0` +
  ` WHEN ${SEARCH_TITLE_NORM} LIKE ? ESCAPE '\\' THEN -2.0` +
  ` WHEN ${SEARCH_TITLE_NORM} LIKE ? ESCAPE '\\' THEN -1.0` +
  " ELSE 0.0 END";
// Text searches are relevance-ranked, so they page by offset rather than the date keyset; this caps
// how deep that paging goes (each page re-ranks the whole match set, and the long tail is noise).
// Counted in ranked rows, not returned ones: collapseDuplicates walks roughly 1.5 rows per result
// it keeps, so 500 here is what leaves ~300 distinct results reachable, which is what the cap was
// worth before collapsing existed.
const SEARCH_RESULT_CAP = 500;
// How many ranked rows a search reads per page relative to the page size, giving collapseDuplicates
// room to drop repeats and still fill the page. The extra rows cost only their share of the
// page-sized logo join, not the ranking, which scans the whole match set either way.
const SEARCH_OVERFETCH = 3;
// Broad searches can match hundreds of thousands of rows; counting them exactly cost multiple
// seconds, so the count is bounded and anything at/above this renders as "N+".
const COUNT_CAP = 5000;
// Upper bound on rows the title typeahead may return. job_titles is a small aggregate (one row per
// distinct title), so a longer list costs little and lets the dropdown show a real, scrollable set
// rather than a top-30 teaser.
const TITLE_SUGGESTION_MAX = 300;
// Companies are a flat list with no folding, so this is only a bound on one response, not a filter
// on what is reachable: the search box narrows 33.6k companies long before a thousand rows matter,
// and the previous 200 made the list look arbitrarily truncated for no benefit.
const COMPANY_SUGGESTION_MAX = 1_000;
// D1 rejects any statement with more than 100 bound parameters.
const D1_MAX_BIND = 100;
// Held back for the binds appended after the filters: the three exactness patterns, posted-within,
// the keyset cursor, and limit/offset.
const RESERVED_BINDS = 10;

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
  // 1 when the board resolves to a logo. The URL stays server-side; the client is handed a
  // /api/logo path keyed on the board, which is what makes the bytes cacheable (and what stops
  // this endpoint from ever accepting a caller-supplied URL to fetch).
  hasLogo: number;
  boardKey: string;
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
  // On the search path every jobs-side predicate is marked with SQLite's unary `+`, which keeps a
  // term but makes it unusable by an index, leaving the FTS table as the only possible driver.
  //
  // This is the difference between a search that answers and one that times out. Given both a text
  // term and a column filter, SQLite would drive from the column index and ask FTS "does this one
  // row match?" per candidate -- and FTS5 answers that by intersecting doclists, not by a point
  // lookup. `product manager` plus postedWithin=7 took over 33s that way and returned a 500;
  // driving from FTS it takes 0.5s and reads 27k rows. Browse keeps its indexes, where they are
  // exactly what makes the keyset page fast.
  const filtered = (expression: string) => (isSearch ? `+${expression}` : expression);
  const conditions = [`${filtered("j.is_active")} = 1`];
  const bindings: unknown[] = [];
  const from = search ? "jobs j JOIN jobs_fts ON jobs_fts.rowid = j.rowid" : "jobs j";

  if (search) {
    conditions.push("jobs_fts MATCH ?");
    bindings.push(search);
    // Punctuation tech terms (c++, c#, ...) ride alongside the FTS match as a substring filter, so
    // "c++ engineer" narrows to engineer via the index and then keeps only the C++ titles. Applied
    // only with a normal FTS term present, which keeps the LIKE bounded to that narrowed set.
    for (const term of specialSearchTerms(params.get("search"))) {
      conditions.push("(lower(j.title) LIKE ? OR lower(coalesce(j.company_name, '')) LIKE ?)");
      bindings.push(`%${term}%`, `%${term}%`);
    }
  }
  // Narrowed through FTS first, exactly as title and company are, and for the same reason -- this
  // was the last unindexed filter left, and the slowest: ?location=new%20york took 3.5s against
  // 0.52s for the indexed ?city=Berlin, because a leading-wildcard LIKE over an expression cannot
  // use any index and the accompanying count has nothing to stop at. jobs_fts has indexed the
  // location column since the first migration; it was simply never used.
  const locationValue = params.get("location");
  const locationMatch = locationFtsQuery(locationValue);
  if (locationMatch) {
    conditions.push(`${filtered("j.rowid")} IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?)`);
    bindings.push(locationMatch);
  }
  addLikeFilter(conditions, bindings, "lower(coalesce(j.location, ''))", locationValue);
  // Narrowed through the FTS index first, exactly as the title filter is, and for the same reason:
  // a leading-wildcard LIKE over an expression cannot use any index, so this was a full scan of
  // every active row. Measured on production, ?company=Revolut took 13.4s and ?company=Stripe 3.8s
  // for result sets of a few hundred rows. jobs_fts already indexes both company columns.
  const companyValue = params.get("company");
  const companyMatch = companyFtsQuery(companyValue);
  if (companyMatch) {
    conditions.push(`${filtered("j.rowid")} IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?)`);
    bindings.push(companyMatch);
  }
  // Then matched EXACTLY, not as a substring. A substring match on the raw columns meant picking
  // "Mercury" returned Mercury (56), Mercuryinsurance (43) and even Masco (1) -- the last because
  // the string appears somewhere in its identifier. Company is always chosen from a fixed set (the
  // dropdown, a chip, or a click on the table), so there is no partial to support; free-text company
  // search belongs to the search box, which is a different parameter.
  //
  // The comparison is against the same DISPLAY expression the job_companies aggregate groups on --
  // Workday identifiers are "tenant|wdN|site" and only the tenant is the company -- and both sides
  // are normalised the same way, because the dropdown titlecases "acme-corp" to "Acme Corp" before
  // offering it and the value has to find its way back to the stored form.
  if (companyValue?.trim()) {
    conditions.push(`${filtered(COMPANY_DISPLAY_SQL)} = ?`);
    bindings.push(normalizeCompanyValue(companyValue));
  }
  // Role and company are separate fields: searching "stripe" as a role should not match every
  // posting at Stripe, and vice versa.
  // The title filter is a substring match, which means a leading wildcard and therefore an
  // unindexable scan of every active row. The page query survived that (the date index lets it stop
  // once it has 20 matches) but the accompanying COUNT has no limit to stop at, so filtering by a
  // title cost ~4s -- and the Title dropdown only just became usable enough for people to do it.
  // Narrowing on the FTS title column first cuts that to ~0.2s for an identical result; the LIKE
  // stays as the exactness check, since FTS ignores word order and punctuation.
  const titleValue = params.get("title");
  const titleMatch = titleFtsQuery(titleValue);
  if (titleMatch) {
    conditions.push(`${filtered("j.rowid")} IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?)`);
    bindings.push(titleMatch);
  }
  addLikeFilter(conditions, bindings, "lower(j.title)", titleValue);

  // One budget shared by every set filter, spent in declaration order. Each filter alone caps at
  // 12 values, but eight filters times 12 is 96 binds BEFORE the text filters above take theirs --
  // a URL stacking all of them bound 109 parameters and D1 threw "too many SQL variables": a 500
  // and a blank first paint from a shareable link. The trailing binds (exactness, posted-within,
  // cursor, limit/offset) live inside RESERVED_BINDS.
  const setBudget = { left: Math.max(0, D1_MAX_BIND - RESERVED_BINDS - bindings.length) };

  // "anywhere" is remote-with-no-country, which is a distinct answer from "country unknown".
  const country = params.get("country");
  if (country === "anywhere") {
    conditions.push(`${filtered("j.country")} IS NULL AND ${filtered("j.workplace")} = 'Remote'`);
  } else if (country) {
    addSetFilter(conditions, bindings, setBudget, filtered("j.country"), country, (value) => value.toLowerCase());
  }

  // Filters accept comma-separated values so the UI can offer multi-select without extra requests.
  addSetFilter(conditions, bindings, setBudget, filtered("j.provider"), params.get("provider"), (value) =>
    PROVIDER_BY_LABEL.get(value.toLowerCase()) ?? value.toLowerCase());
  addSetFilter(conditions, bindings, setBudget, filtered("j.city"), params.get("city"));
  addSetFilter(conditions, bindings, setBudget, filtered("j.role_family"), params.get("roleFamily"));
  addSetFilter(conditions, bindings, setBudget, filtered("j.company_industry"), params.get("industry"));
  addSetFilter(conditions, bindings, setBudget, filtered("j.workplace"), params.get("workplace"));
  // Employment types are stored as each provider sent them ("Full-Time", "full time", "Full Time",
  // ...), so the filter matches case- and hyphen-insensitively; an exact IN matched almost nothing.
  addSetFilter(
    conditions,
    bindings,
    setBudget,
    filtered("lower(replace(j.employment_type, '-', ' '))"),
    params.get("employmentType"),
    (value) => value.toLowerCase().replaceAll("-", " "),
  );

  // Company watchlist. Newline-separated (not comma) because company names frequently contain commas
  // ("Alphabet, Inc."), and capped so the clause and request URL stay bounded. Matched the same
  // lenient way as the single-company filter (substring against name-or-identifier) so a starred
  // company and its clickable link return the same jobs -- including Workday boards whose display
  // name is a humanized slice of a piped identifier ("Aaco" from "aaco|wd1|site").
  // The watchlist is the last and by far the largest group of bindings, so it is what pushes a query
  // over D1's 100-parameter ceiling -- and a query that exceeds it does not degrade, it throws, so
  // /api/jobs returned 500 on every request for that user until they cleared filters. 60 starred
  // companies plus a dozen cities and a dozen countries was enough to do it, all within the caps the
  // UI itself offers. Taking whatever budget is left rather than a fixed 60 keeps the statement
  // legal no matter how the other filters are combined; the trailing binds (posted-within, cursor,
  // limit/offset) are what the headroom is reserved for.
  const bindBudget = Math.max(0, D1_MAX_BIND - RESERVED_BINDS - bindings.length);
  const companies = (params.get("companies") ?? "")
    .split("\n").map((entry) => entry.trim().toLowerCase()).filter(Boolean)
    .slice(0, Math.min(60, bindBudget));
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
    conditions.push(`${filtered("j.published_at")} >= datetime('now', ?)`);
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
  // Named, because the count below has to strip exactly the clause this pushes and nothing else. It
  // used to re-derive the answer as `!isSearch && cursor`, which is a different question: hand a
  // browse request an OFFSET cursor -- clear the search box while paging, or share that URL -- and
  // the count sliced off a genuine filter instead. Harmless today only because a cursor also turns
  // the count off; a trap for whoever changes either line next.
  const hasKeysetCursor = !isSearch && cursor !== null && "key" in cursor;
  if (hasKeysetCursor) pushCursorCondition(conditions, bindings, sort, cursor as KeysetCursor);

  const limit = clampInteger(params.get("limit"), 100, 1, 100);
  const where = conditions.join(" AND ");
  // The exactness bonus binds three patterns into the SELECT list, ahead of every filter binding,
  // because SQLite numbers placeholders by their position in the SQL text. Ordering by the relScore
  // alias rather than repeating the expression keeps it to one set of bindings (and one evaluation).
  const exactness = isSearch ? exactnessPatterns(params.get("search")) : null;
  const searchScore = `bm25(jobs_fts, ${SEARCH_WEIGHTS}) + ${SEARCH_RECENCY}`
    + (exactness ? ` + (${SEARCH_EXACTNESS})` : "");
  // Newest first, including on the search path. Relevance still decides WHICH postings match and
  // which survive SEARCH_RESULT_CAP -- the score is still computed and still bounds the set -- but
  // the rows that come back are ordered by posting time, because on a job board recency is what
  // people are actually scanning for.
  const innerOrder = isSearch ? `${orderBy(sort)}, relScore` : orderBy(sort);
  // A search over-fetches so identical postings can be collapsed below without leaving a short page:
  // employers routinely run several requisitions with one title, and three "Data Scientist" rows
  // from the same company are three wasted slots on the first page.
  const fetchLimit = isSearch ? Math.min(limit * SEARCH_OVERFETCH, 300) : limit;
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
      -- Whether there is a logo AT ALL. The URL itself no longer travels to the client: the row
      -- carries the board key and the client asks /api/logo for it, so the bytes come from our
      -- origin with cache headers the browser can actually use. See web/app/api/logo/route.ts.
      CASE WHEN coalesce(base.logoRaw, c.logo_url) IS NOT NULL
            AND coalesce(base.logoRaw, c.logo_url) <> '' THEN 1 ELSE 0 END AS hasLogo,
      base.boardKey,
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
    ORDER BY ${baseOrderBy(sort)}
  `).bind(...(exactness ?? []), ...bindings, fetchLimit, ...(isSearch ? [offset] : []));

  // The count ignores the cursor clause, otherwise the total would shrink as the user pages. A
  // broad search can match hundreds of thousands of rows, so its count is bounded (LIMIT in a
  // subquery) and reported as "N+"; browse counts stay exact and index-backed. The count inherits
  // the `filtered()` markers from `conditions`, which is what keeps a filtered search's count on the
  // FTS-driven plan rather than the pathological per-row-probe one.
  const countConditions = hasKeysetCursor ? conditions.slice(0, -1) : conditions;
  const countWhere = countConditions.join(" AND ");
  const countBindings = bindings.slice(0, filterBindingCount);
  // The unfiltered browse -- the homepage, by far the most requested shape -- is the one whose
  // exact count(*) walks the entire active index: ~1.6M rows read per view, to decorate the h1
  // with a number. That is $0.0017 of D1 reads PER PAGE VIEW, the single thing that would have
  // made traffic expensive. provider_health already holds per-provider active counts, maintained
  // incrementally on every refresh and recomputed exactly once a day, so the same number is a
  // 12-row sum. Every filtered or searched count still runs against jobs, where the filter's own
  // index (or the search cap) bounds the work.
  const isBareBrowse = !isSearch && countConditions.length === 1;
  const count = isBareBrowse
    ? db.prepare("SELECT coalesce(sum(active_jobs), 0) AS total FROM provider_health")
    : isSearch
      ? db.prepare(`SELECT count(*) AS total FROM (SELECT 1 FROM ${from} WHERE ${countWhere} LIMIT ${COUNT_CAP + 1})`).bind(...countBindings)
      : db.prepare(`SELECT count(*) AS total FROM ${from} WHERE ${countWhere}`).bind(...countBindings);

  // Only the first page of a result set needs the total. The infinite scroll keeps the count it got
  // from that page and never reads `total` off a cursor response -- but every scroll page was still
  // running the count, and for an unfiltered browse that is count(*) over the ~1.2M active rows,
  // easily the most expensive statement in the request and the one part of it thrown away. Skipping
  // it takes the work off the scroll path and off the D1 rows-read bill.
  const withCount = !cursor;
  const [rowsResult, countResult] = withCount
    ? await db.batch([select, count])
    : [(await select.all()) as { results: unknown[] }, null];
  const fetched = rowsResult.results as unknown as JobRow[];
  let rawTotal = Number((countResult?.results[0] as { total?: number } | undefined)?.total ?? 0);
  // provider_health is empty on a fresh database (local dev, a rebuilt environment) while jobs may
  // not be -- and "Find 0 open roles" above a full table is worse than one exact count. Zero is the
  // only value that can be wrong here: any positive sum came from real refreshes.
  if (isBareBrowse && withCount && rawTotal === 0) {
    const exact = await db.prepare(`SELECT count(*) AS total FROM ${from} WHERE ${countWhere}`)
      .bind(...countBindings).first<{ total: number }>();
    rawTotal = Number(exact?.total ?? 0);
  }
  const totalCapped = withCount && isSearch && rawTotal > COUNT_CAP;
  // null, not 0: a cursor page has no opinion about the total, and 0 would read as "no results" to
  // anything that trusted it.
  const total = withCount ? (totalCapped ? COUNT_CAP : rawTotal) : null;

  const { rows, consumed } = isSearch ? collapseDuplicates(fetched, limit) : { rows: fetched, consumed: fetched.length };

  let next: string | null;
  if (isSearch) {
    // Paging advances by the rows actually walked, not by the page size, so a collapsed twin sits
    // behind the next offset and cannot resurface at the top of the following page. A short fetch
    // means the ranked window is exhausted.
    const nextOffset = offset + consumed;
    next = fetched.length === fetchLimit && nextOffset < SEARCH_RESULT_CAP ? encodeCursor({ offset: nextOffset }) : null;
  } else {
    next = nextCursor(rows, rows.at(-1), limit, sort, cursor && "key" in cursor ? cursor : null);
  }

  // A near-empty search is likely a typo: try a spelling correction and, if the corrected query
  // actually differs, return its results labelled so the UI can say "Showing results for …". The
  // `_corrected` guard runs this at most once, and only on the first page.
  if (withCount && isSearch && rawTotal < CORRECTION_THRESHOLD && offset === 0 && params.get("_corrected") !== "1") {
    const original = params.get("search") ?? "";
    const fixed = await correctQuery(db, original);
    if (fixed && fixed.toLowerCase() !== original.toLowerCase()) {
      const retryParams = new URLSearchParams(params);
      retryParams.set("search", fixed);
      retryParams.set("_corrected", "1");
      const retry = await queryJobs(retryParams);
      return { ...retry, correctedFrom: original, correctedTo: fixed };
    }
  }

  return { jobs: rows.map(toPublicJob), total, totalCapped, limit, nextCursor: next };
}

// Keep one row per company-and-title, best-ranked first. The duplicates are real, distinct postings
// -- Kong has two "SRE 2, Konnect SREs" requisitions in Bangalore, Peraton three "Data Scientist" --
// so nothing upstream can merge them, but to a reader they are the same row repeated and they were
// taking three of the top ten slots. Returns how many ranked rows were walked so the caller can
// advance its offset past the ones it dropped.
function collapseDuplicates(fetched: JobRow[], limit: number) {
  const seen = new Set<string>();
  const rows: JobRow[] = [];
  let consumed = 0;
  for (const row of fetched) {
    if (rows.length >= limit) break;
    consumed += 1;
    const identity = // "\u0000" as an ESCAPE, never a literal NUL byte: a raw NUL makes grep/rg treat this whole
    // file -- the one holding every SQL statement the API builds -- as binary and silently skip it.
    `${row.title ?? ""}\u0000${row.companyName ?? row.companyIdentifier ?? ""}`.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    rows.push(row);
  }
  return { rows, consumed };
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
  // The mirror image for the ascending sort: the undated group comes first there, so a short page
  // inside it hands off to the dates rather than the other way round. "" is the sentinel
  // pushCursorCondition reads as "dated rows, from the beginning".
  if (sort === "oldest" && cursor !== null && cursor.value === null) {
    return encodeCursor({ value: "", key: "" });
  }
  return null;
}

// Typeahead for the role-title field. Reads the small job_titles aggregate (~99k rows, one per
// distinct title) rather than the 511k-row jobs table, so a keystroke costs a fraction of a search.
// Prefix matches rank above mid-word ones so typing "eng" offers "Engineering Manager" before
// "Senior Software Engineer".
// Job titles arrive from a dozen ATSs with every possible qualifier bolted on, so a search for
// "product designer" returned ten near-identical rows -- "Product Designer (UI/UX)", "Product
// Designer | Senior", "Product Designer II", "Product Designer, App Store" -- pushing genuinely
// different roles off the list. This reduces a title to the role itself so those fold into one.
//
// It is only ever applied to the suggestion LIST. The title filter itself is a substring match
// (`lower(title) LIKE '%value%'`), so picking the folded "Product Designer" still matches every
// variant it stood for -- the collapse loses nothing, it just stops showing the same role ten times.
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

export function canonicalTitle(title: string) {
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

// Folds rows onto their canonical title, summing counts, keeping the most common spelling as the
// label and the original order (which is already relevance- then popularity-sorted).
function collapseTitles(rows: { title: string; jobCount: number }[], limit: number) {
  // Fold to the set of distinct roles, keeping first-seen order (already relevance- then
  // popularity-sorted).
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const label = canonicalTitle(row.title);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }

  // The count has to be what clicking the row actually returns, and clicking applies a SUBSTRING
  // filter -- so "Product Designer" also matches "Senior Product Designer" and "Product Designer,
  // App Store". Summing only the rows that fold onto the label understated it badly: the dropdown
  // read 392 where the filter returned 1,704. Counting by containment makes the number a promise.
  //
  // Which labels make the cut is still decided by the raw popularity order above (counting every
  // label before slicing would be O(labels x rows) over the whole 2,000-row window). The list is
  // then ordered by the number actually shown, so the dropdown reads biggest-first -- folding
  // variants together reshuffles the magnitudes enough that the pre-fold order no longer matched
  // the counts beside each row.
  return labels
    .slice(0, limit)
    .map((label) => {
      const needle = label.toLowerCase();
      let jobCount = 0;
      for (const row of rows) {
        if (row.title.toLowerCase().includes(needle)) jobCount += Number(row.jobCount);
      }
      return { title: label, jobCount };
    })
    .sort((a, b) => b.jobCount - a.jobCount || a.title.localeCompare(b.title));
}

export async function queryTitleSuggestions(query: string, limit = 8) {
  const term = query.trim().toLowerCase().slice(0, 60);
  const cap = Math.min(TITLE_SUGGESTION_MAX, Math.max(1, limit));
  // Over-read so the fold still has `cap` distinct roles to return once the variants have merged.
  // Read well past what is shown: the containment sum below can only count variants it has actually
  // fetched, so a narrow window would undercount a popular role.
  const readCap = Math.min(2_000, Math.max(cap * 8, 400));

  // No (or too-short) query: seed the field with the most common titles so the dropdown shows a
  // starting list to pick from rather than an empty box.
  if (term.length < 2) {
    const rows = await getD1().prepare(`
      SELECT title, job_count AS jobCount FROM job_titles ORDER BY job_count DESC LIMIT ?
    `).bind(readCap).all();
    return collapseTitles((rows.results ?? []) as { title: string; jobCount: number }[], cap);
  }

  const escaped = term.replace(/[\\%_]/g, (character) => `\\${character}`);
  const rows = await getD1().prepare(`
    SELECT title, job_count AS jobCount
    FROM job_titles
    WHERE lower(title) LIKE ? ESCAPE '\\'
    ORDER BY CASE WHEN lower(title) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, job_count DESC
    LIMIT ?
  `).bind(`%${escaped}%`, `${escaped}%`, readCap).all();

  return collapseTitles((rows.results ?? []) as { title: string; jobCount: number }[], cap);
}

// The Company dropdown's options. Unlike titles there is no folding to do -- a company name is
// already the value the filter matches -- so this is a straight read of the daily aggregate, with
// exact counts and no read window.
export async function queryCompanySuggestions(query: string, limit = 50) {
  const term = query.trim().toLowerCase().slice(0, 60);
  const cap = Math.min(COMPANY_SUGGESTION_MAX, Math.max(1, limit));

  if (term.length < 2) {
    const rows = await getD1().prepare(`
      SELECT company, job_count AS jobCount, logo_board_key AS logoBoardKey FROM job_companies ORDER BY job_count DESC LIMIT ?
    `).bind(cap).all();
    return prettyCompanies(rows.results ?? []);
  }

  // ESCAPE, so a company with a literal % or _ in its name is matched rather than turned into a
  // wildcard -- the same guard queryTitleSuggestions uses.
  const escaped = term.replace(/[\\%_]/g, (character) => `\\${character}`);
  const rows = await getD1().prepare(`
    SELECT company, job_count AS jobCount, logo_board_key AS logoBoardKey
    FROM job_companies
    WHERE lower(company) LIKE ? ESCAPE '\\'
    ORDER BY CASE WHEN lower(company) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, job_count DESC
    LIMIT ?
  `).bind(`%${escaped}%`, `${escaped}%`, cap).all();
  return prettyCompanies(rows.results ?? []);
}

// A stored value is either a real company name (left alone) or a bare identifier like "dollartree"
// or "acme-corp", which the table renders titlecased -- so the dropdown must too, or picking a row
// looks like it filtered to something else.
function prettyCompanies(rows: unknown[]) {
  return (rows as { company: string; jobCount: number; logoBoardKey: string | null }[]).map((row) => ({
    // Through the shared humanizer, and with no provider: the aggregate's own SQL has already
    // stripped the provider-specific packaging (the Workday tenant pipe, the iCIMS careers prefix),
    // so all that is left here is reading separators as spaces -- and reading them the same way the
    // table does, which is the whole point of the shared module.
    company: /[a-z]/.test(row.company) && !/\s/.test(row.company)
      ? humanizeIdentifier(row.company, "")
      : row.company,
    jobCount: row.jobCount,
    // The same proxy path the job rows use, so a company's logo is ONE cache entry whether it was
    // first seen in the table or in this dropdown. Null until the daily aggregate has rebuilt with
    // logo_board_key, which simply means no mark rather than a broken one. The stored (un-prettied)
    // company rides along because logo_board_key can be an aggregator board holding many companies'
    // logos -- without it, every Getro-sourced company drew the same arbitrary mark.
    logoUrl: row.logoBoardKey ? logoProxyUrl(row.logoBoardKey, row.company) : null,
  }));
}

function orderBy(sort: SortOption) {
  // Raw column, and a DESCENDING key tiebreak, so that (is_active, published_at DESC, key) can be
  // walked backwards and satisfy this outright. The coalesce bought nothing -- SQLite already orders
  // NULLs first in ASC, exactly where coalesce(…, '') put them -- and cost everything: an expression
  // is not the indexed column, so this ordering was a full sort of 1.24M rows and ?sort=oldest was
  // the slowest request the API served, at 5.9s.
  if (sort === "oldest") return "j.published_at ASC, j.key DESC";
  if (sort === "company") return "lower(coalesce(j.company_name, j.company_identifier)) ASC, j.key";
  // Raw column (not coalesce) so the (is_active, published_at DESC, key) index satisfies the sort
  // with a covering scan instead of reading and sorting the whole table. SQLite orders NULLs last in
  // DESC, which matches the old coalesce('')-to-last behaviour for undated rows.
  return "j.published_at DESC, j.key";
}

// orderBy re-expressed over the outer query's aliased columns, so the join-for-logo wrapper restores
// the exact browse order the inner subquery produced.
function baseOrderBy(sort: SortOption) {
  if (sort === "oldest") return "base.publishedAt ASC, base.key DESC";
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
  // The same two phases as newest, inverted: ascending puts the NULL-dated rows FIRST, so phase one
  // is the tail of that group and phase two the dates. The key tiebreak is `<` because the ordering
  // above walks the index backwards, which reverses the key within a tie.
  if (sort === "oldest") {
    if (cursor.value === null) {
      conditions.push("(j.published_at IS NULL AND j.key < ?)");
      bindings.push(cursor.key);
    } else if (cursor.value === "") {
      // The handoff sentinel written by nextCursor when the NULL group runs out: every real date is
      // greater than the empty string, and NULL compares to nothing, so this is exactly "the dated
      // rows, from the beginning".
      conditions.push("j.published_at IS NOT NULL");
    } else {
      conditions.push("(j.published_at > ? OR (j.published_at = ? AND j.key < ?))");
      bindings.push(cursor.value, cursor.value, cursor.key);
    }
    return;
  }
  const column = "lower(coalesce(j.company_name, j.company_identifier))";
  conditions.push(`(${column} > ? OR (${column} = ? AND j.key > ?))`);
  bindings.push(cursor.value ?? "", cursor.value ?? "", cursor.key);
}

function sortValue(row: JobRow, sort: SortOption): string | null {
  if (sort === "company") return (row.companyName || row.companyIdentifier || "").toLowerCase();
  // null preserved in both date sorts so the cursor knows which phase it is in -- the undated group
  // leads in `oldest` and trails in `newest`, and either way it is walked by key alone.
  return row.publishedAt ?? null;
}

// The company name as the UI shows it, reduced to its comparison form. Imported rather than written
// out here: this expression and the humanizeIdentifier that produces the value it is compared
// against were two independent implementations of one idea, and they disagreed for 25% of the index
// (see src/company-name.mjs).
const COMPANY_DISPLAY_SQL = companyMatchExpression("j");

// Column-scoped FTS narrowing, shared by the title, company and location filters. Each of the three
// is a substring LIKE over an expression, which means a leading wildcard and therefore a scan of
// every active row; running the FTS index in front of it is what turns that back into a seek. The
// LIKE always stays, as the exactness check -- FTS ignores word order and punctuation, so it
// narrows correctly but does not decide correctly.
//
// `prefixLast` prefix-matches the final token, for the filters whose value can be partially typed.
// Returns null when nothing usable is left, in which case the caller keeps its LIKE alone and
// accepts the scan rather than silently matching nothing.
function columnFtsQuery(columns: string, value: string | null, prefixLast: boolean) {
  const raw = value?.trim().toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  // Single-character tokens are dropped: a bare "a" prefix-matches almost everything, which is both
  // useless and pathologically slow. The exception is a value that IS one character -- there is no
  // longer token to fall back on, and one prefix term still narrows far below a whole-table scan.
  const tokens = (raw.length === 1 && raw[0].length === 1 ? raw : raw.filter((token) => token.length >= 2))
    .slice(0, 8);
  if (!tokens.length) return null;
  const phrases = tokens.map((token, index) =>
    prefixLast && index === tokens.length - 1 ? `"${token}"*` : `"${token}"`);
  return `${columns}:(${phrases.join(" AND ")})`;
}

// Company names are matched across BOTH indexed company columns -- the display name when a provider
// supplied one, the identifier when it did not. The final token is a prefix match so a partial name
// still narrows correctly (a hand-typed ?company=revolut has to keep reaching Revolut), and the
// LIKE that follows removes anything the widening let through.
function companyFtsQuery(value: string | null) {
  return columnFtsQuery("{company_identifier company_name}", value, true);
}

// Not prefix-matched: the title filter is an exact phrase the user picked from a list, not something
// they are still typing.
function titleFtsQuery(value: string | null) {
  return columnFtsQuery("title", value, false);
}

// Prefix-matched, because unlike title and company this value is not always picked from a list -- a
// click on a row's location supplies the whole string, but a hand-typed ?location=berl has to keep
// reaching Berlin.
function locationFtsQuery(value: string | null) {
  return columnFtsQuery("location", value, true);
}

function addLikeFilter(conditions: string[], bindings: unknown[], column: string, value: string | null) {
  const normalized = value?.trim().toLowerCase().slice(0, 48);
  if (!normalized) return;
  // ESCAPE, which the two suggestion queries have always had and this one never did. Without it the
  // caller's value is not matched, it is EXECUTED: ?location=%25 returned all 1,240,216 active rows
  // and ?location=_aris was byte-for-byte the same response as ?location=paris. It also made
  // ?title=%25 the most expensive statement the API can be asked for -- a full scan plus an
  // unbounded count over the whole table -- from a URL anyone can type.
  const escaped = normalized.replace(/[\\%_]/g, (character) => `\\${character}`);
  conditions.push(`${column} LIKE ? ESCAPE '\\'`);
  bindings.push(`%${escaped}%`);
}

function addSetFilter(
  conditions: string[],
  bindings: unknown[],
  budget: { left: number },
  column: string,
  value: string | null,
  normalize: (value: string) => string = (input) => input,
) {
  const values = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, Math.min(12, budget.left))
    .map(normalize);
  if (!values.length) return;
  conditions.push(`${column} IN (${values.map(() => "?").join(", ")})`);
  bindings.push(...values);
  budget.left -= values.length;
}

// Build the FTS5 MATCH expression: each meaningful token becomes a quoted prefix term, AND-ed so
// every word must appear. Tokens are split on the same boundaries the unicode61 tokenizer uses --
// runs of letters/digits only -- so a query term always corresponds to a real indexed term. Matching
// the index this way is what stops "c++" from collapsing to the term "c" and prefix-matching every
// posting that starts with c; "front-end" likewise becomes front AND end, both of which exist.
// Single-character tokens are dropped: a bare "a" prefix-matches almost everything, which is useless
// and pathologically slow, so a query of only a lone letter yields null (no text filter, plain browse).
// The three bindings SEARCH_EXACTNESS compares against: the query normalized the same way the SQL
// normalizes the title, then its prefix and contains patterns. Returns null when there is nothing
// worth comparing, so the caller can leave the bonus out of the score entirely.
export function exactnessPatterns(value: string | null) {
  const phrase = (value ?? "")
    .toLowerCase()
    .replace(/[-/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (phrase.length < 2) return null;
  const escaped = phrase.replace(/[\\%_]/g, (character) => `\\${character}`);
  return [phrase, `${escaped}%`, `%${escaped}%`];
}

export function ftsQuery(value: string | null) {
  const tokens = value?.trim().toLowerCase().match(/[\p{L}\p{N}]+/gu)
    ?.filter((token) => token.length >= 2)
    .slice(0, 8) ?? [];
  if (!tokens.length) return null;
  return tokens.map((token) => `"${token}"*`).join(" AND ");
}

// Tech terms whose punctuation the FTS tokenizer strips, collapsing them to a bare letter the query
// then drops (so "c++"/"c#" would otherwise match nothing meaningful). When one appears alongside a
// normal search word, it is applied as a substring filter on top of the FTS match -- fast because
// the FTS term has already narrowed the set, and exact because "%c++%" hits the real title text.
const SPECIAL_TERMS = ["c++", "c#", "f#", "c/c++", "objective-c", ".net"];

export function specialSearchTerms(value: string | null) {
  const lower = (value ?? "").toLowerCase();
  return SPECIAL_TERMS.filter((term) => lower.includes(term));
}

// Every string within edit distance 1 of a word (insertions, deletions, substitutions,
// transpositions), plus the word itself. ~50*len candidates; used only to spell-correct near-empty
// searches, so the fan-out is off the hot path.
export function editDistance1(word: string): string[] {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const set = new Set<string>([word]);
  for (let i = 0; i <= word.length; i += 1) {
    for (const ch of alphabet) set.add(word.slice(0, i) + ch + word.slice(i));
  }
  for (let i = 0; i < word.length; i += 1) {
    set.add(word.slice(0, i) + word.slice(i + 1));
    for (const ch of alphabet) set.add(word.slice(0, i) + ch + word.slice(i + 1));
    if (i < word.length - 1) set.add(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2));
  }
  return [...set];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Spell-correct a query against the FTS term dictionary (jobs_vocab). For each word, the most common
// indexed term within edit distance 1 replaces it -- but only when that term is dramatically more
// common than the word as typed, so real (if rare) terms are left alone. Returns the rewritten query
// or null when nothing warranted correction.
async function correctQuery(
  db: ReturnType<typeof getD1>,
  search: string | null,
): Promise<string | null> {
  // The upper bound is load-bearing: editDistance1 fans out ~52 candidates per character, and a
  // token with no cap made an unauthenticated `?search=` the most expensive request the worker
  // served -- ~0.56 sequential D1 statements per character (measured: 447 statements for an
  // 800-char garbage query, which always lands here because garbage matches nothing). No real
  // vocabulary term is longer than 24 characters; anything longer is not a typo to correct.
  const tokens = (search ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu)
    ?.filter((token) => token.length >= 3 && token.length <= 24).slice(0, 4) ?? [];
  if (!tokens.length) return null;

  let corrected = search ?? "";
  let changed = false;
  for (const token of tokens) {
    const candidates = editDistance1(token);
    const docByTerm = new Map<string, number>();
    // D1 caps a query at 100 bound parameters, so the candidate set is probed in chunks.
    for (let index = 0; index < candidates.length; index += 90) {
      const group = candidates.slice(index, index + 90);
      const rows = await db.prepare(
        `SELECT term, doc FROM jobs_vocab WHERE term IN (${group.map(() => "?").join(",")})`,
      ).bind(...group).all();
      for (const row of (rows.results ?? []) as { term: string; doc: number }[]) {
        docByTerm.set(String(row.term), Number(row.doc));
      }
    }
    const ownDoc = docByTerm.get(token) ?? 0;
    let best = token;
    let bestDoc = ownDoc;
    for (const [term, doc] of docByTerm) {
      if (doc > bestDoc) { best = term; bestDoc = doc; }
    }
    if (best !== token && bestDoc >= Math.max(ownDoc * 8, 40)) {
      corrected = corrected.replace(new RegExp(`\\b${escapeRegExp(token)}\\b`, "gi"), best);
      changed = true;
    }
  }
  return changed ? corrected : null;
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
    // Integer, not merely finite: the offset is bound into `LIMIT ? OFFSET ?`, and SQLite answers
    // a REAL there with "datatype mismatch" -- so a crafted {"offset":0.5} cursor was a one-request
    // 500. Negative and huge values were already clamped; the fraction was the only value that
    // slipped through to the statement.
    if (Number.isInteger(cursor.offset)) return { offset: cursor.offset };
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
    // Our own origin, so the response carries cache-control the browser can use. The ATS hosts send
    // none -- a Workday logo has no cache-control, no etag and no last-modified -- so every scroll
    // back into a virtualized row and every re-open of the Company dropdown re-downloaded it.
    // The company rides along for aggregator boards: one Getro board is many companies, and a
    // board-only key made every row on it draw whichever single logo LIMIT 1 happened to pick.
    companyLogoUrl: job.hasLogo ? logoProxyUrl(job.boardKey, company) : null,
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

// One place that knows the shape of the proxy path, shared by the jobs rows and the Company
// dropdown so the two can never drift into requesting different URLs for the same logo. The
// optional company narrows the lookup within a board -- required for correctness on aggregator
// boards (Getro), where one board key spans many companies' logos.
export function logoProxyUrl(boardKey: string, company?: string | null) {
  const base = `/api/logo?b=${encodeURIComponent(boardKey)}`;
  return company ? `${base}&c=${encodeURIComponent(company)}` : base;
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
