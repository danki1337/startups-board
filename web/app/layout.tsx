import type { Metadata } from "next";
import { Nunito } from "next/font/google";
import "./globals.css";

// Every weight on the page moved up one step, so the loaded set moved with it: body copy at 600,
// headings and emphasis at 700, the heaviest marks at 800. 500 stays for the single modifier that
// has to read LIGHTER than what surrounds it -- "Updating…" beside the count -- and it now has a
// real face to do that with. It previously asked for 400, found nothing loaded, and rendered
// identical to its neighbours because font-synthesis is off.
//
// The explicit list is what keeps 400 off the page. Nunito is a variable font, so omitting `weight`
// would ship the whole 200-1000 range and put it silently back within reach.
const nunito = Nunito({
  variable: "--font-nunito",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
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
      <body className={`${nunito.variable} font-semibold antialiased`}>{children}</body>
    </html>
  );
}
