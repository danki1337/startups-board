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
];

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
  for (const [prefix, label] of EMPLOYMENT_LABELS) {
    if (key === prefix || key.startsWith(`${prefix} `)) return label;
  }
  return String(value);
}

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

  return text.replace(/\s+/g, " ").replace(/\s*,\s*$/, "");
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
  const value = tidyLocation(location);
  const counted = LOCATION_COUNT.exec(value);
  if (counted) {
    // "Multiple locations" states no number; treat it as unknown rather than inventing one.
    return { primary: "", extra: 0, all: value, count: counted[1] ? Number(counted[1]) : 0 };
  }

  const parts = value.split(/\s*[;·•]\s*|\s+·\s+/).map((part) => tidyLocation(part)).filter(Boolean);
  if (parts.length <= 1) return { primary: value, extra: 0, all: value, count: null };

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
