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

// Ashby serves the EMPLOYER'S uploaded logo from app.ashbyhq.com/api/images/org-theme-*, which the
// vendor rejection must carve out — while still refusing Ashby's own cdn.ashbyprd favicon.
test("accepts Ashby org-theme customer logos while rejecting Ashby vendor assets", () => {
  const html = `
    <link rel="icon" href="https://cdn.ashbyprd.com/cdn_assets/abc/favicon.svg">
    <meta property="og:image" content="https://app.ashbyhq.com/api/images/org-theme-logo/0af0921d/cc1e7455/logo.png">
  `;
  assert.equal(
    extractLogoUrl(html, "https://jobs.ashbyhq.com/midjourney"),
    "https://app.ashbyhq.com/api/images/org-theme-logo/0af0921d/cc1e7455/logo.png",
  );
  // A generic app.ashbyhq.com asset outside org-theme-* is still vendor branding.
  assert.equal(
    extractLogoUrl(
      `<meta property="og:image" content="https://app.ashbyhq.com/social/default.png">`,
      "https://jobs.ashbyhq.com/acme",
    ),
    null,
  );
});

// SmartRecruiters boards carry the SR product favicon (av-www.smartrecruiters.com) on every page;
// the employer's image lives on the separate c.smartrecruiters.com bucket.
test("prefers SmartRecruiters customer images over the SR product favicon", () => {
  const html = `
    <link rel="shortcut icon" href="https://av-www.smartrecruiters.com/sr-logo/1.0.6/winston/favicon.ico">
    <meta property="og:image" content="https://c.smartrecruiters.com/sr-careersite-image-prod/606f/80b1?r=s3-eu-central-1">
  `;
  assert.equal(
    extractLogoUrl(html, "https://jobs.smartrecruiters.com/WesternDigital"),
    "https://c.smartrecruiters.com/sr-careersite-image-prod/606f/80b1?r=s3-eu-central-1",
  );
});

test("rejects the Rippling platform favicon", () => {
  const html = `<link rel="icon" href="https://static-assets.ripplingcdn.com/ui-platform/common/favicon-32x32.png">`;
  assert.equal(extractLogoUrl(html, "https://ats.rippling.com/acme/jobs"), null);
});
