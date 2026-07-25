import { queryCompanySuggestions } from "../jobs-query";

// The index's crawlable surface. Until the job title became a real anchor there was nothing here
// worth submitting -- every posting was an onClick with no href, so 1.24M rows were invisible to a
// crawler no matter how many URLs a sitemap listed.
//
// What is listed is the set of pages that are genuinely distinct: the index itself, the remote view,
// and one per company. A company view is the real landing page a job index has -- "jobs at Stripe"
// is a thing people search for; "jobs filtered to Full-time and Hybrid" is not -- and it costs one
// indexed read of the job_companies aggregate the Company dropdown already uses.
export const dynamic = "force-dynamic";

// The ceiling queryCompanySuggestions itself clamps to (COMPANY_SUGGESTION_MAX). Asking for more
// silently returns 1,000 anyway, so the number is written honestly here rather than describing an
// intent the call cannot honour. Well inside the 50,000-URL limit a sitemap file may carry, and past
// the point where the tail is companies with a single open role.
const COMPANY_LIMIT = 1_000;

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;

  let companies: { company: string }[] = [];
  try {
    companies = await queryCompanySuggestions("", COMPANY_LIMIT);
  } catch {
    // A sitemap that lists the two static entries beats a 500. The crawler retries.
  }

  const urls = [
    { loc: origin, priority: "1.0" },
    { loc: `${origin}/?workplace=Remote`, priority: "0.8" },
    ...companies.map((row) => ({
      loc: `${origin}/?company=${encodeURIComponent(row.company)}`,
      priority: "0.6",
    })),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(({ loc, priority }) => `  <url><loc>${escapeXml(loc)}</loc><changefreq>daily</changefreq><priority>${priority}</priority></url>`).join("\n")}
</urlset>
`;

  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      // The company list is rebuilt once a day by the cron, so there is nothing to gain from a
      // shorter window and a full rebuild per crawler hit to lose.
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}

// A company name is arbitrary provider text and lands inside an XML element. encodeURIComponent
// above covers the URL grammar; this covers the document's.
function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
