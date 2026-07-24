"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Input, TextField } from "@heroui/react";
import { TableVirtuoso, type TableComponents } from "react-virtuoso";
import {
  sourceOptions,
  workplaceOptions,
  type Job,
} from "./jobs";
import { countryFlag, countryName, COUNTRY_OPTIONS } from "./countries";
import { INDUSTRY_OPTIONS } from "./taxonomies";
import { AtsMark } from "./ats-marks";

// In local dev the Miniflare D1 binding is empty, so the server render falls back to the bundled
// sample rows and the client reads the real index from the local SQLite API instead (npm run serve).
const apiUrl = typeof window !== "undefined" && window.location.hostname === "localhost"
  ? "http://localhost:3002/api/jobs"
  : "/api/jobs";
const titlesUrl = typeof window !== "undefined" && window.location.hostname === "localhost"
  ? "http://localhost:3002/api/titles"
  : "/api/titles";
const pageSize = 100;
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

// A short "3h ago" / "20m ago" label for freshly posted roles; null once a posting is a week old, so
// the caller falls back to the absolute date. Only used for real publish timestamps — synthesised
// fallback dates keep the calendar date.
function relativePosted(date: Date, now: number): string | null {
  const diffMs = now - date.getTime();
  if (diffMs < 0) return null; // clock skew / future date -> show the date instead
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return null;
}

// A capped count (a broad text search) reads as "5,000+"; an exact count reads plainly.
function formatTotal(total: number, capped: boolean): string {
  return capped ? `${total.toLocaleString()}+` : total.toLocaleString();
}

const employmentOptions = ["Full time", "Part time", "Contract", "Internship", "Temporary"];
const postedWithinOptions = [
  { label: "Any time", value: "" },
  { label: "Last 24 hours", value: "1" },
  { label: "Last 7 days", value: "7" },
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" },
];
// `code` carries the ISO country so the checklists can render an SVG flag; the emoji is gone from
// the label (it lives in the <Flag> glyph now).
const countryOptions = COUNTRY_OPTIONS.map((entry) => ({
  label: entry.name,
  value: entry.code,
  code: entry.code,
}));

// A crisp SVG national flag from flagcdn (a free, public-domain flag CDN) keyed by ISO alpha-2 code,
// replacing the emoji flags that don't render on every platform. A subtle 1px outline gives the same
// edge definition as the company logos; if the image can't load it falls back to the emoji flag.
function Flag({ code }: { code?: string | null }) {
  const cc = (code ?? "").trim().toLowerCase();
  const [failed, setFailed] = useState(false);
  if (cc.length !== 2) return null;
  if (failed) {
    return <span aria-hidden="true" className="text-[13px] leading-none">{countryFlag(cc) ?? ""}</span>;
  }
  return (
    // Remote flag asset, like the ATS company logos, so it can't use a fixed Next image host.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://flagcdn.com/${cc}.svg`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="inline-block h-[13px] w-[18px] shrink-0 rounded-[3px] object-cover align-[-2px] outline outline-1 -outline-offset-1 outline-black/10"
    />
  );
}

// Every filter lives in one object so URL sync, reset, and the active-chip row all read from a
// single source rather than five parallel useStates that could drift apart.
type Filters = {
  search: string;
  title: string;
  location: string;
  company: string;
  country: string;
  // Multi-select facets (comma-joined into the query, which already treats city/industry as sets).
  city: string[];
  roleFamily: string;
  industry: string[];
  workplace: string[];
  source: string[];
  employmentType: string[];
  postedWithin: string;
  sort: string;
  // Show only jobs at companies on the local watchlist. The actual company list is stored in
  // localStorage (device-local), so only this on/off intent lives in the filter state and URL.
  watchlistOnly: boolean;
};

const emptyFilters: Filters = {
  search: "",
  title: "",
  location: "",
  company: "",
  country: "",
  city: [],
  roleFamily: "",
  industry: [],
  workplace: [],
  source: [],
  employmentType: [],
  postedWithin: "",
  sort: "newest",
  watchlistOnly: false,
};

function filtersFromSearchParams(query: string): Filters {
  const params = new URLSearchParams(query);
  const list = (key: string) => (params.get(key) ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  return {
    search: params.get("search") ?? "",
    title: params.get("title") ?? "",
    location: params.get("location") ?? "",
    company: params.get("company") ?? "",
    country: params.get("country") ?? "",
    city: list("city"),
    roleFamily: params.get("roleFamily") ?? "",
    industry: list("industry"),
    workplace: list("workplace"),
    source: list("provider"),
    employmentType: list("employmentType"),
    postedWithin: params.get("postedWithin") ?? "",
    sort: params.get("sort") ?? "newest",
    watchlistOnly: params.get("watchlist") === "1",
  };
}

function filtersToSearchParams(filters: Filters) {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.title.trim()) params.set("title", filters.title.trim());
  if (filters.location.trim()) params.set("location", filters.location.trim());
  if (filters.company.trim()) params.set("company", filters.company.trim());
  if (filters.country) params.set("country", filters.country);
  if (filters.city.length) params.set("city", filters.city.join(","));
  if (filters.roleFamily) params.set("roleFamily", filters.roleFamily);
  if (filters.industry.length) params.set("industry", filters.industry.join(","));
  if (filters.workplace.length) params.set("workplace", filters.workplace.join(","));
  if (filters.source.length) params.set("provider", filters.source.join(","));
  if (filters.employmentType.length) params.set("employmentType", filters.employmentType.join(","));
  if (filters.postedWithin) params.set("postedWithin", filters.postedWithin);
  if (filters.sort !== "newest") params.set("sort", filters.sort);
  if (filters.watchlistOnly) params.set("watchlist", "1");
  return params;
}

// One selected-filter chip. `label` is the display-ready string; `value` (when set) is the bare
// value without its "Location:"-style prefix, which the dashed "[icon] is [value]" chip renders
// after the word "is"; `kind` picks the category icon and the value glyph.
type ChipKind =
  | "search" | "location" | "title" | "company" | "country" | "city" | "roleFamily"
  | "industry" | "workplace" | "source" | "employmentType" | "watchlist";
type ActiveChip = { kind: ChipKind; label: string; value?: string; code?: string; clear: () => void };

const WATCHLIST_KEY = "startups-board:watchlist";
const SAVED_VIEWS_KEY = "startups-board:saved-views";

type SavedView = { name: string; query: string };

