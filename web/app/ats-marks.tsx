"use client";

import { useState } from "react";
import type { Job } from "./jobs";

// The vendors' own icons, fetched from each vendor's site and served locally rather than hotlinked,
// so the table does not fire ten cross-origin image requests per screen and does not break when a
// vendor rotates its CDN path. Used nominatively -- to identify which ATS a posting came from.
// The lettermark below is the fallback whenever an icon fails to load.
const ICONS: Record<string, string> = {
  Ashby: "/ats/ashby.png",
  BambooHR: "/ats/bamboohr.png",
  Gem: "/ats/gem.png",
  Getro: "/ats/getro.png",
  Greenhouse: "/ats/greenhouse.png",
  iCIMS: "/ats/icims.png",
  Lever: "/ats/lever.png",
  Paylocity: "/ats/paylocity.png",
  "Spark Hire": "/ats/sparkhire.png",
  Workday: "/ats/workday.png",
};

const FALLBACKS: Record<string, { short: string; className: string }> = {
  Ashby: { short: "As", className: "bg-[#e8eefc] text-[#294f9f]" },
  BambooHR: { short: "Bm", className: "bg-[#e5efe3] text-[#3f7a2e]" },
  Gem: { short: "Ge", className: "bg-[#efe7fb] text-[#6b3fa0]" },
  Getro: { short: "Gt", className: "bg-[#e1f1ef] text-[#15645a]" },
  Greenhouse: { short: "Gh", className: "bg-[#e3f0e6] text-[#24603a]" },
  iCIMS: { short: "iC", className: "bg-[#e7ecf0] text-[#34495b]" },
  Lever: { short: "Lv", className: "bg-[#fde8ea] text-[#a12b3c]" },
  Paylocity: { short: "Py", className: "bg-[#e8f0fb] text-[#1d4f91]" },
  "Spark Hire": { short: "Sh", className: "bg-[#fff0dc] text-[#95590c]" },
  Workday: { short: "Wd", className: "bg-[#e6f2fb] text-[#0b5c8a]" },
};

export function AtsMark({ source, size = 5 }: { source: Job["source"] | string; size?: 4 | 5 }) {
  const [failed, setFailed] = useState(false);
  const icon = ICONS[source];
  const dimension = size === 4 ? "size-4" : "size-5";

  if (icon && !failed) {
    return (
      /* eslint-disable-next-line @next/next/no-img-element */
      <img
        src={icon}
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
        className={`${dimension} shrink-0 rounded-[4px] object-contain`}
        onError={() => setFailed(true)}
      />
    );
  }

  const mark = FALLBACKS[source] ?? { short: source.slice(0, 2), className: "bg-black/5 text-black/60" };
  return (
    <span
      aria-hidden="true"
      className={`inline-flex ${dimension} shrink-0 items-center justify-center rounded-[5px] text-[10px] font-bold tracking-[-0.02em] ${mark.className}`}
    >
      {mark.short}
    </span>
  );
}
