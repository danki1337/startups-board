import assert from "node:assert/strict";
import test from "node:test";

import { columnWidths, textWidth, COLUMN_KEYS } from "../app/column-widths.mjs";

const row = (over = {}) => ({
  title: "Product Designer",
  company: "Intercom",
  location: "London",
  jobType: "Full time",
  workplace: "Hybrid",
  source: "Ashby",
  hasFlag: true,
  extraPlaces: 0,
  ...over,
});

const sum = (widths) => COLUMN_KEYS.reduce((total, key) => total + widths[key], 0);

test("advance widths agree with the real face", () => {
  // Measured in the browser against the loaded Nunito 700: "Senior Product Designer" is 158.6px at
  // 14px, "SmartRecruiters" 106.0px, "5d ago" 44.8px. Anything within a pixel is well inside what
  // the allocation below can act on.
  assert.ok(Math.abs(textWidth("Senior Product Designer", 14) - 158.6) < 1);
  assert.ok(Math.abs(textWidth("SmartRecruiters", 14) - 106.0) < 1);
  assert.ok(Math.abs(textWidth("5d ago", 14) - 44.8) < 1);
});

test("an unknown glyph is charged rather than ignored", () => {
  // A CJK title used to measure as nothing at all, so the column collapsed and cropped every row.
  assert.ok(textWidth("東京都", 14) > 0);
});

test("the percentages always add up to the full table", () => {
  for (const rows of [[], [row()], Array.from({ length: 50 }, () => row())]) {
    assert.ok(Math.abs(sum(columnWidths(rows)) - 100) < 1e-9);
  }
});

test("an empty Job type column hands its slack to the columns that crop", () => {
  const withType = columnWidths(Array.from({ length: 20 }, () => row({ location: "San Francisco, California" })));
  const withoutType = columnWidths(Array.from({ length: 20 }, () => row({ location: "San Francisco, California", jobType: "" })));

  // The case from the screenshot: every posting in view is missing an employment type.
  assert.ok(withoutType.jobType < withType.jobType,
    `empty Job type should shrink: ${withType.jobType} -> ${withoutType.jobType}`);
  assert.ok(withoutType.location > withType.location,
    `Location should gain the slack: ${withType.location} -> ${withoutType.location}`);

  // The gain is bounded by the heading, and that is worth stating rather than discovering: an empty
  // column cannot give back everything, because it still has to draw "JOB TYPE". What is freed is
  // the difference between the content and the heading, not the whole column.
  // "Full time" measures ~122px against a ~112px heading floor, so about 8px comes back -- not the
  // whole 122. Pinned as a range so the mechanism is visible rather than implied.
  const freed = (withType.jobType - withoutType.jobType) / 100 * 1176;
  assert.ok(freed > 5 && freed < 20, `expected a heading-bounded gain, got ${freed.toFixed(1)}px`);

  // A wider employment type has correspondingly more to give.
  const wide = columnWidths(Array.from({ length: 20 }, () => row({
    location: "San Francisco, California", jobType: "Full-time Tier 2 Contract",
  })));
  assert.ok(withoutType.location - wide.location > withoutType.location - withType.location);
});

test("a heading still fits at the table's narrowest, not just at the reference width", () => {
  // Nothing at all in the bounded columns. They must still be able to draw "JOB TYPE" / "WORKPLACE"
  // on ONE line -- a wrapped heading changes the header's height, and the virtualizer has already
  // computed every row offset against the old one.
  // The check is at 1050px, the table's min-width, because the widths are percentages: a floor that
  // only holds at the 1176px reference is not a floor. This is the bug the browser showed --
  // "JOB TYPE" needed 99.8px, was given 99px, and wrapped.
  const widths = columnWidths([row({ jobType: "", workplace: "", source: "" })]);
  for (const [key, label] of [["jobType", "Job type"], ["workplace", "Workplace"], ["source", "Source"]]) {
    const needs = textWidth(label.toUpperCase(), 12, 0.05) + 40;
    const gets = (widths[key] / 100) * 1050;
    assert.ok(gets >= needs, `${label} gets ${gets.toFixed(1)}px at min width, needs ${needs.toFixed(1)}px`);
  }
});

test("long titles take width from Location, not from the bounded columns", () => {
  const short = columnWidths(Array.from({ length: 10 }, () => row()));
  const long = columnWidths(Array.from({ length: 10 }, () => row({
    title: "Senior Staff Software Engineer, Platform Infrastructure and Developer Experience",
  })));
  assert.ok(long.title > short.title);
  assert.ok(long.location < short.location);
  // Workplace and Posted are drawn from closed vocabularies; a long title must not squeeze them.
  assert.ok(Math.abs(long.workplace - short.workplace) < 0.6);
  assert.ok(Math.abs(long.posted - short.posted) < 0.6);
});

