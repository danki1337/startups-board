import { queryJobs } from "../../jobs-query";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const page = await queryJobs(url.searchParams);

  return Response.json(page, {
    headers: { "cache-control": "public, max-age=30, stale-while-revalidate=120" },
  });
}
