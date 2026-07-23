import { test } from "node:test";
import assert from "node:assert/strict";
import { isLikelyScam } from "../src/quality.mjs";

test("flags real recruitment-scam and job-spam titles", () => {
  for (const title of [
    "$4800USD/MONTHLY ESL/ENGLISH TEACHING JOB WITH FREE AIRFARE AND ACCOMMODATION IN DUBAI, UNITED ARAB EMIRATES.",
    "HIGH PAID ESL/ENGLISH TEACHING JOB WITH FREE AIRFARE AND ACCOMMODATION",
    "LOAN, BG/SBLC MT760 AND PROJECT FUNDING OFFER!!!",
    "URGENT VACANCY FOR BANKING SECTOR",
    "URGENT OPENING MECHANICAL ELECTRICAL & ELECTRONICS ENGINEER",
    "Teacher needed - free visa and accommodation provided",
    "$4800USD ESL/ENGLISH TEACHING JOB IN DUBAI - abdulglobalrecruters@gmail.com",
    "HIGH PAID ESL/ENGLISH TEACHING JOB AVAILABLE - recruiter@yahoo.com",
  ]) {
    assert.equal(isLikelyScam(title), true, title);
  }
});

test("does not flag legitimate postings that share loose keywords", () => {
  for (const title of [
    "Software Engineer, WhatsApp",       // Meta's WhatsApp org — "whatsapp" must not trigger
    "Loan Officer",                      // "loan" must not trigger
    "Loan Processing Specialist",
    "Trade Finance Analyst",             // letters of credit are legit finance work
    "Senior Accountant",
    "Registered Nurse - Urgent Care",    // "urgent care" clinic, not "urgent vacancy"
    "Flight Attendant",
    "Visa Compliance Manager",           // "visa" without "free"
    "Monthly Reporting Analyst",         // "month" without the "USD/monthly" spam shape
    "Email Marketing Manager",           // "email" without an address
    "Careers at gmail — Product Lead",   // "gmail" without an @address is not the pattern
  ]) {
    assert.equal(isLikelyScam(title), false, title);
  }
});

test("handles empty and missing titles", () => {
  assert.equal(isLikelyScam(""), false);
  assert.equal(isLikelyScam(null), false);
  assert.equal(isLikelyScam(undefined), false);
});
