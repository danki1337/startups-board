import assert from "node:assert/strict";
import test from "node:test";

import { compactCount, splitLocations, tidyEmploymentType, tidyLocation } from "../app/format.mjs";

/* --------------------------------------------------------------- employment type */

test("the five spellings of full time render as one job type", () => {
  // Measured on production, active jobs: Full-time 176,146 · Full time 163,077 · Full-Time 79,568 ·
  // Full Time 7,830 · full time 4,382. 430,003 rows reading as five different types in a column
  // four characters wide.
  for (const raw of ["Full-time", "Full time", "Full-Time", "Full Time", "full time", "FULL-TIME"]) {
    assert.equal(tidyEmploymentType(raw), "Full time", raw);
  }
  for (const raw of ["Part time", "Part-time", "Part-Time", "Part Time"]) {
    assert.equal(tidyEmploymentType(raw), "Part time", raw);
  }
});

test("an employer's extra words are dropped, and the leading type wins", () => {
  // "Tier 2" is Lucid Software's own compensation band, "Hybrid" is a workplace (which has its own
  // column), and "Employee" says nothing the type did not. All three are full-time roles.
  assert.equal(tidyEmploymentType("Full-time Tier 2"), "Full time");
  assert.equal(tidyEmploymentType("Full Time Hybrid"), "Full time");
  assert.equal(tidyEmploymentType("Full Time Employee"), "Full time");
  // A full-time contract is a contract: the leading word is the engagement.
  assert.equal(tidyEmploymentType("Contract Full time"), "Contract");
});

test("matching is on a whole leading word, not a substring", () => {
  // The reason the table is ordered longest-first and compares word boundaries: "contractor" must
  // not be read as "contract " and "internship" must not be read as "intern ".
  assert.equal(tidyEmploymentType("Contractor"), "Contract");
  assert.equal(tidyEmploymentType("Internship"), "Internship");
  assert.equal(tidyEmploymentType("Intern"), "Internship");
});

test("an unrecognised type is left exactly as the provider wrote it", () => {
  // These are real answers from the production tail. Inventing a mapping for them would be guessing.
  for (const raw of ["Regular", "Employee", "Statistician Network"]) {
    assert.equal(tidyEmploymentType(raw), raw);
  }
  // A type that IS recognised takes the table's casing, not the provider's.
  assert.equal(tidyEmploymentType("Per Diem"), "Per diem");
  assert.equal(tidyEmploymentType(null), null);
  assert.equal(tidyEmploymentType(""), "");
});

/* -------------------------------------------------------------------- location */

test("a facility code gives up the place inside it", () => {
  // Resolved to no country and no city before this, because nothing in the string looks like a
  // place until the site register's code is removed.
  assert.equal(tidyLocation("CHN47-01-Chengdu-No. 618 Fenghuang Road"), "Chengdu");
  assert.equal(tidyLocation("USA10-2-Austin-1200 Main St"), "Austin");
});

test("a Workday location tree gives up the city inside it", () => {
  // 2,907 active postings publish the tenant's internal location TREE instead of a place. They are
  // the widest strings in the column, and the table sizes Title and Location from whichever holds
  // more text -- measured, a page with a few of these took 118px off Title to draw a breadcrumb
  // that then truncated anyway.
  // The colon introduces a street address, so everything before it is the tree.
  assert.equal(tidyLocation("Malaysia > Selangor : Imazium, No. 8, Jalan SS 21/37"), "Selangor");
  assert.equal(tidyLocation("United States > Austin : 8701 Bee Caves Rd"), "Austin");
  assert.equal(tidyLocation("Singapore > Singapore : DUO Tower"), "Singapore");
  // ": Remote" is a workplace, which has its own column.
  assert.equal(tidyLocation("INDIA > MAHARASHTRA > MUMBAI : Remote"), "MUMBAI");

  // No colon: a numbered street is obvious, an unnumbered one is not, so depth is the second
  // signal -- four levels with no colon spends the last on the address.
  assert.equal(tidyLocation("NCEE > Sweden > Arlandastad > Industrivagen 14"), "Arlandastad");
  assert.equal(tidyLocation("WEMEA > Netherlands > Apeldoorn > Laan van Westenenk"), "Apeldoorn");

  // Deliberately not re-cased: these trees are full of acronyms (NCEE, WEMEA, GB) that a
  // title-caser would rewrite into something wrong.
  assert.equal(tidyLocation("Berlin, Germany"), "Berlin, Germany");
});

test("anything unrecognised is returned untouched", () => {
  // Conservative on purpose: a location this fails to parse still reads as a place, whereas one it
  // mangles does not.
  for (const raw of ["New York, NY, USA", "Berlin, Germany", "Remote", "US (Remote)"]) {
    assert.equal(tidyLocation(raw), raw);
  }
  // Whitespace and a dangling separator are still tidied.
  assert.equal(tidyLocation("  London,   England ,"), "London, England");
});

/* --------------------------------------------------------- multi-location splitting */

