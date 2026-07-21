"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Chip, Input, SearchField, TextField } from "@heroui/react";
import { TableVirtuoso, type TableComponents } from "react-virtuoso";
import {
  categoryOptions,
  jobs,
  sourceOptions,
  workplaceOptions,
  type Job,
} from "./jobs";

type WorkplaceFilter = Job["workplace"] | "All";
type SourceFilter = Job["source"] | "All";
type CategoryFilter = Job["category"] | "All";

const referenceDate = new Date(Date.UTC(2026, 6, 20));
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

export function JobsExplorer() {
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState("");
  const [workplace, setWorkplace] = useState<WorkplaceFilter>("All");
  const [source, setSource] = useState<SourceFilter>("All");
  const [category, setCategory] = useState<CategoryFilter>("All");
  const [remoteJobs, setRemoteJobs] = useState<Job[]>([]);
  const [totalJobs, setTotalJobs] = useState(jobs.length);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const filteredJobs = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const normalizedLocation = location.trim().toLocaleLowerCase();

    return jobs.filter((job) => {
      const searchable = [job.title, job.company, job.description, ...job.skills]
        .join(" ")
        .toLocaleLowerCase();

      return (
        (!normalizedQuery || searchable.includes(normalizedQuery)) &&
        (!normalizedLocation || job.location.toLocaleLowerCase().includes(normalizedLocation)) &&
        (workplace === "All" || job.workplace === workplace) &&
        (source === "All" || job.source === source) &&
        (category === "All" || job.category === category)
      );
    });
  }, [category, location, query, source, workplace]);

  function resetPagination() {
    setCursor(null);
    setNextCursor(null);
    setRemoteJobs([]);
  }

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const parameters = new URLSearchParams({
        limit: String(pageSize),
      });
      if (cursor) parameters.set("cursor", cursor);
      if (query.trim()) parameters.set("search", query.trim());
      if (location.trim()) parameters.set("location", location.trim());
      if (workplace !== "All") parameters.set("workplace", workplace);
      if (source !== "All") {
        parameters.set("provider", source === "Spark Hire" ? "sparkhire" : source.toLocaleLowerCase());
      }
      if (category !== "All") parameters.set("category", category);

      setIsLoading(true);
      try {
        const response = await fetch(`${apiUrl}?${parameters}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Jobs API returned ${response.status}`);
        const payload = (await response.json()) as { jobs: Job[]; total: number; nextCursor: string | null };
        setRemoteJobs((current) => {
          if (!cursor) return payload.jobs;
          const byId = new Map(current.map((job) => [job.id, job]));
          for (const job of payload.jobs) byId.set(job.id, job);
          return [...byId.values()];
        });
        setTotalJobs(payload.total);
        setNextCursor(payload.nextCursor);
        setIsLive(true);
      } catch (error) {
        if ((error as Error).name !== "AbortError" && !cursor) setIsLive(false);
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [category, cursor, location, query, source, workplace]);

  const displayedJobs = isLive ? remoteJobs : filteredJobs;
  const displayedTotal = isLive ? totalJobs : filteredJobs.length;

  const activeFilterCount = [
    query.trim(),
    location.trim(),
    workplace !== "All" ? workplace : "",
    category !== "All" ? category : "",
    source !== "All" ? source : "",
  ].filter(Boolean).length;

  function clearFilters() {
    setQuery("");
    setLocation("");
    setWorkplace("All");
    setSource("All");
    setCategory("All");
    setCursor(null);
    setNextCursor(null);
  }

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
            {isLive ? "Live local index" : "Demo fallback"}
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
          <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-[minmax(260px,1.5fr)_minmax(190px,0.9fr)_repeat(3,minmax(150px,0.7fr))_auto]">
            <SearchField
              aria-label="Search roles, companies, or skills"
              value={query}
              onChange={(value) => {
                setQuery(value);
                resetPagination();
              }}
              fullWidth
              className="min-w-0"
            >
              <SearchField.Group className="min-h-11 rounded-xl bg-[var(--control)] px-3.5 shadow-none">
                <SearchField.SearchIcon className="text-[var(--muted)]" />
                <SearchField.Input
                  placeholder="Role, company, or skill"
                  className="text-base text-[var(--ink)] placeholder:text-[var(--muted)] sm:text-sm"
                />
                <SearchField.ClearButton aria-label="Clear job search" />
              </SearchField.Group>
            </SearchField>

            <TextField aria-label="Filter by location" fullWidth className="min-w-0">
              <Input
                value={location}
                onChange={(event) => {
                  setLocation(event.target.value);
                  resetPagination();
                }}
                placeholder="Location"
                className="min-h-11 rounded-xl bg-[var(--control)] px-3.5 text-base text-[var(--ink)] shadow-none placeholder:text-[var(--muted)] sm:text-sm"
              />
            </TextField>

            <FilterSelect
              label="Workplace"
              value={workplace}
              options={workplaceOptions}
              onChange={(value) => {
                setWorkplace(value as WorkplaceFilter);
                resetPagination();
              }}
            />
            <FilterSelect
              label="Function"
              value={category}
              options={categoryOptions}
              onChange={(value) => {
                setCategory(value as CategoryFilter);
                resetPagination();
              }}
            />
            <FilterSelect
              label="ATS"
              value={source}
              options={sourceOptions}
              onChange={(value) => {
                setSource(value as SourceFilter);
                resetPagination();
              }}
            />

            <Button
              variant="secondary"
              isDisabled={!activeFilterCount}
              className="min-h-11 rounded-xl px-4 font-medium transition-[scale,background-color] duration-150 active:not-disabled:scale-[0.96] md:col-span-2 xl:col-span-1"
              onPress={clearFilters}
            >
              Clear
              {activeFilterCount > 0 && (
                <span className="tabular-nums text-[var(--muted)]">{activeFilterCount}</span>
              )}
            </Button>
          </div>
        </div>

        <div className="mb-3 mt-7 flex items-center justify-between gap-4 px-1">
          <p aria-live="polite" className="text-sm font-medium text-[var(--muted-strong)]">
            <span className="tabular-nums text-[var(--ink)]">{displayedTotal}</span>{" "}
            {displayedTotal === 1 ? "job" : "jobs"}
            {isLoading && <span className="ms-2 font-normal">Updating…</span>}
          </p>
          <p className="text-[13px] text-[var(--muted)]">Newest first</p>
        </div>

        {displayedJobs.length > 0 ? (
          <div className="overflow-hidden rounded-2xl shadow-[var(--shadow-table)]">
            <TableVirtuoso
              aria-label="Startup jobs from public ATS pages"
              className="jobs-table-scroll bg-white"
              style={{ height: "clamp(420px, 68vh, 760px)" }}
              data={displayedJobs}
              components={virtuosoComponents}
              computeItemKey={(_index, job) => job.id}
              fixedHeaderContent={TableHeader}
              itemContent={(_index, job) => <JobCells job={job} />}
              defaultItemHeight={73}
              increaseViewportBy={{ top: 220, bottom: 420 }}
              initialItemCount={Math.min(12, displayedJobs.length)}
              endReached={() => {
                if (isLive && !isLoading && nextCursor && remoteJobs.length < totalJobs) {
                  setCursor(nextCursor);
                }
              }}
            />
          </div>
        ) : (
          <div className="rounded-2xl bg-white px-6 py-16 text-center shadow-[var(--shadow-table)]">
            <p className="text-base font-semibold">No matching jobs</p>
            <p className="mt-1 text-sm text-[var(--muted)]">Try a broader search or clear a filter.</p>
            <Button
              variant="secondary"
              className="mt-5 min-h-11 rounded-xl px-4 font-medium transition-transform duration-150 active:scale-[0.96]"
              onPress={clearFilters}
            >
              Clear filters
            </Button>
          </div>
        )}

        {isLive && (
          <p className="mt-4 text-center text-[13px] tabular-nums text-[var(--muted)]">
            Showing {remoteJobs.length.toLocaleString()} of {displayedTotal.toLocaleString()}
            {remoteJobs.length < displayedTotal ? " · Scroll for more" : ""}
          </p>
        )}
      </section>
    </main>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
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
        <option value="All">All {label.toLocaleLowerCase()}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
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
        <span className="mt-0.5 block text-[12px] text-[var(--muted)]">{job.category}</span>
      </td>
      <td className="px-5 py-3.5 text-sm text-[var(--muted-strong)]">{job.location}</td>
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
