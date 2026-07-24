"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, ListBox, Select, TextField } from "@heroui/react";
import { TableVirtuoso, type TableComponents } from "react-virtuoso";
import {
  sourceOptions,
  workplaceOptions,
  type Job,
} from "./jobs";
import { countryFlag, countryName, COUNTRY_OPTIONS } from "./countries";
import { CITY_OPTIONS, INDUSTRY_OPTIONS } from "./taxonomies";
import { AtsMark } from "./ats-marks";

const referenceDate = new Date(Date.UTC(2026, 6, 20));
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
const cityOptions = CITY_OPTIONS.map((entry) => ({
  label: `${countryFlag(entry.country) ?? ""} ${entry.name}`.trim(),
  value: entry.name,
}));
const countryOptions = COUNTRY_OPTIONS.map((entry) => ({
  label: `${entry.flag ?? ""} ${entry.name}`.trim(),
  value: entry.code,
}));

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

// One selected-filter chip. `label` is the display-ready string the bar variant shows; `value`
// (when set) is the bare value without its "Location:"-style prefix, which the v3 dashed
// "[icon] is [value]" chips use; `kind` picks the category icon and value glyph there.
type ChipKind =
  | "search" | "location" | "title" | "company" | "country" | "city" | "roleFamily"
  | "industry" | "workplace" | "source" | "employmentType" | "watchlist";
