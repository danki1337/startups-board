// How a raw provider value is rendered in the table.
//
// Every value here arrives as free text from one of twelve ATSs and none of them agree with each
// other. Normalising at DISPLAY time rather than at ingestion is deliberate: the stored value stays
// exactly what the provider said, so nothing needs a 1.24M-row backfill and no filter changes
// meaning. The filters already normalise the same way in SQL, so a row reading "Full time" is
// matched by the "Full time" facet whichever of the five spellings it is stored as.

/* --------------------------------------------------------------- employment type */

// Measured on production, active jobs, one concept spelled five ways:
//   Full-time 176,146 · Full time 163,077 · Full-Time 79,568 · Full Time 7,830 · full time 4,382
// That is 430,003 rows -- a third of the index -- reading as five different job types in a column
// four characters wide. Part time is the same story across four spellings.
//
// Keyed on the same normalisation the SQL filter uses (lower-cased, hyphens and underscores read as
// spaces), so the label in a row and the option in the Job type dropdown can never disagree.
const EMPLOYMENT_LABELS = [
  ["full time", "Full time"],
  ["part time", "Part time"],
  ["contractor", "Contract"],
  ["contract", "Contract"],
  ["freelance", "Contract"],
  ["internship", "Internship"],
  ["intern", "Internship"],
  ["apprenticeship", "Apprenticeship"],
  ["apprentice", "Apprenticeship"],
  ["temporary", "Temporary"],
  ["temp", "Temporary"],
  ["seasonal", "Seasonal"],
  ["permanent", "Permanent"],
  ["volunteer", "Volunteer"],
  ["per diem", "Per diem"],
  ["casual", "Casual"],
  // The tail, measured on production rather than imagined. Each of these renders raw today, which
  // in a column this narrow means a truncated fragment: "Variable ti…", "Independent c…".
  ["fixed term", "Fixed term"],
  ["variable time", "Variable"],
  ["variable hour", "Variable"],
  ["independent contractor", "Contract"],
  ["contractual", "Contract"],
  ["fulltime", "Full time"],
  ["parttime", "Part time"],
  // US healthcare shorthand: pro re nata, "as needed" -- the same shift-by-shift arrangement the
  // rest of the index spells "per diem". 340 postings.
  ["prn", "Per diem"],
  // Abbreviations. Whole-word only, which is what keeps "ft" from swallowing "ft. lauderdale".
  ["fte", "Full time"],
  ["ft", "Full time"],
  ["pt", "Part time"],
  // French, from Canadian and EU tenants.
  ["temps plein", "Full time"],
  ["temps partiel", "Part time"],
  ["cdi", "Permanent"],
  ["cdd", "Fixed term"],
];

// Values that are a WORKPLACE, not an employment type. Some tenants put them in the type field, and
// rendering "Remote" under JOB TYPE beside a WORKPLACE column already reading "Remote" says the
// same thing twice and answers the wrong question. Shown as blank, which the column already handles
// for the three quarters of the index that publish no type at all.
const NOT_A_JOB_TYPE = new Set(["remote", "hybrid", "on site", "onsite", "in office", "office"]);

