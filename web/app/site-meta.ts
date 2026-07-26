// The site's own origin, and the social card.
//
// SITE_ORIGIN is what metadataBase resolves every absolute URL against -- the OG image, the Twitter
// card, canonical links. robots.txt and sitemap.xml do NOT read it: they are route handlers that
// derive the origin from the request, so they stay correct on whatever host is serving them. This
// constant exists because `metadata` in layout.tsx is assembled with no request in hand.
//
// Overridable by env so a preview deployment describes itself rather than pointing its cards at
// production. The default is the real domain, because the common case is production.
export const SITE_ORIGIN = process.env.SITE_ORIGIN ?? "https://aboard.cc";

// The social card, in one place because Next does NOT deep-merge `openGraph`.
//
// A page that exports any `openGraph` object replaces the layout's whole object rather than
// extending it, so `openGraph: { title, description }` in page.tsx silently dropped the image. That
// is not hypothetical: every filtered URL -- /?company=Intercom, /?search=designer, the ones people
// actually paste into Slack -- has been unfurling with no picture, while the unfiltered index (which
// exported nothing and therefore inherited the layout's object intact) looked fine. Spreading these
// into every openGraph/twitter block is what keeps the two in step.
//
// 1200x630 is the 1.91:1 og:image asks for, cropped from a 1920x1080 source by taking 72px off the
// TOP: the wordmark bleeds off the bottom by design, so that is the only crop that leaves the
// composition alone.
//
// WebP at q90 is 18KB, against 33KB for JPEG and 72KB for PNG at the same crop. The catch is real
// and worth stating rather than discovering: LinkedIn does not render WebP og:images, so a link
// shared there unfurls without a picture. OG_IMAGE_FALLBACK is the identical crop as JPEG, sitting
// in public/ for exactly that reason -- swapping the two constants here is the whole fix if
// LinkedIn matters more than 15KB.
export const OG_IMAGE = "/aboard-og.webp";
export const OG_IMAGE_FALLBACK = "/aboard-og.jpg";

export const OG_IMAGES = [{ url: OG_IMAGE, width: 1200, height: 630, alt: "Aboard" }];
export const TWITTER_IMAGES = [OG_IMAGE];
