"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Input, TextField } from "@heroui/react";
import { TableVirtuoso, type TableComponents, type VirtuosoHandle } from "react-virtuoso";
import {
  sourceOptions,
  workplaceOptions,
  type Job,
} from "./jobs";
import { countryFlag, countryName, COUNTRY_OPTIONS } from "./countries";
import { CITY_OPTIONS, INDUSTRY_OPTIONS } from "./taxonomies";
import { AtsMark, warmAtsIcons } from "./ats-marks";
// Shared with the ingestion worker, which decides whether to STORE a logo using exactly these
// numbers. They used to be written out here and agree with the server by coincidence; the cost of
// that coincidence was 324,728 stored Workday URLs the server had no idea this file would reject.
import { isUsableLogoRatio } from "../../src/logo-shape.mjs";
// Its own module so a test can import and run it -- see the note there.
import { placeTip } from "./place-tip.mjs";
// Display normalisation for the free text a dozen ATSs return -- see the note in that file.
import { splitLocations, tidyEmploymentType, normalizeEmploymentKey } from "./format.mjs";

// In local dev the Miniflare D1 binding is empty, so the server render falls back to the bundled
// sample rows and the client reads the real index from the local SQLite API instead (npm run serve).
const apiUrl = typeof window !== "undefined" && window.location.hostname === "localhost"
  ? "http://localhost:3002/api/jobs"
  : "/api/jobs";
const titlesUrl = typeof window !== "undefined" && window.location.hostname === "localhost"
  ? "http://localhost:3002/api/titles"
  : "/api/titles";
const companiesUrl = typeof window !== "undefined" && window.location.hostname === "localhost"
  ? "http://localhost:3002/api/companies"
  : "/api/companies";

// Suggestion responses, kept for the session and keyed by request URL.
//
// Without this every open of a dropdown started from nothing: an empty list, a debounce, a fetch,
// and only then the rows -- so the panel opened short and grew a moment later, which is the jump.
// The list for a given query cannot change between two opens (the aggregates behind it are rebuilt
// once a day), so re-fetching it was pure latency. A cache hit renders the full list in the first
// paint, and prefetchSuggestions() below warms the default query before the panel is ever opened.
// Holds the PROMISE, not the resolved value. Caching the value only helps once the response has
// landed, so a warm started on pointerdown and a read started on click raced: the read found
// nothing, issued its own identical request, and the panel still opened empty and grew. Caching the
// promise means the second caller joins the first request instead of starting a second one.
const suggestionCache = new Map<string, Promise<unknown>>();
// What has actually resolved, for the synchronous read that seeds the first render.
const suggestionResults = new Map<string, unknown>();

function fetchSuggestions<T>(url: string): Promise<T> {
  let pending = suggestionCache.get(url) as Promise<T> | undefined;
  if (!pending) {
    // No signal: the request is shared, so one component unmounting must not abort it for another.
    // Callers guard against their own staleness instead.
    pending = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`Suggestions API returned ${response.status}`);
        return response.json() as Promise<T>;
      })
      .then((payload) => {
        suggestionResults.set(url, payload);
        return payload;
      })
      .catch((error) => {
        // A failed request must not be cached, or one blip poisons the dropdown for the session.
        suggestionCache.delete(url);
        throw error;
      });
    suggestionCache.set(url, pending);
  }
  return pending;
}

function cachedSuggestions<T>(url: string): T | undefined {
  return suggestionResults.get(url) as T | undefined;
}

// Warmed on pointer-down of the pill rather than on mount: it costs one request per dropdown and
// only for the dropdowns actually reached for, and a pointerdown lands well before the click that
// opens the panel -- so by the time it renders, the list is usually already in the cache.
export function prefetchSuggestions(url: string) {
  if (!suggestionCache.has(url)) void fetchSuggestions(url).catch(() => {});
}

