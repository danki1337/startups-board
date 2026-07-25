import { JobsExplorer } from "./jobs-explorer";
import { queryJobs, type JobsPage } from "./jobs-query";

export const dynamic = "force-dynamic";

// Local dev binds an empty Miniflare D1, so the server render reads the real index from the local
// SQLite API instead (npm run serve). Production never takes this path -- D1 answers directly.
const DEV_API_URL = process.env.DEV_JOBS_API_URL ?? "http://localhost:3002/api/jobs";

async function loadFirstPage(params: URLSearchParams): Promise<JobsPage | null> {
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
  const heading = company ? `Jobs at ${company}`
    : title ? `${title} jobs`
    : search ? `“${search}” jobs`
    : location ? `Startup jobs in ${location}`
    : remote ? "Remote startup jobs"
    : null;

  if (!heading) return {};
  const description = `Open ${company ? `roles at ${company}` : heading.toLowerCase()}, collected from public Ashby, Greenhouse, Lever, Workday and other ATS job boards.`;
  return {
    title: heading,
    description,
    openGraph: { title: `${heading} — Startups.board`, description },
    twitter: { title: `${heading} — Startups.board`, description },
  };
}

export default async function Home({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const resolved = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === "string" && value) params.set(key, value);
  }
  params.set("limit", "100");

  const initialPage = await loadFirstPage(params);

  // `limit` is a transport detail, not a filter, so it must not leak into the client's filter state.
  params.delete("limit");

  return (
    <JobsExplorer
      initialJobs={initialPage?.jobs ?? []}
      initialTotal={initialPage?.total ?? 0}
      initialTotalCapped={initialPage?.totalCapped ?? false}
      initialCorrectedTo={initialPage?.correctedTo ?? null}
      initialCursor={initialPage?.nextCursor ?? null}
      hasServerData={initialPage !== null}
      initialQuery={params.toString()}
    />
  );
}