type ActiveChip = { kind: ChipKind; label: string; value?: string; clear: () => void };

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
  variant = "bar",
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
  // "bar" is the original compact top filter bar; "sidebar" is the /v2 right-hand accordion; "chips"
  // is /v3 (dashed "[icon] is [value]" chips + one multistate Filter flyout); "dropdowns" is /v4: a
  // row of independent dropdown pills, one per filter.
  variant?: "bar" | "sidebar" | "chips" | "dropdowns";
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
  // Sidebar variant only: whether the right-hand filter panel is shown ("Hide/Show Filters").
  const [filtersOpen, setFiltersOpen] = useState(true);
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
      params.set("companies", watchlist.slice(0, 100).join("\n"));
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
      } catch (error) {
        if ((error as Error).name !== "AbortError") console.error("Jobs fetch failed", error);
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // initial* are the server-rendered first page, used only to seed the cache once; they are stable.
  }, [queryString, urlQuery, initialJobs, initialTotal, initialTotalCapped, initialCursor]);

  const loadMore = useCallback(async () => {
    if (!cursor || isPaging) return;
    setIsPaging(true);
    try {
      const params = new URLSearchParams(queryString);
      params.set("limit", String(pageSize));
      params.set("cursor", cursor);
      const response = await fetch(`${apiUrl}?${params}`);
      if (!response.ok) throw new Error(`Jobs API returned ${response.status}`);
      const payload = (await response.json()) as { jobs: Job[]; nextCursor: string | null };
      setJobs((current) => {
        const seen = new Set(current.map((job) => job.id));
        return [...current, ...payload.jobs.filter((job) => !seen.has(job.id))];
      });
      setCursor(payload.nextCursor);
    } catch {
      setCursor(null);
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
      const label = filters.country === "anywhere"
        ? "🌍 Anywhere"
        : `${countryFlag(filters.country) ?? ""} ${countryName(filters.country) ?? filters.country}`;
      chips.push({ kind: "country", label: label.trim(), clear: () => update({ country: "" }) });
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

  // /v3 and /v4 give employment type its own table column; /v1 and /v2 stack it under Workplace.
  const jobTypeColumn = variant === "chips" || variant === "dropdowns";

  // A small "Showing results for X" note when a typo'd search was auto-corrected.
  const correctionNote = correctedTo ? (
    <p className="mb-2 px-1 text-[13px] text-[var(--muted-strong)]">
      Showing results for <span className="font-semibold text-[var(--ink)]">{correctedTo}</span>
    </p>
  ) : null;

  // The results table (or empty state) is identical across both page variants, so it lives in one
  // place and is dropped into whichever layout is rendered below.
  const jobsTable = (
    <>
    {correctionNote}
    {jobs.length > 0 ? (
    <div className="overflow-hidden rounded-2xl shadow-[var(--shadow-table)]">
      <TableVirtuoso
        aria-label="Startup jobs from public ATS pages"
        className="jobs-table-scroll bg-white"
        style={{ height: "clamp(420px, 68vh, 760px)" }}
        data={jobs}
        components={virtuosoComponents}
        computeItemKey={(_index, job) => job.id}
        fixedHeaderContent={jobTypeColumn ? TableHeaderWithJobType : TableHeader}
        itemContent={(_index, job) => (
          <JobCells
            job={job}
            onFilter={update}
            isWatched={watchlistSet.has(job.company)}
            onToggleWatch={toggleWatch}
            now={now}
            jobType={jobTypeColumn}
          />
        )}
        fixedItemHeight={72}
        increaseViewportBy={{ top: 240, bottom: 480 }}
        endReached={() => void loadMore()}
      />
    </div>
  ) : (
    <div className="rounded-2xl bg-white px-6 py-16 text-center shadow-[var(--shadow-table)]">
      <p className="text-base font-semibold">No matching jobs</p>
      <p className="mt-1 text-sm text-[var(--muted)]">Try a broader search or clear a filter.</p>
      <Button
        variant="secondary"
        className="mt-5 min-h-11 rounded-xl px-4 font-medium transition-transform duration-150 active:scale-[0.96]"
        onPress={() => setFilters(emptyFilters)}
      >
        Clear filters
      </Button>
    </div>
    )}
    </>
  );

  const showViewsToolbar = watchlist.length > 0 || savedViews.length > 0;
  const viewsToolbar = showViewsToolbar ? (
    <ViewsToolbar
      savedViews={savedViews}
      currentQuery={urlQuery}
      onSaveView={saveView}
      onApplyView={(view) => setFilters(filtersFromSearchParams(view.query))}
      onDeleteView={(name) => setSavedViews((current) => current.filter((view) => view.name !== name))}
      watchlistCount={watchlist.length}
      watchlistOnly={watchlistActive}
      onToggleWatchlistOnly={() => update({ watchlistOnly: !filters.watchlistOnly })}
      showSave={false}
    />
  ) : null;

  const resultsFooter = (
    <p className="mt-4 text-center text-[13px] tabular-nums text-[var(--muted)]">
      Showing {jobs.length.toLocaleString()} of {formatTotal(total, totalCapped)}
      {/* Gate on the cursor, not jobs.length < total: a capped search shows "N+" but stops paging
          at the relevance cap, so there is nothing more to scroll to even though jobs.length < total. */}
      {isPaging ? " · Loading…" : cursor ? " · Scroll for more" : ""}
    </p>
  );

  if (variant === "sidebar") {
    return (
      <SidebarLayout
        total={total}
        totalCapped={totalCapped}
        isLoading={isLoading}
        filters={filters}
        update={update}
        toggle={toggle}
        onSaveView={saveView}
        canSaveView={urlQuery.length > 0}
        onClearAll={() => setFilters(emptyFilters)}
        hasActiveFilters={activeChips.length > 0}
        filtersOpen={filtersOpen}
        onToggleFilters={() => setFiltersOpen((open) => !open)}
        jobsTable={jobsTable}
        viewsToolbar={viewsToolbar}
        resultsFooter={resultsFooter}
      />
    );
  }

  return (
    <main className="min-h-screen bg-[var(--canvas)] text-[var(--ink)]">
      {/* v3 and v4 drop the site header entirely — the hero already carries the brand and count. */}
      {variant === "bar" && (
        <header className="border-b border-[var(--border)] bg-[var(--surface)]">
          <div className="mx-auto flex min-h-[60px] w-full max-w-[1240px] items-center justify-between gap-4 px-5 sm:px-8">
            <div className="flex items-center gap-3">
              <span className="brand-mark" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
              </span>
              <span className="text-[15px] font-semibold tracking-[-0.015em]">Startups.board</span>
            </div>
            <div className="flex items-center gap-2 text-[13px] text-[var(--muted)]">
              <span className="size-2 rounded-full bg-[var(--success)]" aria-hidden="true" />
              <span className="tabular-nums">{formatTotal(total, totalCapped)}</span> live roles
            </div>
          </div>
        </header>
      )}

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
            <span className="font-semibold tabular-nums text-[var(--accent)]">{formatTotal(total, totalCapped)}</span>{" "}
            open roles at today&rsquo;s top startups. Updated daily.
          </p>
        </div>

        {/* v4 has no panel chrome behind the filter row; the others keep the rounded surface card. */}
        <div className={variant === "dropdowns" ? "" : "rounded-2xl bg-[var(--surface)] p-3 shadow-[var(--shadow-panel)]"}>
          {variant === "dropdowns" ? (
            <FilterDropdownBar filters={filters} update={update} toggle={toggle} />
          ) : (
            <FilterBar
              filters={filters}
              update={update}
              toggle={toggle}
              onSaveView={saveView}
              canSaveView={urlQuery.length > 0}
              menu={variant === "chips" ? "stack" : "panels"}
            />
          )}

          {/* v4's dropdown pills carry their own count badges, so it skips the separate chip row. */}
          {activeChips.length > 0 && variant !== "dropdowns" && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-black/6 pt-3">
              {variant === "chips" ? (
                <>
                  {/* v3: each selected filter as a dashed "[icon] is [value]" pill, with Save view
                      beside Clear all — so saving only surfaces once there is something to save. */}
                  {activeChips.map((chip) => <FilterChip key={`${chip.kind}:${chip.label}`} chip={chip} />)}
                  <span className="ms-auto flex items-center gap-2">
                    <SaveViewPill onSaveView={saveView} canSaveView compact />
                    <Button
                      variant="secondary"
                      className="min-h-9 rounded-full px-3 text-[12px] font-medium transition-transform duration-150 active:scale-[0.96]"
                      onPress={() => setFilters(emptyFilters)}
                    >
                      Clear all
                    </Button>
                  </span>
                </>
              ) : (
                <>
                  <span className="text-[12px] font-medium text-[var(--muted)]">Active</span>
                  {activeChips.map((chip) => (
                    <button
                      key={chip.label}
                      type="button"
                      onClick={chip.clear}
                      className="inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-[var(--control)] px-2.5 text-[12px] font-medium text-[var(--ink)] transition-[background-color,scale] duration-150 hover:bg-[var(--control-hover)] active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
                      aria-label={`Remove filter ${chip.label}`}
                    >
                      {chip.label}
                      <span aria-hidden="true" className="text-[var(--muted)]">×</span>
                    </button>
                  ))}
                  <Button
                    variant="secondary"
                    className="ms-auto min-h-8 rounded-lg px-3 text-[12px] font-medium transition-transform duration-150 active:scale-[0.96]"
                    onPress={() => setFilters(emptyFilters)}
                  >
                    Clear all
                  </Button>
                </>
              )}
            </div>
          )}

          {/* Watchlist / saved-views toolbar is hidden on v4 for now. */}
          {showViewsToolbar && variant !== "dropdowns" && (
            <div className="mt-3 border-t border-black/6 pt-3">{viewsToolbar}</div>
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
const IconChevronDown = () => <LineIcon><path d="M4.5 6.5 8 10l3.5-3.5" /></LineIcon>;
const IconUpDown = () => <LineIcon><path d="M5.5 6.5 8 4l2.5 2.5M5.5 9.5 8 12l2.5-2.5" /></LineIcon>;
const IconChevronRight = () => <LineIcon><path d="M6.5 4.5 10 8l-3.5 3.5" /></LineIcon>;
const IconChevronLeft = () => <LineIcon><path d="M9.5 4.5 6 8l3.5 3.5" /></LineIcon>;
const IconSliders = () => <LineIcon><path d="M2.5 5.5h1.7M8 5.5h5.5M2.5 10.5h5.5M11.8 10.5h1.7" /><circle cx="6" cy="5.5" r="1.7" /><circle cx="9.9" cy="10.5" r="1.7" /></LineIcon>;
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

type FilterCategoryKey = "industry" | "city" | "workplace" | "employmentType" | "source";

const FILTER_CATEGORIES: {
  key: FilterCategoryKey;
  label: string;
  Icon: () => React.ReactElement;
  options: readonly { label: string; value: string }[];
  glyph?: "globe" | "ats";
  badge?: boolean;
}[] = [
  { key: "industry", label: "Industry", Icon: IconIndustry, options: INDUSTRY_OPTIONS.map((name) => ({ label: name, value: name })), badge: true },
  { key: "city", label: "City", Icon: IconPin, options: cityOptions.filter((option) => option.value), badge: true },
  { key: "workplace", label: "Workplace", Icon: IconWorkplace, options: workplaceOptions.map((name) => ({ label: name, value: name })), glyph: "globe" },
  { key: "employmentType", label: "Job type", Icon: IconJobType, options: employmentOptions.map((name) => ({ label: name, value: name })) },
  { key: "source", label: "ATS", Icon: IconAts, options: sourceOptions.map((name) => ({ label: name, value: name })), glyph: "ats", badge: true },
];

// The "Add filter" flyout: a category list on the left, and the active category's options as a
// checkbox multi-select on the right — the design's two-panel menu. Every category maps to a
// multi-select filter (the query already treats city/industry as comma-separated sets).
function AddFilterMenu({
  filters,
  toggle,
}: {
  filters: Filters;
  toggle: (key: FilterCategoryKey, value: string) => void;
}) {
  const [active, setActive] = useState<FilterCategoryKey>("industry");
  const category = FILTER_CATEGORIES.find((entry) => entry.key === active) ?? FILTER_CATEGORIES[0];
  const card = "w-64 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-[var(--shadow-lift)]";
  const row = "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-start text-sm text-[var(--ink)] transition-colors duration-100";

  return (
    <div className="absolute left-0 top-[calc(100%+8px)] z-30 flex items-start gap-2">
      <div className={card}>
        {FILTER_CATEGORIES.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setActive(entry.key)}
            onMouseEnter={() => setActive(entry.key)}
            className={`${row} ${active === entry.key ? "bg-[var(--control-hover)]" : "hover:bg-[var(--control-hover)]"}`}
          >
            <entry.Icon />
            <span className="flex-1 font-medium">{entry.label}</span>
            {entry.badge && <span className="tabular-nums text-[13px] text-[var(--muted)]">{entry.options.length}+</span>}
            <IconChevronRight />
          </button>
        ))}
      </div>

      <div className={`${card} max-h-96 overflow-auto`}>
        {category.options.map((option) => {
          const checked = filters[category.key].includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => toggle(category.key, option.value)}
              aria-pressed={checked}
              className={`${row} justify-between hover:bg-[var(--control-hover)]`}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                {category.glyph === "globe" && <IconGlobe />}
                {category.glyph === "ats" && (
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-white">
                    <AtsMark source={option.value} size={4} />
                  </span>
                )}
                <span className="truncate">{option.label}</span>
              </span>
              <FilterCheckbox checked={checked} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// The "Date posted" dropdown, shared by the top filter bar and the sidebar-variant toolbar.
function DatePostedSelect({
  filters,
  update,
  triggerClass = FILTER_PILL,
}: {
  filters: Filters;
  update: (patch: Partial<Filters>) => void;
  triggerClass?: string;
}) {
  return (
    <Select
      aria-label="Date posted"
      selectedKey={filters.postedWithin === "" ? SELECT_EMPTY_KEY : filters.postedWithin}
      onSelectionChange={(key) => update({ postedWithin: key === SELECT_EMPTY_KEY ? "" : String(key ?? "") })}
    >
      <Select.Trigger className={triggerClass}>
        <IconCalendar />
        <Select.Value className="whitespace-nowrap" />
        <IconChevronDown />
      </Select.Trigger>
      <Select.Popover className="max-h-72 min-w-[var(--trigger-width)] overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow-lift)]">
        <ListBox aria-label="Date posted" items={postedWithinOptions} className="outline-none">
          {(option) => (
            <ListBox.Item
              id={option.value === "" ? SELECT_EMPTY_KEY : option.value}
              textValue={option.label}
              className="flex min-h-9 cursor-pointer items-center rounded-lg px-3 text-sm text-[var(--ink)] outline-none transition-colors duration-100 data-[focused]:bg-[var(--control-hover)] data-[selected]:bg-[var(--accent-wash)] data-[selected]:text-[var(--accent-strong)]"
            >
              {option.label}
            </ListBox.Item>
          )}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

// ---- Second main-page layout: results table beside a right-hand filter sidebar ----

// The whole page for variant="sidebar": same header + hero as the bar variant, then a toolbar
// (result count, date, Hide/Show Filters) above a two-column body of table + FilterSidebar.
function SidebarLayout({
  total,
  totalCapped,
  isLoading,
  filters,
  update,
  toggle,
  onSaveView,
  canSaveView,
  onClearAll,
  hasActiveFilters,
  filtersOpen,
  onToggleFilters,
  jobsTable,
  viewsToolbar,
  resultsFooter,
}: {
  total: number;
  totalCapped: boolean;
  isLoading: boolean;
  filters: Filters;
  update: (patch: Partial<Filters>) => void;
  toggle: (key: FilterCategoryKey, value: string) => void;
  onSaveView: (name: string) => void;
  canSaveView: boolean;
  onClearAll: () => void;
  hasActiveFilters: boolean;
  filtersOpen: boolean;
  onToggleFilters: () => void;
  jobsTable: React.ReactNode;
  viewsToolbar: React.ReactNode;
  resultsFooter: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-[var(--canvas)] text-[var(--ink)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex min-h-[60px] w-full max-w-[1320px] items-center justify-between gap-4 px-5 sm:px-8">
          <div className="flex items-center gap-3">
            <span className="brand-mark" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </span>
            <span className="text-[15px] font-semibold tracking-[-0.015em]">Startups.board</span>
          </div>
          <div className="flex items-center gap-2 text-[13px] text-[var(--muted)]">
            <span className="size-2 rounded-full bg-[var(--success)]" aria-hidden="true" />
            <span className="tabular-nums">{formatTotal(total, totalCapped)}</span> live roles
          </div>
        </div>
      </header>

      <section className="mx-auto w-full max-w-[1320px] px-5 pb-24 pt-10 sm:px-8 sm:pt-12">
        <div className="mb-9 text-center">
          <span
            className="mx-auto mb-7 block h-[38px] w-24 rounded-xl"
            style={{ background: "var(--chip)" }}
            aria-hidden="true"
          />
          <h1
            className="mx-auto text-[clamp(34px,5vw,52px)] leading-[1.03] tracking-[-0.01em] text-balance"
            style={{ fontFamily: "var(--font-pixel), var(--font-inter), sans-serif", fontWeight: 500 }}
          >
            Join a high-growth startup
          </h1>
          <p className="mx-auto mt-4 max-w-[600px] text-[15px] leading-relaxed text-[var(--muted)]">
            Find{" "}
            <span className="font-semibold tabular-nums text-[var(--accent)]">{formatTotal(total, totalCapped)}</span>{" "}
            open roles at today&rsquo;s top startups. Updated daily.
          </p>
        </div>

        {/* Toolbar: live count on the left, date + filter toggle on the right. */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 px-1">
          <p aria-live="polite" className="text-sm font-medium text-[var(--muted-strong)]">
            <span className="tabular-nums text-[var(--ink)]">{formatTotal(total, totalCapped)}</span>{" "}
            {total === 1 ? "job" : "jobs"}
            {isLoading && <span className="ms-2 font-normal">Updating…</span>}
          </p>
          <div className="flex items-center gap-2">
            <DatePostedSelect filters={filters} update={update} />
            <button
              type="button"
              onClick={onToggleFilters}
              aria-expanded={filtersOpen}
              className={FILTER_PILL}
            >
              {filtersOpen ? "Hide Filters" : "Show Filters"}
            </button>
          </div>
        </div>

        {viewsToolbar && <div className="mb-4 rounded-2xl bg-[var(--surface)] p-1 shadow-[var(--shadow-panel)]">{viewsToolbar}</div>}

        <div className="flex flex-col items-start gap-5 lg:flex-row">
          <div className="min-w-0 flex-1">
            {jobsTable}
            {resultsFooter}
          </div>

          {filtersOpen && (
            <div className="w-full shrink-0 lg:w-[312px]">
              <FilterSidebar
                filters={filters}
                update={update}
                toggle={toggle}
                onSaveView={onSaveView}
                canSaveView={canSaveView}
                onClearAll={onClearAll}
                hasActiveFilters={hasActiveFilters}
              />
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

// The right-hand accordion of filter sections. Each section expands to a search-and-checklist
// (Title/Location/Industry/City) or a set of toggle pills (Workplace/Job type/ATS). Everything is
// wired to the same filter state and update/toggle handlers as the bar variant.
function FilterSidebar({
  filters,
  update,
  toggle,
  onSaveView,
  canSaveView,
  onClearAll,
  hasActiveFilters,
}: {
  filters: Filters;
  update: (patch: Partial<Filters>) => void;
  toggle: (key: FilterCategoryKey, value: string) => void;
  onSaveView: (name: string) => void;
  canSaveView: boolean;
  onClearAll: () => void;
  hasActiveFilters: boolean;
}) {
  const byKey = (key: FilterCategoryKey) => FILTER_CATEGORIES.find((entry) => entry.key === key)!;

  return (
    <aside aria-label="Filters" className="flex w-full flex-col gap-2.5">
      <SidebarSection Icon={IconLocate} label="Title" count={filters.title ? 1 : 0} defaultOpen>
        <TitleCheckList value={filters.title} onChange={(value) => update({ title: value })} />
      </SidebarSection>

      <SidebarSection Icon={IconPin} label="Location" count={filters.location ? 1 : 0}>
        <LocationSearch
          value={filters.location}
          onChange={(value) => update({ location: value, city: [] })}
        />
      </SidebarSection>

      <SidebarSection Icon={IconIndustry} label="Industry" count={filters.industry.length}>
        <SearchCheckList
          options={byKey("industry").options}
          selected={filters.industry}
          onToggle={(value) => toggle("industry", value)}
        />
      </SidebarSection>

      <SidebarSection Icon={IconGlobe} label="City" count={filters.city.length}>
        <SearchCheckList
          options={byKey("city").options}
          selected={filters.city}
          onToggle={(value) => toggle("city", value)}
        />
      </SidebarSection>

      <SidebarSection Icon={IconWorkplace} label="Workplace" count={filters.workplace.length}>
        <SidebarPills
          options={byKey("workplace").options}
          selected={filters.workplace}
          onToggle={(value) => toggle("workplace", value)}
          glyph="globe"
        />
      </SidebarSection>

      <SidebarSection Icon={IconJobType} label="Job type" count={filters.employmentType.length}>
        <SidebarPills
          options={byKey("employmentType").options}
          selected={filters.employmentType}
          onToggle={(value) => toggle("employmentType", value)}
        />
      </SidebarSection>

      <SidebarSection Icon={IconAts} label="ATS" count={filters.source.length}>
        <SidebarPills
          options={byKey("source").options}
          selected={filters.source}
          onToggle={(value) => toggle("source", value)}
          glyph="ats"
        />
      </SidebarSection>

      <SidebarSaveView onSaveView={onSaveView} canSaveView={canSaveView} />

      {hasActiveFilters && (
        <button
          type="button"
          onClick={onClearAll}
          className="mx-auto mt-0.5 inline-flex min-h-8 items-center rounded-lg px-3 text-[12px] font-medium text-[var(--muted-strong)] transition-colors duration-150 hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
        >
          Clear all filters
        </button>
      )}
    </aside>
  );
}

function SidebarChevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={`size-4 shrink-0 text-[var(--muted)] transition-transform duration-200 ${open ? "rotate-180" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4.5 6.5 8 10l3.5-3.5" />
    </svg>
  );
}

// One collapsible sidebar section: a header (icon, label, active-count badge, chevron) and the
// section's controls, shown while open.
function SidebarSection({
  Icon,
  label,
  count,
  defaultOpen = false,
  children,
}: {
  Icon: () => React.ReactElement;
  label: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-2xl bg-[var(--surface)] shadow-[var(--shadow-panel)]">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-2xl px-4 py-3.5 text-start transition-colors duration-150 hover:bg-[var(--control-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
      >
        {/* The line icons hard-code a muted stroke; the descendant selector overrides it so section
            headers read in the ink colour like the design. */}
        <span className="[&>svg]:text-[var(--ink)]"><Icon /></span>
        <span className="flex-1 text-[15px] font-semibold tracking-[-0.01em]">{label}</span>
        {count > 0 && (
          <span className="min-w-5 rounded-full bg-[var(--accent-wash)] px-1.5 py-0.5 text-center text-[12px] font-semibold tabular-nums text-[var(--accent-strong)]">
            {count}
          </span>
        )}
        <SidebarChevron open={open} />
      </button>
      {open && <div className="px-3 pb-3.5 pt-0.5">{children}</div>}
    </div>
  );
}

// The search box that heads Location and every checklist section.
function SidebarSearchInput({
  value,
  onChange,
  placeholder = "Search",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex min-h-10 items-center gap-2 rounded-xl bg-[var(--control-hover)] px-3">
      <IconSearch />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full min-w-0 bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
      />
    </div>
  );
}

// A search box over a static option list, with each match a checkbox row (multi-select).
function SearchCheckList({
  options,
  selected,
  onToggle,
}: {
  options: readonly { label: string; value: string }[];
  selected: string[];
  onToggle: (value: string) => void;
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
      <SidebarSearchInput value={query} onChange={setQuery} />
      <div className="mt-1 max-h-64 overflow-auto">
        {shown.map((option) => {
          const checked = selectedSet.has(option.value);
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onToggle(option.value)}
              aria-pressed={checked}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-start transition-colors duration-100 hover:bg-[var(--control-hover)]"
            >
              <span className="min-w-0 truncate text-sm text-[var(--ink)]">{option.label}</span>
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

// Free-text location search (a single value, unlike the checklist facets). Controlled straight off
// the filter value so an external reset (Clear all) empties it too.
function LocationSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div>
      <SidebarSearchInput value={value} onChange={onChange} placeholder="City, region or country" />
      <p className="px-2 pt-1.5 text-[12px] text-[var(--muted)]">Free-text match on the posting&rsquo;s location.</p>
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
    const timer = window.setTimeout(async () => {
      if (term.length < 2) {
        setSuggestions([]);
        return;
      }
      try {
        const response = await fetch(`${titlesUrl}?q=${encodeURIComponent(term)}`, { signal: controller.signal });
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
      <SidebarSearchInput value={query} onChange={setQuery} placeholder="Search titles" />
      <div className="mt-1 max-h-64 overflow-auto">
        {rows.map((row) => {
          const checked = row.title === value;
          return (
            <button
              key={row.title}
              type="button"
              onClick={() => onChange(checked ? "" : row.title)}
              aria-pressed={checked}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-start transition-colors duration-100 hover:bg-[var(--control-hover)]"
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
  glyph?: "globe" | "ats";
}) {
  return (
    <div className="flex flex-wrap gap-2 pt-0.5">
      {options.map((option) => {
        const checked = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onToggle(option.value)}
            aria-pressed={checked}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] ${
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
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// Full-width "Save view" control for the sidebar, mirroring the bar variant's naming flow.
function SidebarSaveView({
  onSaveView,
  canSaveView,
}: {
  onSaveView: (name: string) => void;
  canSaveView: boolean;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  function commit() {
    onSaveView(name);
    setName("");
    setNaming(false);
  }

  if (naming) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          commit();
        }}
      >
        <TextField aria-label="Name this view" autoFocus>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => (name.trim() ? commit() : setNaming(false))}
            onKeyDown={(event) => event.key === "Escape" && setNaming(false)}
            placeholder="View name"
            maxLength={40}
            className="min-h-11 w-full rounded-full border border-[var(--border)] bg-[var(--control)] px-4 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
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
      className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] text-sm font-medium text-[var(--ink)] shadow-[var(--shadow-panel)] transition-colors duration-150 hover:bg-[var(--control-hover)] disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
    >
      <IconPlus /> Save view
    </button>
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
      className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-dashed border-[var(--border)] bg-[var(--control)] px-3 text-sm font-medium text-[var(--ink)] transition-[background-color,scale] duration-150 hover:bg-[var(--control-hover)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
    >
      {Icon && <Icon />}
      <span className="text-[var(--muted)]">is</span>
      <span className="inline-flex max-w-48 items-center gap-1.5 truncate">
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

// The multistate Filter flyout: one anchored panel that starts on the category list and slides
// into a category's own panel (back chevron + "Is" tag in the header). Unlike AddFilterMenu's
// side-by-side panels, only one panel is ever visible. Reuses the sidebar's option controls:
// searchable checklists for the long facets, toggle pills for the short ones.
function FilterMenu({
  filters,
  toggle,
}: {
  filters: Filters;
  toggle: (key: FilterCategoryKey, value: string) => void;
}) {
  const [view, setView] = useState<"root" | FilterCategoryKey>("root");
  const card =
    "absolute left-0 top-[calc(100%+8px)] z-30 w-72 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-[var(--shadow-lift)]";

  if (view === "root") {
    return (
      <div className={card}>
        {FILTER_CATEGORIES.map((entry) => {
          const selected = filters[entry.key].length;
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => setView(entry.key)}
              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-start text-sm text-[var(--ink)] transition-colors duration-100 hover:bg-[var(--control-hover)]"
            >
              <entry.Icon />
              <span className="flex-1 font-medium">{entry.label}</span>
              {selected > 0 ? (
                <span className="min-w-5 rounded-full bg-[var(--accent-wash)] px-1.5 py-0.5 text-center text-[12px] font-semibold tabular-nums text-[var(--accent-strong)]">
                  {selected}
                </span>
              ) : (
                entry.badge && <span className="tabular-nums text-[13px] text-[var(--muted)]">{entry.options.length}+</span>
              )}
              <IconChevronRight />
            </button>
          );
        })}
      </div>
    );
  }

  const category = FILTER_CATEGORIES.find((entry) => entry.key === view) ?? FILTER_CATEGORIES[0];
  return (
    <div className={card}>
      <div className="flex items-center gap-1 px-1 pb-1.5 pt-1">
        <button
          type="button"
          onClick={() => setView("root")}
          aria-label="Back to all filters"
          className="flex size-7 items-center justify-center rounded-lg transition-colors duration-100 hover:bg-[var(--control-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
        >
          <IconChevronLeft />
        </button>
        <span className="flex-1 text-sm font-medium text-[var(--muted-strong)]">{category.label}</span>
        {/* Match-mode tag from the design; "is" is the only mode the query supports, so it is a
            static label rather than a control that pretends otherwise. */}
        <span className="inline-flex items-center gap-0.5 rounded-lg bg-[var(--control-hover)] px-2 py-1 text-[12px] font-medium text-[var(--muted-strong)]">
          Is <IconUpDown />
        </span>
      </div>
      <div className="px-1 pb-1">
        {category.key === "workplace" || category.key === "employmentType" || category.key === "source" ? (
          <SidebarPills
            options={category.options}
            selected={filters[category.key]}
            onToggle={(value) => toggle(category.key, value)}
            glyph={category.glyph}
          />
        ) : (
          <SearchCheckList
            options={category.options}
            selected={filters[category.key]}
            onToggle={(value) => toggle(category.key, value)}
          />
        )}
      </div>
    </div>
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

// v4 pill: 36px tall, 8px padding, 14px radius, a hairline shadow in place of a border, transparent
// fill until hover (the container itself has no fill).
const V4_PILL =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[14px] bg-transparent px-2 text-sm font-medium text-[var(--ink)] shadow-[var(--shadow-control)] transition-colors duration-150 hover:bg-[#F5F5FA] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";

// The v4 search field: 231x36, 14px radius, fills on hover/focus, a pink inset focus ring, the
// supplied glyphs, a clear button once there is text, and a clickable surround (the <label> focuses
// the input from anywhere in the box).
function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex h-9 w-[231px] shrink-0 cursor-text items-center gap-2 rounded-[14px] px-2 shadow-[var(--shadow-control)] transition-colors duration-150 hover:bg-[#F5F5FA] focus-within:bg-[#F5F5FA] focus-within:shadow-[var(--shadow-control),inset_0_0_0_1.5px_#FF73E5]">
      <IconSearchGlyph />
      <input
        aria-label="Search all job text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search"
        className="min-w-0 flex-1 bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="flex shrink-0 items-center justify-center rounded-full transition-opacity duration-150 hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]"
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
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} className={V4_PILL}>
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
        <div className={`absolute left-0 top-[calc(100%+8px)] z-30 ${width} rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-[var(--shadow-lift)]`}>
          {children}
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
  options: readonly { label: string; value: string }[];
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
      <SidebarSearchInput value={query} onChange={setQuery} />
      <div className="mt-1 max-h-64 overflow-auto">
        {shown.map((option) => {
          const checked = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(checked ? "" : option.value)}
              aria-pressed={checked}
              className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-start transition-colors duration-100 hover:bg-[var(--control-hover)] ${checked ? "bg-[var(--accent-wash)]" : ""}`}
            >
              <span className="min-w-0 truncate text-sm text-[var(--ink)]">{option.label}</span>
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

// The v4 filter row: an independent dropdown per filter, then a Search field and the date pill on
// the right. Every control is wired to the same filter state as the other variants.
function FilterDropdownBar({
  filters,
  update,
  toggle,
}: {
  filters: Filters;
  update: (patch: Partial<Filters>) => void;
  toggle: (key: FilterCategoryKey, value: string) => void;
}) {
  const options = (key: FilterCategoryKey) => FILTER_CATEGORIES.find((entry) => entry.key === key)!.options;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterDropdown Icon={IconLocate} label="Title" count={filters.title ? 1 : 0} width="w-72">
        <TitleCheckList value={filters.title} onChange={(value) => update({ title: value })} />
      </FilterDropdown>
      <FilterDropdown Icon={IconJobType} label="Job type" count={filters.employmentType.length} width="w-72">
        <SidebarPills options={options("employmentType")} selected={filters.employmentType} onToggle={(value) => toggle("employmentType", value)} />
      </FilterDropdown>
      <FilterDropdown Icon={IconWorkplace} label="Workplace" count={filters.workplace.length} width="w-72">
        <SidebarPills options={options("workplace")} selected={filters.workplace} onToggle={(value) => toggle("workplace", value)} glyph="globe" />
      </FilterDropdown>
      <FilterDropdown Icon={IconPin} label="Country" count={filters.country && filters.country !== "anywhere" ? 1 : 0}>
        <SearchSelectList options={countryOptions} value={filters.country} onChange={(value) => update({ country: value })} />
      </FilterDropdown>
      <FilterDropdown Icon={IconGlobe} label="City" count={filters.city.length}>
        <SearchCheckList options={options("city")} selected={filters.city} onToggle={(value) => toggle("city", value)} />
      </FilterDropdown>
      <FilterDropdown Icon={IconIndustry} label="Industry" count={filters.industry.length}>
        <SearchCheckList options={options("industry")} selected={filters.industry} onToggle={(value) => toggle("industry", value)} />
      </FilterDropdown>
      <FilterDropdown Icon={IconAts} label="ATS" count={filters.source.length} width="w-72">
        <SidebarPills options={options("source")} selected={filters.source} onToggle={(value) => toggle("source", value)} glyph="ats" />
      </FilterDropdown>

      <div className="ms-auto flex items-center gap-2">
        <SearchBox value={filters.search} onChange={(value) => update({ search: value })} />
        <DatePostedSelect filters={filters} update={update} triggerClass={V4_PILL} />
      </div>
    </div>
  );
}

// Shared pill: a standalone rounded, bordered control — the design uses these rather than one
// segmented bar.
const FILTER_PILL =
  "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--control)] px-3.5 text-sm font-medium text-[var(--ink)] transition-colors duration-150 hover:bg-[var(--control-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";

// The "Save view" control with its inline naming flow. Lives in the filter bar on v1; v3 places it
// in the selected-filters row instead (compact sizing to sit beside the chips).
function SaveViewPill({
  onSaveView,
  canSaveView,
  compact = false,
}: {
  onSaveView: (name: string) => void;
  canSaveView: boolean;
  compact?: boolean;
}) {
  const [naming, setNaming] = useState(false);
  const [viewName, setViewName] = useState("");
  const pill = compact
    ? "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--control)] px-3 text-sm font-medium text-[var(--ink)] transition-colors duration-150 hover:bg-[var(--control-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
    : FILTER_PILL;

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
            className={`${compact ? "min-h-9" : "min-h-11"} w-36 rounded-full border border-[var(--border)] bg-[var(--control)] px-4 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--muted)]`}
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
      className={`${pill} disabled:cursor-not-allowed disabled:opacity-55`}
    >
      <IconPlus /> Save view
    </button>
  );
}

// The compact filter bar, replicating the design's separate pills: Search, a divider, then Title /
// Location / Add filter, and — pushed right — a date pill and Save view. The remaining filters live
// behind "Add filter"; everything here is wired to the same filter state as the full panel.
function FilterBar({
  filters,
  update,
  toggle,
  onSaveView,
  canSaveView,
  menu = "panels",
}: {
  filters: Filters;
  update: (patch: Partial<Filters>) => void;
  toggle: (key: FilterCategoryKey, value: string) => void;
  onSaveView: (name: string) => void;
  canSaveView: boolean;
  // "panels" is the v1 two-panel Add filter flyout; "stack" is the v3 single multistate flyout.
  menu?: "panels" | "stack";
}) {
  const [openPill, setOpenPill] = useState<"title" | "location" | null>(null);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const titleRef = useRef<HTMLDivElement>(null);
  const locationRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close an open Title/Location popover when a pointer lands outside it.
  useEffect(() => {
    if (!openPill) return;
    const onPointerDown = (event: PointerEvent) => {
      const ref = openPill === "title" ? titleRef : locationRef;
      if (ref.current && !ref.current.contains(event.target as Node)) setOpenPill(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openPill]);

  // Same, for the Add filter flyout.
  useEffect(() => {
    if (!filterMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setFilterMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [filterMenuOpen]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Search */}
      <div className="inline-flex min-h-11 w-full min-w-0 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--control)] px-3.5 sm:w-80">
        <IconSearch />
        <input
          aria-label="Search all job text"
          value={filters.search}
          onChange={(event) => update({ search: event.target.value })}
          placeholder="Search"
          className="w-full min-w-0 bg-transparent text-base text-[var(--ink)] outline-none placeholder:text-[var(--muted)] sm:text-sm"
        />
      </div>

      <span aria-hidden="true" className="mx-0.5 hidden h-6 w-px bg-[var(--border)] sm:block" />

      {/* Title — opens a role-title typeahead */}
      <div ref={titleRef} className="relative">
        <button
          type="button"
          onClick={() => setOpenPill((current) => (current === "title" ? null : "title"))}
          aria-expanded={openPill === "title"}
          className={FILTER_PILL}
        >
          <IconLocate />
          <span className="max-w-40 truncate">{filters.title || "Title"}</span>
          <IconUpDown />
        </button>
        {openPill === "title" && (
          <div className="absolute left-0 top-[calc(100%+8px)] z-30 w-72 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-[var(--shadow-lift)]">
            <TitleCombobox value={filters.title} onChange={(value) => update({ title: value })} placeholder="Filter by role title" />
          </div>
        )}
      </div>

      {/* Location */}
      <div ref={locationRef} className="relative">
        <button
          type="button"
          onClick={() => setOpenPill((current) => (current === "location" ? null : "location"))}
          aria-expanded={openPill === "location"}
          className={FILTER_PILL}
        >
          <IconPin />
          <span className="max-w-40 truncate">{filters.location || "Location"}</span>
          <IconUpDown />
        </button>
        {openPill === "location" && (
          <div className="absolute left-0 top-[calc(100%+8px)] z-30 w-64 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-[var(--shadow-lift)]">
            <input
              autoFocus
              aria-label="Filter by location"
              value={filters.location}
              onChange={(event) => update({ location: event.target.value, city: [] })}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === "Escape") setOpenPill(null);
              }}
              placeholder="City, region or country"
              className="min-h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--control)] px-3 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
            />
          </div>
        )}
      </div>

      {/* Add filter / Filter — opens the faceted flyout (two-panel on v1, multistate on v3) */}
      <div ref={menuRef} className="relative">
        <button
          type="button"
          onClick={() => setFilterMenuOpen((open) => !open)}
          aria-expanded={filterMenuOpen}
          className={FILTER_PILL}
        >
          {menu === "stack" ? <><IconSliders /> Filter</> : <><IconPlus /> Add filter</>}
        </button>
        {filterMenuOpen && (menu === "stack"
          ? <FilterMenu filters={filters} toggle={toggle} />
          : <AddFilterMenu filters={filters} toggle={toggle} />)}
      </div>

      {/* Right group, pushed to the end */}
      <div className="ms-auto flex flex-wrap items-center gap-2">
        <DatePostedSelect filters={filters} update={update} />

        {/* Save view lives here on v1; v3 moves it into the selected-filters row instead. */}
        {menu !== "stack" && <SaveViewPill onSaveView={onSaveView} canSaveView={canSaveView} />}
      </div>
    </div>
  );
}

// Saved views (recall a whole filter set by name) and the company watchlist toggle. Both are
// device-local conveniences, kept in one slim toolbar above the results.
function ViewsToolbar({
  savedViews,
  currentQuery,
  onSaveView,
  onApplyView,
  onDeleteView,
  watchlistCount,
  watchlistOnly,
  onToggleWatchlistOnly,
  showSave = true,
}: {
  savedViews: SavedView[];
  currentQuery: string;
  onSaveView: (name: string) => void;
  onApplyView: (view: SavedView) => void;
  onDeleteView: (name: string) => void;
  watchlistCount: number;
  watchlistOnly: boolean;
  onToggleWatchlistOnly: () => void;
  // The compact filter bar already owns "Save view"; hide it here to avoid two save controls.
  showSave?: boolean;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  // A view captures the whole current filter set, so there is nothing to save on an unfiltered page.
  const canSave = currentQuery.length > 0;

  function commit() {
    onSaveView(name);
    setName("");
    setNaming(false);
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 px-1">
      <button
        type="button"
        onClick={watchlistCount > 0 ? onToggleWatchlistOnly : undefined}
        aria-pressed={watchlistOnly}
        disabled={watchlistCount === 0}
        title={watchlistCount === 0 ? "Star a company to build your watchlist" : "Show only watchlisted companies"}
        className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-[background-color,scale] duration-150 active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-55 ${
          watchlistOnly
            ? "bg-[var(--accent-strong)] text-white"
            : "bg-[var(--control)] text-[var(--ink)] enabled:hover:bg-[var(--control-hover)]"
        }`}
      >
        <span aria-hidden="true">{watchlistOnly ? "★" : "☆"}</span>
        Watchlist
        <span className="tabular-nums opacity-70">{watchlistCount}</span>
      </button>

      <span className="mx-0.5 h-4 w-px bg-[var(--border)]" aria-hidden="true" />

      {savedViews.map((view) => (
        <span
          key={view.name}
          className="inline-flex min-h-8 items-center gap-1 rounded-lg bg-[var(--control)] pe-1.5 ps-2.5 text-[12px] font-medium text-[var(--ink)]"
        >
          <button
            type="button"
            onClick={() => onApplyView(view)}
            title={`Apply saved view “${view.name}”`}
            className="rounded transition-colors duration-150 hover:text-[var(--accent-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
          >
            {view.name}
          </button>
          <button
            type="button"
            onClick={() => onDeleteView(view.name)}
            aria-label={`Delete saved view ${view.name}`}
            className="rounded px-0.5 text-[var(--muted)] transition-colors duration-150 hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
          >
            ×
          </button>
        </span>
      ))}

      {showSave && (naming ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            commit();
          }}
          className="inline-flex items-center gap-1"
        >
          <TextField aria-label="Name this view" autoFocus>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => (name.trim() ? commit() : setNaming(false))}
              onKeyDown={(event) => event.key === "Escape" && setNaming(false)}
              placeholder="View name"
              maxLength={40}
              className="min-h-8 w-32 rounded-lg border border-[var(--border)] bg-[var(--control)] px-2.5 text-[12px] text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
            />
          </TextField>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setNaming(true)}
          disabled={!canSave}
          title={canSave ? "Save the current filters as a view" : "Apply a filter first, then save it as a view"}
          className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2.5 text-[12px] font-medium text-[var(--muted-strong)] transition-colors duration-150 enabled:hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
        >
          <span aria-hidden="true">＋</span> Save view
        </button>
      ))}
    </div>
  );
}

// A searchable single-select: a text input that filters a static option list as you type and shows a
// dropdown of matches. Used where a plain dropdown is unwieldy (the ~200-entry country list) and
// where a pick and a free-text search should share one field (city).
//
// When `onFreeText` is supplied the field is dual-purpose: typing sets the free text (city -> a
// location substring search) and picking an option sets the exact value, each clearing the other.
// Sentinel key for the date Select: React Aria treats an empty-string key as "no selection".
const SELECT_EMPTY_KEY = " all";

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

function TableHeader({ jobType = false }: { jobType?: boolean } = {}) {
  if (jobType) {
    // v3 layout: employment type gets its own column and the lead headings carry small icons.
    const heading = (Icon: () => React.ReactElement, label: string) => (
      <span className="inline-flex items-center gap-1.5 [&>svg]:size-3.5">
        <Icon />
        {label}
      </span>
    );
    return (
      <tr className="bg-[var(--control-hover)]">
        <TableHeading className="w-[34%]">{heading(IconUser, "Role")}</TableHeading>
        <TableHeading className="w-[20%]">{heading(IconPin, "Location")}</TableHeading>
        <TableHeading className="w-[12%]">{heading(IconCalendar, "Posted")}</TableHeading>
        <TableHeading className="w-[12%]">Job type</TableHeading>
        <TableHeading className="w-[11%]">Workplace</TableHeading>
        <TableHeading className="w-[11%] text-end">Source</TableHeading>
      </tr>
    );
  }
  return (
    <tr className="bg-[var(--control-hover)]">
      {/* Role and company share one column: the title is what people scan for, so it leads and the
          company sits beneath it as context, rather than the company owning the first column. */}
      <TableHeading className="w-[41%]">Role</TableHeading>
      <TableHeading className="w-[22%]">Location</TableHeading>
      <TableHeading className="w-[13%]">Posted</TableHeading>
      <TableHeading className="w-[13%]">Workplace</TableHeading>
      <TableHeading className="w-[11%] text-end">Source</TableHeading>
    </tr>
  );
}

// fixedHeaderContent wants a niladic component, so the v3 header is a preset of TableHeader.
function TableHeaderWithJobType() {
  return <TableHeader jobType />;
}

function JobCells({
  job,
  onFilter,
  isWatched,
  onToggleWatch,
  now,
  jobType = false,
}: {
  job: Job;
  onFilter: (patch: Partial<Filters>) => void;
  isWatched: boolean;
  onToggleWatch: (company: string) => void;
  now: number;
  // v3 gives employment type its own column; the default stacks it under Workplace.
  jobType?: boolean;
}) {
  const postedDate = job.publishedAt ? new Date(job.publishedAt) : new Date(referenceDate);
  if (!job.publishedAt) {
    postedDate.setUTCDate(referenceDate.getUTCDate() - Math.max(0, (job.postedDaysAgo ?? 1) - 1));
  }
  // Relative label only for real timestamps, and only once `now` is set on the client (0 during SSR
  // -> null -> the absolute date renders, matching the server markup).
  const relative = job.publishedAt && now ? relativePosted(postedDate, now) : null;

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
                title={isWatched ? `Remove ${job.company} from watchlist` : `Add ${job.company} to watchlist`}
                className={`shrink-0 rounded text-[13px] leading-none transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] ${
                  isWatched ? "text-[var(--accent-strong)]" : "text-[var(--border)] hover:text-[var(--muted-strong)]"
                }`}
              >
                {isWatched ? "★" : "☆"}
              </button>
              <button
                type="button"
                onClick={() => onFilter({ company: job.company })}
                title={`Show only jobs at ${job.company}`}
                className="max-w-[52%] truncate rounded underline-offset-2 transition-colors duration-150 hover:text-[var(--ink)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
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
          <span aria-hidden="true" className="shrink-0 text-[13px] leading-none">
            {job.countryFlag ?? (job.workplace === "Remote" ? "🌍" : "")}
          </span>
          {job.location === "Location not specified" ? (
            <span className="truncate">{job.location}</span>
          ) : (
            <button
              type="button"
              // Filtering by the resolved city is far more useful than the raw string, which is
              // often a full address that would match only this one posting.
              onClick={() => (job.city ? onFilter({ city: [job.city], location: "" }) : onFilter({ location: job.location }))}
              title={job.city ? `Show only jobs in ${job.city}` : `Show only jobs in ${job.location}`}
              className="truncate rounded text-start underline-offset-2 transition-colors duration-150 hover:text-[var(--ink)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
            >
              {job.location}
            </button>
          )}
        </span>
      </td>
      <td className="whitespace-nowrap px-5 py-3.5 text-sm tabular-nums text-[var(--muted-strong)]">
        {/* suppressHydrationWarning: the relative label depends on the current time, so the server and
            client can legitimately render a slightly different string. title keeps the exact date. */}
        <time
          dateTime={postedDate.toISOString().slice(0, 10)}
          title={dateFormatter.format(postedDate)}
          suppressHydrationWarning
        >
          {relative ?? dateFormatter.format(postedDate)}
        </time>
      </td>
      {jobType && (
        <td className="px-5 py-3.5 text-sm text-[var(--ink)]">
          {job.employmentType ?? <span className="text-[var(--muted)]">—</span>}
        </td>
      )}
      <td className="px-5 py-3.5">
        {/* Workplace over employment type, stacked, matching the design's two-line Workplace column
            (the employment type used to sit in the role subtitle). v3 splits the type into its own
            column, so the cell is single-line there. */}
        <span className="flex flex-col leading-tight">
          <span className="text-sm text-[var(--ink)]">{job.workplace}</span>
          {!jobType && job.employmentType && (
            <span className="text-[12px] text-[var(--muted)]">{job.employmentType}</span>
          )}
        </span>
      </td>
      <td className="whitespace-nowrap px-5 py-3.5 text-end">
        <a
          href={job.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-10 items-center justify-end gap-2 rounded-lg px-2 text-sm font-medium text-[var(--muted-strong)] transition-colors duration-150 hover:text-[var(--accent-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
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
  // Rounded-square violet-gradient mark for companies without a logo, matching the design's app-icon
  // style logos.
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center rounded-[10px] text-[11px] font-bold tracking-[-0.02em] text-white outline outline-1 -outline-offset-1 outline-black/5"
      style={{ background: "linear-gradient(150deg, #b9a5ff 0%, #8f8bf6 100%)" }}
      aria-hidden="true"
    >
      {job.companyMark}
    </span>
  );
}


// Typeahead over real job titles. The role dropdown above filters by family (29 buckets); this
// completes the exact ~99,000 titles that actually exist, so a search cannot be typed for a title
// the index does not contain.
function TitleCombobox({
  value,
  onChange,
  bare = false,
  placeholder = "Role title",
}: {
  value: string;
  onChange: (value: string) => void;
  // `bare` drops the input's own border/height so it can sit inside the segmented filter bar.
  bare?: boolean;
  placeholder?: string;
}) {
  const [suggestions, setSuggestions] = useState<{ title: string; jobCount: number }[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  // Set while committing a suggestion so the resulting value change does not immediately refetch
  // and reopen the list under the user's cursor.
  const justPicked = useRef(false);

  useEffect(() => {
    if (justPicked.current) {
      justPicked.current = false;
      return;
    }
    const term = value.trim();
    const controller = new AbortController();
    // All state updates happen inside the debounce, never synchronously during the effect.
    const timer = window.setTimeout(async () => {
      if (term.length < 2) {
        setSuggestions([]);
        return;
      }
      try {
        const response = await fetch(`${titlesUrl}?q=${encodeURIComponent(term)}`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { titles: { title: string; jobCount: number }[] };
        setSuggestions(payload.titles ?? []);
        setHighlighted(-1);
      } catch {
        // A failed lookup just means no suggestions; the field still filters on what was typed.
      }
    }, 160);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [value]);

  function commit(title: string) {
    justPicked.current = true;
    onChange(title);
    setIsOpen(false);
    setSuggestions([]);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!isOpen || suggestions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + step + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter" && highlighted >= 0) {
      event.preventDefault();
      commit(suggestions[highlighted].title);
    } else if (event.key === "Escape") {
      setIsOpen(false);
    }
  }

  const showList = isOpen && suggestions.length > 0;

  return (
    <div className="relative min-w-0">
      <label className="sr-only" htmlFor="role-title-input">Filter by job title</label>
      <input
        id="role-title-input"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        // Blur is delayed so a click on a suggestion lands before the list unmounts.
        onBlur={() => window.setTimeout(() => setIsOpen(false), 120)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={showList}
        aria-controls="role-title-listbox"
        aria-autocomplete="list"
        aria-activedescendant={highlighted >= 0 ? `role-title-option-${highlighted}` : undefined}
        className={
          bare
            ? "w-24 min-w-0 bg-transparent text-base text-[var(--ink)] outline-none placeholder:text-[var(--muted)] sm:w-28 sm:text-sm"
            : "min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--control)] px-3.5 text-base text-[var(--ink)] outline-none shadow-none transition-[box-shadow,background-color] duration-150 placeholder:text-[var(--muted)] hover:bg-[var(--control-hover)] focus-visible:shadow-[0_0_0_2px_var(--focus)] sm:text-sm"
        }
      />

      {showList && (
        <ul
          id="role-title-listbox"
          role="listbox"
          className={`absolute top-[calc(100%+8px)] z-20 max-h-72 overflow-auto rounded-xl bg-white py-1 shadow-[var(--shadow-panel)] outline outline-1 -outline-offset-1 outline-black/10 ${
            bare ? "left-0 w-[260px]" : "inset-x-0"
          }`}
        >
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.title} id={`role-title-option-${index}`} role="option" aria-selected={index === highlighted}>
              <button
                type="button"
                // onMouseDown rather than onClick: onClick fires after blur has closed the list.
                onMouseDown={(event) => {
                  event.preventDefault();
                  commit(suggestion.title);
                }}
                onMouseEnter={() => setHighlighted(index)}
                className={`flex w-full items-center justify-between gap-3 px-3.5 py-2 text-start text-[13px] transition-colors duration-100 ${
                  index === highlighted ? "bg-[var(--control-hover)]" : "bg-transparent"
                }`}
              >
                <span className="truncate text-[var(--ink)]">{suggestion.title}</span>
                <span className="shrink-0 tabular-nums text-[12px] text-[var(--muted)]">
                  {suggestion.jobCount.toLocaleString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
