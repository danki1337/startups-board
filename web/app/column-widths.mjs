// How wide each table column should be, given what is actually in it.
//
// The table is `table-layout: fixed` and has to stay that way: only the rows near the viewport
// exist in the DOM while virtualized, so `auto` layout re-measures against whatever happens to be
// on screen and the columns visibly walk about as you scroll. Fixed layout takes every width from
// the header alone -- which is stable, and which is also why those widths were six hard-coded
// percentages that could not know that Job type is empty for three quarters of the index while
// Location is cropping two words short.
//
// So the widths are still fixed, and still come from the header. They are simply COMPUTED from the
// result set first, once, rather than guessed once and for all at design time.
//
// Three properties make this safe to do:
//
//   1. It is a pure function of the rows. No DOM, no measuring, no layout effect. The server and
//      the client run the same arithmetic over the same first page and reach the same answer, so
//      there is no post-hydration reflow and no mismatch.
//   2. It returns PERCENTAGES from a fixed reference width, so the result does not depend on the
//      viewport. Resizing the window rescales the columns; it does not re-lay them out.
//   3. The caller feeds it the FIRST PAGE only. Paging appends rows, and if a row on page 7 could
//      widen a column, the table would shift under the reader mid-scroll -- which is the exact
//      thing this is supposed to prevent.
//
// Text is measured from a table of advance widths rather than a canvas, because a canvas does not
// exist on the server and `measureText` before the webfont loads returns the fallback's metrics.
// The table below was measured from the real face; summing per-character agrees with measureText to
// within 1px on a 162px string, which is far below the granularity anything here decides.

// Nunito 700, advance width per character at font-size 1. Fonts scale linearly, so one table serves
// the 14px cells and the 12px header both.
const ADVANCE = {
  "0": 0.6, "1": 0.6, "2": 0.6, "3": 0.6, "4": 0.6, "5": 0.6, "6": 0.6, "7": 0.6, "8": 0.6, "9": 0.6,
  " ": 0.271, "!": 0.248, '"': 0.448, "#": 0.6, $: 0.6, "%": 0.945, "&": 0.726, "'": 0.243,
  "(": 0.358, ")": 0.358, "*": 0.453, "+": 0.6, ",": 0.248, "-": 0.434, ".": 0.248, "/": 0.313,
  ":": 0.248, ";": 0.248, "<": 0.6, "=": 0.6, ">": 0.6, "?": 0.459, "@": 0.95,
  A: 0.744, B: 0.688, C: 0.68, D: 0.762, E: 0.597, F: 0.562, G: 0.736, H: 0.773, I: 0.282,
  J: 0.354, K: 0.665, L: 0.562, M: 0.868, N: 0.748, O: 0.785, P: 0.652, Q: 0.785, R: 0.686,
  S: 0.631, T: 0.621, U: 0.738, V: 0.713, W: 1.113, X: 0.672, Y: 0.618, Z: 0.605,
  "[": 0.354, "\\": 0.313, "]": 0.354, "^": 0.6, _: 0.5, "`": 0.377,
  a: 0.547, b: 0.6, c: 0.472, d: 0.6, e: 0.542, f: 0.364, g: 0.604, h: 0.585, i: 0.255,
  j: 0.259, k: 0.536, l: 0.319, m: 0.877, n: 0.585, o: 0.576, p: 0.6, q: 0.6, r: 0.392,
  s: 0.488, t: 0.384, u: 0.579, v: 0.527, w: 0.853, x: 0.546, y: 0.526, z: 0.474,
  "{": 0.391, "|": 0.288, "}": 0.391, "~": 0.6,
  "–": 0.5, "—": 1, "‘": 0.248, "’": 0.248, "“": 0.443, "”": 0.443, "·": 0.248, "…": 0.745,
};
// Anything outside the table -- CJK, emoji, an accented glyph nobody thought of -- is charged the
// width of a lowercase o. Over-charging a rare character costs a few pixels of slack; under-charging
// it crops a value that was supposed to fit.
const UNKNOWN_ADVANCE = 0.576;

export function textWidth(text, fontSize, letterSpacing = 0) {
  let total = 0;
  for (const ch of String(text ?? "")) total += ADVANCE[ch] ?? UNKNOWN_ADVANCE;
  return total * fontSize + letterSpacing * fontSize * String(text ?? "").length;
}