function readStored<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function JobsExplorer({
  initialJobs = [],
  initialTotal = 0,
  initialCursor = null,
  hasServerData = false,
  initialQuery = "",
  initialTotalCapped = false,
  initialCorrectedTo = null,
}: {
  initialJobs?: Job[];
  initialTotal?: number;
  initialCursor?: string | null;
  hasServerData?: boolean;
  initialQuery?: string;
  // Whether initialTotal is a capped "N+" figure (a broad search) rather than an exact count.
  initialTotalCapped?: boolean;
  // The term the server-rendered first page was spell-corrected to, if any.
  initialCorrectedTo?: string | null;
}) {
  // Seeded from the server-supplied query string rather than window.location, so the server and
  // client render identical markup. Reading window here caused a hydration mismatch whenever the
  // page was opened with filters already in the URL.
  const [filters, setFilters] = useState<Filters>(() => filtersFromSearchParams(initialQuery));
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [total, setTotal] = useState(initialTotal);
  const [totalCapped, setTotalCapped] = useState(initialTotalCapped);
  // Set when a typo'd search was auto-corrected, so the UI can note the term it actually searched.
  const [correctedTo, setCorrectedTo] = useState<string | null>(initialCorrectedTo);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [isLoading, setIsLoading] = useState(false);
  const [isPaging, setIsPaging] = useState(false);
  // A failed fetch used to only reach the console: the table kept whatever it had and the user was
  // given no reason and no way to retry. `error` drives a visible state, and bumping `retryToken`
  // re-runs the fetch effect without touching the filters.
  const [error, setError] = useState<string | null>(null);
  const [pagingError, setPagingError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  // Captured once after mount (0 during SSR/first paint) so relative "3h ago" labels are computed on
  // the client only -- keeping the server and client markup identical, then swapping in on hydrate.
  const [now, setNow] = useState(0);
  // Watchlist (company names) and saved views (named filter query strings) are device-local, so they
  // live in localStorage rather than the URL or the server. Seeded empty so the server and the first
  // client render match, then hydrated from storage in an effect below.
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const storageHydrated = useRef(false);
  // The server already rendered page one for the current URL, so the first filter effect must not
  // immediately refetch the identical query. When the server could not reach D1 (local dev) the
  // first fetch must still run, otherwise the page would sit on the sample rows forever.
  const skipNextFetch = useRef(hasServerData);
  // In-memory cache of the first page keyed by the fetch query, so returning to a filter combination
  // already viewed this session paints instantly instead of flashing an empty/loading table while a
  // fresh request is in flight. It still revalidates in the background, so nothing goes stale.
  const resultCache = useRef(new Map<string, { jobs: Job[]; total: number; totalCapped: boolean; cursor: string | null }>());
  // The filter query a response must still match to be applied, so an in-flight page that a filter
  // change has superseded is discarded rather than merged into the new result set.
  const queryRef = useRef("");

  const watchlistSet = useMemo(() => new Set(watchlist), [watchlist]);

  // The URL carries the on/off intent (watchlist=1); the fetch expands it into the actual company
  // list so "only jobs from the list" is complete across pagination, not just the current page.
  // Only actually filter by the watchlist when it has entries; an empty list would send no companies
  // and silently show everything, so the toggle stays inert until the first company is starred.
  const watchlistActive = filters.watchlistOnly && watchlist.length > 0;
  const urlQuery = useMemo(() => filtersToSearchParams(filters).toString(), [filters]);
  const queryString = useMemo(() => {
    const params = filtersToSearchParams(filters);
    if (filters.watchlistOnly && watchlist.length > 0) {
      params.delete("watchlist");
      // 60 matches the query's own cap; sending 100 meant the last 40 starred companies were
      // dropped server-side with nothing telling the user their watchlist was incomplete.
      params.set("companies", watchlist.slice(0, 60).join("\n"));
    } else {
      params.delete("watchlist");
    }
    return params.toString();
  }, [filters, watchlist]);

  function update(patch: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...patch }));
  }

  const toggleWatch = useCallback((company: string) => {
    setWatchlist((current) =>
      current.includes(company) ? current.filter((name) => name !== company) : [...current, company]);
  }, []);

  const saveView = useCallback((name: string) => {
    const trimmed = name.trim().slice(0, 40);
    if (!trimmed) return;
    const query = filtersToSearchParams(filters).toString();
    setSavedViews((current) => [...current.filter((view) => view.name !== trimmed), { name: trimmed, query }]);
  }, [filters]);

  function toggle(key: "workplace" | "source" | "employmentType" | "industry" | "city", value: string) {
    setFilters((current) => {
      const values = current[key];
      return {
        ...current,
        [key]: values.includes(value) ? values.filter((v) => v !== value) : [...values, value],
      };
    });
  }

  // Hydrate the device-local watchlist and saved views from storage once, after the first render so
  // it cannot cause a server/client markup mismatch. The setState is the whole point of this mount
  // effect, so the cascading-render lint rule does not apply.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWatchlist(readStored<string[]>(WATCHLIST_KEY, []));
    setSavedViews(readStored<SavedView[]>(SAVED_VIEWS_KEY, []));
    setNow(Date.now());
    storageHydrated.current = true;
  }, []);

  useEffect(() => {
    if (storageHydrated.current) window.localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist));
  }, [watchlist]);
  useEffect(() => {
    if (storageHydrated.current) window.localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(savedViews));
  }, [savedViews]);

  // Refetch page one whenever the filters change, and mirror them into the URL so a filtered view
  // is shareable and survives reload.
  useEffect(() => {
    const nextUrl = `${window.location.pathname}${urlQuery ? `?${urlQuery}` : ""}`;
    window.history.replaceState(null, "", nextUrl);
    queryRef.current = queryString;
    // A paging failure belongs to the result set it happened in. Left uncleared it was sticky for
    // the rest of the session: the footer kept reading "Couldn't load more jobs" over a perfectly
    // healthy new search, and automatic paging never resumed.
    setPagingError(false);

    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      // Seed the cache with the server-rendered first page so returning to the initial view is instant.
      resultCache.current.set(queryString, { jobs: initialJobs, total: initialTotal, totalCapped: initialTotalCapped, cursor: initialCursor });
      return;
    }

    // Paint a previously-fetched page immediately, with no loading indicator; the request below still
    // runs to refresh it.
    const cached = resultCache.current.get(queryString);
    if (cached) {
      setJobs(cached.jobs);
      setTotal(cached.total);
      setTotalCapped(cached.totalCapped);
      setCorrectedTo(null); // re-established by the refresh fetch below
      setCursor(cached.cursor);
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      if (!cached) setIsLoading(true);
      try {
        const params = new URLSearchParams(queryString);
        params.set("limit", String(pageSize));
        const response = await fetch(`${apiUrl}?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Jobs API returned ${response.status}`);
        const payload = (await response.json()) as { jobs: Job[]; total: number; totalCapped?: boolean; correctedTo?: string; nextCursor: string | null };
        // Bounded LRU: re-inserting moves the key to the newest slot; the oldest is dropped past the cap.
        const cache = resultCache.current;
        cache.delete(queryString);
        cache.set(queryString, { jobs: payload.jobs, total: payload.total, totalCapped: payload.totalCapped ?? false, cursor: payload.nextCursor });
        if (cache.size > 40) cache.delete(cache.keys().next().value as string);
        setJobs(payload.jobs);
        setTotal(payload.total);
        setTotalCapped(payload.totalCapped ?? false);
        setCorrectedTo(payload.correctedTo ?? null);
        setCursor(payload.nextCursor);
        setError(null);
      } catch (caught) {
        // An abort is this effect superseding itself, not a failure -- leave the state alone so the
        // newer request owns it.
        if ((caught as Error).name === "AbortError") return;
        console.error("Jobs fetch failed", caught);
        setError((caught as Error).message || "Could not load jobs");
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // initial* are the server-rendered first page, used only to seed the cache once; they are stable.
    // retryToken is not read in the body: it exists purely so "Try again" can re-run this effect.
  }, [queryString, urlQuery, retryToken, initialJobs, initialTotal, initialTotalCapped, initialCursor]);

  // Infinite scroll used to treat a failed page as the end of the list -- it cleared the cursor, so
  // the results simply stopped with no indication anything had gone wrong. Now the cursor is kept
  // and the footer offers a retry.
  //
  // `pagingError` is deliberately NOT in the guard below: it gates the automatic endReached call
  // instead. Guarding here would have made the Retry button a no-op, since the loadMore it calls is
  // the closure from the render where pagingError was still true.
  const loadMore = useCallback(async () => {
    if (!cursor || isPaging) return;
    setIsPaging(true);
    setPagingError(false);
    // A page belongs to the filters that were live when it was requested. Without this check, typing
    // in the search box while a page-2 request is in flight appends the old filter's rows under the
    // new results and installs a cursor into the wrong result set.
    const requestedFor = queryString;
    try {
      const params = new URLSearchParams(queryString);
      params.set("limit", String(pageSize));
      params.set("cursor", cursor);
      const response = await fetch(`${apiUrl}?${params}`);
      if (!response.ok) throw new Error(`Jobs API returned ${response.status}`);
      const payload = (await response.json()) as { jobs: Job[]; nextCursor: string | null };
      if (requestedFor !== queryRef.current) return;
      setJobs((current) => {
        const seen = new Set(current.map((job) => job.id));
        return [...current, ...payload.jobs.filter((job) => !seen.has(job.id))];
      });
      setCursor(payload.nextCursor);
    } catch (caught) {
      console.error("Loading more jobs failed", caught);
      if (requestedFor === queryRef.current) setPagingError(true);
    } finally {
      setIsPaging(false);
    }
  }, [cursor, isPaging, queryString]);

  const activeChips = useMemo(() => {
    const chips: ActiveChip[] = [];
    if (filters.search.trim()) chips.push({ kind: "search", label: `“${filters.search.trim()}”`, clear: () => update({ search: "" }) });
    if (filters.location.trim()) chips.push({ kind: "location", label: `Location: ${filters.location.trim()}`, value: filters.location.trim(), clear: () => update({ location: "" }) });
    if (filters.title.trim()) chips.push({ kind: "title", label: `Role: ${filters.title.trim()}`, value: filters.title.trim(), clear: () => update({ title: "" }) });
    if (filters.company.trim()) chips.push({ kind: "company", label: `Company: ${filters.company.trim()}`, value: filters.company.trim(), clear: () => update({ company: "" }) });
    if (filters.country) {
      // The flag rides along as an ISO code so the chip renders the same SVG glyph as the dropdown,
      // rather than an emoji that only some platforms draw.
      const anywhere = filters.country === "anywhere";
      chips.push({
        kind: "country",
        label: anywhere ? "🌍 Anywhere" : countryName(filters.country) ?? filters.country,
        code: anywhere ? undefined : filters.country,
        clear: () => update({ country: "" }),
      });
    }
    for (const value of filters.city) chips.push({ kind: "city", label: value, clear: () => toggle("city", value) });
    if (filters.roleFamily) chips.push({ kind: "roleFamily", label: filters.roleFamily, clear: () => update({ roleFamily: "" }) });
    for (const value of filters.industry) chips.push({ kind: "industry", label: value, clear: () => toggle("industry", value) });
    for (const value of filters.workplace) chips.push({ kind: "workplace", label: value, clear: () => toggle("workplace", value) });
    for (const value of filters.source) chips.push({ kind: "source", label: value, clear: () => toggle("source", value) });
    for (const value of filters.employmentType) chips.push({ kind: "employmentType", label: value, clear: () => toggle("employmentType", value) });
    // postedWithin deliberately gets no chip: the date pill already displays its own selection
    // ("Last 7 days"), so a chip would double it. "Any time" in the same dropdown clears it.
    if (watchlistActive) chips.push({ kind: "watchlist", label: "★ Watchlist", clear: () => update({ watchlistOnly: false }) });
    return chips;
  }, [filters, watchlistActive]);

  // A small "Showing results for X" note when a typo'd search was auto-corrected.
  const correctionNote = correctedTo ? (
    <p className="mb-2 px-1 text-[13px] text-[var(--muted-strong)]">
      Showing results for <span className="font-semibold text-[var(--ink)]">{correctedTo}</span>
    </p>
  ) : null;

  // Three states share the table's slot, in precedence order: rows if we have any (even stale ones
  // during a refetch), then the skeleton while the first page is in flight, then the failure or
  // empty panel. Showing rows over a pending refetch is deliberate -- swapping to a skeleton on
  // every keystroke would make a working search flicker.
  const jobsTable = (
    <>
    {correctionNote}
    {error && jobs.length > 0 && (
      <div role="status" className="mb-2 flex flex-wrap items-center gap-2 rounded-xl bg-[#FFF4F4] px-3 py-2 text-[13px] text-[#8A1F1F]">
        <span>These results may be out of date &mdash; the last refresh failed.</span>
        <button
          type="button"
          onClick={() => setRetryToken((token) => token + 1)}
          className="rounded font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
        >
          Try again
        </button>
      </div>
    )}
    {jobs.length === 0 && isLoading ? (
      <JobsSkeleton />
    ) : jobs.length === 0 && error ? (
      <div role="alert" className="rounded-2xl bg-white px-6 py-16 text-center shadow-[var(--shadow-table)]">
        <p className="text-base font-semibold">Couldn&rsquo;t load jobs</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-[var(--muted)]">
          The job index didn&rsquo;t respond. Your filters are still set &mdash; retrying will run the same search.
        </p>
        <div className="mt-5 flex justify-center">
          <PillButton onClick={() => setRetryToken((token) => token + 1)}>Try again</PillButton>
        </div>
      </div>
    ) : jobs.length > 0 ? (
    <div className="overflow-hidden rounded-2xl shadow-[var(--shadow-table)]">
      <TableVirtuoso
        aria-label="Startup jobs from public ATS pages"
        className="jobs-table-scroll bg-white"
        style={{ height: "clamp(420px, 68vh, 760px)" }}
        data={jobs}
        components={virtuosoComponents}
        computeItemKey={(_index, job) => job.id}
        fixedHeaderContent={TableHeader}
        itemContent={(_index, job) => (
          <JobCells
            job={job}
            onFilter={update}
            isWatched={watchlistSet.has(job.company)}
            onToggleWatch={toggleWatch}
            now={now}
          />
        )}
        fixedItemHeight={72}
        // Without this the virtualizer renders nothing until it has mounted and measured, so the
        // 100 rows the server already queried and shipped in the payload were invisible until
        // hydration -- and invisible to crawlers and no-JS visitors entirely. This paints the first
        // screenful during SSR; the virtualizer takes over from there.
        initialItemCount={Math.min(jobs.length, 12)}
        increaseViewportBy={{ top: 240, bottom: 480 }}
        // Automatic paging stops after a failure so a scroll at the bottom cannot spin on a broken
        // endpoint; the footer's Retry calls loadMore directly.
        endReached={() => {
          if (!pagingError) void loadMore();
        }}
      />
    </div>
  ) : (
    <div className="rounded-2xl bg-white px-6 py-16 text-center shadow-[var(--shadow-table)]">
      <p className="text-base font-semibold">No matching jobs</p>
      <p className="mt-1 text-sm text-[var(--muted)]">Try a broader search or clear a filter.</p>
      <div className="mt-5 flex justify-center">
        <PillButton onClick={() => setFilters(emptyFilters)}>Clear filters</PillButton>
      </div>
    </div>
    )}
    </>
  );

  const resultsFooter = pagingError ? (
    <p className="mt-4 flex flex-wrap items-center justify-center gap-2 text-center text-[13px] text-[var(--muted)]">
      <span>Couldn&rsquo;t load more jobs.</span>
      <button
        type="button"
        onClick={() => {
          setPagingError(false);
          void loadMore();
        }}
        className="rounded font-semibold text-[var(--accent-strong)] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
      >
        Retry
      </button>
    </p>
  ) : (
    <p className="mt-4 text-center text-[13px] tabular-nums text-[var(--muted)]">
      Showing {jobs.length.toLocaleString()} of {formatTotal(total, totalCapped)}
      {/* Gate on the cursor, not jobs.length < total: a capped search shows "N+" but stops paging
          at the relevance cap, so there is nothing more to scroll to even though jobs.length < total. */}
      {isPaging ? " · Loading…" : cursor ? " · Scroll for more" : ""}
    </p>
  );

  return (
    <main className="min-h-screen bg-[var(--canvas)] text-[var(--ink)]">
      <section className="mx-auto w-full max-w-[1240px] px-5 pb-24 pt-10 sm:px-8 sm:pt-14">
        <div className="mb-10 text-center">
          <span
            className="mx-auto mb-8 block h-[42px] w-24 rounded-xl"
            style={{ background: "var(--chip)" }}
            aria-hidden="true"
          />
          <h1
            className="mx-auto text-[clamp(38px,6vw,58px)] leading-[1.02] tracking-[-0.01em] text-balance"
            style={{ fontFamily: "var(--font-pixel), var(--font-inter), sans-serif", fontWeight: 500 }}
          >
            Join a high-growth startup
          </h1>
          <p className="mx-auto mt-[18px] max-w-[620px] text-[16px] leading-relaxed text-[var(--muted)]">
            Find{" "}
            <span className="font-semibold tabular-nums text-[var(--accent-strong)]">{formatTotal(total, totalCapped)}</span>{" "}
            open roles at today&rsquo;s top startups. Updated daily.
          </p>
        </div>

        {/* No panel chrome behind the filter row — the pills carry their own hairline shadow. */}
        <div>
          <FilterDropdownBar filters={filters} update={update} toggle={toggle} />

          {/* Selected filters as dashed "[icon] is [value]" chips, with Save view and Clear all
              pushed to the end of the same row. */}
          {activeChips.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {activeChips.map((chip) => <FilterChip key={`${chip.kind}:${chip.label}`} chip={chip} />)}
              <span className="ms-auto flex items-center gap-2">
                <SaveViewPill onSaveView={saveView} canSaveView />
                <PillButton onClick={() => setFilters(emptyFilters)}>Clear all</PillButton>
              </span>
            </div>
          )}
        </div>

        <div className="mb-3 mt-7 flex items-center justify-between gap-4 px-1">
          <p aria-live="polite" className="text-sm font-medium text-[var(--muted-strong)]">
            <span className="tabular-nums text-[var(--ink)]">{formatTotal(total, totalCapped)}</span>{" "}
            {total === 1 ? "job" : "jobs"}
            {isLoading && <span className="ms-2 font-normal">Updating…</span>}
          </p>
        </div>

        {jobsTable}

        {resultsFooter}
      </section>
    </main>
  );
}

