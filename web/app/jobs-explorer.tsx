"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Input, TextField } from "@heroui/react";
import { TableVirtuoso, type TableComponents, type VirtuosoHandle } from "react-virtuoso";
import { TextMorph } from "torph/react";
import {
  sourceOptions,
  workplaceOptions,
  type Job,
} from "./jobs";
import { countryFlag, countryName, COUNTRY_OPTIONS } from "./countries";
import { CITY_OPTIONS, INDUSTRY_OPTIONS } from "./taxonomies";
import { AtsMark, warmAtsIcons } from "./ats-marks";
// One owner for "reveal an image once its pixels are actually here" -- see the note in that file
// for the cached-image trap it exists to keep out of five separate <img>s.
import { useImagePainted } from "./image-fade";
// Shared with the ingestion worker, which decides whether to STORE a logo using exactly these
// numbers. They used to be written out here and agree with the server by coincidence; the cost of
// that coincidence was 324,728 stored Workday URLs the server had no idea this file would reject.
import { isUsableLogoRatio } from "../../src/logo-shape.mjs";
// Its own module so a test can import and run it -- see the note there.
import { placeTip } from "./place-tip.mjs";
// Display normalisation for the free text a dozen ATSs return -- see the note in that file.
import { splitLocations, tidyEmploymentType, normalizeEmploymentKey } from "./format.mjs";
import { columnWidths } from "./column-widths.mjs";

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

// A national flag, served from our own origin.
//
// It used to be `https://flagcdn.com/{cc}.svg`, and that was slow for two compounding reasons. The
// first is the third party: a cross-origin DNS lookup and TLS handshake before the first flag byte
// arrives, on a host nothing else on the page uses. The second is the format, and it is the bigger
// one -- an SVG flag is vector artwork drawn at full detail regardless of the 18x13 box it lands in.
// Mexico's is 143,318 bytes. The same flag as a 40px PNG is 328. All 63 together are 13,606 bytes,
// which is a tenth of that ONE file.
//
// 40px wide for an 18px box, so it stays crisp on a 2x display. Vendored like the ATS marks above,
// for the same reasons stated there: no cross-origin request per row, and nothing breaks when a CDN
// rotates its paths.
// loading="lazy" is gone with them. It was deferring 300-byte same-origin images that are already on
// screen, which only ever added a visibility check between the row appearing and its flag doing so.
function Flag({ code }: { code?: string | null }) {
  const cc = (code ?? "").trim().toLowerCase();
  const [failed, setFailed] = useState(false);
  const { paint, fade } = useImagePainted();
  // Two ASCII letters, not merely two characters. `code` is job.country, ingested from a dozen ATS
  // payloads, and it goes straight into a URL below -- so what it is allowed to contain has to be
  // stated here rather than assumed of every upstream normalizer forever.
  if (!/^[a-z]{2}$/.test(cc)) return null;
  if (failed) {
    return <span aria-hidden="true" className="text-[13px] leading-none">{countryFlag(cc) ?? ""}</span>;
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={`/flags/${cc}.png`}
      alt=""
      width={18}
      height={13}
      decoding="async"
      ref={paint}
      onLoad={(event) => paint(event.currentTarget)}
      onError={() => setFailed(true)}
      className={`inline-block h-[13px] w-[18px] shrink-0 rounded-[3px] object-cover align-[-2px] outline outline-1 -outline-offset-1 outline-black/10 ${fade}`}
    />
  );
}

// 357px wide for a 119px box, and that number is the whole point: it is the size that survives BOTH
// the way this image gets painted. Neither larger nor smaller works, which took four comparisons to
// establish.
//
// Chrome downsamples with high-quality filtering while painting an image untransformed, and drops to
// a cheaper filter the moment a transform is involved. So:
//
//   - The old 707px master had to come down 2.97x to reach the 238 device pixels it occupies on a 2x
//     screen. Sharp at rest, because the good filter handled it -- and visibly aliased under the
//     hover tilt, which is the one moment the mark is being looked at closely.
//   - Pre-scaling to exactly 238px fixed the hover and broke the rest, because cwebp's resizer is
//     WORSE than Chrome's: side by side at rest, the 238px file was plainly softer and fatter than
//     the master. Chrome one-step canvas and multi-step halving both came closer but neither matched
//     it. That version shipped, and looked wrong.
//   - 357px is sharp in both. At rest Chrome's 1.5x downscale is gentle enough to wash the encoder's
//     softness out; under the transform there is only a 1.44x reduction left for the cheap filter to
//     spoil.
//
// One file, no srcset. A 2x screen fetches 16.6KB where it used to fetch 57KB, and a 3x screen gets
// it 1:1. Still lossless, for the reason it always was: at q92 this encodes larger, because lossy
// spends its bits on exactly the sharp flat-colour edges a logo is made of and pays for them in
// ringing around every letter.
//
// The 707px master is kept out of public/ at web/design/, so it is never served but this can be
// regenerated from it. width/height are the intrinsics, so the box is reserved from the ratio and
// the headline beneath never jumps.
// alt is the brand name, not empty: this is the only place the product names itself on screen, and
// a wordmark that reads as nothing is a wordmark that is not there.
function Wordmark() {
  const { paint, fade } = useImagePainted();
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src="/aboard-wordmark.webp"
      alt="Aboard"
      width={357}
      height={153}
      ref={paint}
      onLoad={(event) => paint(event.currentTarget)}
      className={`block h-[51px] w-auto ${fade}`}
    />
  );
}

// Locations that are a REGION rather than a country. These arrive with country = null, because
// there is no ISO code for a continent -- which is why "Europe" drew a globe emoji where every row
// around it drew a flag.
// The EU flag standing in for Europe is a deliberate approximation and not a correct one: the UK,
// Norway and Switzerland are all in the index and none of them are in the EU. It is used because at
// 18x13 it reads as "somewhere in Europe" faster than a globe does, and because the alternative --
// no mark at all -- leaves the column visibly ragged. The text beside it still says Europe.
// A CONTAINS check rather than an exact match, because the data does not write it one way: the
// index holds "Europe", "Remote - Europe", "Europe, Remote", "Remote-WesternEurope" and "UK/Europe |
// Portugal", and an exact map covered the first of those and left the rest with a globe.
// Safe as a last resort specifically because it IS last: a posting that carries a real country code,
// or a city that resolves to one, has already been answered before this runs -- so "Europe, France,
// Paris" flies the French flag, and only the ones with no country at all reach here.
const REGION_FLAGS: [RegExp, string][] = [[/\beurope\b|europe$|emea\b/i, "eu"]];

export function regionFlagCode(location?: string | null) {
  const text = (location ?? "").trim();
  if (!text) return null;
  for (const [pattern, code] of REGION_FLAGS) if (pattern.test(text)) return code;
  return null;
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

// The order chips are shown in: first applied, first in the row.
//
// The caller OWNS the order array and passes it in -- it must never be module state. This renders
// on the server too, where one isolate serves many visitors: a module-level array accumulated one
// visitor's application order and imposed it on the next request's chips, so two identical URLs
// rendered differently depending on who filtered before you -- and, because the client's copy
// always started empty, every polluted server render was a hydration mismatch on the chip row.
// Updated in place during render (not state): an effect would paint the OLD order first and
// reshuffle -- a visible flick on exactly the element that just changed.
// Reconciled rather than appended blindly: ids that no longer exist are dropped, so removing a chip
// and re-adding it puts it at the end again, which is what "when it was applied" means.
// Kinds that can only ever produce ONE chip. Their identity is the kind alone, deliberately: the
// label carries the live value, so keying on it meant every keystroke in the search box produced a
// new React key -- the chip unmounted and remounted, replaying its entrance animation on each
// character, and chipOrder saw an unfamiliar id and re-appended it, so it also jumped to the end of
// the row while you typed.
const SINGLETON_CHIPS = new Set(["search", "title", "company", "location", "roleFamily", "watchlist"]);

function chipId(chip: ActiveChip) {
  return SINGLETON_CHIPS.has(chip.kind) ? chip.kind : `${chip.kind}:${chip.label}`;
}

export function orderChips(chips: ActiveChip[], order: string[] = []) {
  const ids = chips.map(chipId);
  const present = new Set(ids);
  const known = new Set(order);
  order.splice(0, order.length,
    ...order.filter((id) => present.has(id)),
    ...ids.filter((id) => !known.has(id)),
  );
  const rank = new Map(order.map((id, index) => [id, index]));
  // Stable by construction: every id is in `rank`, because the order was just rebuilt from these
  // exact chips.
  return [...chips].sort((left, right) => rank.get(chipId(left))! - rank.get(chipId(right))!);
}

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

// The storage keys carry the OLD name on purpose. They are invisible to the reader, and renaming
// them would orphan every watchlist and saved view already on a device -- a rename is a cosmetic
// change and must not cost anyone their data. readStored() below reads the new key first and falls
// back to the old one, so a future rename can migrate rather than discard.
const WATCHLIST_KEY = "aboard:watchlist";
const WATCHLIST_KEY_LEGACY = "startups-board:watchlist";
const SAVED_VIEWS_KEY = "aboard:saved-views";
const SAVED_VIEWS_KEY_LEGACY = "startups-board:saved-views";

type SavedView = { name: string; query: string };

// `legacyKey` is what makes a rename free. Storage keys are invisible to the reader, so changing one
// buys nothing -- but every watchlist and saved view already on a device is written under the old
// key, and dropping it would cost people their data for a cosmetic change. New key first, old key
// as a fallback; the next write lands under the new name and the old entry simply stops being read.
function readStored<T>(key: string, fallback: T, legacyKey?: string): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key) ?? (legacyKey ? window.localStorage.getItem(legacyKey) : null);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

// The empty state, with transitions.dev texts-reveal (18-texts-reveal.md) on its four lines.
//
// This is the one place on the page where a stack of copy ENTERS as its own event: everywhere else
// content either was already there or arrives as table rows. Four lines rising 12px out of a 3px
// blur, 40ms apart, gives the reader's eye somewhere to land -- previously the whole card faded in
// as one flat block via .panel-in.
// .panel-in is GONE from this card on purpose. It scaled the whole 420px panel from 0.97, which
// under the stagger became two motions competing on one event -- the card growing while its own
// contents rose out of it. The background is now simply there, and only the content arrives.
// The icon and the button are lines 1 and 4 rather than being left static, because a stagger that
// skips the two most visible elements reads as a glitch rather than as rhythm.
function EmptyState({ onClear }: { onClear: () => void }) {
  const shown = useRevealed();
  return (
    <div
      className={`t-stagger flex min-h-0 flex-1 flex-col items-center justify-center rounded-[24px] bg-white px-6 py-16 text-center shadow-[var(--shadow-table)] ${shown ? "is-shown" : ""}`}
      style={{ minHeight: TABLE_MIN_HEIGHT }}
    >
      <span className="t-stagger-line t-stagger-line--1"><IconNoResults /></span>
      <p className="t-stagger-line t-stagger-line--2 mt-3 text-base font-bold">No matching jobs</p>
      {/* No full stop. It is a fragment offering two options, not a sentence, and the heading above
          it does not carry one either -- one of the pair had to give. */}
      <p className="t-stagger-line t-stagger-line--3 mt-1 text-sm text-[var(--muted)]">Try a broader search or clear a filter</p>
      <div className="t-stagger-line t-stagger-line--4 mt-5 flex justify-center">
        {/* The same dashed pill the filter row uses, not a second kind of button that does the same
            thing under a different name. Two controls for one action, worded differently, is the
            kind of thing that makes a reader stop and work out whether they differ. */}
        <ClearAllChip onClick={onClear} />
      </div>
    </div>
  );
}

