import assert from "node:assert/strict";
import test from "node:test";
import { canonicalTitle } from "../src/database.mjs";

// Mirrored in web/app/jobs-query.ts. Every case below is a real title from the production index
// that was showing up as its own row in the Title dropdown alongside the plain role.
test("folds every qualifier form onto one role", () => {
  for (const variant of [
    "Product Designer",
    "Product Designer (UI/UX)",
    "Product Designer (Contract)",
    "Product Designer (m/w/d)",
    "Product Designer (Mid-Level)",
    "Product Designer (UX), HCI",
    "Product Designer (Web3) - Shenzhen based",
    "Product Designer | Senior",
    "Product Designer II",
    "Product Designer - US Government",
    "Product Designer- San Francisco",
    "Product Designer, App Store",
    "Product Designer: Design Systems",
    "Product Designer & Builder",
    "Product Designer / プロダクトデザイナー",
    "Product Designer/Sr. Product Designer",
    "Product Designer Freelance",
    "Product Designer Lead",
    "Product Designer Pleno",
    "Product Designer Remote",
  ]) {
    assert.equal(canonicalTitle(variant), "Product Designer", variant);
  }
  assert.equal(canonicalTitle("Software Engineer 3"), "Software Engineer");
  assert.equal(canonicalTitle("Data Analyst L4"), "Data Analyst");
  assert.equal(canonicalTitle("Account Manager Level 2"), "Account Manager");
});

test("keeps distinctions that actually change the role", () => {
  // Leading seniority is part of the role; only trailing qualifiers are stripped.
  assert.equal(canonicalTitle("Senior Product Designer"), "Senior Product Designer");
  // A hyphen inside a word is not a separator.
  assert.equal(canonicalTitle("Front-End Engineer"), "Front-End Engineer");
  // A one-word head means the suffix carries the specialty, so nothing is dropped.
  assert.equal(canonicalTitle("Engineer, Machine Learning"), "Engineer, Machine Learning");
  assert.equal(canonicalTitle("UI/UX Designer"), "UI/UX Designer");
  // Stripping must never reduce a title to a single word.
  assert.equal(canonicalTitle("Design Lead"), "Design Lead");
  // Distinct roles must not merge just because they share a prefix.
  assert.notEqual(canonicalTitle("Engineering Manager"), canonicalTitle("Engineering Director"));
});

test("folds single-word roles too, without eating their specialties", () => {
  // A pure level code is never part of a role name, so it may strip down to one word.
  assert.equal(canonicalTitle("Designer II"), "Designer");
  // Engagement type and duration likewise.
  assert.equal(canonicalTitle("Designer Contract"), "Designer");
  assert.equal(canonicalTitle("Designer - 6 month"), "Designer");
  assert.equal(canonicalTitle("Engineer Remote"), "Engineer");
  // But a descriptive suffix after a one-word head is the specialty, and stays.
  assert.equal(canonicalTitle("Designer, Brand"), "Designer, Brand");
  assert.equal(canonicalTitle("Designer - Men's"), "Designer - Men's");
});
