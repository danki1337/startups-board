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
  Rippling: "/ats/rippling.png",
  SmartRecruiters: "/ats/smartrecruiters.png",
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
  Rippling: { short: "Rp", className: "bg-[#fdeae6] text-[#a8331b]" },
  SmartRecruiters: { short: "SR", className: "bg-[#e6f0fb] text-[#15508c]" },
  "Spark Hire": { short: "Sh", className: "bg-[#fff0dc] text-[#95590c]" },
  Workday: { short: "Wd", className: "bg-[#e6f2fb] text-[#0b5c8a]" },
};

// Pulls the twelve marks into the browser cache once, so the ATS dropdown -- which renders all of
// them at the same instant -- does not fire twelve first-time requests as it opens. Cheap enough to
// do unconditionally: 56KB total, and they never change.
let warmed = false;
export function warmAtsIcons() {
  if (warmed || typeof window === "undefined") return;
  warmed = true;
  for (const src of Object.values(ICONS)) {
    const image = new Image();
    image.decoding = "async";
    image.src = src;
  }
}

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
        // Not lazy. These are 20px marks that are on screen the moment they render -- in every
        // table row, and twelve at once when the ATS filter opens -- so deferring them bought
        // nothing and cost a visible pop-in per icon. The whole set is 56KB and cached after first
        // paint; warmAtsIcons() below fetches it once so the filter panel never opens empty.
        loading="eager"
        decoding="async"
        fetchPriority="low"
        // 36%, because that is the artwork's OWN corner radius -- measured off the alpha channel,
        // all twelve icons go opaque 23px into a 64px canvas, and their edge midpoints are fully
        // opaque, so they are rounded squares at 23/64. A box-shadow follows the border-radius, so
        // at the old 4px (20% of a 20px mark) the shadow's corners sat outside the icon's rounder
        // ones and drew a squarer outline around a rounder logo. A percentage keeps the two in step
        // at both sizes the mark renders at.
        // The same hairline-ring-plus-lift the filter pills wear (--shadow-control), not a border:
        // these marks are square vendor icons on a white row, and several of them are themselves
        // near-white, so without an edge they float. A shadow rather than an outline because the
        // ring layer IS the first shadow (0 0 0 1px), so one property draws both the edge and the
        // lift and they can never disagree.
        className={`${dimension} shrink-0 rounded-[36%] object-contain shadow-[var(--shadow-control)]`}
        onError={() => setFailed(true)}
      />
    );
  }

  const mark = FALLBACKS[source] ?? { short: source.slice(0, 2), className: "bg-black/5 text-black/60" };
  return (
    <span
      aria-hidden="true"
      className={`inline-flex ${dimension} shrink-0 items-center justify-center rounded-[36%] text-[10px] font-bold tracking-[-0.02em] shadow-[var(--shadow-control)] ${mark.className}`}
    >
      {mark.short}
    </span>
  );
}