// The width of a .t-morph container, measured so it can be tweened.
//
// Every state is in the DOM, overlaid in one grid cell, so each can be measured at any time. The
// container is then given the active one's width outright, which is the only way a width transition
// has two numbers to interpolate between; `auto` to `auto` animates nothing.
// useLayoutEffect, not useEffect: this runs before paint, so the width is already correct on the
// frame the state flips and the tween starts from the right place rather than snapping first.
// `key` is whatever else changes the measurement -- the count's own digits, for one. "1,204 jobs"
// and "157,212 jobs" are different widths, and a container that kept the old one would clip the
// number it exists to show.
function useSwapWidth(active: number, key: string) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const child = el?.children[active] as HTMLElement | undefined;
    if (!el || !child) return;
    // Cleared BEFORE reading. The container clips (overflow: hidden), so with last frame's width
    // still set, the child about to become active reports the OLD width and nothing ever resizes --
    // measured at 79px for both states before this line existed. Clearing lets the grid size to
    // max-content for one read; the write on the next line puts it straight back, inside the same
    // layout pass, so nothing paints in between.
    el.style.width = "";
    // box-sizing is border-box globally, so `width` includes any padding the container carries --
    // and .t-morph-pill carries 8px a side to keep a pill's shadow from being cropped. Measuring the
    // child alone and writing that would clip the pill by exactly that padding.
    const style = getComputedStyle(el);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    el.style.width = `${child.offsetWidth + padding}px`;
  }, [active, key]);
  return ref;
}

// True only once `active` has been continuously true for `delay` ms. A request that settles before
// then never raises a loading state at all.
//
// Most requests here are fast enough that announcing them was pure noise: measured against
// production, the homepage answers in ~270ms at p50 and a page of scroll results in ~160ms. Showing
// "Loading more…" for a sixth of a second, on every page, during one continuous scroll, is a badge
// that blinks rather than a badge that informs. Below the threshold the reader simply sees the
// result arrive, which is the honest report of what happened.
//
// `minVisible` is not scope creep, it is what stops the threshold from becoming a new flicker
// source. Search sits at ~2.5s at p50, right on top of a 2s delay, so without a floor the spinner
// would appear at 2.00s and vanish at 2.05s on exactly the queries the delay is meant to cover.
// Once it has been earned it stays long enough to be read.
function useSlowFlag(active: boolean, delay = 2000, minVisible = 400) {
  const [shown, setShown] = useState(false);
  // Refs, not state: these are bookkeeping for the timers and must not themselves cause a render.
  // Only touched inside the effect, never during one.
  const shownAt = useRef(0);
  const isShown = useRef(false);
  useEffect(() => {
    if (active) {
      // Already visible from an earlier run -- rescheduling would reset shownAt and extend the
      // floor past what was actually earned.
      if (isShown.current) return;
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        isShown.current = true;
        setShown(true);
      }, delay);
      return () => clearTimeout(timer);
    }
    if (!isShown.current) return;
    // Always through a timer, even at zero: a synchronous setState here is a cascading render, and
    // Math.max keeps the two cases one code path instead of two.
    const timer = setTimeout(() => {
      isShown.current = false;
      setShown(false);
    }, Math.max(0, minVisible - (Date.now() - shownAt.current)));
    return () => clearTimeout(timer);
  }, [active, delay, minVisible]);
  return shown;
}

// transitions.dev texts-reveal (18) needs .is-shown added AFTER the element has painted once at
// its starting values -- applied during the same render, the browser has no previous frame to
// transition FROM and the lines simply appear. A state flip inside an effect, one frame late, is
// the React equivalent of the snippet's `void block.offsetHeight` reflow.
function useRevealed() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return shown;
}

