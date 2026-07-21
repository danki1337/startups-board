import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// Weights start at 500: the design brief calls for medium as the lightest weight on the page, so
// 400 is deliberately not loaded and cannot be used by accident.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Startup jobs — Startups.board",
  description:
    "Filter startup roles published on public Ashby, Greenhouse, Lever, and other ATS job boards.",
  applicationName: "Startups.board",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} font-medium antialiased`}>{children}</body>
    </html>
  );
}
