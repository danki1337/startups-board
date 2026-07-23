"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Input, ListBox, SearchField, Select, TextField, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { TableVirtuoso, type TableComponents } from "react-virtuoso";
import {
  sourceOptions,
  workplaceOptions,
  type Job,
} from "./jobs";
import { COUNTRY_OPTIONS, countryFlag, countryName } from "./countries";
import { CITY_OPTIONS, INDUSTRY_OPTIONS, ROLE_FAMILY_OPTIONS } from "./taxonomies";
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

const employmentOptions = ["Full time", "Part time", "Contract", "Internship", "Temporary"];
const postedWithinOptions = [
  { label: "Any time", value: "" },
  { label: "Past 24 hours", value: "1" },
  { label: "Past week", value: "7" },
  { label: "Past 30 days", value: "30" },
  { label: "Past 90 days", value: "90" },
];
// "Anywhere" is remote-with-no-country -- a real answer, distinct from an unrecognised location.
const countrySelectOptions = [
  { label: "All countries", value: "" },
  { label: "🌍 Anywhere (remote)", value: "anywhere" },
  ...COUNTRY_OPTIONS.map((entry) => ({ label: `${entry.flag} ${entry.name}`, value: entry.code })),
];

const cityOptions = [
  { label: "All cities", value: "" },
  ...CITY_OPTIONS.map((entry) => ({
    label: `${countryFlag(entry.country) ?? ""} ${entry.name}`.trim(),
    value: entry.name,
  })),
];
const roleOptions = [
  { label: "All roles", value: "" },
  ...ROLE_FAMILY_OPTIONS.map((name) => ({ label: name, value: name })),
];
const industryOptions = [
  { label: "All industries", value: "" },
  ...INDUSTRY_OPTIONS.map((name) => ({ label: name, value: name })),
];

