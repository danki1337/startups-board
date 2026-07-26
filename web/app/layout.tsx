import type { Metadata } from "next";
import { Nunito } from "next/font/google";
import "./globals.css";
import { OG_IMAGES, SITE_ORIGIN, TWITTER_IMAGES } from "./site-meta";

// One weight, 700, for everything on the page.
//
// Loading only 700 is what ENFORCES that rather than merely expressing it. A weight utility this
// file does not ship -- one from HeroUI's own styles, or one a future component reaches for -- has
// no face to render with, and with font-synthesis off the browser falls back to the nearest weight
// that IS loaded. When 700 is the only one, everything resolves to 700 whatever it asked for.
//
// Nunito is a variable font, so omitting `weight` would ship the whole 200-1000 range and quietly
// undo that. The explicit list is the enforcement.
//
// What this trades: there is no longer a lighter step available for the one modifier that used to
// read quieter than its surroundings -- "Updating…" beside the result count. It now sits at the same
// weight as the number it qualifies. That is the instruction, not an oversight, and it is a one-line
// change here plus a font-bold on that span if the distinction is ever wanted back.
const nunito = Nunito({
  variable: "--font-nunito",
  subsets: ["latin"],
  weight: ["700"],
  display: "swap",
});

// Pixelify Sans used to sit here as the hero's display face. It was dropped from the markup when the
// headline became a sentence with a live number in it -- a display face is for three or four words --
// but the loader stayed, so every visitor was still downloading a webfont that no rule referenced.

// The FALLBACK only. The index's real title carries its live job count and is built in page.tsx;
// this is what shows if that query fails, and what the "%s — Aboard" template hangs off.
// It no longer says "startup": 63% of the boards in the index are Paylocity, BambooHR, Workday or
// iCIMS -- hospitals, councils and enterprises -- so the word described a minority of the rows.
const TITLE = "Every open job, from the source — Aboard";
const DESCRIPTION =
  "Search open roles collected straight from companies' own Ashby, Greenhouse, Lever, Workday and other ATS job boards.";

// Defaults only: page.tsx narrows the title and description to whatever filters the URL carries, so
// a shared or crawled /?company=Stripe describes itself rather than inheriting the index's copy.
// The social card was the conspicuous gap -- the image has been sitting in public/ unreferenced, so
// every link to the site anywhere unfurled as a bare URL.
export const metadata: Metadata = {
  // Without this the social card resolves to a relative "/aboard-og.webp", which most unfurlers
  // will not fetch -- the tag is present and the preview is still blank. See SITE_ORIGIN.
  metadataBase: new URL(SITE_ORIGIN),
  title: { default: TITLE, template: "%s — Aboard" },
  description: DESCRIPTION,
  applicationName: "Aboard",
  // The sticker "a", from the same drawing as the wordmark. Built from a 1000x1000 source with
  // Lanczos3 down to 16/32/48 packed into one .ico (PNG payloads, not BMP -- every browser in use
  // and Windows Vista onward read them, and they are a fraction of the size), plus PNGs for the
  // platforms that ignore .ico entirely.
  // The .svg this replaces was the OLD brand -- four green #267047 squares on cream -- and it had to
  // be deleted rather than merely unreferenced: browsers prefer an SVG icon when one is declared, so
  // leaving the file and the entry would have kept serving the wrong mark.
  // Worth knowing before the next export: the source is opaque. What looks like a floating sticker
  // is a sticker drawn ON white, so the tab icon is a white tile, which shows on dark browser chrome.
  // A re-export with a transparent background is a drop-in replacement; the alpha cannot be
  // recovered from this raster, because the drop shadow ramps continuously from the page white into
  // the sticker's own white outline with no boundary between them.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
  openGraph: {
    type: "website",
    siteName: "Aboard",
    title: TITLE,
    description: DESCRIPTION,
    images: OG_IMAGES,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: TWITTER_IMAGES,
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${nunito.variable} font-bold antialiased`}>{children}</body>
    </html>
  );
}