// Small line icons for the compact filter bar (16px, currentColor stroke), matching the design's
// monochrome glyphs without pulling in an icon dependency.
function LineIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-4 shrink-0 text-[var(--muted)]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}
const IconSearch = () => <LineIcon><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></LineIcon>;
const IconLocate = () => <LineIcon><circle cx="8" cy="8" r="4" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" /><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" /></LineIcon>;
const IconPin = () => <LineIcon><path d="M8 14s4.5-4 4.5-7A4.5 4.5 0 0 0 3.5 7c0 3 4.5 7 4.5 7Z" /><circle cx="8" cy="6.8" r="1.6" /></LineIcon>;
const IconPlus = () => <LineIcon><path d="M8 3.5v9M3.5 8h9" /></LineIcon>;
const IconCalendar = () => <LineIcon><rect x="2.5" y="3.5" width="11" height="10" rx="2" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></LineIcon>;
const IconUpDown = () => <LineIcon><path d="M5.5 6.5 8 4l2.5 2.5M5.5 9.5 8 12l2.5-2.5" /></LineIcon>;
const IconUser = () => <LineIcon><circle cx="8" cy="5.3" r="2.4" /><path d="M3.5 13.5c0-2.4 2-3.9 4.5-3.9s4.5 1.5 4.5 3.9" /></LineIcon>;
const IconIndustry = () => <LineIcon><path d="M2 13.5V8l3 1.6V8l3 1.6V5.5l3.5 2v6z" /><path d="M2 13.5h11.5" /></LineIcon>;
const IconWorkplace = () => <LineIcon><rect x="3" y="2.5" width="6" height="11" rx="1" /><path d="M5.2 5h1.6M5.2 7.3h1.6M5.2 9.6h1.6" /><path d="M9 6.5h3.5v7H9" /><path d="M10.7 9h.01M10.7 11h.01" /></LineIcon>;
const IconJobType = () => <LineIcon><circle cx="6" cy="5" r="2.2" /><path d="M2.5 12.6c0-2 1.6-3.4 3.5-3.4c.6 0 1.2.1 1.7.4" /><circle cx="11" cy="10.5" r="3" /><path d="M11 9.3v1.3l1 .6" /></LineIcon>;
const IconAts = () => <LineIcon><path d="M4.5 2.5h4l3 3v8h-7z" /><path d="M8.5 2.5v3h3" /><circle cx="8" cy="9.5" r="1.6" /></LineIcon>;
const IconGlobe = () => <LineIcon><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5S9.6 11.9 8 13.5C6.4 11.9 5.6 10.1 5.6 8S6.4 4.1 8 2.5Z" /></LineIcon>;

function FilterCheckbox({ checked }: { checked: boolean }) {
  return checked ? (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-[var(--ink)]">
      <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 5" /></svg>
    </span>
  ) : (
    <span className="size-5 shrink-0 rounded-md border-[1.5px] border-[var(--border)]" />
  );
}

// "city" has no dropdown of its own — it is set by clicking a location in the table and cleared from
// its chip — so it carries no option list here.
type FilterCategoryKey = "industry" | "city" | "workplace" | "employmentType" | "source";

const FILTER_CATEGORIES: {
  key: Exclude<FilterCategoryKey, "city">;
  options: readonly { label: string; value: string }[];
}[] = [
  { key: "industry", options: INDUSTRY_OPTIONS.map((name) => ({ label: name, value: name })) },
  { key: "workplace", options: workplaceOptions.map((name) => ({ label: name, value: name })) },
  { key: "employmentType", options: employmentOptions.map((name) => ({ label: name, value: name })) },
  { key: "source", options: sourceOptions.map((name) => ({ label: name, value: name })) },
];

// A search box over a static option list, with each match a checkbox row (multi-select).
function SearchCheckList({
  options,
  selected,
  onToggle,
  searchLabel = "Search options",
}: {
  options: readonly { label: string; value: string; code?: string }[];
  selected: string[];
  onToggle: (value: string) => void;
  searchLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const term = query.trim().toLowerCase();
  const matches = term ? options.filter((option) => option.label.toLowerCase().includes(term)) : options;
  // The city/industry lists run to hundreds of entries; cap the rendered rows so a section stays
  // light, and surface selected-but-unmatched values first so they never hide off the end.
  const selectedSet = new Set(selected);
  const ordered = [
    ...matches.filter((option) => selectedSet.has(option.value)),
    ...matches.filter((option) => !selectedSet.has(option.value)),
  ];
  const shown = ordered.slice(0, 50);

  return (
    <div>
      <SearchBox full value={query} onChange={setQuery} label={searchLabel} />
      <div className="mt-1 max-h-64 overflow-auto">
        {shown.map((option) => {
          const checked = selectedSet.has(option.value);
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onToggle(option.value)}
              aria-pressed={checked}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-start hover:bg-[var(--control-hover)]"
            >
              <span className="flex min-w-0 items-center gap-2 text-sm text-[var(--ink)]">
                <Flag code={option.code} />
                <span className="min-w-0 truncate">{option.label}</span>
              </span>
              <FilterCheckbox checked={checked} />
            </button>
          );
        })}
        {shown.length === 0 && (
          <p className="px-2 py-3 text-[13px] text-[var(--muted)]">No matches</p>
        )}
        {ordered.length > shown.length && (
          <p className="px-2 pt-1 text-[12px] text-[var(--muted)]">Keep typing to narrow {ordered.length - shown.length} more…</p>
        )}
      </div>
    </div>
  );
}

// Title picker: a search box that lists matching real job titles as checkbox rows. Title is a single
// value, so picking one replaces it and picking the selected one clears it.
function TitleCheckList({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [query, setQuery] = useState(value);
  const [suggestions, setSuggestions] = useState<{ title: string; jobCount: number }[]>([]);

  useEffect(() => {
    const term = query.trim();
    const controller = new AbortController();
    // An empty query fetches the most common titles, so the dropdown opens on a starting list.
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`${titlesUrl}?q=${encodeURIComponent(term)}&limit=25`, { signal: controller.signal });
        if (!response.ok) return;
        const payload = (await response.json()) as { titles: { title: string; jobCount: number }[] };
        setSuggestions(payload.titles ?? []);
      } catch {
        // A failed lookup just means no suggestions.
      }
    }, 160);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  // Always surface the current selection as a checked row, even before typing.
  const rows = [
    ...(value && !suggestions.some((s) => s.title === value) ? [{ title: value, jobCount: 0 }] : []),
    ...suggestions,
  ];

  return (
    <div>
      <SearchBox full value={query} onChange={setQuery} placeholder="Search titles" label="Search job titles" />
      <div className="mt-1 max-h-64 overflow-auto">
        {rows.map((row) => {
          const checked = row.title === value;
          return (
            <button
              key={row.title}
              type="button"
              onClick={() => onChange(checked ? "" : row.title)}
              aria-pressed={checked}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-start hover:bg-[var(--control-hover)]"
            >
              <span className="min-w-0 truncate text-sm text-[var(--ink)]">{row.title}</span>
              <span className="flex shrink-0 items-center gap-2">
                {row.jobCount > 0 && (
                  <span className="tabular-nums text-[12px] text-[var(--muted)]">{row.jobCount.toLocaleString()}</span>
                )}
                <FilterCheckbox checked={checked} />
              </span>
            </button>
          );
        })}
        {rows.length === 0 && (
          <p className="px-2 py-3 text-[13px] text-[var(--muted)]">
            {query.trim().length < 2 ? "Type to search job titles" : "No matching titles"}
          </p>
        )}
      </div>
    </div>
  );
}

