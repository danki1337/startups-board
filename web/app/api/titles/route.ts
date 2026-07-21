import { queryTitleSuggestions } from "../../jobs-query";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const titles = await queryTitleSuggestions(url.searchParams.get("q") ?? "");

  return Response.json({ titles }, {
    // Suggestions change at most daily, so repeated prefixes are served from cache.
    headers: { "cache-control": "public, max-age=300, stale-while-revalidate=3600" },
  });
}
