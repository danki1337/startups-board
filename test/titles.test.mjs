import assert from "node:assert/strict";
import test from "node:test";
import { canonicalTitle } from "../src/database.mjs";

// Mirrored in web/app/jobs-query.ts; these cases are the ones that made the Title dropdown show the
// same role ten times.
test("folds qualifier variants onto one role", () => {
  for (const variant of [
    "Product Designer",
    "Product Designer (UI/UX)",
    "Product Designer (Contract)",
    "Product Designer (UX), HCI",
    "Product Designer | Senior",
    "Product Designer II",
    "Product Designer - US Government",
    "Product Designer, App Store",
    "Product Designer (Web3) - Shenzhen based",
    "Software Engineer 3",
  ].slice(0, 9)) {
    assert.equal(canonicalTitle(variant), "Product Designer", variant);
  }
  assert.equal(canonicalTitle("Software Engineer 3"), "Software Engineer");
  assert.equal(canonicalTitle("Data Analyst L4"), "Data Analyst");
});

test("keeps distinctions that actually change the role", () => {
  // Seniority is part of the role, not a suffix.
  assert.equal(canonicalTitle("Senior Software Engineer"), "Senior Software Engineer");
  // A hyphen inside a word is not a separator.
  assert.equal(canonicalTitle("Front-End Engineer"), "Front-End Engineer");
  // A one-word head means the suffix is carrying the specialty, so it stays.
  assert.equal(canonicalTitle("Engineer, Machine Learning"), "Engineer, Machine Learning");
  assert.equal(canonicalTitle("Designer - Brand"), "Designer - Brand");
  // Distinct roles must not merge just because they share a prefix.
  assert.notEqual(canonicalTitle("Engineering Manager"), canonicalTitle("Engineering Director"));
});
