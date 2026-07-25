import assert from "node:assert/strict";
import test from "node:test";
import { locationCity, locationCountry } from "../src/locations.mjs";

// 435,754 of 1,240,226 active jobs (35%) resolve to no country. These are the shapes worth fixing:
// each one below is a real production string, with the row count it accounts for.

test("a trailing ISO alpha-2 code resolves the country", () => {
  // "City, Region, CC" is a common Getro and Ashby shape, and nothing caught it: the needle list
  // carries country NAMES plus a handful of aliases, so "Berlin, DE" resolved only because "de"
  // happens to be an alias while "Suzhou, Jiangsu, CN" resolved to nothing at all.
  assert.equal(locationCountry("Suzhou, Jiangsu, CN"), "cn");       // 319 rows
  assert.equal(locationCountry("Levallois-Perret, IDF, FR"), "fr"); // 309 rows
  assert.equal(locationCountry("Osaka, Osaka, JP"), "jp");
});

test("the trailing-code rule cannot steal a US state", () => {
  // Several ISO codes collide with US state codes. The rule runs LAST, after both the needle pass
  // and the US-state pass, so any string carrying a state has already resolved -- which is the
  // whole reason it is safe to read a bare two-letter token as a country at all.
  assert.equal(locationCountry("Fresno, CA"), "us");
  assert.equal(locationCountry("Indianapolis, IN"), "us");
  assert.equal(locationCountry("Wilmington, DE"), "us");
  assert.equal(locationCountry("Boise, ID"), "us");
});

test("known shapes keep resolving exactly as before", () => {
  assert.equal(locationCountry("New York, NY, USA"), "us");
  assert.equal(locationCountry("London, England, GB"), "gb");
  assert.equal(locationCountry("Toronto, ON, CA"), "ca");
  assert.equal(locationCountry("Berlin, Germany"), "de");
});

test("a location with nothing to resolve stays null rather than being guessed", () => {
  // Guessing wrong hides real jobs behind a country filter they do not belong to, which is worse
  // than not resolving at all.
  assert.equal(locationCountry("Remote"), null);          // 8,205 rows
  assert.equal(locationCountry("Europe"), null);          // 318 rows
  assert.equal(locationCountry("Statistician Network"), null);
  assert.equal(locationCountry(""), null);
  assert.equal(locationCountry(null), null);
  // An unknown two-letter tail is not a country either -- Lebanon is not in the country list yet,
  // and inventing a code the UI cannot name or flag would be worse than leaving it unresolved.
  assert.equal(locationCountry("Beirut, Beirut Governorate, LB"), null); // 702 rows
});

test("Workday's recovered primary location geocodes", () => {
  // The shape ingestion now writes for the 28,214 rows Workday published as a bare count. The
  // geocoder reads the leading segment, so recovering the place also recovers country and city --
  // which is what puts a flag on rows that never had one.
  assert.equal(locationCountry("Beijing · 2 Locations"), "cn");
  assert.equal(locationCity("Beijing · 2 Locations"), "Beijing");
  assert.equal(locationCountry("2 Locations"), null);
});