export function normalizeEmploymentKey(value) {
  return String(value ?? "").toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The employment type as a reader should see it.
 *
 * Matching is on a leading WORD, not a substring, which is what keeps "contractor" from being read
 * as "contract" and "internship" from being read as "intern". Trailing words the employer bolted on
 * are dropped: "Full-time Tier 2" (Lucid Software's own compensation band), "Full Time Hybrid"
 * (a workplace, which has its own column) and "Full Time Employee" are all full-time roles, and the
 * extra word belongs on the posting rather than in a four-character column.
 *
 * Anything with no known leading type is returned unchanged -- "Regular", "Employee", "Per Diem"
 * and the rest of the tail are real answers, just not ones worth inventing a mapping for.
 */
export function tidyEmploymentType(value) {
  const key = normalizeEmploymentKey(value);
  if (!key) return value ?? null;
  if (NOT_A_JOB_TYPE.has(key)) return null;
  for (const [prefix, label] of EMPLOYMENT_LABELS) {
    // A SPACE was the only accepted boundary, so the employer's trailing qualifier had to be
    // separated by one. Measured on production, it usually is not: "Full time, non exempt" (698),
    // "Full-time/Part-time" (394), "Full time (hourly)" (175), "Full time: experienced" (161) all
    // fell through and rendered raw, which in this column is a truncated fragment. Any punctuation
    // that ends a word ends it here too.
    if (key === prefix || BOUNDARY.test(key.slice(prefix.length)) && key.startsWith(prefix)) return label;
  }
  return String(value);
}

// What may follow a matched type: a space, or the punctuation employers separate qualifiers with.
// Anchored, so "contract" cannot match inside "contractual" -- that has its own entry above.
const BOUNDARY = /^[\s,;:/()[\]|+&-]/;

/* -------------------------------------------------------------------- location */

// A facility code with the place buried inside it: "CHN47-01-Chengdu-No. 618 Fenghuang Road" is
// Chengdu. Workday tenants that expose their internal site register write these, and they resolve to
// no country and no city because nothing in them looks like a place until the code is removed.
// {ISO3}{digits}-{digits}-{Place}-{street} is the shape; the place is the third segment.
const FACILITY_CODE = /^[A-Z]{2,4}\d{1,4}-\d{1,3}-([^-]+)(?:-.*)?$/;

// A postal address is not a location for a job board -- nobody scans a column for a street number.
const STREET_NOISE = /^(?:no\.?\s*\d+|\d+)\s/i;

/**
 * The location as a reader should see it: the place, without the internal codes and street
 * addresses some tenants attach to it.
 *
 * Deliberately conservative. Anything it does not recognise is returned untouched, because a
 * location it fails to parse still reads as a place, whereas one it mangles does not.
 */
export function tidyLocation(value) {
  const text = String(value ?? "").trim();
  if (!text) return text;

  const facility = FACILITY_CODE.exec(text);
  if (facility) {
    const place = facility[1].trim();
    if (place && !STREET_NOISE.test(place)) return place;
  }

  const breadcrumb = tidyBreadcrumb(text);
  if (breadcrumb) return breadcrumb;

  return text.replace(/\s+/g, " ").replace(/\s*,\s*$/, "");
}

// Some Workday tenants publish their internal location TREE rather than a place:
//   "INDIA > MAHARASHTRA > MUMBAI : Remote"
//   "United States > Austin : 8701 Bee Caves Rd"
//   "NCEE > Sweden > Arlandastad > Industrivagen 14"
// 2,907 active postings carry one. They are not just ugly -- they are the widest strings in the
// column, and the table sizes Title and Location from whichever is holding more text, so a page
// with a few of these took 118px off Title and spent it drawing a breadcrumb that then truncated
// anyway. Nobody could read either field.
//
// The place is the most specific segment: everything after the last ">", minus the street address
// the colon introduces. Trailing segments that are plainly a street ("Industrivagen 14") are
// dropped so the city behind them survives.
const BREADCRUMB = /\s*>\s*/;
const HAS_NUMBER = /\d/;

function tidyBreadcrumb(text) {
  if (!BREADCRUMB.test(text)) return null;
  // The colon separates the location tree from a street address; keep only the tree.
  const tree = text.split(":")[0];
  const parts = tree.split(BREADCRUMB).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  // Walk back past anything that reads as a street rather than a place. A numbered street is
  // obvious ("Industrivagen 14"); an unnumbered one is not ("Laan van Westenenk"), so depth is the
  // second signal: a tree four levels deep with no colon has spent the last level on the address
  // (region > country > city > street), which is the shape these tenants publish.
  let index = parts.length - 1;
  if (parts.length >= 4 && !text.includes(":")) index -= 1;
  while (index > 0 && (STREET_NOISE.test(parts[index]) || HAS_NUMBER.test(parts[index]))) index -= 1;
  const place = parts[index];
  // Deliberately NOT re-cased. "MUMBAI" is loud, but recasing would also rewrite the acronyms these
  // trees are full of (NCEE, WEMEA, GB) into something wrong, and this module's rule is that a
  // location it mangles is worse than one it merely fails to prettify.
  return place || null;
}

// "Remote" is not a place, and the row already says so.
//
// Workplace is its own column, populated for the same postings, so "Europe, Remote" spends a third
// of the location cell repeating the cell two columns to its right -- and the location column is the
// one that crops. 599 European postings alone carry it.
//
// Conservative on purpose. Only a whole segment that says nothing but "remote" is dropped, plus the
// two prefix forms the ATSs actually write ("Remote in Europe", "Remote-WesternEurope") and the
// trailing form ("US Remote"). A segment is bounded by a comma, a pipe, a slash, a semicolon, a
// middot (Ashby's list separator) or a SPACED hyphen -- spaced, so that Winston-Salem and
// Baden-Baden survive. The middot and semicolon were missing at first, so "Berlin · Remote" was
// one segment whose trailing word got stripped -- rendering "Berlin ·", dangling separator and all,
// in the column and its tooltip.
// Anything it does not recognise is returned untouched: a location it fails to strip still reads as
// a place, whereas one it mangles does not.
const REMOTE_ONLY = /^(?:fully\s+|100%\s+|is\s+|entirely\s+)?remote(?:\s+(?:work|only|first|position|role|job))?$/i;
const SEGMENT = /\s*(?:[,|/;·•]|\s[-–—]\s)\s*/;

// Per SEGMENT, not over the whole string, and that ordering is the whole correctness of it. Doing
// the trailing "... Remote" strip first turned "Europe, Remote" into "Europe," (a dangling comma)
// and "Fully Remote" into "Fully" -- both cases where the word is the segment rather than a suffix
// of one. Dropping whole segments first leaves the suffix rule with only real suffixes to see.
function stripRemoteSegment(part) {
  const lead = part
    .replace(/^remote\s+(?:in|from|within|across)\s+/i, "")
    .replace(/^remote\s*[-–—]\s*/i, "")
    .trim();
  if (!lead || REMOTE_ONLY.test(lead)) return "";
  const trailing = lead.replace(/\s+remote$/i, "").trim();
  return trailing || lead;
}

export function stripRemote(value) {
  const text = String(value ?? "").trim();
  if (!text) return text;
  const parts = text.split(SEGMENT).map((part) => part.trim()).filter(Boolean);
  const kept = parts.map(stripRemoteSegment).filter(Boolean);
  // Every segment said remote: there is no place here at all, and an empty cell beside a Remote
  // workplace says more than the word repeated does.
  if (!kept.length) return "";
  // Untouched when nothing was removed, so a location this does not recognise keeps its own
  // punctuation rather than being rewritten with commas.
  if (kept.length === parts.length && kept.every((part, i) => part === parts[i])) return text;
  return kept.join(", ");
}

/* ------------------------------------------------------- multi-location splitting */

// Two shapes of multi-location arrive from the ATSs.
//
//   "Beijing · 2 Locations"      -- Workday. It publishes a COUNT and refuses to name the places,
//                                   but the primary one IS in the posting's own path, so ingestion
//                                   recovers it and keeps the count beside it (workdayLocation in
//                                   src/providers.mjs). 28,214 active rows.
//   "2 Locations"                -- the same, for postings whose path carried no usable place. A
//                                   bare count, with nothing to show but the count.
//   "Berlin · Munich · Remote"   -- Ashby (middot), and others use a semicolon. A real list whose
//                                   first entry is a usable answer on its own.
const LOCATION_COUNT = /^(?:(\d+)\s+locations?|multiple\s+locations?)$/i;

/**
 * @returns {{ primary: string, extra: number, all: string, count: number|null }}
 *   `primary` is the place to show, `extra` how many more there are, `all` the tooltip text, and
 *   `count` is set only for the degenerate case where there is no place to show at all.
 */
export function splitLocations(location) {
  const value = stripRemote(tidyLocation(location));
  if (!value) return { primary: "", extra: 0, all: "", count: null };
  const counted = LOCATION_COUNT.exec(value);
  if (counted) {
    // "Multiple locations" states no number; treat it as unknown rather than inventing one.
    return { primary: "", extra: 0, all: value, count: counted[1] ? Number(counted[1]) : 0 };
  }

  // Split from the TIDIED original, not from `value`: when stripRemote removes a segment it
  // rejoins the survivors with commas, so a stripped "Berlin · Munich · Remote" no longer carries
  // the middots this split is looking for -- the two named places would collapse into one entry
  // and the "+1" disappear.
  const parts = String(tidyLocation(location)).split(/\s*[;·•]\s*/)
    .map((part) => stripRemote(part)).filter(Boolean);
  if (parts.length <= 1) return { primary: parts[0] ?? value, extra: 0, all: value, count: null };

  // A count riding along with named places is Workday's shape: the count is the TOTAL, so what is
  // hidden is the total minus what we can name -- one named place out of two is "+1", not "+0".
  const stated = parts.map((part) => LOCATION_COUNT.exec(part)).find(Boolean);
  const places = parts.filter((part) => !LOCATION_COUNT.test(part));
  if (!places.length) return { primary: "", extra: 0, all: value, count: stated?.[1] ? Number(stated[1]) : 0 };

  const total = stated?.[1] ? Number(stated[1]) : places.length;
  return {
    primary: places[0],
    extra: Math.max(0, total - 1),
    // The tooltip promises what it can name. Where the count exceeds that, it says so rather than
    // listing one place under a "+3" badge and leaving the reader to wonder what the other three
    // were.
    all: places.length < total ? `${places.join(" · ")} and ${total - places.length} more` : places.join(" · "),
    count: null,
  };
}

/* ---------------------------------------------------------------- compact counts */

/**
 * A job total short enough to survive a browser tab.
 *
 * A tab strip shows maybe fifteen characters before it truncates, and "1,802,032 jobs — Aboard"
 * spends nine of them on digits nobody reads at that size -- the tab ends up saying "1,802,03…"
 * and the brand, which is the part that identifies the tab, falls off the end entirely.
 *
 * One decimal place, and only while the whole part is a single digit. "1.8M" carries something
 * "2M" does not; "44.6K" is a precision the reader has no use for, so that becomes "45K". Values
 * under a thousand are exact, because at that size the real number is already short.
 *
 * Deliberately hand-rolled rather than Intl.NumberFormat's compact notation: this string is built
 * in the Worker and asserted in Node, and the two only agree if their ICU data does. A dozen lines
 * of arithmetic are the same everywhere.
 *
 * @param {number} value
 * @returns {string} e.g. "1.8M", "45K", "721"
 */
export function compactCount(value) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  if (total < 1_000) return String(total);
  for (const [suffix, size] of [["B", 1e9], ["M", 1e6], ["K", 1e3]]) {
    if (total < size) continue;
    const scaled = total / size;
    const rounded = scaled < 10 ? Math.round(scaled * 10) / 10 : Math.round(scaled);
    // Rounding can carry into the next unit: 999,999 scales to 1000K, which should read "1M".
    if (rounded >= 1_000) return compactCount(size * 1_000);
    return `${rounded}${suffix}`;
  }
  return String(total);
}

/* ------------------------------------------------------------------ posted age */

// How far a publish time may sit in the future before it stops being clock skew and starts being a
// wrong date. Two minutes covers the once-a-minute `now` tick with room to spare, and is far short
// of anything a reader would notice as a lie.
const RELATIVE_FUTURE_GRACE_MS = 2 * 60_000;

// A short "3h ago" / "20m ago" label for freshly posted roles; null once a posting is a week old, so
// the caller falls back to the absolute date. Only used for real publish timestamps — synthesised
// fallback dates keep the calendar date.
export function relativePosted(date, now) {
  const diffMs = now - date.getTime();
  // A posting reading as slightly AHEAD of `now` is normal, not a broken date, and treating it as
  // broken is what put a bare calendar date on the freshest rows -- the ones a reader most wants a
  // relative age for. Three ordinary causes, none of them a bad timestamp:
  //   - `now` ticks once a minute, so anything published since the last tick is ahead of it;
  //   - the reader's clock is their own, and ours is the server's;
  //   - providers round. Workday publishes "Posted Today", which resolves to a day boundary.
  // Checked against production: of 1,807,690 active jobs, ZERO are dated in the future by the
  // database's own clock. So every one of these that surfaced was skew, and the row said
  // "Jul 27, 2026" about a job posted minutes earlier while the row beneath it said "2h ago".
  // Beyond the grace window it is a real anomaly and the absolute date is the honest answer.
  if (diffMs < -RELATIVE_FUTURE_GRACE_MS) return null;
  const minutes = Math.floor(Math.max(diffMs, 0) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return null;
}
