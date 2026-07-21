import assert from "node:assert/strict";
import test from "node:test";
import { extractLogoUrl } from "../src/company-logo.mjs";

test("prefers a square icon over a wide social banner", () => {
  const html = `
    <meta property="og:image" content="https://images.stripeassets.com/Stripe_jobs_share.jpg">
    <link rel="icon" href="https://images.stripeassets.com/favicon.png?w=180">
  `;
  assert.equal(
    extractLogoUrl(html, "https://job-boards.greenhouse.io/stripe"),
    "https://images.stripeassets.com/favicon.png?w=180",
  );
});

test("falls back to og:image when a board uploads a logo but no favicon", () => {
  const html = `<meta property="og:image"
    content="https://s8-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/1.png">`;
  assert.equal(
    extractLogoUrl(html, "https://job-boards.greenhouse.io/anthropic"),
    "https://s8-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/1.png",
  );
});

// Without this the same Ashby or BambooHR image would be shown as the logo of every company on
// those platforms, which is worse than showing no logo at all.
test("rejects ATS vendor branding so it never masquerades as a company logo", () => {
  const ashby = `<link rel="icon" href="https://cdn.ashbyprd.com/cdn_assets/abc/favicon.svg">`;
  assert.equal(extractLogoUrl(ashby, "https://jobs.ashbyhq.com/ramp"), null);

  const bamboo = `<meta property="og:image" content="https://www.bamboohr.com/media_115e.png?width=1200">`;
  assert.equal(extractLogoUrl(bamboo, "https://acme.bamboohr.com/careers"), null);

  const paylocityFavicon = `
    <link rel="shortcut icon" href="https://cdn.paylocity.com/cdn/branding/favicon.ico">
    <meta property="og:image" content="https://recruiting.paylocity.com/Recruiting/Jobs/GetLogoFileById?logoFileStoreId=1">
  `;
  assert.equal(
    extractLogoUrl(paylocityFavicon, "https://recruiting.paylocity.com/recruiting/jobs/All/x/"),
    "https://recruiting.paylocity.com/Recruiting/Jobs/GetLogoFileById?logoFileStoreId=1",
  );
});

test("ignores inline data placeholders and resolves relative hrefs", () => {
  assert.equal(extractLogoUrl(`<link rel="icon" href="data:,">`, "https://acme.icims.com/jobs/intro"), null);
  assert.equal(
    extractLogoUrl(`<link rel="apple-touch-icon" href="/assets/logo.png">`, "https://acme.icims.com/jobs/intro"),
    "https://acme.icims.com/assets/logo.png",
  );
});

test("decodes HTML entities in the resolved URL", () => {
  const html = `<meta property="og:image" content="https://x.com/logo.png?w=1200&#x26;format=png">`;
  assert.equal(
    extractLogoUrl(html, "https://acme.icims.com/jobs/intro"),
    "https://x.com/logo.png?w=1200&format=png",
  );
});

test("returns null when a board exposes no usable image", () => {
  assert.equal(extractLogoUrl("<html><body>no tags</body></html>", "https://jobs.lever.co/acme"), null);
  assert.equal(extractLogoUrl("", "https://jobs.lever.co/acme"), null);
});
