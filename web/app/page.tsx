import { cache } from "react";

import { JobsExplorer } from "./jobs-explorer";
import { queryJobs, type JobsPage } from "./jobs-query";
import { OG_IMAGES, TWITTER_IMAGES } from "./site-meta";

export const dynamic = "force-dynamic";

// Local dev binds an empty Miniflare D1, so the server render reads the real index from the local
// SQLite API instead (npm run serve). Production never takes this path -- D1 answers directly.
const DEV_API_URL = process.env.DEV_JOBS_API_URL ?? "http://localhost:3002/api/jobs";

// cache() so generateMetadata and the page component share ONE query. Both need the first page
// now -- the metadata for the live count in the <title>, the component for the rows -- and without
// this the index would be queried twice per request, which on the unfiltered page is the most
// expensive query the site runs.
const loadFirstPage = cache(async function loadFirstPage(params: URLSearchParams): Promise<JobsPage | null> {
  const isProduction = process.env.NODE_ENV === "production";
  try {
    const page = await queryJobs(params);
    // In production, whatever the query answered IS the answer -- including "nothing matches".
    // The zero-total check below used to apply there too, which treats an empty result as a broken
    // database: a shared link to a search that legitimately matches nothing rendered "No matching
    // jobs", reported hasServerData=false so the client refetched the identical query, and rendered
    // "No matching jobs" again with a skeleton in between.
    //
    // In dev it still means what it was written to mean. The Miniflare D1 binding exists but is
    // empty, so it answers 0 rather than throwing, and the count is the only signal that the real
    // index lives behind the local SQLite API instead.
    if (isProduction || (page.total ?? 0) > 0) return page;
  } catch {
    // Falls through to the dev API below.
  }

  if (isProduction) return null;
  try {
    const response = await fetch(`${DEV_API_URL}?${params}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as JobsPage;
  } catch {
    return null;
  }
});

// cache() keys on the ARGUMENT, and a URLSearchParams built twice is two different objects -- so the
// key is its string form and both callers go through here.
const paramCache = new Map<string, URLSearchParams>();
function firstPageParams(resolved: Record<string, string | string[] | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === "string" && value) params.set(key, value);
  }
  params.set("limit", "100");
  const key = params.toString();
  const existing = paramCache.get(key);
  if (existing) return existing;
  paramCache.set(key, params);
  if (paramCache.size > 200) paramCache.delete(paramCache.keys().next().value as string);
  return params;
}

// The filters a crawler should treat as the page's identity. Deliberately a small, fixed list: the
// same result set is reachable through many parameter spellings, and every extra one indexed is
// another near-duplicate competing with the page it duplicates.
const CANONICAL_KEYS = ["company", "title", "search", "location", "workplace", "country", "employmentType"];

function canonicalPath(resolved: Record<string, string | string[] | undefined>) {
  const params = new URLSearchParams();
  for (const key of CANONICAL_KEYS) {
    const value = resolved[key];
    if (typeof value === "string" && value.trim()) params.set(key, value.trim());
  }
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Every filter combination is served from this one route, so without this they all shared the
// index's title and description -- which is what a crawler reads as duplicate content, and what a
// shared /?company=Stripe link showed the person it was sent to. The title is derived from the
// params alone: no extra query, so this costs nothing on a page that is already force-dynamic.
export async function generateMetadata({ searchParams }: { searchParams: SearchParams }) {
  const resolved = await searchParams;
  const one = (key: string) => {
    const value = resolved[key];
    return (typeof value === "string" ? value : "").trim().slice(0, 60);
  };

  const company = one("company");
  const title = one("title");
  const search = one("search");
  const location = one("location");
  const remote = one("workplace").toLowerCase() === "remote";

  // Most specific wins. Anything past the first is already in the page's own chips; repeating the
  // whole filter set in a <title> makes it unreadable in a tab and unusable in a result listing.
  // No longer "Startup jobs in X": 63% of the boards in the index are Paylocity, BambooHR, Workday
  // or iCIMS -- hospitals, councils and enterprises -- so "startup" described a minority of the
  // rows it sat above.
  const heading = company ? `Jobs at ${company}`
    : title ? `${title} jobs`
    : search ? `“${search}” jobs`
    : location ? `Jobs in ${location}`
    : remote ? "Remote jobs"
    : null;

  // The unfiltered index gets the live count instead of a fixed phrase: it is the one number that
  // tells a reader whether the page is worth opening, and in a tab strip a moving figure is easier
  // to find again than another line of prose. The query is the one the page component is about to
  // run anyway -- cache() above makes them the same call, not two.
  if (!heading) {
    const page = await loadFirstPage(firstPageParams(resolved));
    const total = page?.total ?? 0;
    if (!total) return {};
    // "1 jobs" is the kind of thing a stub row in a test catches and nobody else does.
    const plural = total === 1 && !page?.totalCapped ? "job" : "jobs";
    const count = `${total.toLocaleString()}${page?.totalCapped ? "+" : ""} ${plural}`;
    return {
      title: { absolute: `${count} — Aboard` },
      // Relative, so it resolves against metadataBase -- which is aboard.cc. That is what makes the
      // workers.dev origin and www both point at the canonical host instead of competing with it as
      // duplicates of the same page.
      alternates: { canonical: "/" },
      // images spread in explicitly: Next replaces the layout's whole openGraph object rather than
      // merging into it, so omitting them here drops the card. See site-meta.ts.
      openGraph: { title: `${count} — Aboard`, images: OG_IMAGES },
      twitter: { title: `${count} — Aboard`, images: TWITTER_IMAGES },
    };
  }
  const description = `Open ${company ? `roles at ${company}` : heading.toLowerCase()}, collected from public Ashby, Greenhouse, Lever, Workday and other ATS job boards.`;
  return {
    title: heading,
    description,
    // The canonical for a FILTERED page is that page, not the index. Pointing them all at "/" would
    // tell a crawler that /?company=Intercom is a duplicate of the homepage and drop the entire long
    // tail -- which is most of what there is to index here. Only the params that produced the
    // heading are kept, so /?company=Intercom&limit=100 and /?company=Intercom are one URL.
    alternates: { canonical: canonicalPath(resolved) },
    openGraph: { title: `${heading} — Aboard`, description, images: OG_IMAGES },
    twitter: { title: `${heading} — Aboard`, description, images: TWITTER_IMAGES },
  };
}

export default async function Home({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const resolved = await searchParams;
  const params = firstPageParams(resolved);

  const initialPage = await loadFirstPage(params);

  // `limit` is a transport detail, not a filter, so it must not leak into the client's filter state.
  // Deleted from a COPY: `params` is the object firstPageParams memoises and hands to every caller
  // with the same query, so mutating it here would strip the limit from the next request that
  // reused it -- and that request would then ask the index for its default page size instead of 100.
  const clientQuery = new URLSearchParams(params);
  clientQuery.delete("limit");

  return (
    <JobsExplorer
      initialJobs={initialPage?.jobs ?? []}
      initialTotal={initialPage?.total ?? 0}
      initialTotalCapped={initialPage?.totalCapped ?? false}
      initialCorrectedTo={initialPage?.correctedTo ?? null}
      initialCursor={initialPage?.nextCursor ?? null}
      hasServerData={initialPage !== null}
      initialQuery={clientQuery.toString()}
    />
  );
}
