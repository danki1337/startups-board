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

import { imageDimensions, isUsableLogoRatio } from "./logo-shape.mjs";

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
  // SmartRecruiters serves its own favicon/wordmark from av-www.smartrecruiters.com on every board.
  /(^|\.)smartrecruiters\.com$/i,
  /(^|\.)ripplingcdn\.com$/i,
];

// Customer-owned assets that happen to live on a vendor domain, carved out of the vendor rejection:
// Ashby boards put the employer's uploaded logo at app.ashbyhq.com/api/images/org-theme-*, and
// SmartRecruiters keeps customer images on the separate c.smartrecruiters.com bucket.
function isCustomerAsset(url) {
  const host = url.hostname.toLowerCase();
  if (host === "app.ashbyhq.com" && url.pathname.startsWith("/api/images/org-theme-")) return true;
  if (host === "c.smartrecruiters.com") return true;
  return false;
}

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

// Every candidate the page offers, best-priority first, rather than only the winner.
//
// The single-winner version could not recover from a bad top pick, and the top pick is bad often:
// og:image is a social-share banner by design, and the boards that fall through to it are exactly
// the ones whose own favicon is a vendor asset we reject. Measured on production, Lever boards
// served a logo URL for 32 of 32 sampled companies and only 2 were a usable shape -- the other 30
// were banners. Handing the caller the whole list lets it verify and move on instead of giving up.
export function extractLogoCandidates(html, baseUrl) {
  if (!html) return [];
  const found = new Map();

  for (const match of html.matchAll(TAG_PATTERN)) {
    const kind = match[1].toLowerCase().trim();
    const key = TAG_PRIORITY.find((candidate) => kind === candidate)
      ?? (kind.includes("icon") ? "icon" : null);
    if (!key || found.has(key)) continue;

    const raw = decodeHtmlEntities(match[2].trim());
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

  const ordered = [];
  for (const key of TAG_PRIORITY) {
    const url = found.get(key);
    if (url && !ordered.includes(url)) ordered.push(url);
  }
  return ordered;
}

export function isVendorAsset(url) {
  if (isCustomerAsset(url)) return false;
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

// As above, but every candidate rather than the best one, for callers that verify before storing.
export async function resolveBoardLogoCandidates(board, request) {
  const target = board.boardUrl || board.apiUrl;
  if (!target) return [];
  const response = await request(target);
  const html = await response.text();
  return extractLogoCandidates(html, response.url || target);
}

// The first candidate that is a real, correctly-shaped image. Bounded because this runs on the
// monthly recheck for every board in the registry, and an unbounded walk over a page that lists a
// dozen icons would multiply that by twelve.
export async function firstUsableLogo(candidates, request, limit = 3) {
  for (const candidate of candidates.slice(0, limit)) {
    const verified = await verifyLogoShape(candidate, request);
    if (verified) return verified;
  }
  return null;
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#x26;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#x2F;/gi, "/");
}

// Providers whose job payload carries a CONSTRUCTED logo URL rather than one the ATS actually
// published. Workday is the only one: every tenant is assumed to serve its customer's logo at
// {board}/assets/logo, which is true in the sense that something is served there and false in the
// sense that it is usually the website's header banner (measured: ratios 1.76 to 6.38) or a 404.
//
// The distinction matters because a non-null bad URL is worse than a null one -- it wins the
// coalesce against companies.logo_url in the read path, so it actively suppresses the scraped logo
// that would have worked. Providers not listed here (Getro, Spark Hire, Paylocity) send a URL the
// ATS itself stores, and those are trusted as before.
export const CONSTRUCTED_LOGO_PROVIDERS = new Set(["workday"]);

// Is this candidate actually usable as a 36px avatar? Fetches only the head of the file: every
// format states its dimensions within the first bytes, so there is no reason to pull a 2MB banner
// down in full to discover it is a banner.
//
// Returns the url when it is a real, correctly-shaped image, and null otherwise -- including for
// non-200s, non-images, and HTML error pages served with a 200, all of which occur here.
export async function verifyLogoShape(url, request) {
  if (!url) return null;
  try {
    const response = await request(url);
    if (!response.ok) return null;
    const type = response.headers.get("content-type") ?? "";
    // Some CDNs answer a missing asset with the site's HTML shell and a 200.
    if (type && !/^image\/|^application\/octet-stream/i.test(type)) return null;

    const buffer = await response.arrayBuffer();
    const size = imageDimensions(new Uint8Array(buffer));
    if (!size) return null;
    return isUsableLogoRatio(size.width, size.height) ? url : null;
  } catch {
    // A logo that cannot be fetched is not a logo. Treated the same as a missing one so the caller
    // falls through to scraping rather than storing something unverified.
    return null;
  }
}