// A cached list is applied without waiting for the debounce -- the debounce exists to avoid a
// request per keystroke, and there is no request to avoid.
const pageSize = 100;
// Shared by the results table and the skeleton stacked behind it, so the two layers are the same
// size and the cross-fade between them moves nothing.
// The floor the results card will not shrink past. Above it the card grows to fill the viewport
// (see the flex section below), so on a normal screen the page itself does not scroll and the
// sticky column header stays put. Below it -- a short window, a phone -- the page scrolls again
// rather than crushing the table into a few rows.
// How many role titles the Title dropdown pulls. There are ~99k distinct titles, so "all" is not a
// literal option -- this is the long tail worth scrolling, backed by the search box above it.
const TABLE_MIN_HEIGHT = "420px";
const TITLE_SUGGESTION_LIMIT = 200;
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
// `short` is what the pill shows: the full phrase made the date control the widest thing in the row
// for no gain, since the menu right below it spells every option out.
const postedWithinOptions = [
  { label: "Any time", short: "All", value: "" },
  { label: "Last 24 hours", short: "24h", value: "1" },
  { label: "Last 7 days", short: "7d", value: "7" },
  { label: "Last 30 days", short: "30d", value: "30" },
  { label: "Last 60 days", short: "60d", value: "60" },
  { label: "Last 90 days", short: "90d", value: "90" },
];
// `code` carries the ISO country so the checklists can render an SVG flag; the emoji is gone from
// the label (it lives in the <Flag> glyph now).
// Falls back to the city's country when a posting resolved one but not the other. Measured against
// production this currently never fires -- of 1.23M active jobs, 799k have a country and the other
// 436k have NEITHER a country nor a city, because the ATS location string was unparseable ("2
// Locations", "UHealth Doral DT"). Kept as insurance for when the ingester improves; adding flags to
// those 436k rows is an ingestion-side geocoding problem, not something the UI can infer.
const CITY_COUNTRY = new Map(CITY_OPTIONS.map((entry) => [entry.name.toLowerCase(), entry.country]));
function cityCountry(city: string | null | undefined) {
  return city ? CITY_COUNTRY.get(city.trim().toLowerCase()) ?? null : null;
}

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
  // Two ASCII letters, not merely two characters. `code` is job.country, ingested from a dozen ATS
  // payloads, and it goes straight into a remote URL below -- so what it is allowed to contain has
  // to be stated here rather than assumed of every upstream normalizer forever.
  if (!/^[a-z]{2}$/.test(cc)) return null;
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
  // Multi-select facets (comma-joined into the query, which already treats country/city/industry as
  // sets). The API caps each set at FILTER_VALUE_MAX values.
  country: string[];
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
  country: [],
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
  // De-duplicated: a hand-edited or double-appended "?industry=A,A" used to yield two chips with
  // the same React key, which collides in the list and makes removing one remove both.
  const list = (key: string) => [
    ...new Set((params.get(key) ?? "").split(",").map((v) => v.trim()).filter(Boolean)),
  ];
  return {
    search: params.get("search") ?? "",
    title: params.get("title") ?? "",
    location: params.get("location") ?? "",
    company: params.get("company") ?? "",
    // "anywhere" was a value the chip row rendered but the Country list had no option for, so it
    // showed as an active filter the dropdown reported as unset and only the chip could clear. It
    // means "no country filter", so it is normalised away on the way in.
    country: list("country").filter((value) => value !== "anywhere"),
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

// The query keys this page owns. Anything else in the URL belongs to whoever linked here and is
// preserved verbatim.
const FILTER_PARAM_KEYS = [
  "search", "title", "location", "company", "country", "city", "roleFamily", "industry",
  "workplace", "provider", "employmentType", "postedWithin", "sort", "watchlist",
];

function filtersToSearchParams(filters: Filters) {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.title.trim()) params.set("title", filters.title.trim());
  if (filters.location.trim()) params.set("location", filters.location.trim());
  if (filters.company.trim()) params.set("company", filters.company.trim());
  if (filters.country.length) params.set("country", filters.country.join(","));
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
type ActiveChip = { kind: ChipKind; label: string; value?: string; code?: string; logoUrl?: string | null; clear: () => void };

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
  // The search field's own busy flag, deliberately not `isLoading`. Two reasons they differ: the
  // 250ms debounce means a request has not even been issued yet for the quarter second after the
  // last keystroke, and isLoading is suppressed entirely when a cached page paints -- both of which
  // would leave the field looking idle while the results underneath it were still the old ones.
  // Raised in the change handler (a user event, so no cascading-render concern) and cleared where
  // the fetch settles.
  const [searchBusy, setSearchBusy] = useState(false);
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
  // The virtualizer keeps its scroll offset when the data underneath it changes, so applying a
  // filter while scrolled to row 250 dropped the user into the middle of the new 100-row set -- or
  // at its end, which immediately fired endReached and auto-paged. It reads as "the filter did
  // nothing". Reset to the top whenever a new result set replaces the old one.
  const tableRef = useRef<VirtuosoHandle>(null);
  // The results scroller, captured from virtuoso so the overlay scrollbar can measure it.
  const [scroller, setScroller] = useState<HTMLElement | null>(null);

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

  function toggle(key: FilterCategoryKey, value: string) {
    setFilters((current) => {
      const values = current[key];
      if (values.includes(value)) {
        return { ...current, [key]: values.filter((v) => v !== value) };
      }
      // The API keeps only the first FILTER_VALUE_MAX values of a set, so selecting past the cap
      // would silently do nothing. The dropdown disables further options at the cap; this is the
      // backstop for the paths that do not go through it (a hand-edited URL, a saved view).
      if (values.length >= FILTER_VALUE_MAX) return current;
      return { ...current, [key]: [...values, value] };
    });
  }

  // Hydrate the device-local watchlist and saved views from storage once, after the first render so
  // it cannot cause a server/client markup mismatch. The setState is the whole point of this mount
  // effect, so the cascading-render lint rule does not apply.
  useEffect(() => {
    // Not a setState -- it fills the module-level logo cache, and must run before the first rows
    // mount so recycled rows can read it.
    hydrateLogoOutcomes();
    warmAtsIcons();
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
    // Carry through anything the filter model does not own -- campaign tags, referrers -- instead of
    // erasing it from the address bar the moment the page hydrates.
    const merged = new URLSearchParams(window.location.search);
    for (const key of FILTER_PARAM_KEYS) merged.delete(key);
    for (const [key, value] of new URLSearchParams(urlQuery)) merged.set(key, value);
    const mergedQuery = merged.toString();
    const nextUrl = `${window.location.pathname}${mergedQuery ? `?${mergedQuery}` : ""}`;
    window.history.replaceState(null, "", nextUrl);
    queryRef.current = queryString;
    // A paging failure belongs to the result set it happened in. Left uncleared it was sticky for
    // the rest of the session: the footer kept reading "Couldn't load more jobs" over a perfectly
    // healthy new search, and automatic paging never resumed. Resetting state for the new query is
    // this effect's job, so the cascading-render rule does not apply.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
        tableRef.current?.scrollToIndex({ index: 0 });
      } catch (caught) {
        // An abort is this effect superseding itself, not a failure -- leave the state alone so the
        // newer request owns it.
        if ((caught as Error).name === "AbortError") return;
        console.error("Jobs fetch failed", caught);
        setError((caught as Error).message || "Could not load jobs");
      } finally {
        // An abort means a newer request has already taken over and will clear this itself, so the
        // superseded one must not put the field back to idle underneath it.
        if (!controller.signal.aborted) {
          setIsLoading(false);
          setSearchBusy(false);
        }
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
    if (filters.company.trim()) {
      // Taken from the rows already on screen rather than fetched: they are, by definition, this
      // company's jobs, so one of them carries its logo.
      const logoUrl = jobs.find((job) => job.company === filters.company.trim())?.companyLogoUrl ?? null;
      chips.push({ kind: "company", label: `Company: ${filters.company.trim()}`, value: filters.company.trim(), logoUrl, clear: () => update({ company: "" }) });
    }
    // The flag rides along as an ISO code so the chip renders the same SVG glyph as the dropdown,
    // rather than an emoji that only some platforms draw.
    for (const value of filters.country) {
      chips.push({
        kind: "country",
        label: countryName(value) ?? value,
        code: value,
        clear: () => toggle("country", value),
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
  }, [filters, watchlistActive, jobs]);

  // A small "Showing results for X" note when a typo'd search was auto-corrected.
  const correctionNote = (
    <div className={`row-collapse ${correctedTo ? "is-open" : ""}`}>
      <div>
        <p className="mb-2 px-1 text-[13px] text-[var(--muted-strong)]">
          Showing results for <span className="font-semibold text-[var(--ink)]">{correctedTo}</span>
        </p>
      </div>
    </div>
  );

  // Three states share the table's slot, in precedence order: rows if we have any (even stale ones
  // during a refetch), then the skeleton while the first page is in flight, then the failure or
  // empty panel. Showing rows over a pending refetch is deliberate -- swapping to a skeleton on
  // every keystroke would make a working search flicker.
  const jobsTable = (
    <>
    {correctionNote}
    <div className={`row-collapse ${error && jobs.length > 0 ? "is-open" : ""}`}>
      <div inert={error && jobs.length > 0 ? undefined : true}>
        <div role="status" className="mb-2 flex flex-wrap items-center gap-2 rounded-xl bg-[var(--danger-wash)] px-3 py-2 text-[13px] text-[var(--danger-ink)]">
          <span>These results may be out of date &mdash; the last refresh failed.</span>
          <button
            type="button"
            onClick={() => setRetryToken((token) => token + 1)}
            className="rounded font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
    {jobs.length > 0 || isLoading ? (
      // Skeleton and table are stacked in one slot and cross-faded, so the swap costs no layout and
      // reads as one motion. `is-revealed` flips the moment there are rows: when the server already
      // sent them it is true on the first paint (nothing was ever loading, so nothing animates), and
      // when a search starts from empty it transitions, which is exactly when the reveal is wanted.
      <div
        className={`t-skel min-h-0 flex-1 overflow-hidden rounded-[24px] shadow-[var(--shadow-table)] ${jobs.length > 0 ? "is-revealed" : ""}`}
        style={{ minHeight: TABLE_MIN_HEIGHT }}
      >
        <div className="jobs-skeleton t-skel-skeleton is-pulsing" aria-hidden="true">
          <JobsSkeleton />
        </div>
        <div className="t-skel-content relative">
          <TableVirtuoso
            ref={tableRef}
            aria-label="Startup jobs from public ATS pages"
            // The scroller fades its bottom edge while there is more below. Bottom only: the column
            // header is sticky inside this same scroller and a mask applies to sticky children too,
            // so a top fade would wash the header out the moment you scrolled.
            scrollerRef={(node) => {
              const el = node as HTMLElement | null;
              setScroller((current) => (current === el ? current : el));
              if (!el || el.dataset.fadeBound) return;
              el.dataset.fadeBound = "1";
              const sync = () => {
                const atEnd = Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight - 1;
                el.toggleAttribute("data-scroll-bottom", !atEnd);
                el.toggleAttribute("data-scroll-top", el.scrollTop > 1);
                // The top fade parks directly under the sticky column header, so it needs that
                // header's height -- measured rather than hardcoded, since it is styled in Tailwind
                // and changes with the type scale.
                const header = el.querySelector("thead");
                if (header) {
                  el.parentElement?.style.setProperty(
                    "--jobs-header-height",
                    `${header.getBoundingClientRect().height}px`,
                  );
                }
              };
              el.addEventListener("scroll", sync, { passive: true });
              // The edge flags were only ever recomputed on scroll, so they went stale whenever the
              // CONTENT changed without one -- narrowing a filter from a thousand rows to five left
              // data-scroll-bottom set, and the table kept a bottom fade over a list that had
              // nothing left to scroll. Watching the scroller and its content covers both the
              // container resizing and the rows underneath it changing.
              const resize = new ResizeObserver(sync);
              resize.observe(el);
              if (el.firstElementChild) resize.observe(el.firstElementChild);
              sync();
            }}
            className="jobs-table-scroll scroll-shadow bg-white"
            style={{ height: "100%" }}
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
            // 61, not 60: the row's content box is 60px (a 36px logo inside 12px padding), and the
            // separator adds a 1px border on top of that. The virtualizer positions every row from
            // this number, so a 1px understatement compounds -- a thousand rows down it has the
            // scroll height off by a thousand pixels. Measured in the browser, not inferred.
            fixedItemHeight={60}
            // Without this the virtualizer renders nothing until it has mounted and measured, so the
            // 100 rows the server already queried and shipped in the payload were invisible until
            // hydration -- and invisible to crawlers and no-JS visitors entirely. This paints the
            // first screenful during SSR; the virtualizer takes over from there.
            initialItemCount={Math.min(jobs.length, 12)}
            // 1,400px below the fold is ~23 rows of runway, which is what endReached fires on. At
            // 480px the request for the next page only started about half a second before the reader
            // reached the bottom, so they sat on an empty edge waiting for it.
            increaseViewportBy={{ top: 240, bottom: 1400 }}
            // Automatic paging stops after a failure so a scroll at the bottom cannot spin on a
            // broken endpoint; the footer's Retry calls loadMore directly.
            endReached={() => {
              if (!pagingError) void loadMore();
            }}
          />
          {/* Drawn as an overlay rather than folded into the scroller's mask: a mask fades sticky
              children too, so a top fade there would wash out the column header. */}
          <div className="jobs-table-top-fade" aria-hidden="true" />
          <OverlayScrollbar target={scroller} />
          {/* The count, floating over the foot of the table. It lands in the same 64px the bottom
              fade already dims, so it reads over emptying rows rather than over live ones, and
              pointer-events:none keeps the row underneath clickable through it. */}
          <p aria-live="polite" className="jobs-count-badge">
            <span className="tabular-nums text-[var(--ink)]">{formatTotal(total, totalCapped)}</span>{" "}
            {total === 1 ? "job" : "jobs"}
            {isLoading && <span className="ms-1.5 font-normal">Updating…</span>}
          </p>
        </div>
      </div>
    ) : error ? (
      <div role="alert" className="panel-in rounded-[24px] bg-white px-6 py-16 text-center shadow-[var(--shadow-table)]">
        <p className="text-base font-semibold">Couldn&rsquo;t load jobs</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-[var(--muted)]">
          The job index didn&rsquo;t respond. Your filters are still set &mdash; retrying will run the same search.
        </p>
        <div className="mt-5 flex justify-center">
          <PillButton onClick={() => setRetryToken((token) => token + 1)}>Try again</PillButton>
        </div>
      </div>
  ) : (
    <div className="panel-in rounded-[24px] bg-white px-6 py-16 text-center shadow-[var(--shadow-table)]">
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
    // Hidden: the count already sits above the table ("157,212 jobs") and "Scroll for more" told
    // people to do the thing they were already doing. The failure branch above stays -- a paging
    // error still needs somewhere to say so and offer a retry.
    null
  );

  return (
    <main className="min-h-screen bg-[var(--canvas)] text-[var(--ink)]">
      {/* The section owns the viewport and the results card takes whatever the hero and controls
          leave, so every pixel trimmed above goes straight into rows on screen. Kept deliberately
          tight for that reason. */}
      <section className="mx-auto flex min-h-[100dvh] w-full max-w-[1240px] flex-col px-5 pb-6 pt-8 sm:px-8 sm:pt-10">
        <div className="mb-8 text-center">
          {/* The description IS the headline now -- "Join a high-growth startup" said nothing this
              does not, and said it without the live count, which is the one number that tells a
              reader whether the page is worth their time.
              Smaller than the slogan it replaced (58px -> 40px cap) because a sentence set in a
              pixel display face at slogan size wraps to three lines and stops being readable; the
              max-width holds it to two. */}
          {/* One line at every width, which is what whitespace-nowrap plus a purely viewport-based
              size buys: the clamp has a low floor precisely so a 390px phone can still fit the
              sentence rather than breaking it. Inter, not the pixel face -- a display face is for
              three or four words, and this is a sentence with a number in it. */}
          <h1
            className="mx-auto whitespace-nowrap text-[clamp(15px,3.15vw,28px)] font-semibold leading-[1.15] tracking-[-0.02em]"
          >
            Find{" "}
            <span className="tabular-nums text-[var(--accent-strong)]">{formatTotal(total, totalCapped)}</span>{" "}
            open roles at today&rsquo;s top startups
          </h1>
        </div>

        {/* No panel chrome behind the filter row — the pills carry their own hairline shadow. */}
        <div>
          <FilterDropdownBar
            filters={filters}
            update={update}
            toggle={toggle}
            searchBusy={searchBusy}
            onSearchInput={() => setSearchBusy(true)}
          />

          {/* Selected filters as dashed "[icon] is [value]" chips, with Save view and Clear all
              pushed to the end of the same row. */}
          {/* Always mounted, collapsed to zero height when empty, so applying the first filter (or
              clearing the last) slides the table rather than shoving it 49px on the same frame the
              rows are changing. `inert` keeps the clipped controls out of the tab order. */}
          <div className={`row-collapse ${activeChips.length > 0 ? "is-open" : ""}`}>
            <div inert={activeChips.length === 0 ? true : undefined}>
              <div className="mt-3 flex flex-wrap items-center gap-[10px] border-t border-[var(--border)] pt-3">
                {activeChips.map((chip) => <FilterChip key={`${chip.kind}:${chip.label}`} chip={chip} />)}
                {/* Last in the row and wearing the chip's own dashed pill, because it belongs to the
                    filters rather than to the page -- it is the "and clear all of these" at the end
                    of the list, not a separate control parked on the right. Save view stays right:
                    it acts on the whole view, not on the chips. */}
                <ClearAllChip onClick={() => setFilters(emptyFilters)} />
                <span className="ms-auto flex items-center gap-[10px]">
                  <SaveViewPill onSaveView={saveView} canSaveView />
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* The count that used to sit here, in a band of its own, now floats over the foot of the
            table itself -- see .jobs-count-badge. It is a caption on the thing it counts, and every
            pixel it stops occupying above the card becomes another row inside it.
            The wrapper inherits the column layout the band's siblings used to get directly from the
            section, so the table still takes whatever height is left rather than its content's. */}
        <div className="mt-5 flex min-h-0 flex-1 flex-col">{jobsTable}</div>

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
const IconPlus = () => <LineIcon><path d="M8 3.5v9M3.5 8h9" /></LineIcon>;
const IconUpDown = () => <LineIcon><path d="M5.5 6.5 8 4l2.5 2.5M5.5 9.5 8 12l2.5-2.5" /></LineIcon>;
const IconUser = () => <LineIcon><circle cx="8" cy="5.3" r="2.4" /><path d="M3.5 13.5c0-2.4 2-3.9 4.5-3.9s4.5 1.5 4.5 3.9" /></LineIcon>;

// ---- Overlay scrollbar -----------------------------------------------------------------------
// Every scroll box here sits inside a rounded, clipped container, and a native scrollbar cannot live
// there cleanly. Left as a macOS overlay it is painted flush to the scroller's edge, so the card's
// 24px radius slices its ends off; styled into its own gutter it becomes an opaque 12px strip that
// cuts a white notch out of those same corners and pushes the last column inward. This is neither:
// it is a sibling of the scroller, so no ancestor clips it, and it is transparent until the box is
// scrolled or hovered.
const SCROLLBAR_FADE_MS = 900;
// Keeps both ends of the thumb clear of the container's corner radius.
const SCROLLBAR_INSET = 10;
const SCROLLBAR_MIN_THUMB = 32;

function OverlayScrollbar({ target }: { target: HTMLElement | null }) {
  // The track is measured from the RAIL, not from the scroller, because the rail starts below the
  // sticky column header (see --jobs-header-height in globals.css) while the scroller does not.
  // Sizing the thumb against the scroller would have made it overshoot the shorter track by exactly
  // the header's height.
  const rail = useRef<HTMLDivElement | null>(null);
  const [thumb, setThumb] = useState<{ top: number; height: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const fade = useRef(0);
  // Dragging the thumb scrolls the box, which means writing scrollTop on an element that arrived as
  // a prop. A ref is the sanctioned channel for that -- mutating the prop binding directly is what
  // the compiler lint objects to, and it is right to: it hides a side effect inside render's data
  // flow. The element is the same either way; only the path to it changes.
  const scroller = useRef<HTMLElement | null>(null);
  const drag = useRef<{ grabY: number; startScroll: number } | null>(null);

  const measure = useCallback(() => {
    if (!target) return setThumb(null);
    const { scrollHeight, clientHeight, scrollTop } = target;
    const overflow = scrollHeight - clientHeight;
    // Nothing to scroll, nothing to draw -- a track sitting over content that already fits reads as
    // an unexplained line down the edge of the card.
    if (overflow <= 1) return setThumb(null);
    const railHeight = rail.current?.clientHeight ?? clientHeight;
    const track = railHeight - SCROLLBAR_INSET * 2;
    const height = Math.max(SCROLLBAR_MIN_THUMB, Math.round((clientHeight / scrollHeight) * track));
    setThumb({ top: SCROLLBAR_INSET + (scrollTop / overflow) * (track - height), height });
  }, [target]);

  useEffect(() => {
    scroller.current = target;
    if (!target) return;
    // Measuring on mount is the whole point of this effect -- the thumb cannot be sized until the
    // scroller exists and has laid out -- so the cascading-render rule does not apply.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    measure();

    const hide = (delay: number) => {
      window.clearTimeout(fade.current);
      fade.current = window.setTimeout(() => {
        if (!drag.current) setVisible(false);
      }, delay);
    };
    const reveal = () => {
      window.clearTimeout(fade.current);
      setVisible(true);
    };
    const onScroll = () => {
      measure();
      reveal();
      hide(SCROLLBAR_FADE_MS);
    };

    target.addEventListener("scroll", onScroll, { passive: true });
    target.addEventListener("pointerenter", reveal);
    target.addEventListener("pointerleave", () => hide(300));
    // The scrollable height changes without the box resizing -- infinite scroll appends rows, a
    // filter replaces them, a dropdown list narrows as you type -- so watch the content, not just
    // the container.
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    if (target.firstElementChild) observer.observe(target.firstElementChild);

    return () => {
      target.removeEventListener("scroll", onScroll);
      observer.disconnect();
      window.clearTimeout(fade.current);
    };
  }, [target, measure]);

  if (!thumb) return null;

  return (
    <div ref={rail} className="overlay-scrollbar" data-visible={visible || undefined} aria-hidden="true">
      <div
        className="overlay-scrollbar-thumb"
        style={{ top: thumb.top, height: thumb.height }}
        onPointerDown={(event) => {
          const box = scroller.current;
          if (!box) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { grabY: event.clientY, startScroll: box.scrollTop };
        }}
        onPointerMove={(event) => {
          const held = drag.current;
          const box = scroller.current;
          if (!held || !box) return;
          const track = (rail.current?.clientHeight ?? box.clientHeight) - SCROLLBAR_INSET * 2;
          const travel = track - thumb.height;
          if (travel <= 0) return;
          // The pointer moves across the track; the content moves across its own overflow. One drag
          // of the full track must therefore cover the whole scroll range, not the track's length.
          const overflow = box.scrollHeight - box.clientHeight;
          box.scrollTop = held.startScroll + ((event.clientY - held.grabY) / travel) * overflow;
        }}
        onPointerUp={(event) => {
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      />
    </div>
  );
}

// ---- Tooltip for truncated text -------------------------------------------------------------
// A value the table or a filter list had to crop shows its full text on hover and on keyboard focus.
// Two things this does that the earlier CSS-only version could not: it renders into document.body,
// so it is not clipped by the very `overflow: hidden` that did the truncating (nor by the table's
// scroller), and it measures the element first, so a value that already fits gets no tooltip at all.
const TIP_DELAY = 120;

function TipBubble({
  anchor,
  label,
  closing,
  onDismiss,
  onClosed,
}: {
  anchor: DOMRect;
  label: string;
  // Kept mounted after hide() so the exit can play. It used to vanish on the frame the pointer left,
  // which read as a flicker against a 120ms entrance -- the two halves of one gesture, one animated
  // and one not.
  closing: boolean;
  onDismiss: () => void;
  onClosed: () => void;
}) {
  const bubble = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Measured before paint, so the bubble never flashes at the top-left corner on its way to place.
  useLayoutEffect(() => {
    const el = bubble.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos(placeTip(anchor, width, height, window.innerWidth));
  }, [anchor]);

  // Any scroll slides the anchor out from under the bubble. The listener is in the capture phase
  // because the scroll that matters is the table's own scroller, which does not bubble to window.
  useEffect(() => {
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    return () => {
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("resize", onDismiss);
    };
  }, [onDismiss]);

  return createPortal(
    <div
      ref={bubble}
      // The full text is already in the DOM -- truncation is purely visual -- so a screen reader
      // reads the value either way and announcing the bubble too would just double it.
      aria-hidden="true"
      className="tip-bubble"
      data-closing={closing ? "" : undefined}
      // Unmounting is driven by the animation finishing rather than by a timer that would have to
      // be kept in step with the CSS. Under prefers-reduced-motion the duration is 1ms rather than
      // `none`, precisely so this still fires and the bubble cannot get stuck on screen.
      onAnimationEnd={() => { if (closing) onClosed(); }}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, opacity: 0 }}
    >
      {label}
    </div>,
    document.body,
  );
}

// One hook, two behaviours. `measure` is what separates them: a truncation tooltip only earns its
// place when the text was actually cropped, while the "+2" locations badge stands in for places the
// cell never drew at all, so there is no overflow to detect and it always shows.
//
// These were two near-identical copies until the exit animation had to be added to both.
function useTip(label: string, measure: boolean) {
  const node = useRef<HTMLElement | null>(null);
  const timer = useRef(0);
  const [state, setState] = useState<{ anchor: DOMRect; closing: boolean } | null>(null);

  // Marks the bubble closing rather than dropping it, so the exit can play. TipBubble calls
  // `drop` when the animation ends.
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setState((current) => (current && !current.closing ? { ...current, closing: true } : current));
  }, []);

  const drop = useCallback(() => setState(null), []);

  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    // The delay keeps tooltips from strobing as the pointer sweeps down a column of rows.
    timer.current = window.setTimeout(() => {
      const el = node.current;
      if (!el) return;
      // scrollWidth exceeds clientWidth only where the text actually overflowed its box. The 1px
      // slack absorbs sub-pixel layout, which otherwise reports untruncated rows as truncated.
      if (measure && el.scrollWidth <= el.clientWidth + 1) return;
      // A fresh object even when re-showing mid-exit, so the bubble restarts rather than finishing
      // its way out under a pointer that has come back.
      setState({ anchor: el.getBoundingClientRect(), closing: false });
    }, TIP_DELAY);
  }, [measure]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const ref = useCallback((element: HTMLElement | null) => {
    node.current = element;
  }, []);

  return {
    open: state !== null && !state.closing,
    // Spread onto the element that does the truncating -- the one carrying `truncate`.
    tipProps: { ref, onPointerEnter: show, onPointerLeave: hide, onFocus: show, onBlur: hide },
    tip: state
      ? <TipBubble anchor={state.anchor} label={label} closing={state.closing} onDismiss={hide} onClosed={drop} />
      : null,
  };
}

const useHoverTip = (label: string) => useTip(label, false);
const useTruncationTip = (label: string) => useTip(label, true);

// Both states are always rendered and cross-faded, rather than one replacing the other. Swapping
// the elements meant the tick appeared fully formed with no acknowledgement that anything happened;
// this way the box reads as filling. 120ms, which is short enough to keep a list you are ticking
// through several options in feeling immediate.
function FilterCheckbox({ checked }: { checked: boolean }) {
  return (
    <span className="relative flex size-5 shrink-0 items-center justify-center">
      <span
        className={`absolute inset-0 rounded-md border-[1.5px] border-[var(--border)] transition-opacity duration-[120ms] ease-[var(--ease-out)] ${checked ? "opacity-0" : "opacity-100"}`}
      />
      <span
        className={`check-fill absolute inset-0 flex items-center justify-center rounded-md bg-[var(--ink)] ${checked ? "is-on" : ""}`}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 5" /></svg>
      </span>
    </span>
  );
}

// "city" has no dropdown of its own — it is set by clicking a location in the table and cleared from
// its chip — so it carries no option list here; "country" has one, but its options are the ISO list
// rather than a literal taxonomy.
type FilterCategoryKey = "industry" | "city" | "country" | "workplace" | "employmentType" | "source";

// How many values one facet may carry. addSetFilter() in jobs-query.ts keeps the first 12 and drops
// the rest, and the D1 statement has a 100-parameter ceiling that the watchlist shares -- so this is
// the API's cap surfaced in the UI rather than a preference.
const FILTER_VALUE_MAX = 12;

const FILTER_CATEGORIES: {
  key: Exclude<FilterCategoryKey, "city" | "country">;
  options: readonly { label: string; value: string }[];
}[] = [
  { key: "industry", options: INDUSTRY_OPTIONS.map((name) => ({ label: name, value: name })) },
  { key: "workplace", options: workplaceOptions.map((name) => ({ label: name, value: name })) },
  { key: "employmentType", options: employmentOptions.map((name) => ({ label: name, value: name })) },
  { key: "source", options: sourceOptions.map((name) => ({ label: name, value: name })) },
];

// One option row. Split out of the map below so it can hold the tooltip hook for its own label --
// a country like "South Georgia and the South Sandwich Islands" does not fit the popover.
function CheckOption({
  option,
  checked,
  disabled,
  onToggle,
}: {
  option: { label: string; value: string; code?: string };
  checked: boolean;
  disabled: boolean;
  onToggle: (value: string) => void;
}) {
  const tip = useTruncationTip(option.label);
  return (
    <button
      type="button"
      onClick={() => onToggle(option.value)}
      aria-pressed={checked}
      disabled={disabled}
      className="flex w-full items-center justify-between gap-2 rounded-[10px] px-2 py-1.5 text-start hover:bg-[var(--control-hover)] disabled:pointer-events-none disabled:opacity-40"
    >
      <span className="flex min-w-0 items-center gap-2 text-sm text-[var(--ink)]">
        <Flag code={option.code} />
        <span {...tip.tipProps} className="min-w-0 truncate">{option.label}</span>
        {tip.tip}
      </span>
      <FilterCheckbox checked={checked} />
    </button>
  );
}

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
  // Selected-but-unmatched values sort first so they never hide off the end of the list.
  //
  // Every match is rendered. There used to be a 50-row cap here with a "keep typing to narrow N
  // more" note under it, from when this list also served the 231-entry city picker -- city is now
  // set by clicking a location in the table and has no dropdown, so the only lists left are
  // Industry (13) and Country (62). The cap fired on exactly one of them and did nothing but hide
  // 12 countries behind a search box.
  const selectedSet = new Set(selected);
  const shown = [
    ...matches.filter((option) => selectedSet.has(option.value)),
    ...matches.filter((option) => !selectedSet.has(option.value)),
  ];
  // At the cap, unpicked options go inert rather than silently no-oping when clicked.
  const atCap = selected.length >= FILTER_VALUE_MAX;

  return (
    <div>
      {/* No `loading`: this list is filtered in memory from a fixed set of options, so there is
          never a request to wait for. */}
      <SearchBox full focusOnMount value={query} onChange={setQuery} label={searchLabel} />
      <ScrollShadow className="mt-1 max-h-64">
        {shown.map((option) => {
          const checked = selectedSet.has(option.value);
          return (
            <CheckOption
              key={option.value}
              option={option}
              checked={checked}
              disabled={atCap && !checked}
              onToggle={onToggle}
            />
          );
        })}
        {shown.length === 0 && (
          <p className="px-2 py-3 text-[13px] text-[var(--muted)]">No matches</p>
        )}
        {atCap && (
          <p className="px-2 pt-1 text-[14px] text-[var(--muted)]">{FILTER_VALUE_MAX} at a time — unselect one to add another.</p>
        )}
      </ScrollShadow>
    </div>
  );
}

// Placeholder rows for a list that is still loading, sized like the real ones so the panel does not
// resize under the cursor when they arrive.
function ListSkeleton({ rows = 9 }: { rows?: number }) {
  return (
    <div className="is-pulsing" aria-hidden="true">
      <div>
        {Array.from({ length: rows }, (_, row) => (
          <div key={row} className="flex items-center justify-between gap-2 px-2 py-[9px]">
            <span className="skeleton h-3 rounded" style={{ width: `${46 + ((row * 13) % 34)}%` }} />
            <span className="skeleton h-3 w-6 shrink-0 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

// Title picker: a search box that lists matching real job titles as checkbox rows. Title is a single
// value, so picking one replaces it and picking the selected one clears it.
// Company picker. Single-value like Title -- the filter is one substring match, so picking a second
// company would return nothing rather than both. Backed by the job_companies aggregate, so the
// count beside each name is exact and the list opens on the companies actually hiring most.
// The table's avatar at dropdown scale. Same fallback rule -- a monogram when there is no logo, and
// when the logo turns out to be unusable -- so a company looks the same in the list as in the rows.
function initialsOf(name: string) {
  return name.split(/[\s|_-]+/).filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("");
}

function CompanyMark({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  if (logoUrl && !failed) {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-[6px] bg-white outline outline-1 outline-offset-0 outline-[var(--border)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-full object-contain"
          onError={() => setFailed(true)}
          onLoad={(event) => {
            const img = event.currentTarget;
            if (!isUsableLogoRatio(img.naturalWidth, img.naturalHeight)) setFailed(true);
          }}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-5 shrink-0 items-center justify-center rounded-[6px] text-[11px] font-bold leading-none text-white"
      style={{ background: "var(--accent)" }}
    >
      {initialsOf(name)}
    </span>
  );
}

function CompanyCheckList({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [query, setQuery] = useState("");
  // Seeded from the cache so a warmed list is present in the FIRST render -- rendering empty and
  // filling in a moment later is exactly the jump this is here to remove.
  const initial = cachedSuggestions<{ companies: { company: string; jobCount: number; logoUrl: string | null }[] }>(
    `${companiesUrl}?q=&limit=100`);
  const [rows, setRows] = useState<{ company: string; jobCount: number; logoUrl: string | null }[]>(initial?.companies ?? []);
  const [state, setState] = useState<"loading" | "ready" | "failed">(initial ? "ready" : "loading");

  useEffect(() => {
    const term = query.trim();
    const controller = new AbortController();
    // Entering the loading state as the request starts is what this effect is for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState("loading");
    const timer = window.setTimeout(async () => {
      try {
        const payload = await fetchSuggestions<{ companies: { company: string; jobCount: number; logoUrl: string | null }[] }>(
          `${companiesUrl}?q=${encodeURIComponent(term)}&limit=100`);
        if (controller.signal.aborted) return;
        setRows(payload.companies ?? []);
        setState("ready");
      } catch (caught) {
        if ((caught as Error).name === "AbortError") return;
        console.error("Loading companies failed", caught);
        setState("failed");
      }
    }, 160);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  // The current selection is pinned at the top even when the search has moved elsewhere, so it can
  // always be unpicked without clearing the box first.
  const shown = value && !rows.some((row) => row.company === value)
    ? [{ company: value, jobCount: 0, logoUrl: null }, ...rows]
    : rows;

  return (
    <div>
      {/* These two lists fetch on every query change -- /api/companies and /api/titles, behind a
          160ms debounce -- so they have something to wait for and a spinner to show for it. The
          state they already tracked for the skeleton below is the same state the field needs. */}
      <SearchBox full focusOnMount value={query} onChange={setQuery} label="Search companies" loading={state === "loading"} />
      <ScrollShadow className="mt-1 max-h-80">
        {shown.map((row) => {
          const checked = row.company === value;
          return (
            <button
              key={row.company}
              type="button"
              onClick={() => onChange(checked ? "" : row.company)}
              aria-pressed={checked}
              className="flex w-full items-center justify-between gap-2 rounded-[10px] px-2 py-1.5 text-start hover:bg-[var(--control-hover)]"
            >
              <span className="flex min-w-0 items-center gap-2">
                <CompanyMark name={row.company} logoUrl={row.logoUrl} />
                <span className="min-w-0 truncate text-sm text-[var(--ink)]">{row.company}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {row.jobCount > 0 && (
                  <span className="tabular-nums text-[14px] text-[var(--muted)]">{row.jobCount.toLocaleString()}</span>
                )}
                <FilterCheckbox checked={checked} />
              </span>
            </button>
          );
        })}
        {shown.length === 0 && state === "loading" && <ListSkeleton rows={12} />}
        {shown.length === 0 && state !== "loading" && (
          <p className="px-2 py-3 text-[13px] text-[var(--muted)]">
            {state === "failed"
              ? "Couldn't load companies. Type a name to filter by it anyway."
              : "No matching companies"}
          </p>
        )}
      </ScrollShadow>
    </div>
  );
}

function TitleCheckList({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  // Starts empty, not seeded from the current selection. Seeding it meant reopening the dropdown
  // after picking "Product Designer" pre-filled the search with "Product Designer" and showed only
  // that one row, so there was no way to browse to a different title without clearing the box
  // first. The selection is still visible -- it is pinned as a checked row below.
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<{ title: string; jobCount: number }[]>([]);
  // A down titles endpoint used to render exactly the same "No matching titles" as a genuine
  // zero-result query, so a broken lookup was indistinguishable from an empty one.
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const term = query.trim();
    const controller = new AbortController();
    // Entering the loading state as the request starts is what this effect is for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState("loading");
    // An empty query fetches the most common titles, so the dropdown opens on a starting list.
    const timer = window.setTimeout(async () => {
      try {
        const payload = await fetchSuggestions<{ titles: { title: string; jobCount: number }[] }>(
          `${titlesUrl}?q=${encodeURIComponent(term)}&limit=${TITLE_SUGGESTION_LIMIT}`);
        if (controller.signal.aborted) return;
        setSuggestions(payload.titles ?? []);
        setState("ready");
      } catch (caught) {
        if ((caught as Error).name === "AbortError") return;
        setState("failed");
      }
    }, 160);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  // The current selection is always the first row, so what is filtered is visible the moment the
  // panel opens rather than buried a hundred rows down the list. It keeps its real count when the
  // suggestions include it, which they usually do.
  const selected = value ? suggestions.find((row) => row.title === value) ?? { title: value, jobCount: 0 } : null;
  const rows = selected
    ? [selected, ...suggestions.filter((row) => row.title !== value)]
    : suggestions;

  return (
    <div>
      <SearchBox full focusOnMount value={query} onChange={setQuery} placeholder="Search titles" label="Search job titles" loading={state === "loading"} />
      {/* Fixed height, not max-height: the panel used to open at the skeleton's ~200px and then jump
          to 320px the moment the suggestions arrived. Both states now occupy the same box. */}
      <ScrollShadow className="mt-1 max-h-80">
        {rows.map((row) => {
          const checked = row.title === value;
          return (
            <button
              key={row.title}
              type="button"
              onClick={() => onChange(checked ? "" : row.title)}
              aria-pressed={checked}
              className="flex w-full items-center justify-between gap-2 rounded-[10px] px-2 py-1.5 text-start hover:bg-[var(--control-hover)]"
            >
              <span className="min-w-0 truncate text-sm text-[var(--ink)]">{row.title}</span>
              <span className="flex shrink-0 items-center gap-2">
                {row.jobCount > 0 && (
                  <span className="tabular-nums text-[14px] text-[var(--muted)]">{row.jobCount.toLocaleString()}</span>
                )}
                <FilterCheckbox checked={checked} />
              </span>
            </button>
          );
        })}
        {rows.length === 0 && state === "loading" && <ListSkeleton rows={12} />}
        {rows.length === 0 && state !== "loading" && (
          <p className="px-2 py-3 text-[13px] text-[var(--muted)]">
            {state === "failed"
              ? "Couldn't load titles. Type a title to filter by it anyway."
              : "No matching titles"}
          </p>
        )}
      </ScrollShadow>
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
        const OptionIcon = glyph === "jobtype"
          ? JOB_TYPE_ICONS[option.value.toLowerCase()]
          : glyph === "globe"
            ? WORKPLACE_ICONS[option.value.toLowerCase()]
            : undefined;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onToggle(option.value)}
            aria-pressed={checked}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] ${
              checked
                ? "border-[var(--accent)]/30 bg-[var(--accent)]/15 text-[var(--accent-strong)]"
                : "border-[var(--border)] bg-[var(--surface)] text-[var(--ink)] hover:bg-[var(--control-hover)]"
            }`}
          >
            {/* The glyphs draw in currentColor, which on an unselected pill is the near-black label
                colour and reads heavier than the text beside it. Muting them to the same grey as
                the category icons in the filter row keeps the label the emphasis. Selected pills
                pass through, so the icon inverts to white with the text. */}
            {glyph === "ats" && (
              <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-white">
                <AtsMark source={option.value} size={4} />
              </span>
            )}
            {OptionIcon && <span className={checked ? "" : "text-[var(--glyph)]"}><OptionIcon /></span>}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ---- v3: dashed "is" chips + the single multistate Filter flyout ----


// One selected filter, rendered as the design's dashed pill: category icon, the word "is", the
// value (with its glyph — flag, globe, or ATS mark), and an ×. Clicking anywhere removes it.
// The same dashed pill a chip wears, so it reads as the last item in the row rather than a
// different kind of control. No leading mark: it stands for all of them, not for one value.
function ClearAllChip({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="chip-in inline-flex min-h-9 items-center gap-1.5 rounded-full border border-dashed border-[var(--border)] bg-[var(--control)] px-3 text-sm font-medium text-[var(--muted-strong)] transition-transform duration-[160ms] ease-[var(--ease-out)] hover:bg-[var(--control-hover)] hover:text-[var(--ink)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
    >
      Clear all
    </button>
  );
}

function FilterChip({ chip }: { chip: ActiveChip }) {
  // Only the company chip carries a leading mark now, and it is that company's logo -- so the chip
  // and the rows it filtered to look like the same company.
  const value = chip.value ?? chip.label;
  return (
    <button
      type="button"
      onClick={chip.clear}
      aria-label={`Remove filter ${value}`}
      className="chip-in inline-flex min-h-9 items-center gap-1.5 rounded-full border border-dashed border-[var(--border)] bg-[var(--control)] px-3 text-sm font-medium text-[var(--ink)] transition-transform duration-[160ms] ease-[var(--ease-out)] hover:bg-[var(--control-hover)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
    >
      {/* No leading category glyph. It named the FILTER ("this is a country filter") while the mark
          beside the value already names the VALUE (a flag, a globe, an ATS logo) -- two icons for one
          fact, and the redundant one came first. The company chip keeps its logo because that is the
          value's own mark, not a category label. */}
      {chip.kind === "company" && <CompanyMark name={value} logoUrl={chip.logoUrl ?? null} />}
      <span className="inline-flex max-w-48 items-center gap-1.5 truncate">
        {chip.code && <Flag code={chip.code} />}
        {chip.kind === "workplace" && WORKPLACE_ICONS[value.toLowerCase()] && (
          <span className="inline-flex [&>svg]:size-5 text-[var(--glyph)]">{(() => { const Glyph = WORKPLACE_ICONS[value.toLowerCase()]; return <Glyph />; })()}</span>
        )}
        {chip.kind === "source" && (
          <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-white">
            <AtsMark source={value} size={4} />
          </span>
        )}
        {value}
      </span>
      <IconCloseGlyph />
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
    <path d="M9.99969 0.791504C15.0662 0.791504 19.2085 4.93308 19.2087 9.99951C19.2087 15.0661 15.0663 19.2085 9.99969 19.2085C4.93326 19.2083 0.791687 15.066 0.791687 9.99951C0.791864 4.93319 4.93337 0.791681 9.99969 0.791504ZM7.58173 5.86084C7.10669 5.38588 6.33605 5.38587 5.86102 5.86084C5.386 6.33587 5.38605 7.10648 5.86102 7.58154L8.27899 9.99951L5.86102 12.4185C5.38629 12.8934 5.3864 13.6632 5.86102 14.1382C6.33608 14.6132 7.10667 14.6132 7.58173 14.1382L9.99969 11.7192L12.4186 14.1382C12.8937 14.6132 13.6633 14.6132 14.1384 14.1382C14.6134 13.6631 14.6134 12.8935 14.1384 12.4185L11.7194 9.99951L14.1384 7.58154C14.6134 7.10649 14.6134 6.33587 14.1384 5.86084C13.6634 5.38624 12.8936 5.38616 12.4186 5.86084L9.99969 8.27881L7.58173 5.86084Z" fill="currentColor" />
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
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-5 shrink-0">
    <path d="M7.74767 0.837057C11.7031 0.697582 15.0228 3.7907 15.1629 7.74613C15.303 11.7015 12.2104 15.0217 8.25504 15.1625C4.29877 15.3032 0.977649 12.2098 0.837525 8.2535C0.697401 4.29721 3.79136 0.976563 7.74767 0.837057ZM10.1412 7.54339C10.4672 7.34527 10.886 7.20878 10.9784 6.82323C11.0217 6.64746 10.9915 6.4616 10.8948 6.30857C10.8022 6.16209 10.6543 6.05932 10.4848 6.02369C10.3079 5.98665 10.1483 6.00843 9.99093 6.09664C9.56283 6.33655 9.13721 6.5818 8.7115 6.82595C8.7003 6.83237 8.67959 6.85036 8.66986 6.85867L8.66815 4.86489C8.66819 4.55015 8.68946 4.12664 8.64103 3.82396C8.59377 3.52865 8.22145 3.29224 7.91334 3.34672C7.63552 3.3822 7.37838 3.59453 7.3476 3.8845C7.32177 4.12768 7.33431 4.40393 7.33444 4.65101L7.33413 6.00872L7.33415 7.37449C7.33419 7.55058 7.34394 7.75939 7.33492 7.9391C7.31335 8.36903 7.66455 8.72499 8.10044 8.65444C8.36733 8.61124 8.69409 8.3424 8.94451 8.22516C9.34099 8.0128 9.74534 7.75023 10.1412 7.54339Z" fill="currentColor" />
  </svg>
);
const IconPartTime = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-5 shrink-0">
    <path d="M7.74569 0.837087C11.701 0.69716 15.0211 3.78975 15.1617 7.74506C15.3025 11.7004 12.2105 15.021 8.2552 15.1625C4.29886 15.3039 0.97712 12.2109 0.836403 8.25457C0.695687 4.2982 3.7893 0.977052 7.74569 0.837087ZM11.3155 11.7327C12.3105 10.8553 12.9131 9.61641 12.9891 8.29206C13.0662 6.96524 12.6125 5.66223 11.7279 4.6703C11.0792 3.94322 10.2318 3.4222 9.2902 3.17166C9.08917 3.11788 8.6973 3.02373 8.49083 3.05468C7.89755 3.14258 7.9998 3.84873 8.00036 4.28456L8.00077 5.44832L8.0009 9.14161L8.00088 11.4207L8 12.0522C7.99986 12.1637 7.99469 12.3463 8.01186 12.4508C8.03931 12.6131 8.12929 12.7581 8.26247 12.8547C8.45308 12.9902 8.6379 12.9591 8.85313 12.9244C9.7033 12.7869 10.6842 12.3296 11.3155 11.7327Z" fill="currentColor" />
  </svg>
);
const IconContract = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-5 shrink-0">
    <path d="M7.32482 0.838336C8.18355 0.827626 9.05534 0.83066 9.91439 0.839945C10.2052 0.843089 10.5831 0.872788 10.8657 0.928867C11.5447 1.07036 12.1624 1.4207 12.6324 1.93079C13.5472 2.90498 13.4998 3.90506 13.5004 5.151L13.5005 6.67686L13.501 8.36632C13.5012 8.6645 13.4995 8.97617 13.4998 9.28074C13.5184 10.0319 12.5101 10.2302 12.2437 9.55127C12.1707 9.36516 12.2033 8.68317 12.2034 8.45558L12.2028 5.64251C12.2026 4.98661 12.2325 4.24665 12.1176 3.5989C12.0726 3.34511 11.8614 3.01876 11.6888 2.82923C11.3103 2.41343 10.7761 2.17123 10.2133 2.16265C9.57109 2.14312 8.93441 2.13473 8.29176 2.1428C7.99893 2.15075 7.6903 2.12479 7.40138 2.17304C7.16252 2.21294 6.96521 2.49443 6.84628 2.68537C6.49371 3.2514 6.65431 3.89636 6.63153 4.52362C6.61328 5.02627 6.48254 5.48905 6.10027 5.84093C5.60268 6.30655 5.02392 6.32047 4.3828 6.29735C4.19468 6.28623 3.99612 6.28572 3.80326 6.28881C3.32816 6.29645 2.5765 6.62331 2.48141 7.14229C2.45638 7.27886 2.46425 7.55016 2.46414 7.70033L2.46386 8.57823C2.46383 9.57987 2.45111 10.5851 2.48714 11.5857C2.5016 11.9873 2.53709 12.4308 2.66313 12.8125C2.78769 13.2047 3.19199 13.6271 3.58175 13.7732C3.95882 13.9147 4.39254 13.9601 4.40875 14.4956C4.4149 14.668 4.35117 14.8356 4.23203 14.9604C3.97758 15.2284 3.70614 15.1847 3.38608 15.0902C2.89329 14.9447 2.54822 14.7139 2.17307 14.3735C1.27648 13.56 1.1994 12.3812 1.17555 11.2461C1.15788 10.3391 1.16659 9.40232 1.16695 8.48676L1.16929 7.13789C1.1722 6.49262 1.18734 5.84718 1.27257 5.20676C1.40883 4.18293 1.93055 3.24546 2.63861 2.50497C2.96759 2.16469 3.3404 1.86973 3.74723 1.62785C4.96014 0.900591 5.96096 0.867151 7.32482 0.838336Z" fill="currentColor" />
    <path d="M9.53948 8.50416C9.8488 8.49125 10.21 8.54893 10.4588 8.74968C11.493 9.58405 10.5746 11.2185 10.0711 12.095C9.92169 12.3551 9.70005 12.6356 9.52416 12.868C9.88321 12.789 10.178 12.6684 10.4951 12.4807C10.6273 12.4021 10.7553 12.3165 10.8784 12.2244C11.1505 12.0214 11.4801 11.7285 11.8374 11.758C12.7905 11.8369 12.5264 13.0222 13.045 13.5829C13.0721 13.6122 13.1414 13.6693 13.1714 13.6601C13.3634 13.6015 13.5747 13.2189 13.7017 13.0953C13.8385 12.9624 14.0024 12.9079 14.1662 12.9082C14.3464 12.9086 14.519 12.9815 14.6449 13.1105C14.7674 13.2387 14.8343 13.4103 14.8307 13.5877C14.8255 13.8615 14.6357 14.0762 14.4726 14.2787C13.8057 15.1071 12.8474 15.3086 12.0655 14.4894C11.803 14.2134 11.6045 13.7952 11.4859 13.4377C10.4535 14.0842 9.51428 14.4558 8.30287 14.074C8.24311 14.1148 8.18179 14.1633 8.12414 14.207C7.78898 14.4606 7.43451 14.6928 7.05949 14.8823C6.59828 15.1153 5.95718 15.3959 5.5958 14.8474C5.37843 14.5174 5.54973 14.0085 5.92501 13.8781C6.01239 13.8477 6.11502 13.8348 6.20311 13.8044C6.54223 13.6748 6.8435 13.4667 7.14814 13.2735C7.06841 13.1704 6.98419 13.0713 6.90783 12.9669C6.18045 11.9725 6.41691 10.736 7.18978 9.84186C7.77278 9.16734 8.62599 8.58119 9.53948 8.50416ZM8.01814 12.2239C8.06428 12.2803 8.10984 12.3379 8.16024 12.3904C8.72986 11.7715 9.18954 11.0986 9.46948 10.2996C9.50351 10.2025 9.59537 9.9519 9.58865 9.85479C9.57518 9.84685 9.58002 9.84626 9.56815 9.84693C9.0159 9.93767 8.41748 10.4006 8.0956 10.8478C7.76866 11.302 7.6816 11.7483 8.01814 12.2239Z" fill="currentColor" />
  </svg>
);
const IconInternship = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-5 shrink-0">
    <path d="M7.9062 1.50426C8.04231 1.49858 8.17867 1.50621 8.3133 1.52706C9.75837 1.73723 14.1124 3.62862 14.9626 4.78354C15.1074 4.98021 15.193 5.21052 15.153 5.45653C15.0736 5.94527 14.5439 6.31592 14.1726 6.58624C14.1567 6.7754 14.1672 7.1058 14.1672 7.30746L14.1676 8.66559L14.167 10.1285C14.1667 10.3431 14.1528 10.7282 14.1844 10.925C14.195 10.9911 14.4058 11.3692 14.4547 11.4639C14.7711 12.0767 15.1221 12.7791 15.1643 13.4793C15.1793 13.7278 15.0959 14.0028 14.9193 14.1799C14.6358 14.4638 14.2539 14.5046 13.8718 14.5023C13.385 14.4993 12.8011 14.5596 12.4221 14.1908C11.8122 13.5976 12.4675 12.2933 12.7667 11.6785C12.88 11.4458 13.068 11.147 13.1502 10.9097C13.1769 10.8327 13.1681 10.4747 13.168 10.3695L13.1672 9.49487L13.1671 7.20155C12.8553 7.36235 12.5624 7.52176 12.2462 7.67752C11.3376 8.12699 10.4009 8.51752 9.44214 8.84671C9.03112 8.98351 8.59624 9.12598 8.16249 9.16095C6.88733 9.26375 3.51197 7.61752 2.34263 6.91674C2.01332 6.71939 1.68925 6.50463 1.39682 6.25545C1.13683 6.0339 0.863157 5.74824 0.837825 5.38997C0.818679 5.11919 0.947497 4.87828 1.11973 4.67892C2.08722 3.55899 6.43179 1.61421 7.9062 1.50426Z" fill="currentColor" />
    <path d="M3.90919 8.89844C4.06774 8.91064 4.33947 9.05067 4.49629 9.1188C4.6581 9.18939 4.82079 9.25795 4.98431 9.3245C5.34723 9.47371 5.71464 9.61175 6.08604 9.73843C6.60852 9.91472 7.34906 10.1488 7.89649 10.1619C8.80148 10.1836 10.0379 9.71618 10.8763 9.38038C11.0971 9.29232 11.3162 9.20022 11.5336 9.10409C11.6428 9.05593 11.8991 8.93583 12.0038 8.91125C12.0938 8.89043 12.1885 8.9068 12.2662 8.95666C12.3944 9.03782 12.428 9.20026 12.4169 9.34134C12.3704 9.93839 12.3805 10.5493 12.3331 11.1448C12.3277 11.2174 12.3177 11.2896 12.3033 11.3609C12.2626 11.5559 12.1825 11.7238 12.0782 11.8907C12.0697 11.9031 12.0613 11.9154 12.0528 11.9277C11.5999 12.5748 10.4353 12.8931 9.70211 13.0281C8.15998 13.312 5.6201 13.2137 4.31409 12.2946C3.98237 12.0622 3.75662 11.7075 3.68652 11.3085C3.66495 11.1809 3.65931 11.0064 3.65281 10.8747L3.6211 10.0983L3.59533 9.56279C3.58014 9.25422 3.52454 8.96214 3.90919 8.89844Z" fill="currentColor" />
  </svg>
);

const IconRemoteF = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="size-5 shrink-0">
    <path d="M9.68379 1.04617C14.6279 0.872232 18.7771 4.73841 18.9525 9.6824C19.1277 14.6264 15.2628 18.7768 10.3188 18.9535C5.37293 19.1302 1.22056 15.2634 1.04517 10.3174C0.869775 5.37147 4.73781 1.22018 9.68379 1.04617ZM2.71417 9.15367C3.51503 9.61203 3.99771 9.59357 4.87303 9.61027C5.90095 9.6299 7.07164 9.95846 7.33598 11.094C7.56952 11.9608 7.39065 12.9259 7.51268 13.7909C7.61474 14.5142 8.06677 15.3015 8.13837 16.0586C8.17454 16.441 8.16467 16.7032 8.06328 17.0758C8.34021 17.135 8.58074 17.1956 8.86331 17.2394C9.79876 17.3833 10.7532 17.3467 11.6748 17.1315C12.011 16.456 12.2816 15.776 12.0212 15.017C11.9297 14.7505 11.8109 14.525 11.6847 14.2745C11.405 13.6905 11.2397 13.2173 11.4645 12.5523C11.5999 12.1521 11.8883 11.7594 12.283 11.5863C12.9552 11.2914 13.6839 11.4675 14.3986 11.2518C14.9246 11.0932 15.1077 10.9275 15.5542 10.6457C16.0824 10.3099 16.7081 10.1612 17.331 10.2235C17.3194 10.0873 17.3246 9.93074 17.3216 9.79152C17.3175 9.56061 17.3008 9.33009 17.272 9.10096C17.1402 8.02742 16.7716 6.99654 16.193 6.08276C16.1188 5.96552 15.9193 5.6615 15.8221 5.5648C14.8629 5.94506 14.7873 6.37014 14.0942 7.05523C13.2555 7.8924 12.0448 8.43844 10.8854 7.93199C10.3356 7.69181 9.92879 7.31229 9.69661 6.74822C9.50556 6.28404 9.53889 5.77592 9.35635 5.32234C9.26048 5.08407 8.84845 4.92668 8.63678 4.77694C8.39969 4.61107 8.19953 4.39786 8.04895 4.15077C7.93818 3.96461 7.85354 3.76409 7.79738 3.55487C7.77776 3.48065 7.70327 3.05676 7.70025 3.052L7.68178 3.04976C5.91917 3.59694 4.36691 4.96018 3.51126 6.58661C3.19451 7.18753 2.96384 7.83001 2.82604 8.49517C2.7801 8.71659 2.7574 8.94456 2.71417 9.15367Z" fill="currentColor" />
  </svg>
);

// Only Remote carries a glyph: a globe next to "On-site" was saying the opposite of the label.
const WORKPLACE_ICONS: Record<string, () => React.ReactElement> = {
  remote: IconRemoteF,
};


// The supplied 20px close glyph, drawn at the chip's scale.
const IconCloseGlyph = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="size-4 shrink-0">
    <path d="M15 5L10 10M10 10L5 15M10 10L15 15M10 10L5 5" stroke="#868990" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

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
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[14px] bg-white px-2 text-sm font-medium text-[var(--ink)] shadow-[var(--shadow-control)] transition-transform duration-[160ms] ease-[var(--ease-out)] hover:bg-[var(--control-hover)] active:bg-[var(--control-hover)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";

// A scrollable box that fades its own content at whichever edge still has more to scroll, so a long
// option list reads as continuing rather than ending. Driven off scroll position rather than a
// static gradient, so a list that already fits shows no fade at all.
function ScrollShadow({ className = "", children }: { className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });

  const measure = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const { scrollTop, scrollHeight, clientHeight } = node;
    setEdges({ top: scrollTop > 1, bottom: Math.ceil(scrollTop + clientHeight) < scrollHeight - 1 });
  }, []);

  // Re-measure when the list itself changes (typing in the search box filters it), not just on
  // scroll -- otherwise a list that shrinks to fit keeps a fade with nothing left to scroll to.
  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    // Same reason as the table: a list that shrinks under a search term changes height without ever
    // firing a scroll event, and a stale bottom flag leaves a fade with nothing behind it.
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    if (el.firstElementChild) resize.observe(el.firstElementChild);
    return () => resize.disconnect();
  }, [measure, children]);

  return (
    // The scrollbar is absolutely positioned against this wrapper rather than drawn by the scroller
    // itself, which is the whole point: the scroller clips its own overflow.
    <div className="relative">
      <div
        ref={(node) => {
          ref.current = node;
          setScroller((current) => (current === node ? current : node));
        }}
        onScroll={measure}
        data-scroll-top={edges.top || undefined}
        data-scroll-bottom={edges.bottom || undefined}
        className={`scroll-shadow ${className}`}
      >
        {children}
      </div>
      <OverlayScrollbar target={scroller} />
    </div>
  );
}

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
  focusOnMount = false,
  loading = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  full?: boolean;
  // Swaps the clear button for a spinner while this field's results are being fetched. Only the
  // page search passes it: a dropdown's list filters in memory, so there is nothing to wait for.
  loading?: boolean;
  // Set for the fields inside a dropdown: the popover mounts on open, so focusing on mount puts the
  // caret in the search box the moment the panel appears and you can type straight away.
  focusOnMount?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focusOnMount) return;
    // preventScroll because the popover is mid enter-animation (it translates and scales), and the
    // browser's default focus scroll would jerk the page toward it.
    inputRef.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  const shell = full
    ? "w-full bg-[var(--control-hover)] hover:bg-[var(--control-active)] focus-within:bg-[var(--control-hover)] focus-within:shadow-[inset_0_0_0_1.5px_var(--accent)]"
    : "w-[231px] bg-white shadow-[var(--shadow-control)] hover:bg-[var(--control-hover)] focus-within:bg-[var(--control-hover)] focus-within:shadow-[var(--shadow-control),inset_0_0_0_1.5px_var(--accent)]";
  return (
    <label className={`flex h-9 shrink-0 cursor-text items-center gap-2 rounded-[14px] px-2 ${shell}`}>
      <IconSearchGlyph />
      <input
        ref={inputRef}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
      />
      {/* The spinner takes the clear button's place rather than sitting beside it: the slot is 20px
          wide and adding a second glyph would shift the input's text on every keystroke burst. Both
          are the same size, so the swap moves nothing. */}
      {value && loading ? (
        <span className="search-spinner" role="status" aria-label="Searching" />
      ) : value ? (
        <button
          type="button"
          aria-label={`Clear ${label.toLowerCase()}`}
          onClick={() => onChange("")}
          className="flex shrink-0 items-center justify-center rounded-full text-[var(--glyph)] hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]"
        >
          <IconClearGlyph />
        </button>
      ) : null}
    </label>
  );
}

// One filter as a pill that toggles a popover of that filter's own controls. Each manages its own
// outside-click dismissal so several can sit side by side in the row.
function FilterDropdown({
  Icon,
  label,
  width = "w-64",
  align = "start",
  // The suggestion URL this dropdown will need, warmed on pointerdown so the list is already in the
  // cache by the time the panel renders. Dropdowns with no remote list leave it unset.
  prefetch,
  children,
}: {
  Icon: () => React.ReactElement;
  label: string;
  width?: string;
  prefetch?: string;
  // "end" hangs the panel off the trigger's right edge instead of its left, for pills near the end
  // of the row whose panel is wider than they are and would otherwise run off the viewport.
  align?: "start" | "end";
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
  const warm = useCallback(() => { if (prefetch) prefetchSuggestions(prefetch); }, [prefetch]);

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
        // pointerdown, not click: it fires on press, which buys the fetch the whole press-to-release
        // window before the panel renders. Focus covers keyboard users, who never send a pointer.
        onPointerDown={warm}
        onFocus={warm}
        onClick={() => setPhase((current) => (current === "open" ? "closing" : "open"))}
        aria-expanded={open}
        aria-haspopup="dialog"
        // An open dropdown carries the same focused treatment as the search field, so the pill the
        // panel belongs to is obvious when several sit side by side.
        className={`${V4_PILL} ${open ? "bg-[var(--control-hover)] shadow-[var(--shadow-control),inset_0_0_0_1.5px_var(--accent)]" : ""}`}
      >
        <Icon />
        <span>{label}</span>
        <IconUpDown />
      </button>
      {open && (
        <div
          role="group"
          aria-label={`${label} filter`}
          onAnimationEnd={() => setPhase((current) => (current === "closing" ? "closed" : current))}
          className={`t-resize ${phase === "closing" ? "dropdown-out" : "dropdown-in"} ${align === "end" ? "dropdown-end right-0" : "left-0"} absolute top-[calc(100%+8px)] z-30 ${width} rounded-[20px] border border-[var(--border)] bg-[var(--surface)] p-2 shadow-[var(--shadow-lift)]`}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}

// A searchable single-select list (Country): one value, a checkmark on the chosen row; clicking the
// chosen row clears it.
// The filter row: an independent dropdown per filter, then the Search field and the date pill on
// the right.
function FilterDropdownBar({
  filters,
  update,
  toggle,
  searchBusy,
  onSearchInput,
}: {
  filters: Filters;
  update: (patch: Partial<Filters>) => void;
  toggle: (key: FilterCategoryKey, value: string) => void;
  // The search field's spinner, and the keystroke that starts it. Raising the flag here rather than
  // deriving it in the effect keeps it out of a setState-in-effect, and means it goes up on the
  // keystroke itself instead of 250ms later when the debounce finally fires.
  searchBusy: boolean;
  onSearchInput: () => void;
}) {
  const options = (key: (typeof FILTER_CATEGORIES)[number]["key"]) =>
    FILTER_CATEGORIES.find((entry) => entry.key === key)!.options;
  return (
    // The pills and the search side are two groups, not one wrapping run. Without the inner
    // wrapper every control shared one flex line, so a narrow window pushed Search and the date
    // pill onto their own row and left-aligned them under the pills. Now only the pill group wraps;
    // the search side keeps its place on the right.
    <div className="flex items-start justify-between gap-[10px]">
      <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
      <FilterDropdown Icon={IconTitleF} label="Title" width="w-72" prefetch={`${titlesUrl}?q=&limit=${TITLE_SUGGESTION_LIMIT}`}>
        <TitleCheckList value={filters.title} onChange={(value) => update({ title: value })} />
      </FilterDropdown>
      <FilterDropdown Icon={IconUser} label="Company" width="w-72" prefetch={`${companiesUrl}?q=&limit=100`}>
        <CompanyCheckList value={filters.company} onChange={(value) => update({ company: value })} />
      </FilterDropdown>
      <FilterDropdown Icon={IconJobTypeF} label="Job type" width="w-72">
        <SidebarPills options={options("employmentType")} selected={filters.employmentType} onToggle={(value) => toggle("employmentType", value)} glyph="jobtype" />
      </FilterDropdown>
      <FilterDropdown Icon={IconWorkplaceF} label="Workplace" width="w-72">
        <SidebarPills options={options("workplace")} selected={filters.workplace} onToggle={(value) => toggle("workplace", value)} glyph="globe" />
      </FilterDropdown>
      <FilterDropdown Icon={IconCountryF} label="Country">
        <SearchCheckList options={countryOptions} selected={filters.country} onToggle={(value) => toggle("country", value)} searchLabel="Search countries" />
      </FilterDropdown>
      {/* Industry is hidden for now. The filter itself still works -- the URL parameter, the chip
          and the query are untouched -- it just has no pill of its own, the same arrangement City
          has. Worth knowing before bringing it back: 55% of active jobs have no industry at all,
          because ATSs do not supply one and it is inferred from the company. Selecting every
          option therefore returns barely half the index, which reads as broken. */}
      <FilterDropdown Icon={IconAtsF} label="ATS" width="w-72">
        <SidebarPills options={options("source")} selected={filters.source} onToggle={(value) => toggle("source", value)} glyph="ats" />
      </FilterDropdown>

      </div>
      <div className="flex shrink-0 items-center gap-[10px]">
        <SearchBox
          value={filters.search}
          loading={searchBusy}
          onChange={(value) => {
            // Only claim to be busy when the keystroke actually changes the QUERY, which is the
            // trimmed value -- that is what filtersToSearchParams puts in the URL and therefore what
            // the fetch effect keys on. Typing a trailing space, or retyping a value character for
            // character, leaves queryString identical, so the effect never re-runs and never reaches
            // the `finally` that would put the field back to idle: the spinner would stay up over
            // results that had already arrived.
            if (value.trim() !== filters.search.trim()) onSearchInput();
            update({ search: value });
          }}
        />
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
    <FilterDropdown Icon={IconDateF} label={current.short} width="w-44" align="end">
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
              className="flex items-center justify-between gap-2 rounded-[10px] px-2 py-1.5 text-start text-sm text-[var(--ink)] hover:bg-[var(--control-hover)]"
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

// The align prop is a prop rather than a className, because passing "text-end" alongside the base
// "text-start" put two conflicting utilities on one element -- and which of them wins is decided by
// Tailwind's emission order, not by the order they appear in the attribute. The Source heading
// asked to be right-aligned and was silently left-aligned over right-aligned cells.
function TableHeading({
  children,
  className = "",
  align = "start",
}: { children: React.ReactNode; className?: string; align?: "start" | "end" }) {
  return (
    <th
      scope="col"
      className={`px-5 pb-3 ${align === "end" ? "text-end" : "text-start"} text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--muted)] ${className}`}
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

// Clicking a row opens the posting in a new tab. It lives on the <tr> rather than wrapping cells in
// anchors, because a table row cannot legally contain one -- and a click that started on a control
// inside the row (the star, the company, the location, the source link) belongs to that control.
function VirtuosoRow({ item, ...rowProps }: React.ComponentPropsWithoutRef<"tr"> & { item: Job }) {
  return (
    <tr
      {...rowProps}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a,button")) return;
        window.open(item.url, "_blank", "noopener,noreferrer");
      }}
      className="cursor-pointer"
    />
  );
}

const virtuosoComponents = {
  Table: VirtuosoTable,
  TableRow: VirtuosoRow,
} satisfies TableComponents<Job>;

function TableHeader() {
  return (
    <tr className="bg-[var(--control-hover)]">
      {/* Role and company share one column: the title is what people scan for, so it leads and the
          company sits beneath it as context, rather than the company owning the first column. */}
      {/* "Title", matching the filter pill that searches it. A column and its filter calling one
          field two different names is the kind of mismatch that makes people wonder whether they
          are in fact two different things. */}
      <TableHeading className="w-[30%]">Title</TableHeading>
      <TableHeading className="w-[20%]">Location</TableHeading>
      <TableHeading className="w-[12%]">Job type</TableHeading>
      <TableHeading className="w-[11%]">Workplace</TableHeading>
      <TableHeading className="w-[12%]">Posted</TableHeading>
      {/* 15%. "SmartRecruiters" is the longest provider name at 15 characters -- longer than
          Greenhouse, which is what 13% was sized for -- and it needs the mark and the gap beside it
          too. The 2% comes off Role, which truncates gracefully and has the most to spare. */}
      <TableHeading className="w-[15%]" align="end">Source</TableHeading>
    </tr>
  );
}

// Shown while the first page is in flight, stacked under the real table and cross-faded out when
// rows arrive. It reuses the real table's header and 72px row height so the placeholder blocks sit
// exactly where the logo, title, company and each column will be, and nothing shifts on the swap.
// The container chrome lives on the .t-skel wrapper, which both layers share.
function JobsSkeleton() {
  return (
    <div className="h-full overflow-hidden bg-white">
      <table className="jobs-table w-full min-w-[1050px] border-separate border-spacing-0 text-start">
        <thead>
          <TableHeader />
        </thead>
        <tbody>
          {Array.from({ length: 8 }, (_, row) => (
            <tr key={row}>
              <td className="px-5 py-3">
                <div className="flex items-center gap-3">
                  <span className="skeleton size-9 shrink-0 rounded-[10px]" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="skeleton h-3.5 rounded" style={{ width: `${58 + ((row * 7) % 30)}%` }} />
                    <span className="skeleton h-2.5 w-1/3 rounded" />
                  </div>
                </div>
              </td>
              <td className="px-5 py-3"><span className="skeleton block h-3 w-2/3 rounded" /></td>
              <td className="px-5 py-3"><span className="skeleton block h-3 w-16 rounded" /></td>
              <td className="px-5 py-3"><span className="skeleton block h-3 w-14 rounded" /></td>
              <td className="px-5 py-3"><span className="skeleton block h-3 w-16 rounded" /></td>
              <td className="px-5 py-3"><span className="skeleton ms-auto block h-3 w-16 rounded" /></td>
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
  // Three columns crop their text at the cell edge; each gets the full value back on hover/focus.
  const titleTip = useTruncationTip(job.title);
  const companyTip = useTruncationTip(job.company);
  const places = splitLocations(job.location);
  // The badge stands for locations the cell never drew, so hovering it has to be able to show them.
  const extraTip = useHoverTip(places.all);
  // The tooltip carries the whole list, not just the entry the cell had room for.
  const locationTip = useTruncationTip(places.all);

  return (
    <>
      <td className="px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <CompanyLogo job={job} />
          <div className="min-w-0">
            {/* A real anchor, which is the only thing on this row that opens the posting for anyone
                not using a mouse. The whole action used to be an onClick on the <tr>: no tabIndex,
                no role, no key handler, so a keyboard user could reach the star, the company and the
                location and had no way at all to reach the job -- the one thing the page is for.
                That is WCAG 2.1.1 at level A. It also meant 1.24M postings had no href for a crawler
                to follow.
                A <td> may legally contain an anchor; it is wrapping the <tr> that is not allowed,
                which is what VirtuosoRow's comment is about. The row's own click handler already
                defers to anything inside it matching "a,button", so the two do not fight. */}
            <a
              {...titleTip.tipProps}
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="job-role-line block truncate rounded-sm text-sm font-semibold tracking-[-0.01em] text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
            >
              {job.title}
            </a>
            {titleTip.tip}
            <span className="job-meta-line flex min-w-0 items-center gap-1 text-[14px] text-[var(--muted)]">
              <button
                type="button"
                onClick={() => onToggleWatch(job.company)}
                aria-pressed={isWatched}
                aria-label={isWatched ? `Remove ${job.company} from watchlist` : `Add ${job.company} to watchlist`}
                title={isWatched ? `Remove ${job.company} from watchlist` : `Add ${job.company} to watchlist`}
                // Press-scale only, keyed on :active rather than on the starred state: rows are
                // virtualized, so anything keyed on mount would replay every time the row scrolls
                // back into view.
                className={`shrink-0 rounded text-[13px] leading-none transition-transform duration-[160ms] ease-[var(--ease-out)] active:scale-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] ${
                  isWatched ? "text-[var(--accent-strong)]" : "text-[var(--border)] hover:text-[var(--muted-strong)]"
                }`}
              >
                {isWatched ? "★" : "☆"}
              </button>
              <button
                type="button"
                onClick={() => onFilter({ company: job.company })}
                // The native title explains what clicking does; it is dropped while the truncation
                // tooltip is up so the two never stack on the same element.
                title={companyTip.open ? undefined : `Show only jobs at ${job.company}`}
                // The 52% cap existed to leave room for the category beside it; with that gone the
                // company gets the whole line, so names stop truncating for no reason.
                {...companyTip.tipProps}
                className="-mx-1 min-w-0 truncate rounded-md px-1 hover:bg-[var(--control-hover)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
              >
                {job.company}
              </button>
              {companyTip.tip}

            </span>
          </div>
        </div>
      </td>
      <td className="px-5 py-3 text-sm text-[var(--muted-strong)]">
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {job.country || cityCountry(job.city) ? (
            <Flag code={job.country || cityCountry(job.city)} />
          ) : (
            <span aria-hidden="true" className="shrink-0 text-[13px] leading-none">
              {job.workplace === "Remote" ? "🌍" : ""}
            </span>
          )}
          {job.location === "Location not specified" ? null : places.count !== null ? (
            // A bare count is not a place, so it is not made to look like one: no filter link (there
            // is nothing to filter by), no flag, and lowercase so it reads as a description of the
            // posting rather than the name of somewhere.
            <span className="min-w-0 truncate text-[var(--muted)]">
              {places.count > 0 ? `${places.count} locations` : "Multiple locations"}
            </span>
          ) : (
            <>
              <button
                type="button"
                // Filtering by the resolved city is far more useful than the raw string, which is
                // often a full address that would match only this one posting.
                onClick={() => (job.city ? onFilter({ city: [job.city], location: "" }) : onFilter({ location: places.primary }))}
                title={locationTip.open ? undefined : job.city ? `Show only jobs in ${job.city}` : `Show only jobs in ${places.primary}`}
                {...locationTip.tipProps}
                className="-mx-1.5 min-w-0 truncate rounded-lg px-1.5 py-1 text-start hover:bg-[var(--control-hover)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
              >
                {places.primary}
              </button>
              {/* The remaining places, as a count rather than a truncated run-on. The full list is
                  the tooltip, so nothing is hidden -- it just stops one posting in three from
                  spending the whole column on a semicolon-joined address list. */}
              {places.extra > 0 && (
                <>
                  <span
                    {...extraTip.tipProps}
                    tabIndex={0}
                    className="shrink-0 rounded-full bg-[var(--control-hover)] px-1.5 py-0.5 text-[12px] font-medium tabular-nums text-[var(--muted-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
                  >
                    +{places.extra}
                  </span>
                  {extraTip.tip}
                </>
              )}
            </>
          )}
          {locationTip.tip}
        </span>
      </td>
      <td className="px-5 py-3 text-sm text-[var(--ink)]">
        {/* Providers spell this every way there is -- "Full-Time", "full time", "Full Time" -- which
            is why the SQL filter matches on lower(replace(employment_type, '-', ' ')). The icon
            lookup has to normalise identically or the glyph appears for some spellings only. */}
        {/* Icon and label both come off the TIDIED value, so they can never disagree: keyed on the
            raw text, "Full-time Tier 2" read as an unknown type and lost its clock glyph while the
            label beside it said "Full time". */}
        <ValueWithIcon
          Icon={JOB_TYPE_ICONS[normalizeEmploymentKey(tidyEmploymentType(job.employmentType))]}
          value={tidyEmploymentType(job.employmentType)}
        />
      </td>
      <td className="px-5 py-3 text-sm text-[var(--ink)]">
        <ValueWithIcon Icon={WORKPLACE_ICONS[(job.workplace ?? "").toLowerCase()]} value={job.workplace} />
      </td>
      <td className="whitespace-nowrap px-5 py-3 text-sm tabular-nums text-[var(--muted-strong)]">
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
      {/* Source is a label, not a control. It was an anchor with its own hover colour and a chevron,
          which read as a second, different destination inside a row that already opens the posting
          on click -- two affordances for one action. The whole row is the link now. */}
      <td className="whitespace-nowrap px-5 py-3 text-end">
        <span className="inline-flex items-center justify-end gap-2 text-sm font-medium text-[var(--muted-strong)]">
          <AtsMark source={job.source} />
          {job.source}
        </span>
      </td>
    </>
  );
}

// What each logo URL turned out to be, remembered for the session. The virtualizer unmounts a row
// the instant it leaves the viewport and mounts a fresh component when it comes back, so per-row
// state cannot remember anything: scrolling back over rows replayed the skeleton and the fade-in on
// images the browser already had, and re-mounted (and re-measured) banners already known to be
// unusable. Keyed by URL rather than by job, so the second row from the same company is instant too.
const LOGO_CACHE_KEY = "startups-board:logo-outcomes";
// Bounded so the entry can never grow without limit; oldest are dropped when it overflows.
const LOGO_CACHE_MAX = 4000;

// Seeded from localStorage, so what a previous visit learned about a URL is known before the first
// paint of this one. That matters more than it sounds: a quarter of the index is Workday, whose
// logo URL is constructed rather than verified and almost always resolves to a wide header banner
// or a 404. Without this, every one of those was re-requested, decoded and re-rejected on every
// single page load -- hundreds of image fetches whose only possible outcome was the monogram that
// was already going to be drawn.
// Deliberately EMPTY at module scope, and filled by hydrateLogoOutcomes() after mount. Seeding it
// from storage during module evaluation would make the client's very first render disagree with the
// server's -- the server has no localStorage, so it renders a placeholder where the client would
// already render a finished logo (or a monogram) -- and that is a hydration mismatch. Filling it a
// tick later costs only the dozen rows the server sent; every row scrolled into view afterwards,
// which is the overwhelming majority, still reads the cache.
const logoOutcome = new Map<string, "ok" | "bad">();

export function hydrateLogoOutcomes() {
  for (const [url, outcome] of readStored<[string, "ok" | "bad"][]>(LOGO_CACHE_KEY, [])) {
    if (!logoOutcome.has(url)) logoOutcome.set(url, outcome);
  }
}

// Written back on a timer rather than on every settle: a screenful of rows resolves in a burst, and
// serialising 4,000 entries per image would cost more than the fetches saved.
let logoCacheFlush = 0;
function persistLogoOutcomes() {
  if (typeof window === "undefined") return;
  window.clearTimeout(logoCacheFlush);
  logoCacheFlush = window.setTimeout(() => {
    try {
      const entries = [...logoOutcome.entries()].slice(-LOGO_CACHE_MAX);
      window.localStorage.setItem(LOGO_CACHE_KEY, JSON.stringify(entries));
    } catch {
      // A full or disabled localStorage is not worth breaking the page over; the in-memory map
      // still works for this session.
    }
  }, 1_000);
}

// A table value carrying the same filled glyph its filter pill uses, so "Full time" reads the same
// in the row as it does in the dropdown it came from. Only some values have a glyph -- Unspecified
// and the long tail of provider-specific employment types do not -- and those simply render as text
// rather than reserving an empty slot that would misalign the column.
function ValueWithIcon({ Icon, value }: { Icon?: () => React.ReactElement; value: string | null }) {
  if (!value) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {Icon && <span className="inline-flex shrink-0 text-[var(--glyph)] [&>svg]:size-4"><Icon /></span>}
      <span className="min-w-0 truncate">{value}</span>
    </span>
  );
}

function CompanyLogo({ job }: { job: Job }) {
  const url = job.companyLogoUrl ?? "";
  // Seeded from the session map, so a recycled row renders its logo immediately instead of starting
  // over at the placeholder. Empty on the server and on the first client render, which is what keeps
  // the hydrated markup identical.
  const [outcome, setOutcome] = useState<"pending" | "ok" | "bad">(() => logoOutcome.get(url) ?? "pending");
  const failed = outcome === "bad";
  const loaded = outcome === "ok";

  const settle = useCallback((result: "ok" | "bad") => {
    logoOutcome.set(url, result);
    persistLogoOutcomes();
    setOutcome(result);
  }, [url]);

  // A URL already known to be unusable renders the monogram directly -- no <img>, so no request,
  // no decode, no skeleton flash on the way to the same result.
  if (job.companyLogoUrl && !failed) {
    // The ring sits OUTSIDE the tile (offset 0, not -1) so it frames the logo rather than cropping
    // a pixel off it, and uses the shared border token so it matches every other hairline here.
    return (
      <span className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[12px] bg-white outline outline-1 outline-offset-0 outline-[var(--border)]">
        {/* Kept mounted and faded out rather than unmounted on load: removing it in the same frame
            the image appears left one blank frame between the two, which is the pop this is here to
            remove. Both sides run the same 120ms so they cross-fade. */}
        <span
          className={`skeleton skeleton-pulse absolute inset-0 transition-opacity duration-[120ms] ease-[var(--ease-out)] ${loaded ? "opacity-0" : "opacity-100"}`}
          aria-hidden="true"
        />
        {/* Dynamic ATS logos are remote and cannot use a fixed Next image host allowlist. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={job.companyLogoUrl}
          alt=""
          // Eager, not lazy: virtualization already means only the rows near the viewport exist in
          // the DOM, so lazy loading added a second visibility check -- and its decode latency -- to
          // images that are about to be on screen either way.
          loading="eager"
          decoding="async"
          // Low priority: a logo is decoration next to the row text, and it must not compete with
          // the jobs request that fills the table in the first place.
          fetchPriority="low"
          referrerPolicy="no-referrer"
          // No inset: the logo fills the tile edge to edge. object-contain still keeps a
          // not-quite-square mark whole rather than cropping it -- only genuinely square logos
          // reach all four edges, which is the most that can be done without cutting a mark.
          className={`relative size-full object-contain transition-opacity duration-[120ms] ease-[var(--ease-out)] ${loaded ? "opacity-100" : "opacity-0"}`}
          // A cached image can finish before React attaches onLoad, which would leave the row stuck
          // on its placeholder. The ref catches that case on mount.
          ref={(node) => {
            if (node?.complete && node.naturalWidth > 0 && outcome === "pending") {
              settle(isUsableLogoRatio(node.naturalWidth, node.naturalHeight) ? "ok" : "bad");
            }
          }}
          onError={() => settle("bad")}
          // Workday's /assets/logo (and some others) return a wide header banner, which shrinks to
          // an invisible sliver inside the round avatar. Treat anything markedly non-square as a
          // failed logo so it falls back to the clean monogram.
          onLoad={(event) => {
            const img = event.currentTarget;
            settle(isUsableLogoRatio(img.naturalWidth, img.naturalHeight) ? "ok" : "bad");
          }}
        />
      </span>
    );
  }
  // Rounded-square gradient mark in the primary pink for companies without a logo, matching the
  // design's app-icon style logos.
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center rounded-[12px] text-[11px] font-bold tracking-[-0.02em] text-white outline outline-1 outline-offset-0 outline-[var(--border)]"
      style={{ background: "var(--accent)" }}
      aria-hidden="true"
    >
      {job.companyMark}
    </span>
  );
}