// The pill grid for the small facets (Workplace, Job type, ATS): each option a toggle pill, with an
// optional leading glyph (a globe for workplace, the ATS logo for sources).
function SidebarPills({
  options,
  selected,
  onToggle,
  glyph,
}: {
  options: readonly { label: string; value: string }[];
  selected: string[];
  onToggle: (value: string) => void;
  glyph?: "globe" | "ats" | "jobtype";
}) {
  return (
    <div className="flex flex-wrap gap-2 pt-0.5">
      {options.map((option) => {
        const checked = selected.includes(option.value);
        const JobTypeIcon = glyph === "jobtype" ? JOB_TYPE_ICONS[option.value.toLowerCase()] : undefined;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onToggle(option.value)}
            aria-pressed={checked}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] ${
              checked
                ? "border-transparent bg-[var(--accent-strong)] text-white"
                : "border-[var(--border)] bg-[var(--surface)] text-[var(--ink)] hover:bg-[var(--control-hover)]"
            }`}
          >
            {glyph === "globe" && <span className="[&>svg]:text-current"><IconGlobe /></span>}
            {glyph === "ats" && (
              <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-white">
                <AtsMark source={option.value} size={4} />
              </span>
            )}
            {JobTypeIcon && <JobTypeIcon />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ---- v3: dashed "is" chips + the single multistate Filter flyout ----

// Category icon per chip kind, for the "[icon] is [value]" chips.
const CHIP_ICONS: Partial<Record<ChipKind, () => React.ReactElement>> = {
  search: IconSearch,
  location: IconPin,
  title: IconLocate,
  company: IconUser,
  country: IconPin,
  city: IconPin,
  roleFamily: IconLocate,
  industry: IconIndustry,
  workplace: IconWorkplace,
  source: IconAts,
  employmentType: IconJobType,
};

// One selected filter, rendered as the design's dashed pill: category icon, the word "is", the
// value (with its glyph — flag, globe, or ATS mark), and an ×. Clicking anywhere removes it.
function FilterChip({ chip }: { chip: ActiveChip }) {
  const Icon = CHIP_ICONS[chip.kind];
  const value = chip.value ?? chip.label;
  return (
    <button
      type="button"
      onClick={chip.clear}
      aria-label={`Remove filter ${value}`}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-dashed border-[var(--border)] bg-[var(--control)] px-3 text-sm font-medium text-[var(--ink)] transition-transform duration-[160ms] ease-[var(--ease-out)] hover:bg-[var(--control-hover)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
    >
      {Icon && <Icon />}
      <span className="text-[var(--muted)]">is</span>
      <span className="inline-flex max-w-48 items-center gap-1.5 truncate">
        {chip.code && <Flag code={chip.code} />}
        {chip.kind === "workplace" && <IconGlobe />}
        {chip.kind === "source" && (
          <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-white">
            <AtsMark source={value} size={4} />
          </span>
        )}
        {value}
      </span>
      <span aria-hidden="true" className="ms-0.5 text-[var(--muted)]">×</span>
    </button>
  );
}

// ---- v4: a row of independent filter dropdowns ----

// Filled 20px glyphs supplied for the v4 search field (not the stroke-based LineIcon set).
const IconSearchGlyph = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="shrink-0">
    <path d="M8.85303 1.6733C10.6017 1.59876 12.3212 2.13956 13.7124 3.20163C15.2962 4.40783 16.3347 6.19479 16.5987 8.168C16.8791 10.2669 16.3032 12.1756 15.028 13.8469C15.2887 14.1198 15.5791 14.3995 15.8478 14.6677L17.2696 16.0903L17.797 16.6145C18.0685 16.8848 18.3138 17.0653 18.3288 17.4754C18.353 18.1442 17.5911 18.5757 17.0414 18.1921C16.8914 18.0875 16.7594 17.9414 16.6299 17.8119L16.0956 17.2762L14.1405 15.3209C14.1121 15.293 13.8651 15.0308 13.8362 15.0504C13.5513 15.2429 13.2819 15.446 12.9856 15.6235C10.2313 17.2737 6.65483 16.9431 4.23835 14.8209C2.7398 13.5047 1.79233 11.6492 1.68079 9.62841C1.55627 7.62613 2.23945 5.65748 3.57753 4.16276C4.96376 2.61833 6.7886 1.78479 8.85303 1.6733ZM9.27735 14.9968C12.4944 14.9349 15.0534 12.2789 14.9956 9.06177C14.9377 5.8446 12.285 3.28227 9.06777 3.33602C5.84476 3.38986 3.27683 6.04841 3.33475 9.27134C3.39268 12.4943 6.05449 15.0589 9.27735 14.9968Z" fill="#868990" />
  </svg>
);
const IconClearGlyph = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="shrink-0">
    <path d="M9.99969 0.791504C15.0662 0.791504 19.2085 4.93308 19.2087 9.99951C19.2087 15.0661 15.0663 19.2085 9.99969 19.2085C4.93326 19.2083 0.791687 15.066 0.791687 9.99951C0.791864 4.93319 4.93337 0.791681 9.99969 0.791504ZM7.58173 5.86084C7.10669 5.38588 6.33605 5.38587 5.86102 5.86084C5.386 6.33587 5.38605 7.10648 5.86102 7.58154L8.27899 9.99951L5.86102 12.4185C5.38629 12.8934 5.3864 13.6632 5.86102 14.1382C6.33608 14.6132 7.10667 14.6132 7.58173 14.1382L9.99969 11.7192L12.4186 14.1382C12.8937 14.6132 13.6633 14.6132 14.1384 14.1382C14.6134 13.6631 14.6134 12.8935 14.1384 12.4185L11.7194 9.99951L14.1384 7.58154C14.6134 7.10649 14.6134 6.33587 14.1384 5.86084C13.6634 5.38624 12.8936 5.38616 12.4186 5.86084L9.99969 8.27881L7.58173 5.86084Z" fill="#868990" />
  </svg>
);

// Filled 20px category glyphs supplied for the v4 dropdown pills (muted #868990, one per filter).
const IconTitleF = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="shrink-0">
    <path d="M9.68174 1.04624C14.626 0.871228 18.7761 4.73694 18.952 9.6811C19.1279 14.6252 15.263 18.7762 10.3188 18.953C5.37345 19.1298 1.22128 15.2637 1.04532 10.3182C0.869373 5.37277 4.73629 1.2213 9.68174 1.04624ZM10.3006 12.7241C10.7371 12.7461 11.1591 12.7751 11.5905 12.8485C12.6828 13.0344 13.7126 13.4867 14.5883 14.1655C14.7687 14.3048 14.9402 14.4551 15.1021 14.6152C15.1735 14.6854 15.3527 14.8745 15.4249 14.9303C15.7029 14.5954 15.921 14.3355 16.1601 13.9663C17.0505 12.5849 17.4499 10.9441 17.2939 9.30804C17.1122 7.37664 16.1705 5.5966 14.6761 4.35949C13.2818 3.19673 11.5017 2.60003 9.68833 2.68759C7.69893 2.78767 5.911 3.59372 4.56737 5.07888C3.26833 6.51112 2.58933 8.39951 2.67889 10.331C2.74095 11.739 3.20942 13.0988 4.02771 14.2462C4.10099 14.3488 4.48941 14.8798 4.58763 14.9018C4.63827 14.8824 4.81924 14.6691 4.87651 14.6124C6.09899 13.4028 7.76449 12.7379 9.4798 12.7233C9.76114 12.7209 10.0109 12.704 10.3006 12.7241Z" fill="#868990" />
    <path d="M9.79874 5.2153C11.519 5.10668 13.0023 6.41182 13.1135 8.13197C13.2245 9.85211 11.9216 11.3373 10.2016 11.4509C8.47806 11.5648 6.9892 10.2585 6.87783 8.53482C6.76647 6.81113 8.0749 5.32416 9.79874 5.2153Z" fill="#868990" />
  </svg>
);
const IconJobTypeF = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="shrink-0">
    <path d="M13.9249 10.2138C16.3351 10.0812 18.3974 11.9253 18.5341 14.3352C18.6708 16.7453 16.8301 18.8106 14.4203 18.9514C12.0049 19.0924 9.93343 17.2464 9.79645 14.8307C9.65947 12.415 11.509 10.3467 13.9249 10.2138ZM15.5241 15.6098C15.7079 15.5669 15.8432 15.4877 15.9449 15.3219C16.0335 15.1775 16.0594 15.0032 16.0167 14.8393C15.9763 14.6817 15.8733 14.5476 15.7316 14.4679C15.6144 14.4005 14.9409 14.1735 14.7978 14.1488C14.773 13.7647 14.8038 13.3183 14.793 12.9285C14.7872 12.7261 14.8107 12.4863 14.76 12.2913C14.7311 12.175 14.6681 12.07 14.579 11.9896C14.4262 11.8538 14.25 11.8366 14.0544 11.8516C14.0461 11.8523 14.0378 11.853 14.0294 11.8539C13.7387 11.9247 13.56 12.1371 13.5486 12.4401C13.5342 12.8194 13.5445 13.1993 13.5413 13.5788C13.5456 13.9382 13.5224 14.3852 13.5638 14.7377C13.5971 14.8869 13.721 15.0568 13.8565 15.1209C14.0884 15.2303 14.3509 15.3068 14.594 15.3824C14.8583 15.4644 15.253 15.6538 15.5241 15.6098Z" fill="#868990" />
    <path d="M8.52265 1.04759C10.705 0.922742 12.5756 2.59027 12.7012 4.77259C12.8268 6.95491 11.16 8.82606 8.9777 8.95246C6.79433 9.07893 4.92202 7.41105 4.79633 5.22763C4.67065 3.04422 6.3392 1.17251 8.52265 1.04759Z" fill="#868990" />
    <path d="M8.31672 10.215C9.13484 10.1848 9.95386 10.2403 10.7604 10.3807L10.7475 10.3882C10.639 10.4532 10.4474 10.645 10.3547 10.7366C9.65023 11.4311 9.15124 12.3067 8.91267 13.2667C8.58222 14.596 8.76778 16.1097 9.47784 17.2879C8.94446 17.3125 8.28481 17.2957 7.74449 17.2959L4.58982 17.296C3.66661 17.2985 2.94425 17.368 2.20472 16.6935C1.75596 16.2852 1.48887 15.7146 1.46283 15.1084C1.41947 14.1205 1.87163 13.1546 2.5348 12.4446C4.0105 10.8646 6.23215 10.3028 8.31672 10.215Z" fill="#868990" />
  </svg>
);
const IconWorkplaceF = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="shrink-0">
    <path d="M5.43182 1.0484C5.96613 1.04094 6.5005 1.03847 7.03484 1.04099C7.51596 1.03919 7.9971 1.04536 8.47801 1.05953C9.55661 1.09572 10.695 1.19771 11.4944 2.00443C12.2261 2.74274 12.3583 3.72744 12.4117 4.72124C12.4309 5.12211 12.4413 5.52336 12.4429 5.92469C12.4578 5.92369 12.4728 5.92295 12.4878 5.92249C13.0844 5.90956 13.7602 5.92185 14.3665 5.92444C15.3042 5.94421 16.2832 5.86737 17.2033 6.07611C17.5789 6.16134 17.9387 6.35684 18.2176 6.62085C18.8983 7.26548 18.9361 8.25537 18.9552 9.13101C18.9668 9.66451 18.9591 10.2041 18.9593 10.7382V13.5507L18.9589 15.1589C18.9586 15.7789 18.959 16.4611 18.8405 17.0716C18.7559 17.5076 18.5708 17.8902 18.2643 18.2143C17.6233 18.8922 16.6481 18.9481 15.7686 18.9581C14.8216 18.9689 13.8633 18.9611 12.9125 18.9625L12.0682 18.9642C11.8736 18.9646 11.6541 18.9729 11.4613 18.9408C11.2039 18.9035 10.8864 18.6257 10.8444 18.3624C10.7903 18.0242 10.8107 17.6184 10.8107 17.2708L10.8115 15.3841L10.8115 8.89043C10.8115 7.67637 10.8205 6.44315 10.8003 5.23396C10.7722 4.64744 10.7883 3.54032 10.3067 3.12211C9.76228 2.64939 8.53257 2.69931 7.84306 2.68423C6.80288 2.66474 5.76237 2.67272 4.7226 2.70814C3.2732 2.76899 2.78051 3.0915 2.71162 4.60645C2.68702 5.14746 2.66935 5.69111 2.66836 6.23795L2.66772 8.35272C2.66784 8.60313 2.69638 9.08933 2.65542 9.3172C2.47842 10.302 1.03796 10.1882 1.04233 9.15474C1.04799 7.81884 1.02602 6.48982 1.05524 5.15637C1.0788 4.08158 1.16515 2.86094 1.94957 2.04391C2.84257 1.09688 4.21736 1.07594 5.43182 1.0484ZM15.3944 9.78948C15.6039 9.77045 15.753 9.73046 15.8943 9.55831C16.0003 9.4296 16.0501 9.26367 16.0327 9.09784C15.9638 8.41651 15.1207 8.53423 14.6223 8.54783C14.4104 8.56446 14.2616 8.58825 14.1111 8.76289C14.0022 8.89009 13.9488 9.05555 13.9626 9.2224C13.9751 9.38391 14.0524 9.53354 14.1767 9.63742C14.4422 9.8584 15.0361 9.79287 15.3944 9.78948ZM15.3942 13.1228C15.6038 13.1038 15.753 13.0638 15.8943 12.8916C16.0003 12.7629 16.05 12.597 16.0326 12.4312C15.9641 11.7498 15.1206 11.8676 14.6223 11.8811C14.4106 11.8978 14.2616 11.9215 14.1111 12.0962C14.0022 12.2234 13.9488 12.3889 13.9626 12.5557C13.9751 12.7172 14.0524 12.8669 14.1767 12.9708C14.4421 13.1917 15.0354 13.1262 15.3942 13.1228Z" fill="#868990" />
    <path d="M4.81314 14.3806C4.86712 14.379 4.92113 14.3778 4.97513 14.3772C5.99165 14.3664 6.85502 14.7251 7.67206 15.3038C8.06223 15.5717 8.46035 15.8385 8.71937 16.244C9.14283 16.9069 8.97043 17.5777 8.4325 18.1036C8.00861 18.5181 7.53603 18.8574 6.93238 18.9413C6.70855 18.9724 6.47213 18.9631 6.24806 18.9633L5.21487 18.9629L3.97042 18.9635C2.99969 18.9639 2.5796 18.9724 1.82 18.3411C0.474738 17.223 1.0197 16.1482 2.25891 15.3452C3.16966 14.7551 3.70501 14.4488 4.81314 14.3806Z" fill="#868990" />
    <path d="M4.85788 9.3799C6.11882 9.30224 7.20464 10.2599 7.28507 11.5207C7.3655 12.7815 6.41017 13.8694 5.1496 13.9526C3.88509 14.036 2.79305 13.077 2.71237 11.8124C2.63169 10.5477 3.59303 9.4578 4.85788 9.3799Z" fill="#868990" />
    <path d="M7.85138 4.17116C8.08406 4.16318 8.75893 4.1481 8.95859 4.19752C9.06583 4.22451 9.1665 4.27289 9.25457 4.33977C9.43251 4.47439 9.54802 4.67564 9.57448 4.8972C9.60181 5.11577 9.54053 5.3362 9.40432 5.5093C9.24978 5.70528 9.06531 5.80077 8.82199 5.83123C8.60388 5.84328 7.90855 5.85322 7.72233 5.80948C7.61566 5.78417 7.51522 5.7375 7.42707 5.67233C7.24535 5.53828 7.12535 5.35632 7.09387 5.13112C7.05983 4.89953 7.12161 4.66406 7.26497 4.47904C7.42353 4.27524 7.60474 4.20288 7.85138 4.17116Z" fill="#868990" />
    <path d="M4.51814 4.17115C4.75083 4.16318 5.42568 4.1481 5.62535 4.19751C5.73259 4.2245 5.83326 4.27288 5.92133 4.33976C6.09928 4.47437 6.21477 4.67563 6.24121 4.89719C6.26854 5.11576 6.20727 5.33618 6.07106 5.50928C5.91654 5.70527 5.73211 5.80073 5.4888 5.83122C5.27073 5.84327 4.57526 5.8532 4.38909 5.80948C4.28241 5.78416 4.18197 5.73751 4.0938 5.67232C3.91211 5.53827 3.7921 5.35628 3.76061 5.1311C3.72658 4.89951 3.78837 4.66406 3.93175 4.47903C4.0903 4.27523 4.27147 4.20287 4.51814 4.17115Z" fill="#868990" />
    <path d="M7.85138 6.67096C8.07767 6.6632 8.75064 6.64911 8.9453 6.69412C9.05555 6.7198 9.15922 6.76813 9.24975 6.83607C9.42855 6.96917 9.54549 7.1693 9.57366 7.39041C9.60277 7.60926 9.54293 7.83066 9.40752 8.00503C9.25263 8.20313 9.06881 8.29929 8.8237 8.33096C8.60476 8.34285 7.90917 8.35315 7.72233 8.30928C7.61566 8.28397 7.51521 8.23731 7.42706 8.17213C7.24536 8.03809 7.12535 7.85607 7.09387 7.63092C7.05983 7.39933 7.12161 7.16386 7.26497 6.97884C7.42355 6.77502 7.60471 6.70268 7.85138 6.67096Z" fill="#868990" />
    <path d="M4.51814 6.67096C4.74465 6.66316 5.41705 6.64914 5.61206 6.69416C5.72229 6.7198 5.82599 6.76812 5.91651 6.83605C6.09533 6.96915 6.21225 7.16929 6.24039 7.39043C6.26951 7.60927 6.20966 7.83065 6.07425 8.00502C5.91931 8.20319 5.73557 8.29932 5.49039 8.33097C5.2716 8.34285 4.57577 8.35312 4.38909 8.30929C4.28242 8.28397 4.18197 8.23732 4.0938 8.17213C3.91211 8.0381 3.7921 7.85608 3.76061 7.63091C3.72658 7.39933 3.78837 7.16388 3.93173 6.97885C4.09031 6.77502 4.27146 6.70268 4.51814 6.67096Z" fill="#868990" />
  </svg>
);
const IconCountryF = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="shrink-0">
    <path d="M9.72286 1.04716C11.1963 0.988339 12.6458 1.43338 13.8324 2.30891C15.2114 3.31792 16.1325 4.83401 16.3927 6.5229C16.9144 9.9381 14.185 12.4562 11.9491 14.5823C11.3982 15.1061 11.0683 15.4916 10.2796 15.6101C10.2377 15.6145 10.1958 15.6181 10.1538 15.6208C9.58375 15.6548 8.96367 15.4613 8.54962 15.0574C6.46424 13.023 3.78277 10.8411 3.55397 7.7167C3.43943 6.15243 4.09424 4.41536 5.1307 3.25217C6.29948 1.92538 7.95663 1.12968 9.72286 1.04716ZM10.2149 9.98706C11.5888 9.86756 12.6055 8.6568 12.4857 7.28297C12.3659 5.90914 11.155 4.89265 9.78117 5.01274C8.40779 5.13279 7.39165 6.34333 7.51142 7.71675C7.63118 9.09016 8.8415 10.1065 10.2149 9.98706Z" fill="#868990" />
    <path d="M5.76949 13.9626C5.84669 13.9578 5.92419 13.9633 5.99991 13.979C6.22567 14.0263 6.41056 14.15 6.53462 14.3448C6.65423 14.5327 6.69285 14.7609 6.64172 14.9779C6.5716 15.2806 6.32213 15.5348 6.02413 15.6072C5.38444 15.7624 4.82587 15.9052 4.26156 16.2585C4.5557 16.4212 4.84317 16.5598 5.16334 16.6656C7.43728 17.4184 10.9692 17.4316 13.3227 17.0277C14.0629 16.9007 14.822 16.7316 15.4961 16.3921C15.5543 16.3626 15.6728 16.3122 15.6937 16.2487C15.6736 16.2102 15.5861 16.1635 15.5428 16.1395C15.2069 15.9521 14.8277 15.8353 14.4604 15.7288C14.2062 15.6531 13.9371 15.6283 13.7086 15.4854C13.309 15.2358 13.221 14.6891 13.4863 14.3064C13.6109 14.1285 13.8025 14.0091 14.0168 13.9754C14.4469 13.904 15.7328 14.3658 16.1362 14.5674C16.3439 14.6714 16.5421 14.7888 16.7341 14.9241C17.1112 15.2211 17.3932 15.5276 17.4798 16.0268C17.5478 16.4184 17.4328 16.8087 17.1982 17.1234C16.4323 18.1501 14.3754 18.5837 13.1421 18.7523C10.5531 19.09 7.82985 19.0557 5.2861 18.4391C4.3089 18.2021 2.67695 17.6225 2.51561 16.4624C2.46065 16.0685 2.56867 15.6693 2.81471 15.3569C3.34392 14.6711 4.33679 14.3264 5.14207 14.1049C5.31828 14.0565 5.59866 13.9839 5.76949 13.9626Z" fill="#868990" />
  </svg>
);
const IconIndustryF = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="shrink-0">
    <path d="M4.9562 6.04636C5.41675 6.02143 5.93752 6.04097 6.40235 6.04104L8.92593 6.04139L10.1892 6.04045C10.4276 6.04033 10.6845 6.03201 10.9201 6.05536C11.0551 6.06957 11.1759 6.13246 11.2725 6.22474C11.4294 6.37399 11.4586 6.57105 11.46 6.77722C11.4618 7.05432 11.4635 7.33125 11.467 7.60797C11.4728 8.05609 11.5108 8.50485 11.5191 8.95246C12.1469 8.96975 12.7871 8.9507 13.4163 8.95763C13.7058 8.96082 14.036 8.94109 14.3202 8.97933C14.4691 8.99938 14.6131 9.07356 14.7246 9.17532C15.0739 9.49466 14.9911 9.88334 15.0097 10.3051C15.0928 12.1931 15.6325 14.0448 16.738 15.5927C16.89 15.8056 17.2397 16.2645 17.4366 16.4474C17.8065 16.5013 18.157 16.3627 18.4962 16.6955C18.6552 16.8495 18.7458 17.061 18.7478 17.2823C18.7502 17.5085 18.6597 17.7258 18.4974 17.8834C18.4074 17.9723 18.2351 18.0865 18.1113 18.1029C17.7864 18.146 17.3939 18.1297 17.0622 18.1297L15.0586 18.1294H6.0765L3.38329 18.1301L2.56092 18.1304C2.37308 18.1302 2.19833 18.1339 2.01049 18.1179C1.29192 18.0567 1.00749 17.2054 1.49617 16.6912C1.78326 16.389 2.31807 16.4565 2.70299 16.4587C2.84727 16.1526 2.98344 15.7912 3.0979 15.4723C3.54157 14.2044 3.85913 12.896 4.04598 11.5658C4.19778 10.5096 4.29519 9.44618 4.33786 8.37992C4.35184 8.03237 4.36225 7.68467 4.36906 7.33691C4.3702 7.24079 4.37107 7.14364 4.37184 7.04747C4.37463 6.69669 4.33201 6.31514 4.69591 6.11996C4.79038 6.06928 4.84932 6.06148 4.9562 6.04636ZM13.1195 16.4498C13.4767 16.4754 13.9785 16.4541 14.3508 16.4587C14.5629 16.4615 15.1065 16.4715 15.2965 16.453C15.2233 16.3265 15.1208 16.1806 15.0409 16.0542C14.9077 15.8427 14.782 15.6267 14.6639 15.4065C14.0609 14.2595 13.6584 13.0179 13.4739 11.7353C13.4166 11.3485 13.3918 11.0225 13.357 10.6363C12.9919 10.6289 12.6268 10.6269 12.2616 10.6304C12.1187 10.6311 11.8021 10.6413 11.669 10.6235C11.6865 10.9602 11.7738 11.4875 11.8262 11.8263C12.0755 13.4393 12.4814 14.9478 13.1195 16.4498Z" fill="#868990" />
    <path d="M16.1714 1.88038C16.4266 1.86443 16.6826 1.89188 16.9287 1.96154C17.5225 2.13218 17.9899 2.51059 18.3849 2.97658C18.6487 3.28762 18.8352 3.56128 18.7055 3.99082C18.5935 4.36192 18.1887 4.61789 17.8065 4.56313C17.5107 4.52076 17.3152 4.33541 17.1477 4.10388C16.9905 3.89791 16.7612 3.66623 16.5112 3.58265C15.8836 3.39623 15.5082 4.14081 15.1589 4.51804C14.9702 4.72184 14.7522 4.89602 14.507 5.02189C14.207 5.17869 13.8663 5.23965 13.5305 5.19657C13.0259 5.13641 12.5912 4.84309 12.2699 4.46062C11.971 4.1049 11.7915 3.74854 11.3152 3.59515C10.7444 3.5142 10.4846 4.01241 10.1522 4.36266C9.83066 4.69551 9.25296 4.66378 8.95772 4.31676C8.43923 3.68481 8.99726 3.07908 9.44298 2.64912C10.5909 1.54177 12.1551 1.71916 13.1619 2.90519C13.2323 2.98823 13.6508 3.55834 13.7392 3.52979C13.925 3.46973 14.162 3.07534 14.2992 2.92864C14.8031 2.33214 15.3843 1.95321 16.1714 1.88038Z" fill="#868990" />
  </svg>
);
const IconAtsF = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="shrink-0">
    <path d="M8.16274 1.04855C8.78449 1.04037 9.41036 1.03764 10.0312 1.04417C10.4981 1.04909 10.9527 1.12629 11.3555 1.37475C11.7548 1.62105 12.1359 2.03771 12.4715 2.37452L13.5647 3.47253L15.4037 5.32051C15.8487 5.76764 16.2871 6.19648 16.7103 6.66759C17.3643 7.3957 17.2944 8.27077 17.2925 9.1843C17.2912 9.78243 17.303 10.3775 17.2869 10.9708C17.1935 10.8542 16.9935 10.7067 16.868 10.6182C16.2254 10.1648 15.3288 9.90544 14.5448 10.0454C14.0012 10.1424 13.6332 10.4677 13.3302 10.9104C12.9085 10.2749 12.3828 9.98564 11.6147 10.0089C9.75911 10.065 8.26728 11.6573 8.33673 13.5118C8.35679 14.0479 8.60889 14.4745 8.99883 14.8252C9.06049 14.8782 9.17095 14.9496 9.24074 14.9975C8.66367 15.4017 8.33717 15.8734 8.33394 16.6051C8.33797 17.4846 8.68401 18.3281 9.29885 18.9569C8.59228 18.9543 7.93885 18.9588 7.22722 18.9148C6.02985 18.8409 4.86676 18.6812 3.95474 17.8256C2.85441 16.7932 2.75126 15.1112 2.72272 13.6799C2.70427 12.0323 2.69953 10.3845 2.70851 8.73674L2.71204 6.62494C2.72086 5.72925 2.74235 4.82776 2.94238 3.95146C3.20502 2.80078 4.05948 1.8004 5.17785 1.40671C6.12147 1.07452 7.17208 1.06632 8.16274 1.04855ZM15.603 7.9149C15.5227 7.71456 14.7244 6.9437 14.5258 6.74342L13.1033 5.31262L11.6126 3.81602C11.3898 3.59255 10.6685 2.82288 10.4241 2.71952C10.3907 2.93326 10.409 3.33845 10.4136 3.57206C10.4343 4.61574 10.4422 5.8248 11.0736 6.70831C11.945 7.92776 13.6124 7.88612 14.9534 7.91839C15.1414 7.92292 15.4182 7.93249 15.603 7.9149Z" fill="#868990" />
    <path d="M11.6138 11.0468C11.7844 11.0386 11.9454 11.0484 12.1004 11.1273C12.2909 11.2219 12.4356 11.389 12.5019 11.5912C12.565 11.7894 12.5376 12.0447 12.442 12.2179C12.2288 12.6042 11.865 12.6047 11.4915 12.6783C11.2484 12.7355 11.001 13.0185 10.9781 13.2625C10.9321 13.7531 10.8276 14.0492 10.3118 14.1997L10.303 14.2008C10.0733 14.2272 9.83872 14.1783 9.66195 14.0276C9.0641 13.518 9.51822 12.3698 9.9338 11.8843C10.383 11.3593 10.9421 11.1003 11.6138 11.0468Z" fill="#868990" />
    <path d="M14.8496 11.0468C15.3601 11.0293 15.8623 11.1797 16.2793 11.475C16.7949 11.8359 17.1455 12.3873 17.2539 13.0073C17.3518 13.57 17.2333 14.0963 16.5884 14.2074C16.3901 14.2179 16.1896 14.1777 16.0317 14.0605C15.7523 13.8531 15.7287 13.6017 15.6893 13.2897C15.6522 12.9967 15.4139 12.7215 15.1228 12.6621C14.8774 12.6171 14.654 12.6228 14.4419 12.4686C14.0774 12.2035 14.0284 11.6907 14.297 11.3384C14.4407 11.15 14.6226 11.0796 14.8496 11.0468Z" fill="#868990" />
    <path d="M16.3958 15.8C16.8501 15.7661 17.2764 16.0653 17.2863 16.5362C17.3137 17.8376 16.3193 18.8571 15.0507 18.9571C14.6095 18.9675 14.2524 18.7996 14.1406 18.3244C14.0943 18.1274 14.1535 17.8677 14.2694 17.7043C14.4555 17.4419 14.735 17.3841 15.0354 17.3563C15.3111 17.332 15.6413 17.0552 15.6775 16.7703C15.7388 16.2863 15.8219 15.8957 16.3958 15.8Z" fill="#868990" />
    <path d="M10.0529 15.7998C10.5005 15.7663 10.8958 16.0237 10.943 16.4782C10.9871 16.902 11.1076 17.2426 11.5769 17.3483C11.7917 17.3968 12.0063 17.3787 12.2028 17.5211C12.7847 17.9434 12.5736 18.8211 11.8581 18.9516C11.3879 19.0034 10.8229 18.8194 10.433 18.5594C9.90839 18.2112 9.54413 17.6684 9.42073 17.051C9.30733 16.4797 9.39177 15.9304 10.0529 15.7998Z" fill="#868990" />
  </svg>
);
const IconDateF = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="shrink-0" stroke="#868990" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13.3333 1.6665V4.99984M6.66666 1.6665V4.99984" />
    <path d="M10.8333 3.3335H9.16667C6.02397 3.3335 4.45262 3.3335 3.47631 4.3098C2.5 5.28612 2.5 6.85746 2.5 10.0002V11.6668C2.5 14.8095 2.5 16.3809 3.47631 17.3572C4.45262 18.3335 6.02397 18.3335 9.16667 18.3335H10.8333C13.976 18.3335 15.5474 18.3335 16.5237 17.3572C17.5 16.3809 17.5 14.8095 17.5 11.6668V10.0002C17.5 6.85746 17.5 5.28612 16.5237 4.3098C15.5474 3.3335 13.976 3.3335 10.8333 3.3335Z" />
    <path d="M2.5 8.3335H17.5" />
    <path d="M8.33333 15.4168L8.33333 11.5395C8.33333 11.3797 8.21938 11.2502 8.07882 11.2502H7.5M11.6667 15.4153L12.9046 11.5769C12.9126 11.5522 12.9167 11.5263 12.9167 11.5002C12.9167 11.3622 12.8047 11.2502 12.6667 11.2502L10.8333 11.25" />
  </svg>
);

// 16px job-type glyphs (currentColor so they invert to white on the selected accent pill).
const IconFullTime = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
    <path d="M7.74767 0.837057C11.7031 0.697582 15.0228 3.7907 15.1629 7.74613C15.303 11.7015 12.2104 15.0217 8.25504 15.1625C4.29877 15.3032 0.977649 12.2098 0.837525 8.2535C0.697401 4.29721 3.79136 0.976563 7.74767 0.837057ZM10.1412 7.54339C10.4672 7.34527 10.886 7.20878 10.9784 6.82323C11.0217 6.64746 10.9915 6.4616 10.8948 6.30857C10.8022 6.16209 10.6543 6.05932 10.4848 6.02369C10.3079 5.98665 10.1483 6.00843 9.99093 6.09664C9.56283 6.33655 9.13721 6.5818 8.7115 6.82595C8.7003 6.83237 8.67959 6.85036 8.66986 6.85867L8.66815 4.86489C8.66819 4.55015 8.68946 4.12664 8.64103 3.82396C8.59377 3.52865 8.22145 3.29224 7.91334 3.34672C7.63552 3.3822 7.37838 3.59453 7.3476 3.8845C7.32177 4.12768 7.33431 4.40393 7.33444 4.65101L7.33413 6.00872L7.33415 7.37449C7.33419 7.55058 7.34394 7.75939 7.33492 7.9391C7.31335 8.36903 7.66455 8.72499 8.10044 8.65444C8.36733 8.61124 8.69409 8.3424 8.94451 8.22516C9.34099 8.0128 9.74534 7.75023 10.1412 7.54339Z" fill="currentColor" />
  </svg>
);
const IconPartTime = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
    <path d="M7.74569 0.837087C11.701 0.69716 15.0211 3.78975 15.1617 7.74506C15.3025 11.7004 12.2105 15.021 8.2552 15.1625C4.29886 15.3039 0.97712 12.2109 0.836403 8.25457C0.695687 4.2982 3.7893 0.977052 7.74569 0.837087ZM11.3155 11.7327C12.3105 10.8553 12.9131 9.61641 12.9891 8.29206C13.0662 6.96524 12.6125 5.66223 11.7279 4.6703C11.0792 3.94322 10.2318 3.4222 9.2902 3.17166C9.08917 3.11788 8.6973 3.02373 8.49083 3.05468C7.89755 3.14258 7.9998 3.84873 8.00036 4.28456L8.00077 5.44832L8.0009 9.14161L8.00088 11.4207L8 12.0522C7.99986 12.1637 7.99469 12.3463 8.01186 12.4508C8.03931 12.6131 8.12929 12.7581 8.26247 12.8547C8.45308 12.9902 8.6379 12.9591 8.85313 12.9244C9.7033 12.7869 10.6842 12.3296 11.3155 11.7327Z" fill="currentColor" />
  </svg>
);
const IconContract = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
    <path d="M7.32482 0.838336C8.18355 0.827626 9.05534 0.83066 9.91439 0.839945C10.2052 0.843089 10.5831 0.872788 10.8657 0.928867C11.5447 1.07036 12.1624 1.4207 12.6324 1.93079C13.5472 2.90498 13.4998 3.90506 13.5004 5.151L13.5005 6.67686L13.501 8.36632C13.5012 8.6645 13.4995 8.97617 13.4998 9.28074C13.5184 10.0319 12.5101 10.2302 12.2437 9.55127C12.1707 9.36516 12.2033 8.68317 12.2034 8.45558L12.2028 5.64251C12.2026 4.98661 12.2325 4.24665 12.1176 3.5989C12.0726 3.34511 11.8614 3.01876 11.6888 2.82923C11.3103 2.41343 10.7761 2.17123 10.2133 2.16265C9.57109 2.14312 8.93441 2.13473 8.29176 2.1428C7.99893 2.15075 7.6903 2.12479 7.40138 2.17304C7.16252 2.21294 6.96521 2.49443 6.84628 2.68537C6.49371 3.2514 6.65431 3.89636 6.63153 4.52362C6.61328 5.02627 6.48254 5.48905 6.10027 5.84093C5.60268 6.30655 5.02392 6.32047 4.3828 6.29735C4.19468 6.28623 3.99612 6.28572 3.80326 6.28881C3.32816 6.29645 2.5765 6.62331 2.48141 7.14229C2.45638 7.27886 2.46425 7.55016 2.46414 7.70033L2.46386 8.57823C2.46383 9.57987 2.45111 10.5851 2.48714 11.5857C2.5016 11.9873 2.53709 12.4308 2.66313 12.8125C2.78769 13.2047 3.19199 13.6271 3.58175 13.7732C3.95882 13.9147 4.39254 13.9601 4.40875 14.4956C4.4149 14.668 4.35117 14.8356 4.23203 14.9604C3.97758 15.2284 3.70614 15.1847 3.38608 15.0902C2.89329 14.9447 2.54822 14.7139 2.17307 14.3735C1.27648 13.56 1.1994 12.3812 1.17555 11.2461C1.15788 10.3391 1.16659 9.40232 1.16695 8.48676L1.16929 7.13789C1.1722 6.49262 1.18734 5.84718 1.27257 5.20676C1.40883 4.18293 1.93055 3.24546 2.63861 2.50497C2.96759 2.16469 3.3404 1.86973 3.74723 1.62785C4.96014 0.900591 5.96096 0.867151 7.32482 0.838336Z" fill="currentColor" />
    <path d="M9.53948 8.50416C9.8488 8.49125 10.21 8.54893 10.4588 8.74968C11.493 9.58405 10.5746 11.2185 10.0711 12.095C9.92169 12.3551 9.70005 12.6356 9.52416 12.868C9.88321 12.789 10.178 12.6684 10.4951 12.4807C10.6273 12.4021 10.7553 12.3165 10.8784 12.2244C11.1505 12.0214 11.4801 11.7285 11.8374 11.758C12.7905 11.8369 12.5264 13.0222 13.045 13.5829C13.0721 13.6122 13.1414 13.6693 13.1714 13.6601C13.3634 13.6015 13.5747 13.2189 13.7017 13.0953C13.8385 12.9624 14.0024 12.9079 14.1662 12.9082C14.3464 12.9086 14.519 12.9815 14.6449 13.1105C14.7674 13.2387 14.8343 13.4103 14.8307 13.5877C14.8255 13.8615 14.6357 14.0762 14.4726 14.2787C13.8057 15.1071 12.8474 15.3086 12.0655 14.4894C11.803 14.2134 11.6045 13.7952 11.4859 13.4377C10.4535 14.0842 9.51428 14.4558 8.30287 14.074C8.24311 14.1148 8.18179 14.1633 8.12414 14.207C7.78898 14.4606 7.43451 14.6928 7.05949 14.8823C6.59828 15.1153 5.95718 15.3959 5.5958 14.8474C5.37843 14.5174 5.54973 14.0085 5.92501 13.8781C6.01239 13.8477 6.11502 13.8348 6.20311 13.8044C6.54223 13.6748 6.8435 13.4667 7.14814 13.2735C7.06841 13.1704 6.98419 13.0713 6.90783 12.9669C6.18045 11.9725 6.41691 10.736 7.18978 9.84186C7.77278 9.16734 8.62599 8.58119 9.53948 8.50416ZM8.01814 12.2239C8.06428 12.2803 8.10984 12.3379 8.16024 12.3904C8.72986 11.7715 9.18954 11.0986 9.46948 10.2996C9.50351 10.2025 9.59537 9.9519 9.58865 9.85479C9.57518 9.84685 9.58002 9.84626 9.56815 9.84693C9.0159 9.93767 8.41748 10.4006 8.0956 10.8478C7.76866 11.302 7.6816 11.7483 8.01814 12.2239Z" fill="currentColor" />
  </svg>
);
const IconInternship = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
    <path d="M7.9062 1.50426C8.04231 1.49858 8.17867 1.50621 8.3133 1.52706C9.75837 1.73723 14.1124 3.62862 14.9626 4.78354C15.1074 4.98021 15.193 5.21052 15.153 5.45653C15.0736 5.94527 14.5439 6.31592 14.1726 6.58624C14.1567 6.7754 14.1672 7.1058 14.1672 7.30746L14.1676 8.66559L14.167 10.1285C14.1667 10.3431 14.1528 10.7282 14.1844 10.925C14.195 10.9911 14.4058 11.3692 14.4547 11.4639C14.7711 12.0767 15.1221 12.7791 15.1643 13.4793C15.1793 13.7278 15.0959 14.0028 14.9193 14.1799C14.6358 14.4638 14.2539 14.5046 13.8718 14.5023C13.385 14.4993 12.8011 14.5596 12.4221 14.1908C11.8122 13.5976 12.4675 12.2933 12.7667 11.6785C12.88 11.4458 13.068 11.147 13.1502 10.9097C13.1769 10.8327 13.1681 10.4747 13.168 10.3695L13.1672 9.49487L13.1671 7.20155C12.8553 7.36235 12.5624 7.52176 12.2462 7.67752C11.3376 8.12699 10.4009 8.51752 9.44214 8.84671C9.03112 8.98351 8.59624 9.12598 8.16249 9.16095C6.88733 9.26375 3.51197 7.61752 2.34263 6.91674C2.01332 6.71939 1.68925 6.50463 1.39682 6.25545C1.13683 6.0339 0.863157 5.74824 0.837825 5.38997C0.818679 5.11919 0.947497 4.87828 1.11973 4.67892C2.08722 3.55899 6.43179 1.61421 7.9062 1.50426Z" fill="currentColor" />
    <path d="M3.90919 8.89844C4.06774 8.91064 4.33947 9.05067 4.49629 9.1188C4.6581 9.18939 4.82079 9.25795 4.98431 9.3245C5.34723 9.47371 5.71464 9.61175 6.08604 9.73843C6.60852 9.91472 7.34906 10.1488 7.89649 10.1619C8.80148 10.1836 10.0379 9.71618 10.8763 9.38038C11.0971 9.29232 11.3162 9.20022 11.5336 9.10409C11.6428 9.05593 11.8991 8.93583 12.0038 8.91125C12.0938 8.89043 12.1885 8.9068 12.2662 8.95666C12.3944 9.03782 12.428 9.20026 12.4169 9.34134C12.3704 9.93839 12.3805 10.5493 12.3331 11.1448C12.3277 11.2174 12.3177 11.2896 12.3033 11.3609C12.2626 11.5559 12.1825 11.7238 12.0782 11.8907C12.0697 11.9031 12.0613 11.9154 12.0528 11.9277C11.5999 12.5748 10.4353 12.8931 9.70211 13.0281C8.15998 13.312 5.6201 13.2137 4.31409 12.2946C3.98237 12.0622 3.75662 11.7075 3.68652 11.3085C3.66495 11.1809 3.65931 11.0064 3.65281 10.8747L3.6211 10.0983L3.59533 9.56279C3.58014 9.25422 3.52454 8.96214 3.90919 8.89844Z" fill="currentColor" />
  </svg>
);

// Job-type glyphs keyed by value; currentColor lets them invert to white on the selected pill.
const JOB_TYPE_ICONS: Record<string, () => React.ReactElement> = {
  "full time": IconFullTime,
  "part time": IconPartTime,
  contract: IconContract,
  internship: IconInternship,
};

// The shared pill: 36px tall, 8px padding, 14px radius, a hairline shadow in place of a border,
// white fill. Every control in the filter row wears it.
// The press-scale is a transition, not a hover one: hover stays instant, but a control the user is
// actively holding should acknowledge the press. 0.97 over 160ms ease-out is the standard tactile
// value -- below 0.95 it reads as the button flinching.
const V4_PILL =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[14px] bg-white px-2 text-sm font-medium text-[var(--ink)] shadow-[var(--shadow-control)] transition-transform duration-[160ms] ease-[var(--ease-out)] hover:bg-[#F5F5FA] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";

// A plain action in that same pill, so a standalone button (Clear all, Clear filters) matches the
// controls beside it instead of importing a second button look.
function PillButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`${V4_PILL} px-3`}>
      {children}
    </button>
  );
}

// The v4 search field: 36px tall, 14px radius, the supplied glyphs, a pink inset focus ring, a clear
// button once there is text, and a clickable surround (the <label> focuses the input from anywhere
// in the box). `full` swaps the fixed 231px + shadow of the top bar for a flush, full-width fill
// used inside the dropdown checklists, so every search field looks the same.
function SearchBox({
  value,
  onChange,
  placeholder = "Search",
  // Every one of these fields used to be announced as just "Search" -- the page search and the one
  // inside each filter dropdown -- so a screen-reader user tabbing the row heard the same name up
  // to seven times. `label` names the field and its clear button for what they actually filter.
  label = placeholder,
  full = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  full?: boolean;
}) {
  const shell = full
    ? "w-full bg-[#F5F5FA] focus-within:shadow-[inset_0_0_0_1.5px_#FF73E5]"
    : "w-[231px] bg-white shadow-[var(--shadow-control)] hover:bg-[#F5F5FA] focus-within:bg-[#F5F5FA] focus-within:shadow-[var(--shadow-control),inset_0_0_0_1.5px_#FF73E5]";
  return (
    <label className={`flex h-9 shrink-0 cursor-text items-center gap-2 rounded-[14px] px-2 ${shell}`}>
      <IconSearchGlyph />
      <input
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
      />
      {value && (
        <button
          type="button"
          aria-label={`Clear ${label.toLowerCase()}`}
          onClick={() => onChange("")}
          className="flex shrink-0 items-center justify-center rounded-full hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]"
        >
          <IconClearGlyph />
        </button>
      )}
    </label>
  );
}

// One filter as a pill that toggles a popover of that filter's own controls. Each manages its own
// outside-click dismissal so several can sit side by side in the row.
function FilterDropdown({
  Icon,
  label,
  count,
  width = "w-64",
  children,
}: {
  Icon: () => React.ReactElement;
  label: string;
  count: number;
  width?: string;
  // A render function receives `close`, for single-select dropdowns that should dismiss on a pick.
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
}) {
  // Three phases rather than a boolean, so the popover survives long enough to play its exit. It
  // stays mounted through "closing" and unmounts when the animation ends; a reduced-motion user gets
  // the same path with a 120ms fade, so the unmount never depends on motion the browser skipped.
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const open = phase !== "closed";
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setPhase((current) => (current === "open" ? "closing" : current)), []);

  useEffect(() => {
    if (phase !== "open") return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    // Escape closes and hands focus back to the pill, so the row stays keyboard-navigable. Without
    // this the only way out of an open dropdown was a mouse click somewhere else.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [phase, close]);

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setPhase((current) => (current === "open" ? "closing" : "open"))}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={V4_PILL}
      >
        <Icon />
        <span>{label}</span>
        {count > 0 && (
          <span className="min-w-5 rounded-full bg-[var(--accent-wash)] px-1.5 py-0.5 text-center text-[12px] font-semibold tabular-nums text-[var(--accent-strong)]">
            {count}
          </span>
        )}
        <IconUpDown />
      </button>
      {open && (
        <div
          role="group"
          aria-label={`${label} filter`}
          onAnimationEnd={() => setPhase((current) => (current === "closing" ? "closed" : current))}
          className={`${phase === "closing" ? "dropdown-out" : "dropdown-in"} absolute left-0 top-[calc(100%+8px)] z-30 ${width} rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-[var(--shadow-lift)]`}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}

// A searchable single-select list (Country): one value, a checkmark on the chosen row; clicking the
// chosen row clears it.
function SearchSelectList({
  options,
  value,
  onChange,
}: {
  options: readonly { label: string; value: string; code?: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const term = query.trim().toLowerCase();
  const matches = term ? options.filter((option) => option.label.toLowerCase().includes(term)) : options;
  const selected = options.find((option) => option.value === value);
  const ordered = selected && !matches.some((option) => option.value === value) ? [selected, ...matches] : matches;
  const shown = ordered.slice(0, 60);

  return (
    <div>
      <SearchBox full value={query} onChange={setQuery} label="Search countries" />
      <div className="mt-1 max-h-64 overflow-auto">
        {shown.map((option) => {
          const checked = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(checked ? "" : option.value)}
              aria-pressed={checked}
              className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-start hover:bg-[var(--control-hover)] ${checked ? "bg-[var(--accent-wash)]" : ""}`}
            >
              <span className="flex min-w-0 items-center gap-2 text-sm text-[var(--ink)]">
                <Flag code={option.code} />
                <span className="min-w-0 truncate">{option.label}</span>
              </span>
              {checked && (
                <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4 shrink-0 text-[var(--accent-strong)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 5" /></svg>
              )}
            </button>
          );
        })}
        {shown.length === 0 && <p className="px-2 py-3 text-[13px] text-[var(--muted)]">No matches</p>}
      </div>
    </div>
  );
}

