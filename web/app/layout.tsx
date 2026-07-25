import type { Metadata } from "next";
import { Inter, Pixelify_Sans } from "next/font/google";
import "./globals.css";

// Weights start at 500: the design brief calls for medium as the lightest weight on the page, so
// 400 is deliberately not loaded and cannot be used by accident.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
});

// Pixel display face for the hero heading only. The redesign used Alpha Lyrae (a paid font);
// Pixelify Sans is the closest open substitute and is loaded via next/font so it self-hosts.
const pixelify = Pixelify_Sans({
  variable: "--font-pixel",
  subsets: ["latin"],
  weight: ["500"],
  display: "swap",
});

const TITLE = "Startup jobs — Startups.board";
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
  title: { default: TITLE, template: "%s — Startups.board" },
  description: DESCRIPTION,
  applicationName: "Startups.board",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    type: "website",
    siteName: "Startups.board",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/startups-board-og.png", width: 1200, height: 630, alt: "Startups.board" }],
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
      <body className={`${inter.variable} ${pixelify.variable} font-medium antialiased`}>{children}</body>
    </html>
  );
}
