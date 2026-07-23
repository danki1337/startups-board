import { test } from "node:test";
import assert from "node:assert/strict";
import { roleFamily, ROLE_FAMILY_NAMES } from "../src/roles.mjs";

test("classifies core software and data titles", () => {
  assert.equal(roleFamily("Senior Software Engineer"), "Software Engineering");
  assert.equal(roleFamily("Staff Data Scientist"), "Data Science & Analytics");
  assert.equal(roleFamily("Site Reliability Engineer"), "DevOps & Infrastructure");
  assert.equal(roleFamily("Sales Engineer"), "Sales Engineering");
});

test("classifies high-frequency retail and hospitality service roles", () => {
  for (const title of [
    "Store Associate", "Host", "Dishwasher", "Bar & Waiting Staff", "Kitchen Assistant",
    "Busser Runner", "Commis de cuisine H/F", "Key Holder", "Merchandiser", "Concierge",
  ]) {
    assert.equal(roleFamily(title), "Retail & Hospitality", title);
  }
});

test("classifies high-frequency clinical roles", () => {
  for (const title of [
    "Speech Language Pathologist", "Dietary Aide", "Registered Dietitian", "Optometrist",
    "Psychiatrist (MD)", "Care Assistant", "Pharmacy Manager",
  ]) {
    assert.equal(roleFamily(title), "Healthcare & Clinical", title);
  }
});

test("classifies banking front-office roles as finance", () => {
  assert.equal(roleFamily("Relationship Banker"), "Finance & Accounting");
  assert.equal(roleFamily("Bank Teller"), "Finance & Accounting");
});

test("classifies project engineering as non-software engineering", () => {
  assert.equal(roleFamily("Project Engineer"), "Engineering (non-software)");
});

test("word-boundary needles do not over-match", () => {
  // " host" must not catch ghostwriter; " teller" must not catch storyteller.
  assert.equal(roleFamily("Ghostwriter"), null);
  assert.equal(roleFamily("Storyteller"), null);
});

test("genuinely ambiguous titles stay unclassified rather than guessed", () => {
  for (const title of ["Assistant Manager I", "To Go Specialist", "General Application", "Associate"]) {
    assert.equal(roleFamily(title), null, title);
  }
});

test("empty or missing titles return null", () => {
  assert.equal(roleFamily(""), null);
  assert.equal(roleFamily(null), null);
  assert.equal(roleFamily(undefined), null);
});

test("every family name is unique and sorted", () => {
  const sorted = [...ROLE_FAMILY_NAMES].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(ROLE_FAMILY_NAMES, sorted);
  assert.equal(new Set(ROLE_FAMILY_NAMES).size, ROLE_FAMILY_NAMES.length);
});
