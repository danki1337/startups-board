// Resolve a company logo from a public ATS board page.
//
// Most ATS job APIs return no logo at all -- only Getro and Spark Hire include one in the payload,
// and Workday's is constructible from the tenant URL. For the rest the board's own HTML carries a
// usable image: Greenhouse exposes the customer's uploaded logo via og:image, iCIMS links the
// company's real favicon on its own domain, and Paylocity serves a per-company GetLogoFileById URL.
//
// The trap is that several ATS products serve their OWN branding from the same tags -- Ashby's
// favicon is cdn.ashbyprd.com and BambooHR's og:image is a bamboohr.com marketing asset -- which
// would paint one identical logo across thousands of unrelated companies. Anything matching a
// vendor asset pattern is rejected so those boards fall back to the generated monogram instead.

const TAG_PATTERN =
  /<(?:meta|link)[^>]*?(?:property|name|rel)=["']([^"']+)["'][^>]*?(?:content|href)=["']([^"']+)["'][^>]*>/gi;

// Square icons are preferred over og:image because the logo renders into a 32px avatar slot, and
// og:image is usually a wide social-share banner (Stripe serves Stripe_jobs_share.jpg there). Boards
// that upload a real logo but no favicon -- Greenhouse customers, Paylocity -- still resolve via the
// og:image fallback at the end of this list.
const TAG_PRIORITY = ["apple-touch-icon", "icon", "shortcut icon", "og:image"];

// Vendor-owned assets: matching these means the tag describes the ATS product, not the employer.
const VENDOR_ASSET_PATTERNS = [
  /(^|\.)ashbyprd\.com$/i,
  /(^|\.)ashbyhq\.com$/i,
  /^www\.bamboohr\.com$/i,
  /(^|\.)lever\.co$/i,
  /(^|\.)gem\.com$/i,
  /(^|\.)comeet\.com$/i,
  /(^|\.)getro\.com$/i,
  /^cdn\.paylocity\.com$/i,
];

export function extractLogoUrl(html, baseUrl) {
  if (!html) return null;
  const found = new Map();

  for (const match of html.matchAll(TAG_PATTERN)) {
    const kind = match[1].toLowerCase().trim();
    const key = TAG_PRIORITY.find((candidate) => kind === candidate)
      ?? (kind.includes("icon") ? "icon" : null);
    if (!key || found.has(key)) continue;

    const raw = decodeHtmlEntities(match[2].trim());
    // Inline placeholders such as `data:,` appear on boards that suppress the favicon entirely.
    if (!raw || raw.startsWith("data:")) continue;

    let absolute;
    try {
      absolute = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (absolute.protocol !== "https:" && absolute.protocol !== "http:") continue;
    if (isVendorAsset(absolute)) continue;
    found.set(key, absolute.href);
  }

  for (const key of TAG_PRIORITY) {
    if (found.has(key)) return found.get(key);
  }
  return null;
}

export function isVendorAsset(url) {
  return VENDOR_ASSET_PATTERNS.some((pattern) => pattern.test(url.hostname));
}

// Board pages are HTML, so this is a single extra request per board and is cached for weeks rather
// than repeated on every refresh.
export async function resolveBoardLogo(board, request) {
  const target = board.boardUrl || board.apiUrl;
  if (!target) return null;
  const response = await request(target);
  const html = await response.text();
  return extractLogoUrl(html, response.url || target);
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#x26;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#x2F;/gi, "/");
}
