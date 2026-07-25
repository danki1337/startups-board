// A route handler rather than a file in public/, so the sitemap it advertises is absolute and
// correct on whatever origin the worker is actually serving -- the workers.dev subdomain today, a
// custom domain later -- without a build-time constant that would quietly go stale.

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const body = [
    "User-agent: *",
    "Allow: /",
    // The JSON endpoints answer the same rows the page already renders, and each one is an
    // uncached D1 query. There is nothing to index and every crawl of them is billed.
    "Disallow: /api/",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