// px-5 either side of every cell.
const CELL_PADDING = 40;
const BODY_SIZE = 14;
const HEADER_SIZE = 12;
const HEADER_TRACKING = 0.05;

// What sits beside the text in each cell and takes width the string does not account for.
const LOGO_AND_GAP = 48; // 36px avatar + 12px gap, the Title cell
const STAR_AND_GAP = 17; // the watchlist star on the company line
const FLAG_AND_GAP = 24; // the country flag in Location
const EXTRA_BADGE = 32; // the "+3" badge when a posting lists several places
const GLYPH_AND_GAP = 22; // a 16px icon + 6px gap, in Job type and Workplace
// Source is NOT the same 22, and assuming it was is why "Greenhouse" was cropped in 24 rows at once.
// Job type and Workplace draw through ValueWithIcon: size-4 (16px) with gap-1.5 (6px). The Source
// cell draws an AtsMark at size-5 (20px) with gap-2 (8px). Six pixels, which is exactly the margin
// "Greenhouse" was missing -- it needed 106px of a 102px inner width.
const ATS_MARK_AND_GAP = 28;

// Posted is measured from its vocabulary rather than from the rows, deliberately. Its text is a
// RELATIVE time computed against the current clock, so the server and the client can legitimately
// render different strings for the same row -- and a width derived from that would differ between
// the two renders, which is a hydration mismatch on a style attribute. So the column is sized for
// the widest label the formatter can produce, always.
// That is the absolute-date fallback, which beats every relative label ("Just now", "59m ago"), in
// the exact shape Intl.DateTimeFormat({month:"short", day:"numeric", year:"numeric"}) emits. May is
// the widest of the twelve abbreviations in this face, and two-digit day and four-digit year are the
// widest each can be. Getting this wrong is not free: an earlier guess of "30 September 2026" was a
// format the page never renders and cost the column 20px it then took from Location.
const POSTED_WIDEST = "May 30, 2026";

const HEADERS = {
  title: "Title",
  location: "Location",
  jobType: "Job type",
  workplace: "Workplace",
  posted: "Posted",
  source: "Source",
};

export const COLUMN_KEYS = Object.freeze(Object.keys(HEADERS));

// The two columns that hold arbitrary text and therefore actually crop. Everything else draws from
// a closed vocabulary -- five workplace values, a dozen ATS names -- so once it fits, more width
// buys nothing and is better spent here.
const FLEXIBLE = ["title", "location"];

// Below these a column stops being readable and starts being a column of ellipses. Reached only
// when the content genuinely does not fit, at which point the table's own min-width takes over and
// it scrolls sideways instead.
const FLOOR = { title: 190, location: 120 };

// The width the percentages are computed against: the section's 1240px cap less its 32px padding.
// Any constant would do -- what matters is that it is the SAME constant everywhere, so the result
// is a property of the data rather than of the window.
const REFERENCE_WIDTH = 1176;

// The table's own min-width, below which it scrolls sideways instead of shrinking further. It
// matters here because the widths are PERCENTAGES: a floor expressed at the reference width is not
// a floor at all once the table is narrower, it just scales down with everything else. Sizing the
// heading against the narrowest the table can get is what makes it a real floor.
// This is not hypothetical -- without it "JOB TYPE" needed 99.8px, got 99px, and wrapped onto two
// lines, which also changes the header's height and with it every row offset the virtualizer has
// computed.
const MIN_TABLE_WIDTH = 1050;
const NARROWEST = REFERENCE_WIDTH / MIN_TABLE_WIDTH;

function headerFloor(key) {
  // letter-spacing lands after every character including the last, so it is charged per character
  // rather than per gap -- which is also how the browser renders it.
  const label = textWidth(HEADERS[key].toUpperCase(), HEADER_SIZE, HEADER_TRACKING);
  return (label + CELL_PADDING) * NARROWEST;
}

/**
 * @param {Array<{
 *   title?: string, company?: string, location?: string, jobType?: string,
 *   workplace?: string, source?: string, hasFlag?: boolean, extraPlaces?: number
 * }>} rows  the FIRST PAGE of results, projected to the strings each cell draws
 * @returns {{ title: number, location: number, jobType: number, workplace: number, posted: number, source: number }}
 *   percentages of the table width, summing to 100
 */
