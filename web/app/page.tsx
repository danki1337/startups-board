import { JobsExplorer } from "./jobs-explorer";
import { queryJobs, type JobsPage } from "./jobs-query";
import { jobs as demoJobs } from "./jobs";

export const dynamic = "force-dynamic";

// The first page is rendered on the server so the table shows real jobs immediately. It used to
// paint a 12-row demo fixture and only replace it once a client fetch resolved, which is why the
// UI appeared to "only show 12 jobs".
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

  let initialPage: JobsPage | null = null;
  try {
    initialPage = await queryJobs(params);
  } catch {
    // Local dev without a D1 binding still renders, falling back to the bundled sample rows.
    initialPage = null;
  }

  // `limit` is a transport detail, not a filter, so it must not leak into the client's filter state.
  params.delete("limit");

  return (
    <JobsExplorer
      initialJobs={initialPage?.jobs ?? demoJobs}
      initialTotal={initialPage?.total ?? demoJobs.length}
      initialCursor={initialPage?.nextCursor ?? null}
      isLiveInitially={initialPage !== null}
      initialQuery={params.toString()}
    />
  );
}
