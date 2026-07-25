import { queryCompanySuggestions } from "../../jobs-query";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const companies = await queryCompanySuggestions(url.searchParams.get("q") ?? "", Number.isFinite(limit) ? limit : 200);

  return Response.json({ companies }, {
    // Rebuilt once a day by the cron, so repeated prefixes are served from cache.
    headers: { "cache-control": "public, max-age=300, stale-while-revalidate=3600" },
  });
}