// Every filter lives in one object so URL sync, reset, and the active-chip row all read from a
// single source rather than five parallel useStates that could drift apart.
type Filters = {
  search: string;
  title: string;
  location: string;
  company: string;
  country: string;
  city: string;
  roleFamily: string;
  industry: string;
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
  city: "",
  roleFamily: "",
  industry: "",
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
    city: params.get("city") ?? "",
    roleFamily: params.get("roleFamily") ?? "",
    industry: params.get("industry") ?? "",
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
  if (filters.city) params.set("city", filters.city);
  if (filters.roleFamily) params.set("roleFamily", filters.roleFamily);
  if (filters.industry) params.set("industry", filters.industry);
  if (filters.workplace.length) params.set("workplace", filters.workplace.join(","));
  if (filters.source.length) params.set("provider", filters.source.join(","));
  if (filters.employmentType.length) params.set("employmentType", filters.employmentType.join(","));
  if (filters.postedWithin) params.set("postedWithin", filters.postedWithin);
  if (filters.sort !== "newest") params.set("sort", filters.sort);
  if (filters.watchlistOnly) params.set("watchlist", "1");
  return params;
}

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
}: {
  initialJobs?: Job[];
  initialTotal?: number;
  initialCursor?: string | null;
  hasServerData?: boolean;
  initialQuery?: string;
}) {
  // Seeded from the server-supplied query string rather than window.location, so the server and
  // client render identical markup. Reading window here caused a hydration mismatch whenever the
  // page was opened with filters already in the URL.
  const [filters, setFilters] = useState<Filters>(() => filtersFromSearchParams(initialQuery));
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [total, setTotal] = useState(initialTotal);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [isLoading, setIsLoading] = useState(false);
  const [isPaging, setIsPaging] = useState(false);
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
  const resultCache = useRef(new Map<string, { jobs: Job[]; total: number; cursor: string | null }>());

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

  function toggle(key: "workplace" | "source" | "employmentType", value: string) {
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
      resultCache.current.set(queryString, { jobs: initialJobs, total: initialTotal, cursor: initialCursor });
      return;
    }

    // Paint a previously-fetched page immediately, with no loading indicator; the request below still
    // runs to refresh it.
    const cached = resultCache.current.get(queryString);
    if (cached) {
      setJobs(cached.jobs);
      setTotal(cached.total);
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
        const payload = (await response.json()) as { jobs: Job[]; total: number; nextCursor: string | null };
        // Bounded LRU: re-inserting moves the key to the newest slot; the oldest is dropped past the cap.
        const cache = resultCache.current;
        cache.delete(queryString);
        cache.set(queryString, { jobs: payload.jobs, total: payload.total, cursor: payload.nextCursor });
        if (cache.size > 40) cache.delete(cache.keys().next().value as string);
        setJobs(payload.jobs);
        setTotal(payload.total);
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
  }, [queryString, urlQuery, initialJobs, initialTotal, initialCursor]);

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
    const chips: { label: string; clear: () => void }[] = [];
    if (filters.search.trim()) chips.push({ label: `“${filters.search.trim()}”`, clear: () => update({ search: "" }) });
    if (filters.location.trim()) chips.push({ label: `Location: ${filters.location.trim()}`, clear: () => update({ location: "" }) });
    if (filters.title.trim()) chips.push({ label: `Role: ${filters.title.trim()}`, clear: () => update({ title: "" }) });
    if (filters.company.trim()) chips.push({ label: `Company: ${filters.company.trim()}`, clear: () => update({ company: "" }) });
    if (filters.country) {
      const label = filters.country === "anywhere"
        ? "🌍 Anywhere"
        : `${countryFlag(filters.country) ?? ""} ${countryName(filters.country) ?? filters.country}`;
      chips.push({ label: label.trim(), clear: () => update({ country: "" }) });
    }
    if (filters.city) chips.push({ label: filters.city, clear: () => update({ city: "" }) });
    if (filters.roleFamily) chips.push({ label: filters.roleFamily, clear: () => update({ roleFamily: "" }) });
    if (filters.industry) chips.push({ label: filters.industry, clear: () => update({ industry: "" }) });
    for (const value of filters.workplace) chips.push({ label: value, clear: () => toggle("workplace", value) });
    for (const value of filters.source) chips.push({ label: value, clear: () => toggle("source", value) });
    for (const value of filters.employmentType) chips.push({ label: value, clear: () => toggle("employmentType", value) });
    if (filters.postedWithin) {
      const label = postedWithinOptions.find((option) => option.value === filters.postedWithin)?.label;
      chips.push({ label: label ?? filters.postedWithin, clear: () => update({ postedWithin: "" }) });
    }
    if (watchlistActive) chips.push({ label: "★ Watchlist", clear: () => update({ watchlistOnly: false }) });
    return chips;
  }, [filters, watchlistActive]);

  return (
    <main className="min-h-screen bg-[var(--canvas)] text-[var(--ink)]">
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
            <span className="tabular-nums">{total.toLocaleString()}</span> live roles
          </div>
        </div>
      </header>

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
            <span className="font-semibold tabular-nums text-[var(--accent)]">{total.toLocaleString()}</span>{" "}
            open roles at today&rsquo;s top startups. Updated daily.
          </p>
        </div>

        <div className="rounded-2xl bg-[var(--surface)] p-3 shadow-[var(--shadow-panel)]">
          <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            <SearchField
              aria-label="Search all job text"
              value={filters.search}
              onChange={(value) => update({ search: value })}
              fullWidth
              className="min-w-0"
            >
              <SearchField.Group className="min-h-11 rounded-xl border border-[var(--border)] bg-[var(--control)] px-3.5 shadow-none">
                <SearchField.SearchIcon className="text-[var(--muted)]" />
                <SearchField.Input
                  placeholder="Search everything"
                  className="text-base text-[var(--ink)] placeholder:text-[var(--muted)] sm:text-sm"
                />
                <SearchField.ClearButton aria-label="Clear job search" />
              </SearchField.Group>
            </SearchField>

            <FilterSelect
              label="Role"
              value={filters.roleFamily}
              options={roleOptions}
              onChange={(value) => update({ roleFamily: value })}
            />

            <FilterSelect
              label="Industry"
              value={filters.industry}
              options={industryOptions}
              onChange={(value) => update({ industry: value })}
            />

            <TitleCombobox
              value={filters.title}
              onChange={(value) => update({ title: value })}
            />

            <TextField aria-label="Filter by company name" fullWidth className="min-w-0">
              <Input
                value={filters.company}
                onChange={(event) => update({ company: event.target.value })}
                placeholder="Company name"
                className="min-h-11 rounded-xl border border-[var(--border)] bg-[var(--control)] px-3.5 text-base text-[var(--ink)] shadow-none placeholder:text-[var(--muted)] sm:text-sm"
              />
            </TextField>

            {/* Type-to-search over the full country list (~200 options is unwieldy as a plain dropdown). */}
            <SearchSelect
              label="Country"
              placeholder="Country"
              options={countrySelectOptions}
              value={filters.country}
              onSelect={(value) => update({ country: value })}
            />

            {/* Combined city control: search the known-cities list and pick one for an exact match, or
                type a free region string. Picking clears the free text and vice versa. */}
            <SearchSelect
              label="City or region"
              placeholder="City or region"
              options={cityOptions}
              value={filters.city}
              onSelect={(value) => update({ city: value, location: "" })}
              freeText={filters.location}
              onFreeText={(text) => update({ location: text, city: "" })}
            />

            <FilterSelect
              label="Date posted"
              value={filters.postedWithin}
              options={postedWithinOptions}
              onChange={(value) => update({ postedWithin: value })}
            />
          </div>

          <div className="mt-3 grid gap-2.5 border-t border-black/6 pt-3 lg:grid-cols-2 xl:grid-cols-3">
            <MultiSelect
              label="Workplace"
              options={workplaceOptions}
              selected={filters.workplace}
              onToggle={(value) => toggle("workplace", value)}
            />
            <MultiSelect
              label="Employment"
              options={employmentOptions}
              selected={filters.employmentType}
              onToggle={(value) => toggle("employmentType", value)}
            />
            <MultiSelect
              label="ATS"
              options={sourceOptions}
              selected={filters.source}
              onToggle={(value) => toggle("source", value)}
              withIcons
            />
          </div>

          {activeChips.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-black/6 pt-3">
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
            </div>
          )}
        </div>

        <ViewsToolbar
          savedViews={savedViews}
          currentQuery={urlQuery}
          onSaveView={saveView}
          onApplyView={(view) => setFilters(filtersFromSearchParams(view.query))}
          onDeleteView={(name) => setSavedViews((current) => current.filter((view) => view.name !== name))}
          watchlistCount={watchlist.length}
          watchlistOnly={watchlistActive}
          onToggleWatchlistOnly={() => update({ watchlistOnly: !filters.watchlistOnly })}
        />

        <div className="mb-3 mt-7 flex items-center justify-between gap-4 px-1">
          <p aria-live="polite" className="text-sm font-medium text-[var(--muted-strong)]">
            <span className="tabular-nums text-[var(--ink)]">{total.toLocaleString()}</span>{" "}
            {total === 1 ? "job" : "jobs"}
            {isLoading && <span className="ms-2 font-normal">Updating…</span>}
          </p>
        </div>

        {jobs.length > 0 ? (
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

        <p className="mt-4 text-center text-[13px] tabular-nums text-[var(--muted)]">
          Showing {jobs.length.toLocaleString()} of {total.toLocaleString()}
          {isPaging ? " · Loading…" : jobs.length < total ? " · Scroll for more" : ""}
        </p>
      </section>
    </main>
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
}: {
  savedViews: SavedView[];
  currentQuery: string;
  onSaveView: (name: string) => void;
  onApplyView: (view: SavedView) => void;
  onDeleteView: (name: string) => void;
  watchlistCount: number;
  watchlistOnly: boolean;
  onToggleWatchlistOnly: () => void;
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

      {naming ? (
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
      )}
    </div>
  );
}

