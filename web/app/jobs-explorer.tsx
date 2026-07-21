"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Chip, Input, SearchField, TextField, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { TableVirtuoso, type TableComponents } from "react-virtuoso";
import {
  categoryOptions,
  sourceOptions,
  workplaceOptions,
  type Job,
} from "./jobs";
import { COUNTRY_OPTIONS, countryFlag, countryName } from "./countries";
import { CITY_OPTIONS, ROLE_FAMILY_OPTIONS } from "./taxonomies";
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

const sortOptions = [
  { label: "Newest first", value: "newest" },
  { label: "Oldest first", value: "oldest" },
  { label: "Company A–Z", value: "company" },
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
  workplace: string[];
  category: string[];
  source: string[];
  employmentType: string[];
  postedWithin: string;
  sort: string;
};

const emptyFilters: Filters = {
  search: "",
  title: "",
  location: "",
  company: "",
  country: "",
  city: "",
  roleFamily: "",
  workplace: [],
  category: [],
  source: [],
  employmentType: [],
  postedWithin: "",
  sort: "newest",
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
    workplace: list("workplace"),
    category: list("category"),
    source: list("provider"),
    employmentType: list("employmentType"),
    postedWithin: params.get("postedWithin") ?? "",
    sort: params.get("sort") ?? "newest",
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
  if (filters.workplace.length) params.set("workplace", filters.workplace.join(","));
  if (filters.category.length) params.set("category", filters.category.join(","));
  if (filters.source.length) params.set("provider", filters.source.join(","));
  if (filters.employmentType.length) params.set("employmentType", filters.employmentType.join(","));
  if (filters.postedWithin) params.set("postedWithin", filters.postedWithin);
  if (filters.sort !== "newest") params.set("sort", filters.sort);
  return params;
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
  // The server already rendered page one for the current URL, so the first filter effect must not
  // immediately refetch the identical query. When the server could not reach D1 (local dev) the
  // first fetch must still run, otherwise the page would sit on the sample rows forever.
  const skipNextFetch = useRef(hasServerData);

  const queryString = useMemo(() => filtersToSearchParams(filters).toString(), [filters]);

  function update(patch: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...patch }));
  }

  function toggle(key: "workplace" | "category" | "source" | "employmentType", value: string) {
    setFilters((current) => {
      const values = current[key];
      return {
        ...current,
        [key]: values.includes(value) ? values.filter((v) => v !== value) : [...values, value],
      };
    });
  }

  // Refetch page one whenever the filters change, and mirror them into the URL so a filtered view
  // is shareable and survives reload.
  useEffect(() => {
    const nextUrl = `${window.location.pathname}${queryString ? `?${queryString}` : ""}`;
    window.history.replaceState(null, "", nextUrl);

    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsLoading(true);
      try {
        const params = new URLSearchParams(queryString);
        params.set("limit", String(pageSize));
        const response = await fetch(`${apiUrl}?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Jobs API returned ${response.status}`);
        const payload = (await response.json()) as { jobs: Job[]; total: number; nextCursor: string | null };
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
  }, [queryString]);

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
    for (const value of filters.workplace) chips.push({ label: value, clear: () => toggle("workplace", value) });
    for (const value of filters.category) chips.push({ label: value, clear: () => toggle("category", value) });
    for (const value of filters.source) chips.push({ label: value, clear: () => toggle("source", value) });
    for (const value of filters.employmentType) chips.push({ label: value, clear: () => toggle("employmentType", value) });
    if (filters.postedWithin) {
      const label = postedWithinOptions.find((option) => option.value === filters.postedWithin)?.label;
      chips.push({ label: label ?? filters.postedWithin, clear: () => update({ postedWithin: "" }) });
    }
    return chips;
  }, [filters]);

  return (
    <main className="min-h-screen bg-[var(--canvas)] text-[var(--ink)]">
      <header className="border-b border-black/8 bg-white">
        <div className="mx-auto flex min-h-[68px] w-full max-w-[1600px] items-center justify-between gap-4 px-5 sm:px-8">
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

      <section className="mx-auto w-full max-w-[1600px] px-5 pb-12 pt-8 sm:px-8 sm:pt-10">
        <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold leading-tight tracking-[-0.025em]">Startup jobs</h1>
            <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">
              Roles published on public company ATS pages.
            </p>
          </div>
          <p className="text-[13px] text-[var(--muted)]">
            Ashby · BambooHR · Gem · Getro · Greenhouse · iCIMS · Lever · Paylocity · Spark Hire · Workday
          </p>
        </div>

        <div className="rounded-2xl bg-white p-3 shadow-[var(--shadow-panel)]">
          <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            <SearchField
              aria-label="Search all job text"
              value={filters.search}
              onChange={(value) => update({ search: value })}
              fullWidth
              className="min-w-0"
            >
              <SearchField.Group className="min-h-11 rounded-xl bg-[var(--control)] px-3.5 shadow-none">
                <SearchField.SearchIcon className="text-[var(--muted)]" />
                <SearchField.Input
                  placeholder="Search everything"
                  className="text-base text-[var(--ink)] placeholder:text-[var(--muted)] sm:text-sm"
                />
                <SearchField.ClearButton aria-label="Clear job search" />
              </SearchField.Group>
            </SearchField>

            <PlainSelect
              label="Role"
              value={filters.roleFamily}
              options={roleOptions}
              onChange={(value) => update({ roleFamily: value })}
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
                className="min-h-11 rounded-xl bg-[var(--control)] px-3.5 text-base text-[var(--ink)] shadow-none placeholder:text-[var(--muted)] sm:text-sm"
              />
            </TextField>

            <PlainSelect
              label="Country"
              value={filters.country}
              options={countrySelectOptions}
              onChange={(value) => update({ country: value })}
            />

            <PlainSelect
              label="City"
              value={filters.city}
              options={cityOptions}
              onChange={(value) => update({ city: value })}
            />

            <TextField aria-label="Filter by city or region" fullWidth className="min-w-0">
              <Input
                value={filters.location}
                onChange={(event) => update({ location: event.target.value })}
                placeholder="City or region"
                className="min-h-11 rounded-xl bg-[var(--control)] px-3.5 text-base text-[var(--ink)] shadow-none placeholder:text-[var(--muted)] sm:text-sm"
              />
            </TextField>

            <PlainSelect
              label="Date posted"
              value={filters.postedWithin}
              options={postedWithinOptions}
              onChange={(value) => update({ postedWithin: value })}
            />
            <PlainSelect
              label="Sort"
              value={filters.sort}
              options={sortOptions}
              onChange={(value) => update({ sort: value })}
            />
          </div>

          <div className="mt-3 grid gap-2.5 border-t border-black/6 pt-3 lg:grid-cols-2 xl:grid-cols-4">
            <MultiSelect
              label="Workplace"
              options={workplaceOptions}
              selected={filters.workplace}
              onToggle={(value) => toggle("workplace", value)}
            />
            <MultiSelect
              label="Function"
              options={categoryOptions}
              selected={filters.category}
              onToggle={(value) => toggle("category", value)}
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

        <div className="mb-3 mt-7 flex items-center justify-between gap-4 px-1">
          <p aria-live="polite" className="text-sm font-medium text-[var(--muted-strong)]">
            <span className="tabular-nums text-[var(--ink)]">{total.toLocaleString()}</span>{" "}
            {total === 1 ? "job" : "jobs"}
            {isLoading && <span className="ms-2 font-normal">Updating…</span>}
          </p>
          <p className="text-[13px] text-[var(--muted)]">
            {sortOptions.find((option) => option.value === filters.sort)?.label}
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
              itemContent={(_index, job) => <JobCells job={job} onFilter={update} />}
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

function PlainSelect({
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
    <label className="relative min-w-0">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 w-full appearance-none rounded-xl bg-[var(--control)] py-2 pe-9 ps-3.5 text-base text-[var(--ink)] outline-none shadow-none transition-[box-shadow,background-color] duration-150 hover:bg-[var(--control-hover)] focus-visible:shadow-[0_0_0_2px_var(--focus)] sm:text-sm"
        aria-label={label}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-xs text-[var(--muted)]"
      >
        ▾
      </span>
    </label>
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
    <tr className="bg-[var(--canvas)]">
      {/* Role and company share one column: the title is what people scan for, so it leads and the
          company sits beneath it as context, rather than the company owning the first column. */}
      <TableHeading className="w-[40%]">Role</TableHeading>
      <TableHeading className="w-[21%]">Location</TableHeading>
      <TableHeading className="w-[13%]">Workplace</TableHeading>
      <TableHeading className="w-[13%]">Posted</TableHeading>
      <TableHeading className="w-[13%] text-end">Source</TableHeading>
    </tr>
  );
}

function JobCells({ job, onFilter }: { job: Job; onFilter: (patch: Partial<Filters>) => void }) {
  const postedDate = job.publishedAt ? new Date(job.publishedAt) : new Date(referenceDate);
  if (!job.publishedAt) {
    postedDate.setUTCDate(referenceDate.getUTCDate() - Math.max(0, (job.postedDaysAgo ?? 1) - 1));
  }

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
                onClick={() => onFilter({ company: job.company })}
                title={`Show only jobs at ${job.company}`}
                className="max-w-[55%] truncate rounded underline-offset-2 transition-colors duration-150 hover:text-[var(--ink)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
              >
                {job.company}
              </button>
              <span aria-hidden="true">·</span>
              <span className="truncate">
                {job.category}
                {job.employmentType ? ` · ${job.employmentType}` : ""}
              </span>
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
      <td className="px-5 py-3.5">
        <Chip size="sm" variant="soft" className="whitespace-nowrap text-[12px]">
          {job.workplace}
        </Chip>
      </td>
      <td className="whitespace-nowrap px-5 py-3.5 text-sm tabular-nums text-[var(--muted-strong)]">
        <time dateTime={postedDate.toISOString().slice(0, 10)}>{dateFormatter.format(postedDate)}</time>
      </td>
      <td className="whitespace-nowrap px-5 py-3.5 text-end">
        <a
          href={job.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-[var(--muted-strong)] transition-[color,background-color,scale] duration-150 hover:bg-black/4 hover:text-[var(--ink)] active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
          aria-label={`Open ${job.title} at ${job.company} on ${job.source}`}
        >
          <AtsMark source={job.source} />
          {job.source}
          <span aria-hidden="true" className="text-[13px]">
            ↗
          </span>
        </a>
      </td>
    </>
  );
}

function CompanyLogo({ job }: { job: Job }) {
  const [failed, setFailed] = useState(false);
  if (job.companyLogoUrl && !failed) {
    return (
      <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white outline outline-1 -outline-offset-1 outline-black/10">
        {/* Dynamic ATS logos are remote and cannot use a fixed Next image host allowlist. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={job.companyLogoUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-contain p-0.5"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span
      className={`flex size-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold tracking-[-0.02em] outline outline-1 -outline-offset-1 outline-black/10 ${job.companyColor}`}
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
        className="min-h-11 w-full rounded-xl bg-[var(--control)] px-3.5 text-base text-[var(--ink)] outline-none shadow-none transition-[box-shadow,background-color] duration-150 placeholder:text-[var(--muted)] hover:bg-[var(--control-hover)] focus-visible:shadow-[0_0_0_2px_var(--focus)] sm:text-sm"
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