test("a Workday count with a recovered place shows one location and hides the rest", () => {
  // The shape ingestion now produces: Workday publishes "2 Locations" and names none of them, but
  // the primary one is in the posting's own path, so it arrives here beside the count.
  const two = splitLocations("Beijing · 2 Locations");
  assert.equal(two.primary, "Beijing");
  assert.equal(two.extra, 1, "the count is the TOTAL, so one named place out of two hides one");
  assert.equal(two.count, null);
  assert.match(two.all, /Beijing and 1 more/);

  const five = splitLocations("Chengdu · 5 Locations");
  assert.equal(five.primary, "Chengdu");
  assert.equal(five.extra, 4);
});

test("a bare count is still labelled as a count, not dressed up as a place", () => {
  // Postings whose path carried no usable place. There is nothing to show but the number, and
  // inventing a city would be worse than admitting that.
  assert.deepEqual(splitLocations("2 Locations"), { primary: "", extra: 0, all: "2 Locations", count: 2 });
  assert.equal(splitLocations("Multiple locations").count, 0);
});

test("a real list of places keeps its places and drops Remote", () => {
  // Remote is not a place, and the row states it two columns to the right in Workplace. Dropping it
  // also corrects the count: "Berlin · Munich · Remote" is two places and one more, not three.
  const list = splitLocations("Berlin · Munich · Remote");
  assert.equal(list.primary, "Berlin");
  assert.equal(list.extra, 1);
  assert.equal(list.all, "Berlin · Munich");
  assert.equal(list.count, null);
});

test("Remote is dropped from a location without mangling the rest", () => {
  // Segment-first, suffix-second. Doing it the other way round turned "Europe, Remote" into
  // "Europe," and "Fully Remote" into "Fully".
  assert.equal(splitLocations("Europe, Remote").primary, "Europe");
  assert.equal(splitLocations("Remote - Europe").primary, "Europe");
  assert.equal(splitLocations("Remote in Europe").primary, "Europe");
  assert.equal(splitLocations("Remote-WesternEurope").primary, "WesternEurope");
  assert.equal(splitLocations("US Remote").primary, "US");
  assert.equal(splitLocations("Remote, San Francisco").primary, "San Francisco");
  assert.equal(splitLocations("Fully Remote").primary, "");
  // Nothing but Remote leaves nothing: an empty cell beside a Remote workplace says more than the
  // word repeated does.
  assert.equal(splitLocations("Remote").primary, "");
});

test("a hyphenated place is not a separator", () => {
  // The segment rule only splits on a SPACED hyphen, which is what keeps these whole.
  assert.equal(splitLocations("Winston-Salem, NC").primary, "Winston-Salem, NC");
  assert.equal(splitLocations("Baden-Baden").primary, "Baden-Baden");
  // And a location with no Remote in it is returned byte-for-byte, punctuation included.
  assert.equal(splitLocations("UK/Europe | Portugal").primary, "UK/Europe | Portugal");
});

test("a single location has nothing hidden", () => {
  const one = splitLocations("San Francisco, CA");
  assert.deepEqual(one, { primary: "San Francisco, CA", extra: 0, all: "San Francisco, CA", count: null });
});

test("a remote entry in a middot or semicolon list leaves no dangling separator", () => {
  // The strip used to treat "Berlin · Remote" as ONE segment (its boundaries knew commas but not
  // middots), strip the trailing word, and render "Berlin ·" -- separator and all -- in the column
  // and its tooltip. Each shape below was a measured production rendering.
  assert.equal(splitLocations("Berlin · Remote").primary, "Berlin");
  assert.equal(splitLocations("Remote; Berlin").primary, "Berlin");
  assert.equal(splitLocations("Remote; Remote").primary, "");
  const list = splitLocations("Berlin · Munich · Remote");
  assert.equal(list.primary, "Berlin");
  // Munich survives as the hidden count even though the remote entry was dropped mid-list.
  assert.equal(list.extra, 1);
});

test("a job total shortens to something a browser tab can hold", () => {
  // The tab strip truncates around fifteen characters. "1,802,032 jobs — Aboard" loses the brand,
  // which is the only part that identifies the tab; "1.8M jobs — Aboard" keeps it.
  assert.equal(compactCount(1_802_032), "1.8M");
  assert.equal(compactCount(1_244_681), "1.2M");
  assert.equal(compactCount(157_212), "157K");
  assert.equal(compactCount(44_557), "45K");

  // One decimal only while the whole part is a single digit: "1.5K" says something "2K" does not,
  // whereas "44.6K" is precision a tab cannot use.
  assert.equal(compactCount(1_500), "1.5K");
  assert.equal(compactCount(5_000), "5K");
  assert.equal(compactCount(1_049), "1K");

  // Under a thousand the real number is already short, so it stays exact -- including the singular
  // the title's plural rule depends on.
  assert.equal(compactCount(1), "1");
  assert.equal(compactCount(721), "721");
  assert.equal(compactCount(999), "999");

  // Rounding that carries has to promote a unit, or 999,999 renders as the nonsense "1000K".
  assert.equal(compactCount(999_999), "1M");
  assert.equal(compactCount(9_999), "10K");
  assert.equal(compactCount(1_000_000), "1M");

  // Junk in, something renderable out -- this feeds a <title>, which must never read "NaN jobs".
  assert.equal(compactCount(0), "0");
  assert.equal(compactCount(Number.NaN), "0");
  assert.equal(compactCount(-5), "0");
});