test("long text in the flexible columns scales them together, not to the floor", () => {
  // Worth pinning because it is the case I first got wrong: 400 characters in both Title and
  // Location does NOT reach the floors. There is still room left over once the bounded columns take
  // their share, so the two shrink in proportion to each other and keep their relative sizes.
  const widths = columnWidths(Array.from({ length: 5 }, () => row({
    title: "x".repeat(400),
    company: "y".repeat(400),
    location: "z".repeat(400),
  })));
  const ratio = widths.title / widths.location;
  assert.ok(ratio > 1.1 && ratio < 1.3, `expected proportional shrink, got ratio ${ratio}`);
  assert.ok(Math.abs(sum(widths) - 100) < 1e-9);
});

test("the floors hold when a bounded column eats the whole table", () => {
  // Source is measured from the rows like any other column, so an absurd provider name is the way
  // to exhaust the room and prove the flexible columns stop rather than collapse to nothing.
  const widths = columnWidths([row({ source: "S".repeat(200), title: "x".repeat(400), location: "z".repeat(400) })]);
  // 190px and 120px, renormalised -- so the ratio between them is what survives, and it is exact.
  assert.ok(Math.abs(widths.title / widths.location - 190 / 120) < 0.01);
  assert.ok(Math.abs(sum(widths) - 100) < 1e-9);
});

test("Posted is sized from its vocabulary, never from the rows", () => {
  // Its text is relative to the current clock, so a width taken from the rows would differ between
  // the server render and the client one -- a hydration mismatch on a style attribute.
  const a = columnWidths([row()]);
  const b = columnWidths([row()]);
  assert.equal(a.posted, b.posted);
  const wide = columnWidths([row({ posted: "an extremely long string that is not real" })]);
  assert.equal(wide.posted, a.posted);
});

test("the same rows always give the same answer", () => {
  // The whole no-reflow guarantee rests on this: the server and the client run it independently.
  const rows = Array.from({ length: 30 }, (_, i) => row({ title: `Role ${i}`, location: `City ${i}` }));
  assert.deepEqual(columnWidths(rows), columnWidths([...rows]));
});

test("one freak row cannot dictate a column", () => {
  // The bug this exists for, from ?search=nurse on production: a single posting whose employment
  // type ran to a paragraph took Job type to 410px -- 35% of the table, for a column EMPTY in every
  // other row -- and squeezed Title from 363px to 208px.
  // max() lets one row in a hundred set the layout for all of them. p95 does not.
  const normal = Array.from({ length: 99 }, () => row({ jobType: "Full time" }));
  const withFreak = [...normal, row({ jobType: "Full-time, benefits eligible, shift differential applies " .repeat(3) })];
  const before = columnWidths(normal);
  const after = columnWidths(withFreak);
  assert.ok(Math.abs(after.jobType - before.jobType) < 0.5,
    `one outlier moved Job type from ${before.jobType.toFixed(2)}% to ${after.jobType.toFixed(2)}%`);
  // And Title keeps its share rather than being squeezed to pay for it.
  assert.ok(Math.abs(after.title - before.title) < 0.5);
});

test("the widest 5% are what truncates, and only them", () => {
  // 95 short rows and 5 long ones: the column is sized for the 95, which is the whole point.
  const rows = [
    ...Array.from({ length: 95 }, () => row({ location: "Berlin" })),
    ...Array.from({ length: 5 }, () => row({ location: "Somewhere With A Very Long Name Indeed, Region, Country" })),
  ];
  const widths = columnWidths(rows);
  const shortNeeds = textWidth("Berlin", 14) + 24 + 40;
  const longNeeds = textWidth("Somewhere With A Very Long Name Indeed, Region, Country", 14) + 24 + 40;
  const got = (widths.location / 100) * 1176;
  assert.ok(got >= shortNeeds, `sized for the short rows: ${got.toFixed(0)} >= ${shortNeeds.toFixed(0)}`);
  assert.ok(got < longNeeds, `not sized for the tail: ${got.toFixed(0)} < ${longNeeds.toFixed(0)}`);
});

test("Source is measured against its own mark, not Job type's", () => {
  // "Greenhouse" was cropped in 24 rows at once because Source was charged 22px for its glyph --
  // the 16px icon + 6px gap that Job type and Workplace use. Source draws an AtsMark at size-5
  // (20px) with gap-2 (8px). Six pixels, and exactly the six it was short by.
  const rows = Array.from({ length: 20 }, () => row({ source: "Greenhouse" }));
  const widths = columnWidths(rows);
  // At the reference width, the column has to hold the text, the 20px mark, the 8px gap and 40px of
  // cell padding.
  const needs = textWidth("Greenhouse", 14) + 20 + 8 + 40;
  const gets = (widths.source / 100) * 1176;
  assert.ok(gets >= needs, `Source gets ${gets.toFixed(1)}px, needs ${needs.toFixed(1)}px`);
});

test("SmartRecruiters, the longest provider name, still fits", () => {
  const rows = Array.from({ length: 20 }, () => row({ source: "SmartRecruiters" }));
  const needs = textWidth("SmartRecruiters", 14) + 20 + 8 + 40;
  const gets = (columnWidths(rows).source / 100) * 1176;
  assert.ok(gets >= needs, `Source gets ${gets.toFixed(1)}px, needs ${needs.toFixed(1)}px`);
});
