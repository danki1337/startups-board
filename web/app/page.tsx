import { JobsExplorer } from "./jobs-explorer";
import { queryJobs, type JobsPage } from "./jobs-query";

export const dynamic = "force-dynamic";

// Local dev binds an empty Miniflare D1, so the server render reads the real index from the local
// SQLite API instead (npm run serve). Production never takes this path -- D1 answers directly.
const DEV_API_URL = process.env.DEV_JOBS_API_URL ?? "http://localhost:3002/api/jobs";

async function loadFirstPage(params: URLSearchParams): Promise<JobsPage | null> {
  try {
    const page = await queryJobs(params);
    if (page.total > 0) return page;
  } catch {
    // Falls through to the dev API below.
  }

  if (process.env.NODE_ENV === "production") return null;
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

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
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
      initialCursor={initialPage?.nextCursor ?? null}
      hasServerData={initialPage !== null}
      initialQuery={params.toString()}
    />
  );
}