// A searchable single-select: a text input that filters a static option list as you type and shows a
// dropdown of matches. Used where a plain dropdown is unwieldy (the ~200-entry country list) and
// where a pick and a free-text search should share one field (city).
//
// When `onFreeText` is supplied the field is dual-purpose: typing sets the free text (city -> a
// location substring search) and picking an option sets the exact value, each clearing the other.
function SearchSelect({
  label,
  placeholder,
  options,
  value,
  onSelect,
  freeText,
  onFreeText,
}: {
  label: string;
  placeholder: string;
  options: readonly { label: string; value: string }[];
  value: string;
  onSelect: (value: string) => void;
  freeText?: string;
  onFreeText?: (text: string) => void;
}) {
  const allowFreeText = typeof onFreeText === "function";
  const listboxId = useId();
  // null while the committed value is shown; a string once the user starts searching.
  const [query, setQuery] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);

  // "" values are the "All …" rows, treated as no selection so the field shows its placeholder.
  const selectedLabel = value ? options.find((option) => option.value === value)?.label ?? "" : "";
  const committed = value ? selectedLabel : (freeText ?? "");
  const inputValue = query ?? committed;

  const needle = query?.trim().toLowerCase() ?? "";
  const matches = useMemo(
    () => (needle ? options.filter((option) => option.label.toLowerCase().includes(needle)) : options).slice(0, 60),
    [needle, options],
  );

  // onSelect and onFreeText each apply a full filter update where one field clears the other (picking
  // a city clears the region text and vice versa), so exactly one is called per interaction --
  // calling both would have the second overwrite the first.
  function commit(option: { label: string; value: string }) {
    onSelect(option.value);
    setQuery(null);
    setIsOpen(false);
    setHighlighted(-1);
  }

  function clear() {
    onSelect("");
    setQuery(null);
    setHighlighted(-1);
  }

  function onType(text: string) {
    setQuery(text);
    setIsOpen(true);
    setHighlighted(-1);
    // Typing is a free-text search; the parent handler also clears any previously picked exact value.
    if (allowFreeText) onFreeText!(text);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setIsOpen(true);
      if (!matches.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + step + matches.length) % matches.length);
    } else if (event.key === "Enter") {
      if (isOpen && highlighted >= 0 && matches[highlighted]) {
        event.preventDefault();
        commit(matches[highlighted]);
      } else {
        setIsOpen(false);
      }
    } else if (event.key === "Escape") {
      setQuery(null);
      setIsOpen(false);
    }
  }

  const showList = isOpen && matches.length > 0;
  const hasValue = Boolean(value || (allowFreeText && freeText));

  return (
    <div className="relative min-w-0">
      <input
        value={inputValue}
        onChange={(event) => onType(event.target.value)}
        onFocus={(event) => {
          setIsOpen(true);
          event.target.select();
        }}
        // Delay so a click on an option lands before the list unmounts.
        onBlur={() => window.setTimeout(() => { setIsOpen(false); setQuery(null); }, 120)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listboxId}
        aria-autocomplete="list"
        autoComplete="off"
        className="min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--control)] py-2 pe-9 ps-3.5 text-base text-[var(--ink)] outline-none shadow-none transition-[box-shadow,background-color] duration-150 placeholder:text-[var(--muted)] hover:bg-[var(--control-hover)] focus-visible:shadow-[0_0_0_2px_var(--focus)] sm:text-sm"
      />
      {hasValue ? (
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={clear}
          aria-label={`Clear ${label}`}
          className="absolute inset-y-0 end-2.5 flex items-center rounded text-[var(--muted)] transition-colors duration-150 hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
        >
          ×
        </button>
      ) : (
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-xs text-[var(--muted)]">▾</span>
      )}

      {showList && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={label}
          className="absolute inset-x-0 top-[calc(100%+4px)] z-20 max-h-72 overflow-auto rounded-xl bg-white py-1 shadow-[var(--shadow-panel)] outline outline-1 -outline-offset-1 outline-black/10"
        >
          {matches.map((option, index) => (
            <li key={option.value || "__any"} role="option" aria-selected={option.value === value}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(option)}
                onMouseEnter={() => setHighlighted(index)}
                className={`flex w-full items-center px-3.5 py-2 text-start text-base sm:text-sm ${
                  index === highlighted ? "bg-[var(--control-hover)]" : ""
                } ${option.value === value && value ? "text-[var(--accent-strong)]" : "text-[var(--ink)]"}`}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// HeroUI's Select (a styled React-Aria listbox in a popover) rather than a native <select>: it gives
// keyboard typeahead, a themed panel that matches the rest of the controls, and selected/focused
// states we can drive from the design tokens. The prop shape is kept identical to the old native
// wrapper so every call site is unchanged.
//
// React Aria treats an empty-string key as "no selection" and would fall back to the placeholder, so
// the "All …" row's "" value is mapped to a sentinel key on the way in and translated back out.
const SELECT_EMPTY_KEY = " all";

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { label: string; value: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select
      aria-label={label}
      selectedKey={value === "" ? SELECT_EMPTY_KEY : value}
      onSelectionChange={(key) => onChange(key === SELECT_EMPTY_KEY ? "" : String(key ?? ""))}
      className="min-w-0"
    >
      <Select.Trigger className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--control)] py-2 pe-3 ps-3.5 text-base text-[var(--ink)] shadow-none outline-none transition-[box-shadow,background-color] duration-150 hover:bg-[var(--control-hover)] data-[focus-visible]:shadow-[0_0_0_2px_var(--focus)] sm:text-sm">
        <Select.Value className="min-w-0 truncate text-start" />
        <Select.Indicator className="shrink-0 text-xs text-[var(--muted)]">▾</Select.Indicator>
      </Select.Trigger>
      <Select.Popover className="max-h-72 min-w-[var(--trigger-width)] overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow-lift)]">
        <ListBox aria-label={label} items={options} className="outline-none">
          {(option) => (
            <ListBox.Item
              id={option.value === "" ? SELECT_EMPTY_KEY : option.value}
              textValue={option.label}
              className="flex min-h-9 cursor-pointer items-center rounded-lg px-3 text-base text-[var(--ink)] outline-none transition-colors duration-100 data-[focused]:bg-[var(--control-hover)] data-[selected]:bg-[var(--accent-wash)] data-[selected]:text-[var(--accent-strong)] sm:text-sm"
            >
              {option.label}
            </ListBox.Item>
          )}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

// Toggle pills rather than <select multiple>: the previous single-select made it impossible to ask
// for, say, Remote *and* Hybrid, which is the most common way people actually filter.
function MultiSelect({
  label,
  options,
  selected,
  onToggle,
  withIcons = false,
}: {
  label: string;
  options: readonly string[];
  selected: string[];
  onToggle: (value: string) => void;
  withIcons?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 px-0.5 text-[12px] font-medium text-[var(--muted)]" id={`filter-${label}`}>
        {label}
      </p>
      {/* HeroUI's ToggleButtonGroup over hand-rolled pills: it owns the selection state, roving
          focus and aria-pressed wiring that the previous buttons implemented by hand. isDetached
          keeps the pills visually separate rather than fusing them into a segmented control. */}
      <ToggleButtonGroup
        selectionMode="multiple"
        isDetached
        size="sm"
        aria-labelledby={`filter-${label}`}
        selectedKeys={new Set(selected)}
        onSelectionChange={(keys) => {
          const next = new Set([...keys].map(String));
          // The group reports the whole selection; translate it back into the single-value toggle
          // the filter state expects so URL sync and chips stay in one code path.
          for (const option of options) {
            if (next.has(option) !== selected.includes(option)) onToggle(option);
          }
        }}
        className="flex flex-wrap gap-1.5"
      >
        {options.map((option) => (
          <ToggleButton key={option} id={option} className="gap-1.5 rounded-lg text-[12px]">
            {withIcons && (
              <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-white">
                <AtsMark source={option} size={4} />
              </span>
            )}
            {option}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </div>
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
              onClick={() => (job.city ? onFilter({ city: job.city, location: "" }) : onFilter({ location: job.location }))}
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
      <td className="px-5 py-3.5">
        {/* Workplace over employment type, stacked, matching the design's two-line Workplace column
            (the employment type used to sit in the role subtitle). */}
        <span className="flex flex-col leading-tight">
          <span className="text-sm text-[var(--ink)]">{job.workplace}</span>
          {job.employmentType && (
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
function TitleCombobox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
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
        placeholder="Role title"
        autoComplete="off"
        role="combobox"
        aria-expanded={showList}
        aria-controls="role-title-listbox"
        aria-autocomplete="list"
        aria-activedescendant={highlighted >= 0 ? `role-title-option-${highlighted}` : undefined}
        className="min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--control)] px-3.5 text-base text-[var(--ink)] outline-none shadow-none transition-[box-shadow,background-color] duration-150 placeholder:text-[var(--muted)] hover:bg-[var(--control-hover)] focus-visible:shadow-[0_0_0_2px_var(--focus)] sm:text-sm"
      />

      {showList && (
        <ul
          id="role-title-listbox"
          role="listbox"
          className="absolute inset-x-0 top-[calc(100%+4px)] z-20 max-h-72 overflow-auto rounded-xl bg-white py-1 shadow-[var(--shadow-panel)] outline outline-1 -outline-offset-1 outline-black/10"
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