// The filter row: an independent dropdown per filter, then the Search field and the date pill on
// the right.
function FilterDropdownBar({
  filters,
  update,
  toggle,
}: {
  filters: Filters;
  update: (patch: Partial<Filters>) => void;
  toggle: (key: FilterCategoryKey, value: string) => void;
}) {
  const options = (key: (typeof FILTER_CATEGORIES)[number]["key"]) =>
    FILTER_CATEGORIES.find((entry) => entry.key === key)!.options;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterDropdown Icon={IconTitleF} label="Title" count={filters.title ? 1 : 0} width="w-72">
        <TitleCheckList value={filters.title} onChange={(value) => update({ title: value })} />
      </FilterDropdown>
      <FilterDropdown Icon={IconJobTypeF} label="Job type" count={filters.employmentType.length} width="w-72">
        <SidebarPills options={options("employmentType")} selected={filters.employmentType} onToggle={(value) => toggle("employmentType", value)} glyph="jobtype" />
      </FilterDropdown>
      <FilterDropdown Icon={IconWorkplaceF} label="Workplace" count={filters.workplace.length} width="w-72">
        <SidebarPills options={options("workplace")} selected={filters.workplace} onToggle={(value) => toggle("workplace", value)} glyph="globe" />
      </FilterDropdown>
      <FilterDropdown Icon={IconCountryF} label="Country" count={filters.country && filters.country !== "anywhere" ? 1 : 0}>
        <SearchSelectList options={countryOptions} value={filters.country} onChange={(value) => update({ country: value })} />
      </FilterDropdown>
      <FilterDropdown Icon={IconIndustryF} label="Industry" count={filters.industry.length}>
        <SearchCheckList options={options("industry")} selected={filters.industry} onToggle={(value) => toggle("industry", value)} searchLabel="Search industries" />
      </FilterDropdown>
      <FilterDropdown Icon={IconAtsF} label="ATS" count={filters.source.length} width="w-72">
        <SidebarPills options={options("source")} selected={filters.source} onToggle={(value) => toggle("source", value)} glyph="ats" />
      </FilterDropdown>

      <div className="ms-auto flex items-center gap-2">
        <SearchBox value={filters.search} onChange={(value) => update({ search: value })} />
        <DateDropdown value={filters.postedWithin} onChange={(value) => update({ postedWithin: value })} />
      </div>
    </div>
  );
}