export function JobsExplorer({
  initialJobs = [],
  initialTotal = 0,
  initialCursor = null,
  hasServerData = false,
  initialQuery = "",
  initialTotalCapped = false,
  initialCorrectedTo = null,
  serverNow = 0,
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
  // The SERVER's clock at render time, so "6d ago" is computed identically on both sides.
  serverNow?: number;
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
  // Seeded with the SERVER's clock, not 0.
  //
  // At 0 the Posted column had no reference point, so it fell back to the absolute date -- every
  // refresh painted "Jul 21, 2026" and then flipped the whole column to "6d ago" a few milliseconds
  // later, once the mount effect supplied a clock. The flip was the most visible thing on the page.
  // Passing the server's own timestamp down means the server and the client's first render compute
  // the SAME label from the SAME instant, so there is nothing to swap and no hydration mismatch --
  // the value is baked into the HTML rather than read from two different clocks. The minute tick
  // below then keeps it fresh. The page is force-dynamic and no-store, so this timestamp is never
  // served stale from a cache.
  const [now, setNow] = useState(serverNow);
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

  // watchlistSet and toggleWatch were the row star's two consumers. Kept out of the render for now
  // rather than deleted -- see the note where the star used to be. eslint would flag them as unused,
  // and a void reference is a clearer marker than a disable comment that says nothing.
  void watchlist;

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

  // useCallback, because this is every row's `onFilter` prop. As a plain function declaration it
  // was a new identity on every parent render, which defeats React.memo on the row outright -- the
  // rows would re-render for a keystroke in the search box no matter what else was memoised.
  // The setter form takes no dependencies, so the identity is stable for the component's life.
  const update = useCallback((patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);


  // Parked with the control it fed -- see the note where SaveViewPill used to render. void rather
  // than a disable comment: it names what is happening instead of silencing the rule.
  void SaveViewPill;
  const saveView = useCallback((name: string) => {
    const trimmed = name.trim().slice(0, 40);
    if (!trimmed) return;
    const query = filtersToSearchParams(filters).toString();
    setSavedViews((current) => [...current.filter((view) => view.name !== trimmed), { name: trimmed, query }]);
  }, [filters]);
  void saveView;

  // useCallback for the same reason as `update`: it is read inside the activeChips memo, so a fresh
  // identity each render would invalidate that memo on every parent render.
  const toggle = useCallback((key: FilterCategoryKey, value: string) => {
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
  }, [])

  // Hydrate the device-local watchlist and saved views from storage once, after the first render so
  // it cannot cause a server/client markup mismatch. The setState is the whole point of this mount
  // effect, so the cascading-render lint rule does not apply.
  useEffect(() => {
    // Not a setState -- it fills the module-level logo cache, and must run before the first rows
    // mount so recycled rows can read it.
    hydrateLogoOutcomes();
    warmAtsIcons();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWatchlist(readStored<string[]>(WATCHLIST_KEY, [], WATCHLIST_KEY_LEGACY));
    setSavedViews(readStored<SavedView[]>(SAVED_VIEWS_KEY, [], SAVED_VIEWS_KEY_LEGACY));
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
    // The refresh-failed banner belongs to the query that failed, for the same reason: uncleared,
    // it sat accusing a brand-new filter's results of being stale before their request had even
    // been sent -- and if that request was aborted mid-typing, nothing ever took it down.
    setError(null);

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
      // THIS is why removing a filter felt slow on data that was already correct.
      // Apply a filter, then remove it before its results land -- which is exactly what you do
      // when the filter felt slow. The cleanup aborts the in-flight request, and the abort guard
      // in `finally` deliberately declines to reset the flags, because a superseded request must
      // not clear them on behalf of a newer one. The newer run then hits the cache and returns
      // without ever raising them, so nobody owned them: the cached rows painted instantly but sat
      // at opacity 0.45 under a shimmering "Updating…" badge for the debounce plus a full round
      // trip. The cache-miss path re-raises the flag below, so owning them here is the whole fix.
      setIsLoading(false);
      setSearchBusy(false);
    } else {
      // A cursor belongs to the result set it came from. On a cache miss the old rows stay up (as
      // the dimmed skeleton backdrop) but the cursor must not: loadMore's stale-query guard checks
      // FILTERS, not cursors, so an endReached during the debounce+fetch window issued "new
      // filters + old cursor" and appended page one of the new results under the old list.
      setCursor(null);
    }

    // Busy is owned by THIS effect, not by the input's onChange.
    //
    // It used to be set from onSearchInput, which fires on every keystroke -- including keystrokes
    // that leave the query unchanged, like retyping the same word or typing a character and deleting
    // it. This effect is keyed on queryString, so in exactly those cases it never ran, and nothing
    // ever put busy back to false: the spinner stayed, the badge stayed on "Updating…", and the
    // table stayed dimmed for the rest of the session. Setting it where it is cleared makes the two
    // impossible to separate.
    setSearchBusy(true);

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

  // One order array per component instance, mutated in place by orderChips. useState's initializer
  // gives a stable identity without re-renders; per-instance is what makes it SSR-safe (a module
  // array shared one visitor's ordering with the next request's render).
  const [chipOrderStore] = useState(() => [] as string[]);
  const activeChips = useMemo(() => {
    const chips: ActiveChip[] = [];
    if (filters.search.trim()) chips.push({ kind: "search", label: `“${filters.search.trim()}”`, clear: () => update({ search: "" }) });
    // code so a region filter wears the same flag its rows do. Without it the "Europe" chip was the
    // one place on the page where that value had no mark beside it.
    if (filters.location.trim()) chips.push({ kind: "location", label: `Location: ${filters.location.trim()}`, value: filters.location.trim(), code: regionFlagCode(filters.location.trim()) ?? undefined, clear: () => update({ location: "" }) });
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
    // Same flag treatment the country and location chips get. A city chip was the one place-shaped
    // chip with no glyph, so picking a place from the table produced a bare "US" next to chips that
    // all carried a mark.
    for (const value of filters.city) {
      chips.push({
        kind: "city",
        label: value,
        code: cityCountry(value) ?? regionFlagCode(value) ?? undefined,
        clear: () => toggle("city", value),
      });
    }
    if (filters.roleFamily) chips.push({ kind: "roleFamily", label: filters.roleFamily, clear: () => update({ roleFamily: "" }) });
    for (const value of filters.industry) chips.push({ kind: "industry", label: value, clear: () => toggle("industry", value) });
    for (const value of filters.workplace) chips.push({ kind: "workplace", label: value, clear: () => toggle("workplace", value) });
    for (const value of filters.source) chips.push({ kind: "source", label: value, clear: () => toggle("source", value) });
    for (const value of filters.employmentType) chips.push({ kind: "employmentType", label: value, clear: () => toggle("employmentType", value) });
    // postedWithin deliberately gets no chip: the date pill already displays its own selection
    // ("Last 7 days"), so a chip would double it. "Any time" in the same dropdown clears it.
    if (watchlistActive) chips.push({ kind: "watchlist", label: "★ Watchlist", clear: () => update({ watchlistOnly: false }) });
    // Ordered by WHEN each filter was applied, not by the order the branches above happen to run in.
    // The list above is a fixed sequence -- search, location, title, company, country, … -- so
    // picking a country after a source pushed the country chip in front of the source that was
    // already there, and the chip you just added appeared somewhere in the middle of a row you were
    // not looking at. Appending keeps the newest at the end, where the eye already is because that
    // is where the previous one landed.
    return orderChips(chips, chipOrderStore);
  }, [filters, watchlistActive, jobs, chipOrderStore, update, toggle]);

  // The chips survive their own exit animation.
  //
  // `is-open` and the chips were both driven by activeChips.length, so React removed the class AND
  // unmounted every chip in ONE commit -- the height transition then had nothing to collapse from
  // and the row staircased instead of sliding. Measured per frame on the live page: 68px -> 32 ->
  // 8 with no intermediate values, against 68 -> 50 -> 35 -> 3.5 -> 0 when the same element was
  // closed with its content left in place. A React sequencing bug, not a CSS one -- which is also
  // why reaching for an animation library would not have fixed it; AnimatePresence is exactly this
  // hold, at 18-34KB for one element.
  //
  // The held list is never cleared, and needs no timer. Its container is collapsed to 0fr with
  // overflow hidden AND carries `inert` whenever there are no live chips, so those nodes are
  // invisible, untabbable and absent from the accessibility tree -- there is nothing to tidy, so
  // there is no cleanup to get wrong.
  const hasChips = activeChips.length > 0;
  const [heldChips, setHeldChips] = useState(activeChips);
  // Synchronising React state with the CSS transition timeline -- an external system whose clock
  // this component does not own -- which is the case the rule's own docs carve out. Guarded on
  // identity so it cannot loop, and skipped entirely while closing, which is the whole point.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (hasChips) setHeldChips(activeChips); }, [hasChips, activeChips]);
  const shownChips = hasChips ? activeChips : heldChips;

  // How many things "Clear all" would actually clear. Not simply activeChips.length: the date filter
  // deliberately has no chip of its own (the date pill already shows its own selection, and a chip
  // would double it), but Clear all resets it too -- so with one chip AND a date set there really
  // are two filters and the control earns its place.
  // Counted from what is on SCREEN, which during the exit is the held list -- otherwise Clear all
  // disappears a frame before the row it belongs to, and the row closes around a hole.
  const shownClearable = shownChips.length + (filters.postedWithin ? 1 : 0);

  // Column widths measured from the rows rather than guessed once at design time -- see
  // useColumnWidths. The skeleton takes the same object, so the placeholder columns land exactly
  // where the real ones will and the cross-fade between them moves nothing.
  // The wordmark shimmers on click. See .wordmark-shimmer.
  const [shimmer, setShimmer] = useState(0);

  const widths = columnWidthsFor(jobs);
  // The BADGE's loading states -- and only the badge's -- wait for the request to outlast two
  // seconds. See useSlowFlag. The table's own dim still reacts immediately, because it says
  // something different: not "work is happening" but "these rows are already stale", which is true
  // from the first millisecond.
  // What the delay costs, stated rather than buried: for a query that settles inside the threshold
  // the badge keeps showing the PREVIOUS count for up to two seconds, and that count is stale by
  // definition while a query is in flight. The judgement is that a number a second or two out of
  // date, which then morphs into the right one, is a smaller lie than a badge that blinks on every
  // keystroke and every scroll page.
  const slowLoading = useSlowFlag(isLoading);
  const slowPaging = useSlowFlag(isPaging);
  // Which of the badge's three states is showing. Loading wins over paging: a new query replaces
  // the whole result set, so the total is stale and saying "loading more" of a set that is about to
  // be discarded would be the wrong claim. In practice they do not overlap -- loadMore returns early
  // while a page is in flight -- but the order states which one matters if they ever do.
  const badgeState = slowLoading ? 1 : slowPaging ? 2 : 0;
  // The badge tweens its width between its states; each needs measuring.
  const countSwapRef = useSwapWidth(badgeState, `${formatTotal(total, totalCapped)} ${total === 1 ? "job" : "jobs"}`);
  // Memoised because Virtuoso re-renders its header whenever this identity changes, and an inline
  // arrow here would hand it a new function on every parent render.
  const renderHeader = useCallback(() => <TableHeader widths={widths} />, [widths]);
  // "Loading more…" reports from the count badge rather than from a row pinned under the last one.
  // The badge already floats at the foot of the card -- exactly where the reader is looking when
  // they hit the bottom -- and it is already the surface that says what the table is doing, so a
  // second status strip 14px below it was two answers to one question.
  // Both hoisted out of the JSX. react-virtuoso republishes every prop into its stream system from
  // an effect with no dependency array, so an inline arrow here is a new identity on each parent
  // render and forces the item list to re-render all ~34 mounted rows -- which is exactly what
  // memoising the row is meant to prevent. `now` is in the deps because the row's "5m ago" label
  // depends on it; it ticks once a minute, which is a re-render the rows genuinely need.
  const computeItemKey = useCallback((_index: number, job: Job) => job.id, []);
  const renderRow = useCallback(
    (_index: number, job: Job) => <JobCells job={job} onFilter={update} now={now} />,
    [update, now],
  );

  // A small "Showing results for X" note when a typo'd search was auto-corrected. `inert` when
  // collapsed, exactly like the chips row and the failure banner: row-collapse hides visually
  // (0fr + opacity) but removes nothing from the accessibility tree, so without it every visitor's
  // screen reader met a dangling "Showing results for" with an empty value on every page load.
  const correctionNote = (
    <div className={`row-collapse ${correctedTo ? "is-open" : ""}`}>
      <div inert={correctedTo ? undefined : true}>
        <p className="mb-2 px-1 text-[13px] text-[var(--muted)]">
          Showing results for <span className="font-bold text-[var(--ink)]">{correctedTo}</span>
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
          {/* Mounted only while failed: role="status" announces on CONTENT change, not visibility
              change, so text that was present from first paint was never read out when the failure
              actually happened. */}
          <span>{error ? <>These results may be out of date &mdash; the last refresh failed.</> : null}</span>
          <button
            type="button"
            onClick={() => setRetryToken((token) => token + 1)}
            className="rounded font-bold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
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
          <JobsSkeleton widths={widths} />
        </div>
        {/* isLoading with rows already present means a REFETCH, not a first load -- the skeleton
            layer behind this one covers that case and is already faded out by now. See
            .jobs-refreshing: the rows dim while the answer is in flight rather than being replaced
            between frames with nothing said in between.
            The RAW flag, deliberately, while the badge below waits two seconds. The dim is not an
            announcement that work is happening -- it is a statement that the rows you are looking at
            are already stale, and that is true from the first millisecond of the request. Delaying
            it would leave a filtered table looking settled while showing the previous filter's
            results. Its own 90ms fade is what keeps it from reading as a flicker. */}
        <div className={`t-skel-content relative ${isLoading && jobs.length > 0 ? "jobs-refreshing" : "jobs-settled"}`}>
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
            computeItemKey={computeItemKey}
            fixedHeaderContent={renderHeader}
            itemContent={renderRow}
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
        </div>
      {/* OUTSIDE .t-skel-content, and that is the whole reason this moved. The badge used to be a
          child of the element that dims and blurs during a refetch, so the one thing that is
          supposed to stay readable was dimmed to 0.45 and blurred with everything else -- and
          z-index could not save it, because an element with a `filter` becomes a containing block
          and its children are rendered INTO the filtered surface. As a sibling it stays crisp
          while they dim, and it stays exactly where it is -- the pill does not travel. */}
      {/* Resting, it floats over the foot of the card. It lands in the same 64px the bottom fade
          already dims, so it reads over emptying rows rather than over live ones, and
          pointer-events:none keeps the row underneath clickable through it. */}
        {/* Two states in one badge, not a label bolted onto a count. "Updating…" used to sit
            BESIDE the number, which said two things at once -- here is the total, and also the
            total is currently wrong. While a query is in flight the count is stale by definition,
            so it steps aside entirely and the badge says only what it can stand behind.
            Same grid-cell cross-fade as the row's Apply swap, so the two read as one idea. The
            badge is therefore always as wide as the wider of the two states, which is the point:
            nothing resizes as it flips.
            aria-live on the wrapper rather than on either state, so a screen reader is told the
            new text once when it settles instead of twice as the pair cross-fades. */}
        <p aria-live="polite" className="jobs-count-badge">
          <span ref={countSwapRef} className="t-morph">
            <span data-active={badgeState === 0 ? "" : undefined}>
              <span className="tabular-nums text-[var(--ink)]">{formatTotal(total, totalCapped)}</span>{" "}
              {total === 1 ? "job" : "jobs"}
            </span>
            {/* transitions.dev shimmer-text (15). A status label claiming work is happening should
                look like it. data-text duplicates the string because ::before masks the gradient
                onto the same glyphs -- keep the two in step if the copy ever changes. */}
            <span data-active={badgeState === 1 ? "" : undefined}>
              <span className="t-shimmer" data-text="Updating…">Updating…</span>
            </span>
            {/* The third state, and the only one that is hidden from the live region. "Updating…"
                follows a deliberate act -- a filter, a keystroke -- and happens once; this follows a
                scroll and happens on every page, so announcing it would read the badge aloud a dozen
                times during one pass down the list. The rows it is fetching land in the table either
                way, which is what a screen reader is actually following. A spinner rather than the
                shimmer because this is work with an end, not a value in flux. */}
            <span data-active={badgeState === 2 ? "" : undefined} aria-hidden="true">
              <span className="inline-flex items-center gap-1.5">
                <span className="search-spinner search-spinner-sm" />
                Loading more…
              </span>
            </span>
          </span>
        </p>
      </div>
    ) : error ? (
      // Same box the table fills, not a card that shrinks to its message. Three states share this
      // slot -- rows, "no matching jobs", and this -- and only one of them used to hold the space,
      // so clearing a filter that emptied the results collapsed the page to a strip and left the
      // footer floating in the middle of the viewport. min-h-0 + flex-1 + the table's own
      // TABLE_MIN_HEIGHT floor make all three exactly the same size, and centring the message
      // inside means the height costs nothing visually.
      <div
        role="alert"
        className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-[24px] bg-white px-6 py-16 text-center shadow-[var(--shadow-table)]"
        style={{ minHeight: TABLE_MIN_HEIGHT }}
      >
        <p className="text-base font-bold">Couldn&rsquo;t load jobs</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-[var(--muted)]">
          The job index didn&rsquo;t respond. Your filters are still set &mdash; retrying will run the same search.
        </p>
        <div className="mt-5 flex justify-center">
          <PillButton onClick={() => setRetryToken((token) => token + 1)}>Try again</PillButton>
        </div>
      </div>
  ) : (
    <EmptyState onClear={() => setFilters(emptyFilters)} />
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
        className="rounded font-bold text-[var(--accent-strong)] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
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
      <section className="mx-auto flex min-h-[100dvh] w-full max-w-[1240px] flex-col px-5 pb-6 pt-4 sm:px-8 sm:pt-6">
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
          {/* A button, not a link, and that changed when the click stopped resetting the filters.
              It was a <Link href="/"> whose click was intercepted to clear them -- the href carried
              real weight there: middle-click, copy-link and crawlers all got the unfiltered view,
              and with JS off the link still did what it promised.
              Now the click only shimmers, so an href would be a claim the control does not honour.
              What that costs, stated rather than buried: the wordmark no longer links home. If it
              should, the honest shape is a link that navigates AND shimmers, not one that swallows
              its own navigation. */}
          <button
            type="button"
            aria-label="Aboard"
            onClick={() => {
              // Every click shimmers the mark. The counter is what makes it REPLAY: a CSS animation
              // on an element that never unmounts fires once and never again, so the span below is
              // keyed on this number and React remounts it each time.
              setShimmer((run) => run + 1);
            }}
            className="wordmark-link mx-auto mb-5 block w-fit rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--focus)]"
          >
            <Wordmark />
            {/* Keyed on the run counter so every click replays it: a CSS animation on an element
                that never unmounts fires once and never again, and React reuses the node unless the
                key changes. */}
            {shimmer > 0 && <span key={shimmer} className="wordmark-shimmer" aria-hidden="true" />}
          </button>
          <h1
            className="mx-auto whitespace-nowrap text-[clamp(15px,3.15vw,28px)] font-bold leading-[1.15] tracking-[-0.02em]"
          >
            Find{" "}
            {/* The one number on the page that changes under the reader's eyes -- every filter, every
                keystroke in the search box, rewrites it. Swapping the string outright made the count
                the one thing on screen that moved without explaining itself; morphing the digits that
                actually differ shows the change as a change.
                as="span" keeps the element the h1 already had, so nothing about the layout moves.
                tabular-nums matters MORE here than it did for a static number: torph animates each
                digit in place, and with proportional figures a 1 becoming an 8 would shift every
                digit to its right mid-flight.
                Torph renders the plain text on first paint (dangerouslySetInnerHTML seeded from a
                ref captured at first render) and only takes over the DOM in an effect, so the server
                still emits "Find 157,212 open roles" -- no hydration mismatch, and the number is
                there for a crawler and for anyone with JS off.
                --ease-out is the page's own curve rather than the library's default expo, and 320ms
                sits between the 160ms of a hover and the 400ms default: this is a number settling,
                not a control responding to a press.
                respectReducedMotion defaults to true; it is written out because it is the reason
                this is safe to put on the busiest-updating element on the page. */}
            <TextMorph
              as="span"
              className="tabular-nums text-[var(--accent-strong)]"
              duration={320}
              ease="cubic-bezier(0.23, 1, 0.32, 1)"
              respectReducedMotion
            >{formatTotal(total, totalCapped)}</TextMorph>{" "}
            open roles, straight from the source
          </h1>
        </div>

        {/* No panel chrome behind the filter row — the pills carry their own hairline shadow. */}
        <div>
          <FilterDropdownBar
            filters={filters}
            update={update}
            toggle={toggle}
            searchBusy={searchBusy}
          />

          {/* Selected filters as dashed "[icon] is [value]" chips, with Save view and Clear all
              pushed to the end of the same row. */}
          {/* Always mounted, collapsed to zero height when empty, so applying the first filter (or
              clearing the last) slides the table rather than shoving it 49px on the same frame the
              rows are changing. `inert` keeps the clipped controls out of the tab order. */}
          <div className={`row-collapse ${activeChips.length > 0 ? "is-open" : ""}`}>
            <div inert={activeChips.length === 0 ? true : undefined}>
              <div className="rule-dashed mt-3 flex flex-wrap items-center gap-[10px] pt-3 pb-2">
                {shownChips.map((chip) => <FilterChip key={chipId(chip)} chip={chip} />)}
                {/* Last in the row and wearing the chip's own dashed pill, because it belongs to the
                    filters rather than to the page -- it is the "and clear all of these" at the end
                    of the list, not a separate control parked on the right. Save view stays right:
                    it acts on the whole view, not on the chips. */}
                {/* Only once there is more than one thing to clear. With a single filter, its own
                    chip already carries an X that does exactly what this does, so the two sat side
                    by side offering the same action twice -- and the reader has to work out whether
                    the second one means something different. */}
                {shownClearable > 1 && <ClearAllChip onClick={() => setFilters(emptyFilters)} />}
                {/* Save view is HIDDEN, not deleted. Everything behind it survives -- saveView, the
                    savedViews list, its localStorage round-trip, and the SaveViewPill component with
                    its three morphing states -- so bringing it back is putting this line back.
                    It goes for the same reason the watchlist star did: it saves a named filter set to
                    this browser and nowhere else. No sync, no way to reach a saved view from another
                    device, and nothing on the page that lists them back to you. A control that looks
                    like it remembers something for you and only remembers it here is a promise the
                    product has not made good on yet. */}
              </div>
            </div>
          </div>
        </div>

        {/* The count that used to sit here, in a band of its own, now floats over the foot of the
            table itself -- see .jobs-count-badge. It is a caption on the thing it counts, and every
            pixel it stops occupying above the card becomes another row inside it.
            The wrapper inherits the column layout the band's siblings used to get directly from the
            section, so the table still takes whatever height is left rather than its content's. */}
        {/* 20px, not 12. This gap is the whole separation between the controls and the results when
            no filter is applied -- with chips the collapsed row adds its own -- and at 12 the
            table's top edge crowded the pills above it. */}
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
// The check that confirms a saved view. On the shared LineIcon like IconPlus beside it, rather
// than a second stroked-glyph convention.
// No stroke-draw: the check arrives as part of a cross-fade that is already carrying the moment, and
// drawing the stroke on top would be two animations for one event. transitions.dev's success-check
// is for the case where the check IS the whole moment.
const IconCheck = () => <LineIcon><path d="M3.5 8.5l3 3 6-6.5" /></LineIcon>;
const IconUpDown = () => <LineIcon><path d="M5.5 6.5 8 4l2.5 2.5M5.5 9.5 8 12l2.5-2.5" /></LineIcon>;

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
      className={`${PRESSABLE} flex w-full items-center justify-between gap-2 rounded-[10px] px-2 py-1.5 text-start hover:bg-[var(--control-hover)] disabled:pointer-events-none disabled:opacity-40`}
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
// h-80 + overflow-hidden: both dropdown lists cap their scroller at max-h-80, and twelve 30px
// placeholder rows are 360px -- so the SKELETON was what triggered the scrollbar, on content
// nobody can scroll to. Clipping the placeholder at exactly the scroller's height keeps the panel
// at its final size with no bar until there is something real to scroll.
function ListSkeleton({ rows = 9 }: { rows?: number }) {
  return (
    <div className="is-pulsing h-80 overflow-hidden" aria-hidden="true">
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

// A monogram's colour comes from the letter it shows, so a column of them reads as a column of
// distinct companies rather than a pink stripe.
//
// Every monogram used to be the accent, which made the avatar column the one place on the page
// where identical-looking marks sat directly on top of each other -- and a logo-less company is the
// common case, not the exception, so that column is mostly monograms.
//
// Keyed on the FIRST LETTER rather than a hash of the whole name, deliberately. It means the colour
// and the glyph agree: every M is the same teal, so the pairing is learnable and two rows of the
// same company never disagree with each other. A hash would scatter better but would make the same
// letter a different colour in every row, which reads as noise.
//
// Hues, not free-form hex. One saturation and one lightness across the set is what keeps twelve
// colours looking like one family and guarantees the text clears contrast on its own wash; picking
// twelve hex triples by hand does neither. 55-80 is skipped because yellow at a readable lightness
// goes muddy, and only one pink is included so the brand accent stays the brand's.
const MONOGRAM_HUES = [340, 355, 20, 40, 100, 145, 172, 195, 215, 245, 275, 310];

function monogramTint(initials: string) {
  const code = initials.trim().toUpperCase().charCodeAt(0);
  const hue = MONOGRAM_HUES[(Number.isNaN(code) ? 0 : code) % MONOGRAM_HUES.length];
  return {
    // The glyph carries the saturation; the tile stays near-white so a row of them does not become
    // a column of colour blocks competing with the job titles beside them.
    color: `hsl(${hue} 52% 42%)`,
    background: `hsl(${hue} 66% 95%)`,
    outlineColor: `hsl(${hue} 44% 82%)`,
  };
}

// What a logo URL turned out to be, for this session and the next. Shared by the table's rows and
// the Company dropdown's marks, which is the point: a company seen in one is already settled in the
// other. Seeded synchronously from the module-level map so a remounting row or a re-opened panel
// renders its answer in the first paint rather than starting over at the placeholder.
function useLogoOutcome(url: string | null) {
  const key = url ?? "";
  const [outcome, setOutcome] = useState<"pending" | "ok" | "bad">(() => logoOutcome.get(key) ?? "pending");

  const settle = useCallback((result: "ok" | "bad") => {
    logoOutcome.set(key, result);
    persistLogoOutcomes();
    setOutcome(result);
  }, [key]);

  return { outcome, settle };
}

function CompanyMark({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  // Through the SAME session cache the table's rows use. This kept its verdict in a plain useState
  // and threw it away every time the dropdown closed, so re-opening re-fetched every logo,
  // re-decoded it and re-ran the shape check from scratch -- including for logos already known to
  // be unusable. The table had been remembering that per URL since the virtualizer forced the issue;
  // the dropdown simply never got the same treatment.
  const { outcome, settle } = useLogoOutcome(logoUrl);
  // The dropdown's mark had no reveal at all while the table's row had one, which is the opposite of
  // what this component is for -- a company is supposed to look the same in the list as in the rows.
  const { painted, paint, fade } = useImagePainted();
  // Same layering as the table's row, because the rule this component exists to hold is that a
  // company looks the same in the list as in the rows: the monogram is the base and a logo fades in
  // over it, so neither surface ever shows a placeholder for a logo that is not coming.
  // `block` for the same reason the table's tile carries it: an inline <span> ignores width and
  // height, so size-5 would apply nothing and the absolute tile would have no box to fill.
  return (
    <span className="relative block size-5 shrink-0">
      <span
        aria-hidden="true"
        // The ring is new here. The logo-bearing tile beside it in the same list has always had one,
        // so a bare monogram was the only mark in the dropdown without an edge -- it read as a
        // floating blob among framed tiles. Same hairline, tinted with the letter, like the table.
        className="absolute inset-0 flex items-center justify-center rounded-[6px] text-[12px] font-bold leading-none outline outline-1 outline-offset-0"
        style={monogramTint(initialsOf(name))}
      >
        {initialsOf(name)}
      </span>
      {logoUrl && outcome !== "bad" ? (
        <span
          // Both conditions, not just `painted`: a logo whose shape turns out to be unusable is
          // replaced by the monogram on the very next render, and revealing it the instant its
          // pixels land would show the wrong mark for one frame on the way there.
          className={`absolute inset-0 flex items-center justify-center overflow-hidden rounded-[6px] bg-white shadow-[var(--shadow-control)] ${painted && outcome === "ok" ? fade : "opacity-0"}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={logoUrl}
            alt=""
            // Eager, like the table's. The panel is on screen the moment it opens, so a visibility
            // check only delays a request that is about to happen anyway.
            loading="eager"
            decoding="async"
            referrerPolicy="no-referrer"
            className="size-full object-contain"
            ref={(node) => {
              paint(node);
              if (node?.complete && node.naturalWidth > 0 && outcome === "pending") {
                settle(isUsableLogoRatio(node.naturalWidth, node.naturalHeight) ? "ok" : "bad");
              }
            }}
            onError={() => settle("bad")}
            onLoad={(event) => {
              const img = event.currentTarget;
              paint(img);
              settle(isUsableLogoRatio(img.naturalWidth, img.naturalHeight) ? "ok" : "bad");
            }}
          />
        </span>
      ) : null}
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

  // What to draw RIGHT NOW, which is not the same as what the server last sent.
  //
  // /api/companies answers in 420-520ms, so between a keystroke and the reply there was half a
  // second of a spinner over a list the reader could already see the answer in. The rows in hand are
  // narrowed locally and shown immediately; the request still runs and replaces them, because 100
  // rows out of 50,964 companies is a sample and only the server can widen it.
  // This is Emil's perceived-performance point rather than an optimisation: the request has not got
  // faster, but the list stops being blank while it happens.
  const narrowed = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term || state !== "loading") return rows;
    const local = rows.filter((entry) => entry.company.toLowerCase().includes(term));
    // Nothing local matching does not mean nothing matches -- it means this page of 100 has none.
    // Falling back to the full list would be a lie; an empty list until the server answers is not.
    return local;
  }, [rows, query, state]);

  // The current selection is pinned at the top even when the search has moved elsewhere, so it can
  // always be unpicked without clearing the box first.
  const shown = value && !narrowed.some((row) => row.company === value)
    ? [{ company: value, jobCount: 0, logoUrl: null }, ...narrowed]
    : narrowed;

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
             className={`${PRESSABLE} flex w-full items-center justify-between gap-2 rounded-[10px] px-2 py-1.5 text-start hover:bg-[var(--control-hover)]`}
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

  // Narrowed locally while the request is out, same as the company list. /api/titles answers in
  // 0.41-1.80s -- the slowest lookup on the page -- and 200 titles is a big enough sample that the
  // row being typed towards is usually already in it. See the note in CompanyCheckList.
  const narrowed = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term || state !== "loading") return suggestions;
    return suggestions.filter((entry) => entry.title.toLowerCase().includes(term));
  }, [suggestions, query, state]);

  // The current selection is always the first row, so what is filtered is visible the moment the
  // panel opens rather than buried a hundred rows down the list. It keeps its real count when the
  // suggestions include it, which they usually do.
  const selected = value ? narrowed.find((row) => row.title === value) ?? { title: value, jobCount: 0 } : null;
  const rows = selected
    ? [selected, ...narrowed.filter((row) => row.title !== value)]
    : narrowed;

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
            className={`${PRESSABLE} flex w-full items-center justify-between gap-2 rounded-[10px] px-2 py-1.5 text-start hover:bg-[var(--control-hover)]`}
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
            className={`${PRESSABLE} inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] ${
              checked
                ? "border-[var(--accent)]/30 bg-[var(--accent)]/15 text-[var(--accent-strong)]"
                : "border-[var(--border)] bg-[var(--surface)] text-[var(--ink)] hover:bg-[var(--control-hover)]"
            }`}
          >
            {/* The glyphs draw in currentColor, which on an unselected pill is the near-black label
                colour and reads heavier than the text beside it. Muting them to the same grey as
                the category icons in the filter row keeps the label the emphasis. Selected pills
                pass through, so the icon inverts to white with the text. */}
            {/* No white ground behind the mark: the vendor icons are opaque rounded squares that
                carry their own background now, so a square white tile behind them only showed at
                the corners, where the icon curves away and the tile does not. */}
            {glyph === "ats" && (
              <span className="flex size-4 shrink-0 items-center justify-center">
                <AtsMark source={option.value} size={4} />
              </span>
            )}
            {/* 16px, like every other glyph that qualifies a value (the chips, the row cells). The
                icons ship as 20px SVGs, so the size has to be forced here -- at 20 they outweighed
                the 13px label they sit beside and the pill read as an icon with a caption. */}
            {OptionIcon && (
              <span className={`inline-flex shrink-0 [&>svg]:size-4 ${checked ? "" : "text-[var(--muted)]"}`}>
                <OptionIcon />
              </span>
            )}
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
      className="chip-in inline-flex min-h-9 items-center gap-1.5 rounded-full border border-dashed border-[var(--border)] bg-[var(--control)] px-3 text-sm font-bold text-[var(--muted)] transition-transform duration-[160ms] ease-[var(--ease-out)] hover:bg-[var(--control-hover)] hover:text-[var(--ink)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
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
      className="chip-in inline-flex min-h-9 items-center gap-1.5 rounded-full border border-dashed border-[var(--border)] bg-[var(--control)] px-3 text-sm font-bold text-[var(--ink)] transition-transform duration-[160ms] ease-[var(--ease-out)] hover:bg-[var(--control-hover)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
    >
      {chip.kind === "company" && <CompanyMark name={value} logoUrl={chip.logoUrl ?? null} />}
      <span className="inline-flex max-w-48 items-center gap-1.5 truncate">
        {chip.code && <Flag code={chip.code} />}
        {/* The Title chip carries the same person glyph as the pill it came from. A picked role was
            the one chip in the row with no mark at all -- every neighbour (flag, globe, ATS logo,
            job-type clock) opens with one, so the bare chip read as unstyled rather than minimal.
            All chip glyphs render at 16px ([&>svg]:size-4): they are qualifiers of the value, not
            the value, and at the pill's 20px they crowded the text they introduce. */}
        {/* The search chip opens with the same magnifier as the field it came from, exactly as the
            Title chip carries the pill's person glyph. Without it the quoted term was the only chip
            in the row with no mark, which read as unstyled rather than deliberate. */}
        {chip.kind === "search" && (
          <span className="inline-flex shrink-0 [&>svg]:size-4"><IconSearchGlyph /></span>
        )}
        {chip.kind === "title" && (
          <span className="inline-flex shrink-0 [&>svg]:size-4"><IconTitleF /></span>
        )}
        {chip.kind === "workplace" && WORKPLACE_ICONS[value.toLowerCase()] && (
          <span className="inline-flex [&>svg]:size-4 text-[var(--muted)]">{(() => { const Glyph = WORKPLACE_ICONS[value.toLowerCase()]; return <Glyph />; })()}</span>
        )}
        {/* Job type carries its glyph here too. It had one in the dropdown you pick it from and one in
            every row it filters to, and none on the chip in between -- the only place in that chain
            where the value appeared bare.
            Looked up through the same normalisation the table uses, not the raw label: keyed on the
            raw text, "Full-time Tier 2" reads as an unknown type and silently loses its clock. */}
        {chip.kind === "employmentType" && JOB_TYPE_ICONS[normalizeEmploymentKey(tidyEmploymentType(value))] && (
          <span className="inline-flex text-[var(--muted)] [&>svg]:size-4">
            {(() => { const Glyph = JOB_TYPE_ICONS[normalizeEmploymentKey(tidyEmploymentType(value))]; return <Glyph />; })()}
          </span>
        )}
        {/* Same as the option pill: no white tile behind an already-opaque rounded icon. */}
        {chip.kind === "source" && (
          <span className="flex size-4 shrink-0 items-center justify-center">
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
  // 16px. It is a clear affordance inside a field, not the field's subject -- at 20 it weighed the
  // same as the search glyph opposite it and read as a second control rather than a dismissal.
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="size-4 shrink-0">
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
// The empty state's mark: a board with a magnifier over it, at 32px in --muted so it reads as part
// of the sentence beneath rather than as an illustration above it. currentColor rather than the
// #868990 the filter pills bake in, because this one belongs to the empty state's own text colour
// and should move with it.
const IconNoResults = () => (
  <svg width="32" height="32" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="shrink-0 text-[var(--muted)]">
    <path d="M8.02508 1.56908C8.88002 1.56077 9.735 1.55853 10.59 1.56236C11.9503 1.56624 13.4942 1.55332 14.8083 1.90853C15.391 2.06604 15.9488 2.36261 16.3963 2.76884C17.5914 3.85388 17.7226 5.53889 17.7836 7.05352C17.8127 7.77969 17.8122 8.53305 17.814 9.26164C17.8146 9.49448 17.8286 10.0821 17.7933 10.2741C17.7668 10.4255 17.697 10.566 17.5923 10.6786C17.4466 10.836 17.2442 10.9288 17.0298 10.9364C16.8126 10.9448 16.6011 10.8651 16.4433 10.7156C16.1314 10.4194 16.1864 10.0635 16.1871 9.67086L16.187 8.66044C16.1819 8.11344 16.1709 7.56651 16.1539 7.01974C16.1457 6.8003 16.1263 6.58146 16.1191 6.36434C14.9897 6.3431 13.8264 6.35813 12.6932 6.35824L6.61563 6.35823L4.31921 6.35844C3.99112 6.35853 3.57103 6.37356 3.25253 6.36155C3.15862 8.49915 3.15371 10.6397 3.23784 12.7778C3.23817 12.7915 3.23878 12.8052 3.23969 12.819C3.3484 14.4299 3.60146 15.6947 5.42451 16.0001C6.29649 16.1464 7.05835 16.165 7.93798 16.1743L9.15771 16.1855C9.41033 16.1859 10.0898 16.1661 10.3007 16.2118C10.4378 16.2415 10.5645 16.307 10.6679 16.4018C10.8309 16.5475 10.9274 16.7535 10.9351 16.9721C10.9426 17.1689 10.8601 17.406 10.7246 17.5464C10.5209 17.7572 10.3323 17.8139 10.0476 17.8155C9.35213 17.8191 8.64848 17.8174 7.95401 17.8086C6.68373 17.7926 5.05179 17.7638 3.89021 17.2177C3.52783 17.0473 3.19594 16.8185 2.90783 16.5404C1.71002 15.3906 1.60728 13.5083 1.57828 11.9402C1.56314 10.9482 1.55808 9.95603 1.56309 8.96393C1.56351 8.52108 1.56795 8.08229 1.57464 7.63731C1.60459 5.6483 1.725 3.23143 3.75801 2.22102C5.02718 1.59024 6.62843 1.59012 8.02508 1.56908Z" fill="currentColor" />
    <path d="M14.7617 11.9847C15.2713 11.9605 15.7782 12.0709 16.2315 12.3048C16.9195 12.6601 17.4381 13.274 17.6735 14.0117C17.9195 14.7887 17.8329 15.562 17.4607 16.2808C17.7163 16.5411 17.9799 16.7949 18.2368 17.0541C18.3487 17.1669 18.4587 17.2692 18.5393 17.4088C18.6067 17.5282 18.6422 17.6628 18.6423 17.7999C18.6463 18.0265 18.557 18.2447 18.3953 18.4033C18.1536 18.6434 17.7551 18.7279 17.4578 18.5663C17.2008 18.4264 16.9009 18.0837 16.6885 17.8691C16.5544 17.7352 16.4186 17.5967 16.2806 17.4674C15.8898 17.6523 15.5588 17.7782 15.1203 17.8072C14.3345 17.8646 13.5584 17.604 12.9668 17.0837C12.3896 16.5765 12.0374 15.8609 11.9876 15.0941C11.9351 14.3159 12.1949 13.549 12.7094 12.9629C13.2508 12.3517 13.9526 12.034 14.7617 11.9847ZM15.0457 16.1339C15.7289 16.0503 16.2152 15.4291 16.1323 14.7458C16.0492 14.0624 15.4284 13.5756 14.745 13.658C14.0608 13.7404 13.5732 14.3623 13.6564 15.0464C13.7394 15.7305 14.3617 16.2176 15.0457 16.1339Z" fill="currentColor" />
    <path d="M9.67429 8.76901L12.5285 8.76824L13.3935 8.76813C13.7156 8.76773 14.0614 8.72835 14.335 8.92467C14.5164 9.05317 14.6385 9.24918 14.6741 9.46865C14.7578 9.99679 14.3919 10.3676 13.8893 10.4418C13.5849 10.4562 13.2353 10.4478 12.9263 10.4479L11.2501 10.448L10.2352 10.4482C10.0322 10.4482 9.78221 10.4593 9.5845 10.4286C8.57915 10.2726 8.61767 8.83776 9.67429 8.76901Z" fill="currentColor" />
    <path d="M5.50777 8.76947C5.72527 8.76855 6.35079 8.7527 6.53453 8.79289C6.64437 8.81695 6.74815 8.8632 6.83949 8.92879C7.02036 9.05689 7.14143 9.25298 7.17493 9.47208C7.2094 9.6919 7.15426 9.91635 7.02185 10.0952C6.85234 10.323 6.65784 10.4022 6.38945 10.4423C6.22482 10.4478 6.06009 10.4501 5.89538 10.4491C5.55663 10.4503 5.25086 10.4675 4.97509 10.233C4.80797 10.0934 4.70548 9.89134 4.69161 9.67402C4.65657 9.16523 5.0082 8.8027 5.50777 8.76947Z" fill="currentColor" />
    <path d="M5.50748 12.1025C5.72498 12.1016 6.35076 12.0857 6.53453 12.1259C6.64439 12.15 6.74817 12.1962 6.83951 12.2618C7.02037 12.3899 7.14144 12.586 7.17494 12.8051C7.2094 13.0248 7.15426 13.2493 7.02186 13.4282C6.85252 13.6558 6.65801 13.7353 6.38981 13.7752C6.22505 13.7808 6.06021 13.783 5.89537 13.7821C5.55644 13.7833 5.25089 13.8006 4.97503 13.566C4.80797 13.4264 4.70551 13.2243 4.69162 13.0071C4.65655 12.4985 5.00805 12.1358 5.50748 12.1025Z" fill="currentColor" />
    <path d="M9.67419 12.1025C9.89168 12.1016 10.5174 12.0857 10.7012 12.1259C10.811 12.1499 10.9148 12.1962 11.0061 12.2618C11.187 12.3899 11.3081 12.586 11.3416 12.8051C11.376 13.025 11.3209 13.2493 11.1885 13.4282C11.0192 13.6557 10.8247 13.7353 10.5565 13.7752C10.3917 13.7808 10.2268 13.7832 10.062 13.7821C9.72306 13.7833 9.41758 13.8006 9.14172 13.566C8.97462 13.4264 8.87213 13.2243 8.85824 13.0071C8.8232 12.4984 9.1747 12.1357 9.67419 12.1025Z" fill="currentColor" />
  </svg>
);

const IconDateF = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="shrink-0">
    <path d="M6.6787 1.04614C6.92157 1.0295 7.15139 1.10757 7.3242 1.28202C7.57669 1.53689 7.56356 1.82584 7.56277 2.15877L7.55847 2.66959C8.10797 2.68322 8.68675 2.6699 9.23985 2.66951L12.4399 2.67554C12.4337 2.46861 12.4509 2.22766 12.4367 2.02516C12.4016 1.5224 12.677 1.05075 13.2355 1.04455C13.4539 1.04166 13.6643 1.12582 13.8206 1.27845C14.0928 1.54725 14.0655 1.8581 14.0642 2.2083L14.0643 2.74878C14.9103 2.83761 15.6941 2.97259 16.422 3.44485C18.0379 4.49328 18.0807 6.52469 18.1142 8.25925C18.1272 9.13065 18.131 10.0022 18.1255 10.8736C18.131 11.7356 18.1269 12.5976 18.1131 13.4594C18.0556 16.0932 17.7881 18.1917 14.8169 18.785C14.573 18.8258 14.3278 18.8586 14.0817 18.8833C13.4725 18.9421 12.8603 18.9507 12.2493 18.9572L10.059 18.963C9.2779 18.9658 8.49682 18.9633 7.71577 18.9556C6.76693 18.9452 5.96415 18.9241 5.04257 18.7541C2.98645 18.3746 2.08209 16.8772 1.95366 14.8934C1.91709 14.3283 1.88965 13.7732 1.88182 13.1938C1.87493 12.4135 1.87281 11.6332 1.87546 10.853C1.87209 10.0229 1.87441 9.19283 1.8824 8.3628C1.90426 6.92991 1.92127 5.2258 2.87577 4.06469C3.64531 3.1286 4.77794 2.86291 5.9321 2.75214C5.97547 2.07978 5.73068 1.17846 6.6787 1.04614ZM3.50993 8.13173L3.499 12.2234C3.50063 13.3276 3.48428 14.4738 3.69481 15.5599C3.85731 16.3983 4.3529 16.9314 5.19348 17.1159C6.18902 17.3344 7.20902 17.3132 8.22226 17.3231L11.6565 17.3248C12.7434 17.315 14.7554 17.3948 15.6242 16.7475C15.9855 16.4664 16.176 16.0902 16.2804 15.6546C16.479 14.8259 16.4741 13.9518 16.4902 13.1055C16.5048 11.8704 16.5083 10.6351 16.5008 9.39991C16.5004 9.01298 16.4746 8.5037 16.487 8.13447C15.6239 8.1275 14.7609 8.12556 13.898 8.12866L9.51813 8.12863L5.74223 8.12886C5.09523 8.12892 4.41269 8.11787 3.76994 8.13104C3.67877 8.13413 3.6015 8.13735 3.50993 8.13173Z" fill="#868990" />
    <path d="M13.5957 10.2405C14.0505 10.1538 14.489 10.4537 14.5733 10.9089C14.6576 11.3641 14.3555 11.801 13.8999 11.883C13.4476 11.9644 13.0145 11.665 12.9308 11.2131C12.8471 10.7611 13.1443 10.3265 13.5957 10.2405Z" fill="#868990" />
    <path d="M9.84269 10.2413C10.2967 10.1552 10.7343 10.4541 10.8193 10.9083C10.9043 11.3625 10.6043 11.7993 10.1499 11.8832C9.6971 11.9667 9.2621 11.6681 9.17742 11.2155C9.09273 10.7629 9.39033 10.3272 9.84269 10.2413Z" fill="#868990" />
    <path d="M9.84269 13.5744C10.2967 13.4882 10.7343 13.7871 10.8193 14.2413C10.9043 14.6955 10.6043 15.1323 10.1499 15.2162C9.6971 15.2998 9.2621 15.0011 9.17742 14.5485C9.09273 14.0959 9.39033 13.6602 9.84269 13.5744Z" fill="#868990" />
    <path d="M6.08945 13.5742C6.543 13.4886 6.97994 13.7872 7.06507 14.2409C7.15018 14.6944 6.85121 15.1311 6.39751 15.2159C5.9444 15.3004 5.50843 15.0019 5.42341 14.5488C5.3384 14.0958 5.6365 13.6596 6.08945 13.5742Z" fill="#868990" />
    <path d="M6.0898 10.2411C6.54331 10.1558 6.98011 10.4544 7.06514 10.908C7.15018 11.3616 6.85122 11.7981 6.39757 11.8828C5.94441 11.9674 5.50839 11.6688 5.42344 11.2157C5.33851 10.7627 5.63676 10.3264 6.0898 10.2411Z" fill="#868990" />
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

// The Company pill's mark. A filled building glyph rather than the stroke-based person outline it
// replaces: the pill filters by EMPLOYER, and a person icon read as "candidate" beside a row of
// filled category glyphs it also did not match.
const IconCompanyF = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="shrink-0">
    <path d="M9.19008 1.77707C9.56556 1.773 9.94107 1.77163 10.3166 1.77294C11.2611 1.77396 12.1666 1.73686 12.8739 2.4513C13.4934 3.07694 13.5408 3.84735 13.5368 4.68733C14.2611 4.69893 14.9988 4.68707 15.7227 4.68947C16.6827 4.69264 17.4191 4.5869 18.1952 5.2775C19.4796 6.42043 18.9618 8.4989 17.9408 9.62431C17.2805 10.3626 16.3676 10.8268 15.382 10.9254C15.0311 10.9573 14.7111 10.9298 14.373 10.9466L14.3734 10.9349C14.379 10.6958 14.3993 10.2192 14.332 9.99945C14.204 9.58205 13.6174 9.4574 13.3049 9.77335C13.2332 9.84585 13.1812 9.9355 13.1539 10.0338C13.1078 10.1976 13.1243 10.7367 13.1254 10.9413C12.3803 10.9612 11.5643 10.9446 10.8138 10.9446L8.2004 10.9447C7.79891 10.9447 7.26004 10.9276 6.87307 10.9466L6.87342 10.9349C6.87909 10.6958 6.89936 10.2192 6.83202 9.99944C6.70418 9.58219 6.11728 9.45736 5.80487 9.77318C5.73307 9.84569 5.68109 9.93542 5.65388 10.0338C5.60789 10.1974 5.62432 10.7369 5.62533 10.9413C5.57398 10.9429 5.52262 10.9438 5.47125 10.944C5.17125 10.946 4.83766 10.9497 4.54081 10.9157C3.65975 10.8135 2.83905 10.4167 2.21177 9.78956C1.47229 9.06326 1.0517 8.07289 1.04256 7.03643C1.03903 5.99796 1.65254 5.09613 2.66466 4.78975C3.02607 4.68035 3.31335 4.68955 3.68659 4.68927L4.49991 4.68917L6.45982 4.69083C6.46068 3.88586 6.49684 3.1068 7.07479 2.49724C7.69341 1.84479 8.34682 1.80241 9.19008 1.77707ZM7.70855 4.68896L10.9961 4.68972L12.2896 4.69013C12.2644 3.90669 12.3076 3.11261 11.2928 3.05977C10.5726 3.02227 9.80917 3.00486 9.08827 3.03511C9.06915 3.0359 9.05006 3.0372 9.03101 3.03902C8.94889 3.04455 8.85342 3.05449 8.77227 3.05741C7.6987 3.09598 7.73283 3.8333 7.70855 4.68896Z" fill="#868990" />
    <path d="M14.3767 11.9796C14.8764 11.979 15.3436 11.9867 15.8359 11.9046C16.7897 11.7455 17.6761 11.3002 18.3845 10.6442C18.5629 10.4789 18.8177 10.2204 18.9575 10.0234C18.9528 11.1568 18.9674 12.2791 18.9424 13.4142C18.9041 14.872 18.7902 16.5621 17.3996 17.3886C16.254 18.0696 14.6377 18.0147 13.3394 18.0222L10.3221 18.0251L7.11544 18.0237C5.95164 18.0204 4.76889 18.0492 3.62987 17.8013C2.37635 17.5285 1.52373 16.6636 1.25439 15.4136C1.08323 14.6192 1.05829 13.8619 1.04735 13.0513C1.04147 12.3948 1.03948 11.7384 1.04137 11.082C1.04118 10.9073 1.03137 10.1657 1.05697 10.0599C1.04984 10.0569 1.40841 10.453 1.43737 10.4825C2.22748 11.2897 3.26936 11.8031 4.39081 11.9378C4.79703 11.9853 5.21501 11.9778 5.62452 11.9818L5.62358 12.4189C5.62334 12.6818 5.6013 12.9356 5.79919 13.1416C5.91304 13.2602 6.07603 13.3263 6.23983 13.3285C6.40726 13.3312 6.56868 13.2661 6.68739 13.148C6.9454 12.8912 6.87264 12.354 6.87669 11.9795L10.3338 11.9781C11.2548 11.978 12.2059 11.9665 13.1246 11.9818L13.1235 12.4189C13.1234 12.682 13.1014 12.9352 13.2995 13.1416C13.4133 13.2601 13.576 13.3261 13.7398 13.3285C13.9073 13.3313 14.0687 13.2661 14.1875 13.148C14.4454 12.891 14.3726 12.3541 14.3767 11.9796Z" fill="#868990" />
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
  // 20px against the chip glyphs' 16: the close is the chip's one ACTION, and the extra size is
  // hit-area as much as emphasis.
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="size-5 shrink-0">
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
// Press feedback for a row or pill inside a dropdown panel.
//
// The pill that OPENS a dropdown already has active:scale-[0.97]; the options inside it had nothing,
// so the trigger answered a press and its own contents did not. 0.98 rather than 0.97 because these
// sit in a dense list and a 3% squeeze on a full-width row reads as the whole panel flinching.
// 120ms: the low end of the 100-160ms press budget, since picking from a list is a fast action.
const PRESSABLE =
  "transition-transform duration-[120ms] ease-[var(--ease-out)] active:scale-[0.98]";

const V4_PILL =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[14px] bg-white px-2 text-sm font-bold text-[var(--ink)] shadow-[var(--shadow-control)] transition-transform duration-[160ms] ease-[var(--ease-out)] hover:bg-[var(--control-hover)] active:bg-[var(--control-hover)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";

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
    <label className={`search-shell flex h-9 shrink-0 cursor-text items-center gap-2 rounded-[14px] px-2 ${shell}`}>
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
          wide and adding a second glyph would shift the input's text on every keystroke burst.
          transitions.dev icon-swap (09-icon-swap.md): both glyphs now share one grid cell and
          cross-fade with blur and scale instead of one being torn out of the DOM. That matters more
          here than it looks -- `loading` flips on every debounce cycle, so the hard swap flickered a
          spinner in and out through a burst of typing. A cross-fade cannot flicker: a state that
          reverts mid-transition eases back from wherever it had got to.
          The grid cell is the 36px hit area, with -m-2 keeping it at 20px of layout, so the swap
          wrapper and the enlarged target are the same box rather than two nested ones.
          The button is DISABLED while the spinner shows rather than merely faded out: an invisible
          control that still takes focus and clicks is worse than a visible one. */}
      {value ? (
        <span
          className="t-icon-swap -m-2 size-9 shrink-0 place-items-center"
          data-state={loading ? "b" : "a"}
        >
          <button
            type="button"
            // Hover darkens the glyph; it does NOT fade it, and that is not a preference.
            // The swap's own rule -- .t-icon-swap[data-state="a"] .t-icon[data-icon="a"] -- sets
            // opacity, filter and transform at specificity (0,4,0). A hover utility for any of
            // those three compiles to (0,2,0) and loses silently, which is why the fade this button
            // used to declare never once applied. Colour is the one channel the swap does not
            // claim. Instant, per the design rule: hover feedback does not transition.
            // (The old utility is described rather than quoted on purpose -- Tailwind scans this
            // file as raw text, comments included, so naming a class here mints a real CSS rule
            // for it.)
            className="t-icon flex size-9 items-center justify-center rounded-full text-[var(--muted)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]"
            data-icon="a"
            disabled={loading}
            aria-hidden={loading || undefined}
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={() => onChange("")}
          >
            <IconClearGlyph />
          </button>
          <span className="t-icon flex size-9 items-center justify-center" data-icon="b" aria-hidden={!loading || undefined}>
            <span className="search-spinner" role={loading ? "status" : undefined} aria-label={loading ? "Searching" : undefined} />
          </span>
        </span>
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
}: {
  filters: Filters;
  update: (patch: Partial<Filters>) => void;
  toggle: (key: FilterCategoryKey, value: string) => void;
  // The search field's spinner, and the keystroke that starts it. Raising the flag here rather than
  // deriving it in the effect keeps it out of a setState-in-effect, and means it goes up on the
  // keystroke itself instead of 250ms later when the debounce finally fires.
  searchBusy: boolean;
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
      <FilterDropdown Icon={IconCompanyF} label="Company" width="w-72" prefetch={`${companiesUrl}?q=&limit=100`}>
        <CompanyCheckList value={filters.company} onChange={(value) => update({ company: value })} />
      </FilterDropdown>
      <FilterDropdown Icon={IconJobTypeF} label="Job type" width="w-72">
        <SidebarPills options={options("employmentType")} selected={filters.employmentType} onToggle={(value) => toggle("employmentType", value)} glyph="jobtype" />
      </FilterDropdown>
      <FilterDropdown Icon={IconWorkplaceF} label="Workplace" width="w-72">
        <SidebarPills options={options("workplace")} selected={filters.workplace} onToggle={(value) => toggle("workplace", value)} glyph="globe" />
      </FilterDropdown>
      {/* "Location", not "Country". The column it filters is headed LOCATION, and a control
            and the column it acts on calling one thing two names is the kind of mismatch that makes
            people wonder whether they are in fact two different things -- the same reason the first
            column and its pill were both renamed to Title. The free-text `location` filter has no
            pill of its own (it is reachable from a row or a URL), so there is no collision. */}
          <FilterDropdown Icon={IconCountryF} label="Location">
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
              className={`${PRESSABLE} flex items-center justify-between gap-2 rounded-[10px] px-2 py-1.5 text-start text-sm text-[var(--ink)] hover:bg-[var(--control-hover)]`}
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
// Save view: one control that morphs through three states rather than three controls that replace
// each other.
//
// Two gaps this closes, both found by the find-animation-opportunities sweep:
//   - Pressing Enter used to write the view to localStorage and say NOTHING. The form closed and
//     the pill came back looking exactly as it had. That is a functional gap wearing an animation
//     costume: the bug was silence, and the fix happens to be motion.
//   - The pill was replaced by a 144px input between one frame and the next.
// Both are rare, deliberate acts -- the tier where a longer beat is welcome -- so the confirmation
// holds for 1,200ms before returning. Long enough to be read, short enough not to be in the way.
function SaveViewPill({
  onSaveView,
  canSaveView,
}: {
  onSaveView: (name: string) => void;
  canSaveView: boolean;
}) {
  const [mode, setMode] = useState<"idle" | "naming" | "saved">("idle");
  const [viewName, setViewName] = useState("");
  const morphRef = useSwapWidth(mode === "idle" ? 0 : mode === "naming" ? 1 : 2, mode);

  // Cleared on unmount so a pill dismounted mid-confirmation cannot set state on a dead component.
  useEffect(() => {
    if (mode !== "saved") return;
    const timer = window.setTimeout(() => setMode("idle"), 1_200);
    return () => window.clearTimeout(timer);
  }, [mode]);

  function commitSave() {
    const name = viewName.trim();
    if (!name) { setMode("idle"); return; }
    onSaveView(name);
    setViewName("");
    setMode("saved");
  }

  return (
    <span ref={morphRef} className="t-morph t-morph-pill align-middle">
      <span data-active={mode === "idle" ? "" : undefined}>
        <button
          type="button"
          onClick={() => setMode("naming")}
          disabled={!canSaveView || mode !== "idle"}
          title={canSaveView ? "Save the current filters as a view" : "Apply a filter first, then save it as a view"}
          className={`${V4_PILL} px-3 disabled:cursor-not-allowed disabled:opacity-55`}
        >
          <IconPlus />
          Save view
        </button>
      </span>

      <span data-active={mode === "naming" ? "" : undefined}>
        <form onSubmit={(event) => { event.preventDefault(); commitSave(); }} className="inline-flex">
          <TextField aria-label="Name this view">
            <Input
              value={viewName}
              // autoFocus on the element itself would fire on every render of a control that is
              // always mounted now. Focused from the effect below the state instead.
              ref={(node) => { if (node && mode === "naming" && document.activeElement !== node) node.focus(); }}
              onChange={(event) => setViewName(event.target.value)}
              onBlur={() => (viewName.trim() ? commitSave() : setMode("idle"))}
              onKeyDown={(event) => event.key === "Escape" && setMode("idle")}
              placeholder="View name"
              maxLength={40}
              className="search-shell h-9 w-36 rounded-[14px] bg-white px-3 text-sm text-[var(--ink)] shadow-[var(--shadow-control)] outline-none placeholder:text-[var(--muted)]"
            />
          </TextField>
        </form>
      </span>

      {/* The confirmation. aria-live so it is announced rather than only drawn -- the whole point is
          that saving used to be invisible, and invisible to a screen reader is the same failure. */}
      <span data-active={mode === "saved" ? "" : undefined}>
        <span role="status" aria-live="polite" className={`${V4_PILL} px-3 text-[var(--accent-strong)]`}>
          <IconCheck />
          Saved
        </span>
      </span>
    </span>
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
  style,
}: { children: React.ReactNode; className?: string; align?: "start" | "end"; style?: React.CSSProperties }) {
  return (
    <th
      scope="col"
      style={style}
      // whitespace-nowrap because a heading that wraps to two lines does not merely look wrong: it
      // changes the header's height, and the virtualizer has already computed every row offset
      // against the old one. columnWidths keeps each column wide enough that this never has to bite.
      className={`whitespace-nowrap px-5 pb-3 ${align === "end" ? "text-end" : "text-start"} text-[12px] font-bold uppercase tracking-[0.05em] text-[var(--muted)] ${className}`}
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

// The six widths used to be hard-coded percentages -- 30/20/12/11/12/15 -- chosen once against an
// imagined result set. They were right for some queries and wrong for most: three quarters of the
// index has no employment type at all, so Job type sat empty at 12% while Location cropped two
// words short beside it. These come from columnWidths() instead, which reads the rows.
// Sized from the FIRST PAGE only, and the memo is keyed on it. Recomputing as later pages arrive
// would relay the table out under someone mid-scroll, which is the failure this is here to avoid --
// a column that moves while you read it is worse than one that was always slightly too narrow.
const HEADER_PAGE = 100;

// What each cell actually DRAWS, which is not the raw row: several places collapse to a count,
// "Location not specified" draws nothing at all, and the employment type is tidied before it is
// shown. Measuring job.location would size the column for a semicolon-joined address the cell was
// never going to render.
function headerRow(job: Job) {
  const places = splitLocations(job.location);
  return {
    title: job.title,
    company: job.company,
    location: job.location === "Location not specified" ? ""
      : places.count !== null ? (places.count > 0 ? `${places.count} locations` : "Multiple locations")
      : places.primary,
    jobType: tidyEmploymentType(job.employmentType) ?? "",
    workplace: job.workplace ?? "",
    source: job.source,
    // A region flag takes the same 24px a country flag does, so the column has to be sized for it.
    hasFlag: Boolean(regionFlagCode(places.primary) || job.country || cityCountry(job.city)),
    extraPlaces: places.extra ?? 0,
  };
}

// A module-level single-entry cache rather than a hook, for the same reason logoOutcome above is
// one: `jobs` gets a new identity on every appended page while the first page -- the only part this
// reads -- has not changed. A useMemo over `jobs` would recompute (harmless: the answer is
// identical) and hand back a NEW object, which changes fixedHeaderContent's identity and makes
// Virtuoso rebuild the sticky header while someone is scrolling under it. This returns the very
// same object until the query itself changes.
// Shared across SSR requests, which is safe because the key is re-checked on every call: two
// concurrent requests with different results cost a recomputation, never a wrong answer.
let widthCache: { key: string; widths: ReturnType<typeof columnWidths> } | null = null;

function columnWidthsFor(jobs: Job[]) {
  const firstPage = jobs.slice(0, HEADER_PAGE);
  const key = firstPage.map((job) => job.id).join(" ");
  if (widthCache?.key !== key) widthCache = { key, widths: columnWidths(firstPage.map(headerRow)) };
  return widthCache.widths;
}

function TableHeader({ widths }: { widths: ReturnType<typeof columnWidths> }) {
  return (
    <tr className="bg-[var(--control-hover)]">
      {/* Role and company share one column: the title is what people scan for, so it leads and the
          company sits beneath it as context, rather than the company owning the first column. */}
      {/* "Title", matching the filter pill that searches it. A column and its filter calling one
          field two different names is the kind of mismatch that makes people wonder whether they
          are in fact two different things. */}
      <TableHeading style={{ width: `${widths.title}%` }}>Title</TableHeading>
      <TableHeading style={{ width: `${widths.location}%` }}>Location</TableHeading>
      <TableHeading style={{ width: `${widths.jobType}%` }}>Job type</TableHeading>
      <TableHeading style={{ width: `${widths.workplace}%` }}>Workplace</TableHeading>
      <TableHeading style={{ width: `${widths.posted}%` }}>Posted</TableHeading>
      <TableHeading style={{ width: `${widths.source}%` }} align="end">Source</TableHeading>
    </tr>
  );
}

// Shown while the first page is in flight, stacked under the real table and cross-faded out when
// rows arrive. It reuses the real table's header and 72px row height so the placeholder blocks sit
// exactly where the logo, title, company and each column will be, and nothing shifts on the swap.
// The container chrome lives on the .t-skel wrapper, which both layers share.
function JobsSkeleton({ widths }: { widths: ReturnType<typeof columnWidths> }) {
  return (
    <div className="h-full overflow-hidden bg-white">
      <table className="jobs-table w-full min-w-[1050px] border-separate border-spacing-0 text-start">
        <thead>
          <TableHeader widths={widths} />
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

// Memoised, and that is the single biggest render win in the file. Virtuoso keeps ~34 rows
// mounted; without this, ANY parent state change -- a keystroke setting searchBusy, isPaging
// flipping mid-scroll, the minute clock ticking -- re-ran all 34 from scratch, each rebuilding four
// tooltip hooks and running the location/employment regexes again. Measured by the profiler on a
// 3,000px scroll: 1,938 row renders before, 50 after.
// It only holds because `onFilter` and `now` are both stable now; a new identity for either puts
// every row straight back to re-rendering.
const JobCells = memo(function JobCells({
  job,
  onFilter,
  now,
}: {
  job: Job;
  onFilter: (patch: Partial<Filters>) => void;
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
  const regionFlag = regionFlagCode(places.primary);
  // The flag (or the remote globe), built once so the cell can place it INSIDE the filter button
  // when there is one: the flag sits flush against the place name it qualifies, so a click landing
  // on it visibly belonged to the same target -- and used to do nothing.
  const flagGlyph = regionFlag || job.country || cityCountry(job.city) ? (
    <Flag code={regionFlag || job.country || cityCountry(job.city)} />
  ) : job.workplace === "Remote" ? (
    <span aria-hidden="true" className="shrink-0 text-[13px] leading-none">🌍</span>
  ) : null;
  // The badge stands for locations the cell never drew, so hovering it has to be able to show them.
  const extraTip = useHoverTip(places.all);
  // The tooltip carries the whole list, not just the entry the cell had room for.
  const locationTip = useTruncationTip(places.all);

  return (
    <>
      <td className="px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {/* The mark filters by its company, same as the name beneath it. It is the largest, most
              obviously clickable thing in the row and it did nothing, which reads as a dead target
              -- and the two halves of one identity should not behave differently. */}
          <button
            type="button"
            onClick={() => onFilter({ company: job.company })}
            aria-label={`Show only jobs at ${job.company}`}
            title={`Show only jobs at ${job.company}`}
            className="shrink-0 rounded-[10px] transition-transform duration-[120ms] ease-[var(--ease-out)] hover:scale-[1.06] active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
          >
            <CompanyLogo job={job} />
          </button>
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
              className="job-role-line block truncate rounded-sm text-sm font-bold tracking-[-0.01em] text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
            >
              {job.title}
            </a>
            {titleTip.tip}
            <span className="job-meta-line flex min-w-0 items-center gap-1 text-[14px] text-[var(--muted)]">
              {/* The watchlist star used to sit here. HIDDEN, not deleted: everything behind it is
                  intact -- the localStorage list, the toggle, the ?watchlist=1 filter and its chip
                  all still work, so turning it back on is putting this button back.
                  It went because it was the one control on the row that promised something the
                  product does not yet do. Starring a company stored a name in this browser and
                  nothing else: no alerts, no digest, no sync to another device. A star that appears
                  to follow a company and does not is worse than no star. */}
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
      <td className="px-5 py-3 text-sm text-[var(--muted)]">
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {/* REGION first (inside flagGlyph above), and that order is the fix rather than an
              ordering preference. job.country is the posting's ingested country, which for a
              multi-location listing is whichever one the ATS happened to resolve -- so
              "Europe · London · Dublin" is stamped gb, and the cell drew a Union Jack next to the
              word Europe. The flag has to answer for the text beside it, and the text beside it is
              places.primary.
              When the cell renders a filter button the glyph moves INSIDE it -- flush against the
              name it qualifies, the flag reads as part of the click target, and it used to be the
              one part of it that ignored the click. The no-button branches keep it out here.
              Nothing at all when there is no glyph -- not an empty span: an empty span is still a
              flex CHILD, so gap-1.5 applied around it and pushed the place name 6px right. */}
          {job.location === "Location not specified" ? flagGlyph : places.count !== null ? (
            // A bare count is not a place, so it is not made to look like one: no filter link (there
            // is nothing to filter by), and lowercase so it reads as a description of the posting
            // rather than the name of somewhere.
            <>
              {flagGlyph}
              <span className="min-w-0 truncate text-[var(--muted)]">
                {places.count > 0 ? `${places.count} locations` : "Multiple locations"}
              </span>
            </>
          ) : !places.primary && !job.city ? flagGlyph : (
            // Nothing at all when there is no place to name -- a Remote-only location strips to the
            // empty string, and the unguarded branch rendered an empty, tab-focusable button whose
            // click filtered by "" (a no-op) on every remote-only row: a nameless control with a
            // dead target, on a very large slice of the table.
            <>
              <button
                type="button"
                // Filtering by the resolved city is far more useful than the raw string, which is
                // often a full address that would match only this one posting.
                onClick={() => (job.city ? onFilter({ city: [job.city], location: "" }) : onFilter({ location: places.primary }))}
                title={locationTip.open ? undefined : job.city ? `Show only jobs in ${job.city}` : `Show only jobs in ${places.primary}`}
                className="-mx-1.5 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-lg px-1.5 py-1 text-start hover:bg-[var(--control-hover)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
              >
                {flagGlyph}
                {/* tipProps ride on THIS span, not the button, because this is the element that
                    truncates -- which is what useTruncationTip measures (scrollWidth > clientWidth).
                    Moving the flag inside the button made the button a flex container, and a flex
                    container never overflows: its children shrink instead. Measured live, the span
                    overflowed by 184px while the button reported 0, so the hook concluded nothing
                    was cropped and suppressed the tooltip on every truncated location. */}
                <span {...locationTip.tipProps} className="min-w-0 truncate">
                  {places.primary || job.city}
                </span>
              </button>
              {/* The remaining places, as a count rather than a truncated run-on. The full list is
                  the tooltip, so nothing is hidden -- it just stops one posting in three from
                  spending the whole column on a semicolon-joined address list. */}
              {places.extra > 0 && (
                <>
                  <span
                    {...extraTip.tipProps}
                    tabIndex={0}
                    className="shrink-0 rounded-full bg-[var(--control-hover)] px-1.5 py-0.5 text-[12px] font-bold tabular-nums text-[var(--muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
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
      {/* Job type and workplace read at --muted like every other column. The row has exactly one
          primary thing in it -- the job title -- and everything else is the metadata that qualifies
          it. These two were the only cells still at --ink, which made "Full time" and "Remote" look
          like headings for their own row when they are the same rank as the location beside them. */}
      <td className="px-5 py-3 text-sm text-[var(--muted)]">
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
      <td className="px-5 py-3 text-sm text-[var(--muted)]">
        <ValueWithIcon Icon={WORKPLACE_ICONS[(job.workplace ?? "").toLowerCase()]} value={job.workplace} />
      </td>
      <td className="whitespace-nowrap px-5 py-3 text-sm tabular-nums text-[var(--muted)]">
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
      {/* Source is a label, not a control -- it names where the posting came from. On hover it
          becomes the row's call to action instead, using the same cross-fade the portfolio's
          "View on LinkedIn" row uses (.row-swap, see globals.css).
          This is what the removed chevron was reaching for and getting wrong: the chevron was a
          second, permanently-visible affordance inside a row that already opens the posting on
          click. A label that turns into "Apply" only while you are pointing at the row states the
          action at the moment it is available and says nothing the rest of the time. */}
      <td className="whitespace-nowrap px-5 py-3 text-end">
        {/* flex, not inline-flex. An inline-flex sits on the cell's TEXT BASELINE rather than filling
            the cell, so the td's vertical-align:middle never reaches it -- and because this one holds
            a 20px mark next to 19px text, baseline alignment pushed the whole thing up. Measured: the
            content sat at 305.7 while every other column's sat at 309.2, a 3.5px lift that read as
            the Source column floating above its own row. Every other cell already uses plain flex;
            this was the one that did not. */}
        <span className="row-swap align-middle text-sm font-bold text-[var(--muted)]">
          <span className="row-swap-out flex items-center justify-end gap-2">
            <AtsMark source={job.source} />
            {job.source}
          </span>
          {/* aria-hidden: the row already has a real anchor whose text is the job title, so a screen
              reader gains nothing from a second "Apply" and would read every row twice. This is a
              pointer affordance, and the media query above means it only ever exists for one. */}
          <span className="row-swap-in flex items-center justify-end gap-2 text-[var(--accent-strong)]" aria-hidden="true">
            Apply
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="shrink-0">
              <circle cx="10" cy="10" r="10" fill="var(--accent)" />
              <path d="M6 10h8M11 7l3 3-3 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </span>
      </td>
    </>
  );
});

// What each logo URL turned out to be, remembered for the session. The virtualizer unmounts a row
// the instant it leaves the viewport and mounts a fresh component when it comes back, so per-row
// state cannot remember anything: scrolling back over rows replayed the skeleton and the fade-in on
// images the browser already had, and re-mounted (and re-measured) banners already known to be
// unusable. Keyed by URL rather than by job, so the second row from the same company is instant too.
const LOGO_CACHE_KEY = "aboard:logo-outcomes";
const LOGO_CACHE_KEY_LEGACY = "startups-board:logo-outcomes";
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
  for (const [url, outcome] of readStored<[string, "ok" | "bad"][]>(LOGO_CACHE_KEY, [], LOGO_CACHE_KEY_LEGACY)) {
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
      {Icon && <span className="inline-flex shrink-0 text-[var(--muted)] [&>svg]:size-4"><Icon /></span>}
      <span className="min-w-0 truncate">{value}</span>
    </span>
  );
}

function CompanyLogo({ job }: { job: Job }) {
  // The same hook the dropdown's mark uses. Empty on the server and on the first client render,
  // which is what keeps the hydrated markup identical.
  const { outcome, settle } = useLogoOutcome(job.companyLogoUrl);
  const failed = outcome === "bad";
  // Two different questions, and conflating them was a bug you could only see on a second visit.
  // `outcome` is the SHAPE verdict for a URL and it is remembered across sessions in localStorage;
  // `painted` is whether THIS <img> element has its pixels right now. Revealing on `outcome === "ok"`
  // alone meant that every row mounted after the outcome cache had hydrated -- so every row on every
  // repeat visit -- rendered at full opacity with nothing in it, skipped the skeleton entirely, and
  // popped the moment the bytes landed. The fade was only ever visible on a cold first visit.
  const { painted, paint, fade } = useImagePainted();
  const loaded = painted && outcome === "ok";

  // The monogram is the BASE layer, always drawn, and a logo fades in over it. It is not a fallback
  // any more and there is no placeholder at all, which is the whole point.
  //
  // What this replaces: a pulsing skeleton that sat there until the logo request settled. That reads
  // as "loading" and for most rows it was loading nothing -- /api/logo answers 404 for any company
  // whose stored logo turns out to be a banner rather than a mark, and it takes ~2s cold and ~0.44s
  // warm to say so (it is not edge-cached; the Next `vary` header defeats that). So a reader
  // scrolling into fresh companies met a column of grey squares that would never become anything.
  // Now every row shows its letter immediately and the ones that HAVE a logo quietly gain it.
  //
  // The base is still rendered when the logo succeeds -- it costs nothing, the white tile covers it
  // completely, and keeping it mounted means the swap never passes through a blank frame.
  // `block`, not the default inline. A <span> is an inline box and an inline box IGNORES width and
  // height, so size-9 applied nothing at all: the absolutely positioned tile inside it had a
  // zero-sized containing block and the monogram rendered as a bare floating letter with no tile.
  // The old markup got away with a bare <span> because it carried `flex`, which made it a block.
  return (
    <span className="relative block size-9 shrink-0">
      <span
        // Rounded-square mark, matching the design's app-icon style logos. A pale tint carrying its
        // own letter rather than a solid block carrying white: the row's real content is the job
        // title, and a saturated 36px block in every logo-less row -- which is most of them -- pulled
        // the eye down the avatar column instead of down the titles.
        // The tint comes from the letter (see monogramTint), so this column stops being one pink
        // stripe. 13px rather than 11: on a 36px tile an 11px letter left a lot of empty fill around
        // it, and the letter is the tinted tile's only strong mark.
        className="absolute inset-0 flex items-center justify-center rounded-[12px] text-[13px] font-bold tracking-[-0.02em] outline outline-1 outline-offset-0"
        style={monogramTint(job.companyMark)}
        aria-hidden="true"
      >
        {job.companyMark}
      </span>
      {job.companyLogoUrl && !failed ? (
        <span
          className={`absolute inset-0 flex items-center justify-center overflow-hidden rounded-[12px] bg-white shadow-[var(--shadow-control)] ${loaded ? fade : "opacity-0"}`}
        >
          {/* Dynamic ATS logos are remote and cannot use a fixed Next image host allowlist. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={job.companyLogoUrl}
            alt=""
            // Eager, not lazy: virtualization already means only the rows near the viewport exist in
            // the DOM, so lazy loading added a second visibility check -- and its decode latency --
            // to images that are about to be on screen either way.
            loading="eager"
            decoding="async"
            // Low priority: a logo is decoration next to the row text, and it must not compete with
            // the jobs request that fills the table in the first place.
            fetchPriority="low"
            referrerPolicy="no-referrer"
            // No inset: the logo fills the tile edge to edge. object-contain still keeps a
            // not-quite-square mark whole rather than cropping it.
            className="size-full object-contain"
            // A cached image can finish before React attaches onLoad. The ref catches that on mount.
            ref={(node) => {
              paint(node);
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
              paint(img);
              settle(isUsableLogoRatio(img.naturalWidth, img.naturalHeight) ? "ok" : "bad");
            }}
          />
        </span>
      ) : null}
    </span>
  );
}

