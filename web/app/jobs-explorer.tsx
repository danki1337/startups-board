"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Chip, Input, SearchField, TextField } from "@heroui/react";
import { TableVirtuoso, type TableComponents } from "react-virtuoso";
import {
  categoryOptions,
  sourceOptions,
  workplaceOptions,
  type Job,
} from "./jobs";
import { COUNTRY_OPTIONS, countryFlag, countryName } from "./countries";
import { AtsMark } from "./ats-marks";

const referenceDate = new Date(Date.UTC(2026, 6, 20));
// In local dev the Miniflare D1 binding is empty, so the server render falls back to the bundled
// sample rows and the client reads the real index from the local SQLite API instead (npm run serve).
const apiUrl = typeof window !== "undefined" && window.location.hostname === "localhost"
  ? "http://localhost:3002/api/jobs"
  : "/api/jobs";
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
  isLiveInitially = false,
  initialQuery = "",
}: {
  initialJobs?: Job[];
  initialTotal?: number;
  initialCursor?: string | null;
  isLiveInitially?: boolean;
  initialQuery?: string;
}) {
  // Seeded from the server-supplied query string rather than window.location, so the server and
  // client render identical markup. Reading window here caused a hydration mismatch whenever the
  // page was opened with filters already in the URL.
  const [filters, setFilters] = useState<Filters>(() => filtersFromSearchParams(initialQuery));
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [total, setTotal] = useState(initialTotal);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [isLive, setIsLive] = useState(isLiveInitially);
  const [isLoading, setIsLoading] = useState(false);
  const [isPaging, setIsPaging] = useState(false);
  // The server already rendered page one for the current URL, so the first filter effect must not
  // immediately refetch the identical query. When the server could not reach D1 (local dev) the
  // first fetch must still run, otherwise the page would sit on the sample rows forever.
  const skipNextFetch = useRef(isLiveInitially);

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
        setIsLive(true);
      } catch (error) {
        if ((error as Error).name !== "AbortError") setIsLive(false);
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
            <span
              className={`size-2 rounded-full ${isLive ? "bg-[var(--success)]" : "bg-amber-400"}`}
              aria-hidden="true"
            />
            {isLive ? "Live index" : "Sample data"}
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

            <TextField aria-label="Filter by job title" fullWidth className="min-w-0">
              <Input
                value={filters.title}
                onChange={(event) => update({ title: event.target.value })}
                placeholder="Role title"
                className="min-h-11 rounded-xl bg-[var(--control)] px-3.5 text-base text-[var(--ink)] shadow-none placeholder:text-[var(--muted)] sm:text-sm"
              />
            </TextField>

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
              itemContent={(_index, job) => <JobCells job={job} />}
              defaultItemHeight={73}
              increaseViewportBy={{ top: 220, bottom: 420 }}
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
}: {
  label: string;
  options: readonly string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 px-0.5 text-[12px] font-medium text-[var(--muted)]">{label}</p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
        {options.map((option) => {
          const isSelected = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onToggle(option)}
              className={`min-h-8 rounded-lg px-2.5 text-[12px] font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] ${
                isSelected
                  ? "bg-[var(--ink)] text-white"
                  : "bg-[var(--control)] text-[var(--muted-strong)] hover:bg-[var(--control-hover)]"
              }`}
            >
              {option}
            </button>
          );
        })}
      </div>
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
      <TableHeading className="w-[17%]">Company</TableHeading>
      <TableHeading className="w-[25%]">Role</TableHeading>
      <TableHeading className="w-[19%]">Location</TableHeading>
      <TableHeading className="w-[13%]">Workplace</TableHeading>
      <TableHeading className="w-[13%]">Posted</TableHeading>
      <TableHeading className="w-[13%] text-end">Source</TableHeading>
    </tr>
  );
}

function JobCells({ job }: { job: Job }) {
  const postedDate = job.publishedAt ? new Date(job.publishedAt) : new Date(referenceDate);
  if (!job.publishedAt) {
    postedDate.setUTCDate(referenceDate.getUTCDate() - Math.max(0, (job.postedDaysAgo ?? 1) - 1));
  }

  return (
    <>
      <td className="px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <CompanyLogo job={job} />
          <span className="truncate text-sm font-semibold tracking-[-0.01em]" title={job.company}>
            {job.company}
          </span>
        </div>
      </td>
      <td className="px-5 py-3.5">
        <span className="block truncate text-sm font-medium text-[var(--ink)]" title={job.title}>
          {job.title}
        </span>
        <span className="mt-0.5 block text-[12px] text-[var(--muted)]">
          {job.category}
          {job.employmentType ? ` · ${job.employmentType}` : ""}
        </span>
      </td>
      <td className="px-5 py-3.5 text-sm text-[var(--muted-strong)]">
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden="true" className="shrink-0 text-[13px] leading-none">
            {job.countryFlag ?? (job.workplace === "Remote" ? "🌍" : "")}
          </span>
          <span className="truncate" title={job.location}>{job.location}</span>
        </span>
      </td>
      <td className="px-5 py-3.5">
        <Chip size="sm" variant="soft" className="whitespace-nowrap text-[12px]">
          {job.workplace}
        </Chip>
      </td>
      <td className="px-5 py-3.5 text-sm tabular-nums text-[var(--muted-strong)]">
        <time dateTime={postedDate.toISOString().slice(0, 10)}>{dateFormatter.format(postedDate)}</time>
      </td>
      <td className="px-5 py-3.5 text-end">
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