// The width that covers all but the widest 5% of rows, rather than the widest row outright.
//
// max() was the obvious choice and it is wrong, because "a closed vocabulary" is not true of the
// data. Measured on ?search=nurse: one posting whose employment type is a paragraph took Job type to
// 410px -- 35% of the table, for a column that is EMPTY in every other row -- and squeezed Title to
// 208px. One outlier in a hundred rows dictated the layout for all of them.
// p95 sizes the column for the ninety-five rows that fit and lets the other five truncate, which is
// what truncation is for. It cannot be gamed by a single row, which max() can and did.
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

const P = 0.95;

export function columnWidths(rows) {
  const samples = { title: [], location: [], jobType: [], workplace: [], source: [] };
  const content = { title: 0, location: 0, jobType: 0, workplace: 0, posted: 0, source: 0 };

  for (const row of rows ?? []) {
    // The Title cell stacks two lines beside one avatar, so it needs whichever of them is longer --
    // not their sum, and not the title alone. A short role at a long company crops the company.
    const titleLine = textWidth(row.title, BODY_SIZE);
    const companyLine = textWidth(row.company, BODY_SIZE) + STAR_AND_GAP;
    samples.title.push(Math.max(titleLine, companyLine) + LOGO_AND_GAP);

    samples.location.push(textWidth(row.location, BODY_SIZE)
      + (row.hasFlag ? FLAG_AND_GAP : 0)
      + (row.extraPlaces > 0 ? EXTRA_BADGE : 0));

    samples.jobType.push(textWidth(row.jobType, BODY_SIZE) + GLYPH_AND_GAP);
    samples.workplace.push(textWidth(row.workplace, BODY_SIZE) + GLYPH_AND_GAP);
    samples.source.push(textWidth(row.source, BODY_SIZE) + ATS_MARK_AND_GAP);
  }
  for (const key of Object.keys(samples)) content[key] = percentile(samples[key], P);
  // Posted is not sampled at all -- see POSTED_WIDEST above.
  content.posted = textWidth(POSTED_WIDEST, BODY_SIZE);

  // A column is never narrower than its own heading. Without this, an all-empty Job type column
  // shrinks to nothing and it is the HEADER that ends up truncated -- swapping one cropped string
  // for another, and a worse one, since the heading is what tells you what the column is.
  // A few pixels of air on top of the measured content, and it earns its place. Widths are
  // PERCENTAGES, so a column sized to exactly its content only fits at exactly the reference width:
  // a 1228px window gives the table 1164px rather than 1176, and every column loses 1%. That was
  // enough to turn "Full time" (119.5px of content in a 118px column) into "Full ti…" in 13 rows at
  // once. Character advances are also an estimate to within about a pixel, and the browser rounds.
  // Losing 24px of the table to this is invisible; losing a whole word to an ellipsis is not.
  const CONTENT_SLACK = 4;
  const natural = {};
  for (const key of COLUMN_KEYS) {
    natural[key] = Math.max(content[key] + (content[key] > 0 ? CELL_PADDING + CONTENT_SLACK : 0), headerFloor(key));
  }

  const rigid = COLUMN_KEYS.filter((key) => !FLEXIBLE.includes(key));
  const rigidTotal = rigid.reduce((sum, key) => sum + natural[key], 0);
  const room = REFERENCE_WIDTH - rigidTotal;
  const flexibleTotal = FLEXIBLE.reduce((sum, key) => sum + natural[key], 0);

  const final = { ...natural };
  if (flexibleTotal > 0) {
    // Split whatever the bounded columns did not need between the two that crop, in proportion to
    // how much text they are each holding. This is the payoff: an index where Job type is blank
    // hands its slack to Location, and one full of "Full-time, Contract" keeps it.
    // The same arithmetic covers the opposite case -- when the flexible columns want MORE than the
    // room left, the ratio is below 1 and they shrink instead, down to the floor.
    const scale = Math.max(room, 0) / flexibleTotal;
    for (const key of FLEXIBLE) final[key] = Math.max(FLOOR[key], natural[key] * scale);
  }

  const total = COLUMN_KEYS.reduce((sum, key) => sum + final[key], 0);
  const percent = {};
  for (const key of COLUMN_KEYS) percent[key] = (final[key] / total) * 100;
  return percent;
}
