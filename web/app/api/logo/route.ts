import { getD1 } from "../../../db";
import { imageDimensions, isUsableLogoRatio } from "../../../../src/logo-shape.mjs";

// A company logo, served from our own origin so it can actually be cached.
//
// The problem this exists for, measured against production: the ATS hosts send NOTHING cacheable.
// A Workday logo comes back with no cache-control, no etag and no last-modified, and
// cf-cache-status: DYNAMIC. The browser stores the response and then cannot use it -- the entry is
// born stale with no validator, so every <img> load re-downloads it in full. Fetched from the page:
//
//     force-cache (use the stored entry)   2 ms     <- the bytes ARE there
//     default     (what <img> uses)      186 ms     <- and are re-downloaded anyway
//
// Across a first paint that was a median of 1,970ms per logo over 18 separate third-party hosts,
// and it is why logos re-appear every time a virtualized row scrolls back or the Company dropdown
// re-opens: the row remembers that the logo was fine, and the browser fetches it again regardless.
//
// We cannot fix Workday's headers. We can put ourselves in the path and send correct ones.
//
// SECURITY. This is a proxy, and a proxy that takes a URL from the caller is an open relay and an
// SSRF hole. It takes a BOARD KEY instead: the URL is looked up in our own database and a caller
// can never express one. There is deliberately no ?url= parameter to review, rate-limit or escape.

export const dynamic = "force-dynamic";

// A year, immutable. Safe because the answer for a board key only changes when that company changes
// its logo, and the monthly logo_checked_at recheck is what picks that up -- a stale logo for a few
// weeks is a far better trade than re-downloading every logo on every scroll.
const CACHE = "public, max-age=31536000, immutable";
// A rejection is cached too, and for the same reason: a board whose logo is a banner or a 404 must
// not be re-fetched by every visitor forever. Shorter, so a company that fixes its logo is picked
// up in a day rather than a year.
const MISS_CACHE = "public, max-age=86400";

// Upstream is fetched through Cloudflare's cache as well, so 27,042 distinct logos cost the ATSs
// one request each per month rather than one per cache-cold visitor.
const UPSTREAM_TTL = 2_592_000;

const EMPTY = new Response(null, {
  status: 404,
  headers: { "cache-control": MISS_CACHE },
});

export async function GET(request: Request) {
  const board = new URL(request.url).searchParams.get("b");
  if (!board) return EMPTY;

  // Mirrors the coalesce the jobs query itself uses: a payload-supplied logo on the board's own jobs
  // (Getro, Spark Hire, Paylocity) wins, then the one the scraper resolved onto the company. Only
  // these two columns can ever produce the URL that gets fetched below.
  const row = await getD1().prepare(`
    SELECT coalesce(
      (SELECT j.company_logo_url FROM jobs j
        WHERE j.board_key = ? AND j.company_logo_url IS NOT NULL AND j.company_logo_url <> '' LIMIT 1),
      c.logo_url
    ) AS url
    FROM boards b LEFT JOIN companies c ON c.key = b.company_key
    WHERE b.key = ?
  `).bind(board, board).first<{ url: string | null }>();

  const url = row?.url ?? "";
  // https only. Even coming from our own database this is the last gate before fetch(), and a
  // stored value is only ever as trustworthy as the ATS page it was scraped from.
  if (!url.startsWith("https://")) return EMPTY;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { accept: "image/*,*/*;q=0.8" },
      redirect: "follow",
      // @ts-expect-error -- `cf` is a Workers-only fetch option and is absent from the DOM types.
      cf: { cacheEverything: true, cacheTtl: UPSTREAM_TTL },
    });
  } catch {
    return EMPTY;
  }
  if (!upstream.ok) return EMPTY;

  const bytes = new Uint8Array(await upstream.arrayBuffer());
  // The same shape check the browser used to run, moved here so it runs ONCE for everyone rather
  // than on every visitor's device on every scroll. Sampled across 14 Workday boards it rejects 10 --
  // which is not a regression but the point: those are the banners the browser was already
  // downloading, decoding and throwing away. pfizer's is 242x100, a ratio of 2.42 against a usable
  // window of 0.625-1.6.
  //
  // Reading the bytes rather than the header is also what saves the opposite case. lowes.wd5 sends
  // a genuine 134x100 PNG announced as `text/plain; charset=UTF-8`; going by content-type would
  // have thrown away a perfectly good logo.
  const size = imageDimensions(bytes);
  if (!size || !isUsableLogoRatio(size.width, size.height)) return EMPTY;

  return new Response(bytes, {
    headers: {
      // The type detected from the FILE, never the one upstream claimed. Workday announces real
      // PNGs as `text/plain; charset=UTF-8` -- lowes.wd5's logo is a genuine 134x100 image sent
      // with that header -- and echoing it back alongside nosniff below tells the browser to refuse
      // to paint a perfectly good logo. An <img> would have sniffed it; a relay must not guess.
      "content-type": size.type,
      "cache-control": CACHE,
      // The bytes are a third party's; nothing here should be treated as same-origin content.
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}
