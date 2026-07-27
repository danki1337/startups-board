import { queryJobs } from "../../jobs-query";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const page = await queryJobs(url.searchParams);

  // A request naming a list of employers is one the reader assembled; `public` would invite shared
  // caches to keep what is effectively a personal document. Everything else is the same for
  // everyone.
  const personal = url.searchParams.has("companies");
  return Response.json(page, {
    headers: {
      "cache-control": personal
        ? "private, max-age=30"
        : "public, max-age=30, stale-while-revalidate=120",
    },
  });
}
