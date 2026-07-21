import type { Job } from "./jobs";

// Brand-tinted lettermarks, not the vendors' actual logos. Each ATS's real logo is its trademark and
// several are not offered under a redistributable licence, so shipping a recognisable colour +
// letter keeps the row scannable without misrepresenting anyone's brand or hotlinking their assets.
const MARKS: Record<string, { short: string; className: string }> = {
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

export function AtsMark({ source }: { source: Job["source"] }) {
  const mark = MARKS[source] ?? { short: source.slice(0, 2), className: "bg-black/5 text-black/60" };
  return (
    <span
      aria-hidden="true"
      className={`inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] text-[10px] font-bold tracking-[-0.02em] ${mark.className}`}
    >
      {mark.short}
    </span>
  );
}
