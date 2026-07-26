import type { Metadata } from "next";
import { Nunito } from "next/font/google";
import "./globals.css";

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

const TITLE = "Startup jobs — Aboard";
const DESCRIPTION =
  "Filter startup roles published on public Ashby, Greenhouse, Lever, and other ATS job boards.";

// Defaults only: page.tsx narrows the title and description to whatever filters the URL carries, so
// a shared or crawled /?company=Stripe describes itself rather than inheriting the index's copy.
// The social card was the conspicuous gap -- the image has been sitting in public/ unreferenced, so
// every link to the site anywhere unfurled as a bare URL.
export const metadata: Metadata = {
  // Without this the social card resolves to a relative "/startups-board-og.png", which most
  // unfurlers will not fetch -- the tag is present and the preview is still blank. robots.txt and
  // the sitemap derive their origin from the request and need no constant; metadata is assembled
  // with no request in hand, so this is the one place the origin has to be written down. Change it
  // here when a custom domain lands.
  metadataBase: new URL("https://startups-board.dilizarov8823.workers.dev"),
  title: { default: TITLE, template: "%s — Aboard" },
  description: DESCRIPTION,
  applicationName: "Aboard",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    type: "website",
    siteName: "Aboard",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/startups-board-og.png", width: 1200, height: 630, alt: "Aboard" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/startups-board-og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${nunito.variable} font-bold antialiased`}>{children}</body>
    </html>
  );
}