// Date posted. A single-select dropdown built from the same pill and popover as the filters, with
// the pill showing the current range rather than a static label — so "Any time" needs no chip in the
// selected-filters strip. Picking a range closes the popover.
function DateDropdown({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const current = postedWithinOptions.find((option) => option.value === value) ?? postedWithinOptions[0];
  return (
    <FilterDropdown Icon={IconDateF} label={current.label} count={0} width="w-44">
      {(close) => (
        <div className="flex flex-col">
          {postedWithinOptions.map((option) => (
            <button
              key={option.value || "any"}
              type="button"
              aria-pressed={option.value === current.value}
              onClick={() => {
                onChange(option.value);
                close();
              }}
              className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-start text-sm text-[var(--ink)] hover:bg-[var(--control-hover)]"
            >
              {option.label}
              {option.value === current.value && (
                <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4 shrink-0 text-[var(--accent-strong)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 5" /></svg>
              )}
            </button>
          ))}
        </div>
      )}
    </FilterDropdown>
  );
}

// The "Save view" control with its inline naming flow, sitting in the selected-filters row beside
// the chips.
function SaveViewPill({
  onSaveView,
  canSaveView,
}: {
  onSaveView: (name: string) => void;
  canSaveView: boolean;
}) {
  const [naming, setNaming] = useState(false);
  const [viewName, setViewName] = useState("");

  function commitSave() {
    onSaveView(viewName);
    setViewName("");
    setNaming(false);
  }

  if (naming) {
    return (
      <form onSubmit={(event) => { event.preventDefault(); commitSave(); }} className="inline-flex">
        <TextField aria-label="Name this view" autoFocus>
          <Input
            value={viewName}
            onChange={(event) => setViewName(event.target.value)}
            onBlur={() => (viewName.trim() ? commitSave() : setNaming(false))}
            onKeyDown={(event) => event.key === "Escape" && setNaming(false)}
            placeholder="View name"
            maxLength={40}
            className="h-9 w-36 rounded-[14px] bg-white px-3 text-sm text-[var(--ink)] shadow-[var(--shadow-control)] outline-none placeholder:text-[var(--muted)]"
          />
        </TextField>
      </form>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setNaming(true)}
      disabled={!canSaveView}
      title={canSaveView ? "Save the current filters as a view" : "Apply a filter first, then save it as a view"}
      className={`${V4_PILL} px-3 disabled:cursor-not-allowed disabled:opacity-55`}
    >
      <IconPlus /> Save view
    </button>
  );
}

function TableHeading({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-5 pb-3 text-start text-[13px] font-medium text-[var(--muted)] ${className}`}
    >
      {children}
    </th>
  );
}

function VirtuosoTable(props: React.ComponentPropsWithoutRef<"table">) {
  const { children, ...tableProps } = props;
  return (
    <table
      {...tableProps}
      className="jobs-table w-full min-w-[1050px] border-separate border-spacing-0 text-start"
    >
      <caption className="sr-only">Startup jobs from public ATS pages</caption>
      {children}
    </table>
  );
}

const virtuosoComponents = {
  Table: VirtuosoTable,
} satisfies TableComponents<Job>;

function TableHeader() {
  const heading = (Icon: () => React.ReactElement, label: string) => (
    <span className="inline-flex items-center gap-1.5 [&>svg]:size-3.5">
      <Icon />
      {label}
    </span>
  );
  return (
    <tr className="bg-[var(--control-hover)]">
      {/* Role and company share one column: the title is what people scan for, so it leads and the
          company sits beneath it as context, rather than the company owning the first column. */}
      <TableHeading className="w-[34%]">{heading(IconUser, "Role")}</TableHeading>
      <TableHeading className="w-[20%]">{heading(IconPin, "Location")}</TableHeading>
      <TableHeading className="w-[12%]">{heading(IconCalendar, "Posted")}</TableHeading>
      <TableHeading className="w-[12%]">Job type</TableHeading>
      <TableHeading className="w-[11%]">Workplace</TableHeading>
      <TableHeading className="w-[11%] text-end">Source</TableHeading>
    </tr>
  );
}

// Shown while the first page is in flight. It reuses the real table's chrome, header and 72px row
// height so the layout does not shift when rows arrive -- the placeholder blocks sit exactly where
// the logo, title, company and each column will be. The alternative was a blank white box, which is
// what the page did before and read as "no results" rather than "loading".
function JobsSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-table)]" aria-hidden="true">
      <table className="jobs-table w-full min-w-[1050px] border-separate border-spacing-0 text-start">
        <thead>
          <TableHeader />
        </thead>
        <tbody>
          {Array.from({ length: 8 }, (_, row) => (
            <tr key={row}>
              <td className="px-5 py-3.5">
                <div className="flex items-center gap-3">
                  <span className="skeleton size-9 shrink-0 rounded-[10px]" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="skeleton h-3.5 rounded" style={{ width: `${58 + ((row * 7) % 30)}%` }} />
                    <span className="skeleton h-2.5 w-1/3 rounded" />
                  </div>
                </div>
              </td>
              <td className="px-5 py-3.5"><span className="skeleton block h-3 w-2/3 rounded" /></td>
              <td className="px-5 py-3.5"><span className="skeleton block h-3 w-16 rounded" /></td>
              <td className="px-5 py-3.5"><span className="skeleton block h-3 w-14 rounded" /></td>
              <td className="px-5 py-3.5"><span className="skeleton block h-3 w-16 rounded" /></td>
              <td className="px-5 py-3.5"><span className="skeleton ms-auto block h-3 w-16 rounded" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JobCells({
  job,
  onFilter,
  isWatched,
  onToggleWatch,
  now,
}: {
  job: Job;
  onFilter: (patch: Partial<Filters>) => void;
  isWatched: boolean;
  onToggleWatch: (company: string) => void;
  now: number;
}) {
  // Roughly 7% of postings arrive with no publish date. They used to be back-dated from a module
  // constant, which meant every one of them rendered the same frozen "Jul 20, 2026" -- a date that
  // looked exactly like a real one and drifted further into the past every day. An unknown date is
  // now shown as unknown. The NaN check also matters: `publishedAt` is passed through from a dozen
  // ATS ingesters, and one unparseable value used to throw a RangeError out of toISOString() during
  // row render, which unmounts the whole React root.
  const parsed = job.publishedAt ? new Date(job.publishedAt) : null;
  const postedDate = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
  // Relative label only once `now` is set on the client (0 during SSR -> null -> the absolute date
  // renders, matching the server markup).
  const relative = postedDate && now ? relativePosted(postedDate, now) : null;

  return (
    <>
      <td className="px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <CompanyLogo job={job} />
          <div className="min-w-0">
            <span className="block truncate text-sm font-semibold tracking-[-0.01em] text-[var(--ink)]" title={job.title}>
              {job.title}
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[12px] text-[var(--muted)]">
              <button
                type="button"
                onClick={() => onToggleWatch(job.company)}
                aria-pressed={isWatched}
                aria-label={isWatched ? `Remove ${job.company} from watchlist` : `Add ${job.company} to watchlist`}
                title={isWatched ? `Remove ${job.company} from watchlist` : `Add ${job.company} to watchlist`}
                className={`shrink-0 rounded text-[13px] leading-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] ${
                  isWatched ? "text-[var(--accent-strong)]" : "text-[var(--border)] hover:text-[var(--muted-strong)]"
                }`}
              >
                {isWatched ? "★" : "☆"}
              </button>
              <button
                type="button"
                onClick={() => onFilter({ company: job.company })}
                title={`Show only jobs at ${job.company}`}
                className="max-w-[52%] truncate rounded underline-offset-2 hover:text-[var(--ink)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
              >
                {job.company}
              </button>
              <span aria-hidden="true">·</span>
              <span className="truncate">{job.category}</span>
            </span>
          </div>
        </div>
      </td>
      <td className="px-5 py-3.5 text-sm text-[var(--muted-strong)]">
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {job.country ? (
            <Flag code={job.country} />
          ) : (
            <span aria-hidden="true" className="shrink-0 text-[13px] leading-none">
              {job.workplace === "Remote" ? "🌍" : ""}
            </span>
          )}
          {job.location === "Location not specified" ? (
            <span className="truncate">{job.location}</span>
          ) : (
            <button
              type="button"
              // Filtering by the resolved city is far more useful than the raw string, which is
              // often a full address that would match only this one posting.
              onClick={() => (job.city ? onFilter({ city: [job.city], location: "" }) : onFilter({ location: job.location }))}
              title={job.city ? `Show only jobs in ${job.city}` : `Show only jobs in ${job.location}`}
              className="truncate rounded text-start underline-offset-2 hover:text-[var(--ink)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
            >
              {job.location}
            </button>
          )}
        </span>
      </td>
      <td className="whitespace-nowrap px-5 py-3.5 text-sm tabular-nums text-[var(--muted-strong)]">
        {/* suppressHydrationWarning: the relative label depends on the current time, so the server and
            client can legitimately render a slightly different string. title keeps the exact date. */}
        {postedDate ? (
          <time
            dateTime={postedDate.toISOString().slice(0, 10)}
            title={dateFormatter.format(postedDate)}
            suppressHydrationWarning
          >
            {relative ?? dateFormatter.format(postedDate)}
          </time>
        ) : (
          <span className="text-[var(--muted)]" title="This posting did not include a publish date">&mdash;</span>
        )}
      </td>
      <td className="px-5 py-3.5 text-sm text-[var(--ink)]">
        {job.employmentType ?? <span className="text-[var(--muted)]">—</span>}
      </td>
      <td className="px-5 py-3.5 text-sm text-[var(--ink)]">{job.workplace}</td>
      <td className="whitespace-nowrap px-5 py-3.5 text-end">
        <a
          href={job.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-10 items-center justify-end gap-2 rounded-lg px-2 text-sm font-medium text-[var(--muted-strong)] hover:text-[var(--accent-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
          aria-label={`Open ${job.title} at ${job.company} on ${job.source}`}
        >
          <AtsMark source={job.source} />
          {job.source}
          {/* Reveals on row hover (rule in globals.css) — the redesign's affordance. */}
          <span aria-hidden="true" className="src-chevron text-[16px] leading-none text-[var(--muted)]">›</span>
        </a>
      </td>
    </>
  );
}

function CompanyLogo({ job }: { job: Job }) {
  const [failed, setFailed] = useState(false);
  if (job.companyLogoUrl && !failed) {
    return (
      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-white outline outline-1 -outline-offset-1 outline-black/10">
        {/* Dynamic ATS logos are remote and cannot use a fixed Next image host allowlist. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={job.companyLogoUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-contain p-0.5"
          onError={() => setFailed(true)}
          // Workday's /assets/logo (and some others) return a wide header banner, which shrinks to
          // an invisible sliver inside the round avatar. Treat anything markedly non-square as a
          // failed logo so it falls back to the clean monogram.
          onLoad={(event) => {
            const img = event.currentTarget;
            const ratio = img.naturalWidth / (img.naturalHeight || 1);
            if (ratio > 1.6 || ratio < 0.625) setFailed(true);
          }}
        />
      </span>
    );
  }
  // Rounded-square gradient mark in the primary pink for companies without a logo, matching the
  // design's app-icon style logos.
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center rounded-[10px] text-[11px] font-bold tracking-[-0.02em] text-white outline outline-1 -outline-offset-1 outline-black/5"
      style={{ background: "linear-gradient(150deg, #ff8ee4 0%, #d426b0 100%)" }}
      aria-hidden="true"
    >
      {job.companyMark}
    </span>
  );
}

