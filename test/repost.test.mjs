import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { JOB_UPSERT_SQL } from "../cloudflare/src/database.mjs";

// The real upsert, run against a real SQLite.
//
// The rule under test is date arithmetic inside a CASE inside an ON CONFLICT clause -- the shape
// that reads correct and behaves otherwise -- and the recording-stub tests in cloudflare.test.mjs
// can only see what was bound, never what SQLite did with it. Everything here executes the exact
// string production executes.

const COLUMNS = [
  "key", "source_id", "board_key", "provider", "company_identifier", "company_name",
  "company_logo_url", "title", "location", "country", "city", "role_family", "company_industry",
  "workplace", "employment_type", "category", "published_at", "url", "fingerprint", "seen_run_id",
  "is_active", "first_seen_at", "updated_at", "closed_at", "reposted_at",
];

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE jobs (
    ${COLUMNS.map((c) => `${c} TEXT`).join(",\n    ")},
    PRIMARY KEY (key)
  )`);
  return db;
}

// One refresh seeing this posting. `fingerprint` stands in for the job's content: the upsert only
// fires when it differs OR the row is closed, which is exactly the production guard.
function refresh(db, { publishedAt, fingerprint = "fp-1", now }) {
  db.prepare(JOB_UPSERT_SQL).run(
    "greenhouse:global:acme:1", "1", "greenhouse:global:acme", "greenhouse",
    "acme", "Acme", null, "Staff Engineer", "Berlin", "de", "Berlin", "Engineering", "Software",
    "Hybrid", "Full time", "Engineering", publishedAt,
    "https://example.com/1", fingerprint, "run-1", now, now,
  );
}

function close(db, at) {
  db.prepare("UPDATE jobs SET is_active = '0', closed_at = ?, updated_at = ? WHERE key = ?")
    .run(at, at, "greenhouse:global:acme:1");
}

function row(db) {
  return db.prepare("SELECT published_at, reposted_at, is_active, closed_at FROM jobs").get();
}

const ORIGINAL = "2026-01-10T09:00:00.000Z";

test("a posting gone long enough to be a repost comes back dated from the repost", () => {
  const db = freshDb();
  refresh(db, { publishedAt: ORIGINAL, now: "2026-01-10T10:00:00.000Z" });
  close(db, "2026-02-01T10:00:00.000Z");

  // Back three weeks later, and the ATS is still serving January's date.
  refresh(db, { publishedAt: ORIGINAL, now: "2026-02-22T10:00:00.000Z" });

  const after = row(db);
  assert.equal(after.published_at, "2026-02-22T10:00:00.000Z", "dated from the repost, not from January");
  assert.equal(after.reposted_at, "2026-02-22T10:00:00.000Z", "and says why it moved");
  assert.equal(after.is_active, "1");
  assert.equal(after.closed_at, null);
});

test("a posting back within three days is a correction, and its date is left alone", () => {
  // This is the case that matters most. Reactivation usually means WE closed it wrongly -- a
  // truncated page, a bot challenge answered with 200, the Workday pagination bug that cost 1,509
  // boards everything past job 40 -- and those recover on the next refresh. Stamping them as
  // reposted would fill the front page with jobs claiming to be new that never went anywhere.
  const db = freshDb();
  refresh(db, { publishedAt: ORIGINAL, now: "2026-01-10T10:00:00.000Z" });
  close(db, "2026-02-01T10:00:00.000Z");

  refresh(db, { publishedAt: ORIGINAL, now: "2026-02-02T22:00:00.000Z" });

  const after = row(db);
  assert.equal(after.published_at, ORIGINAL, "still January's date");
  assert.equal(after.reposted_at, null, "and not recorded as a repost");
  assert.equal(after.is_active, "1", "but reopened either way");
});

test("the boundary is three days, not two and a bit", () => {
  const db = freshDb();
  refresh(db, { publishedAt: ORIGINAL, now: "2026-01-10T10:00:00.000Z" });
  close(db, "2026-02-01T00:00:00.000Z");
  refresh(db, { publishedAt: ORIGINAL, now: "2026-02-03T23:59:00.000Z" });
  assert.equal(row(db).reposted_at, null, "2d23h59m is still a correction");

  const db2 = freshDb();
  refresh(db2, { publishedAt: ORIGINAL, now: "2026-01-10T10:00:00.000Z" });
  close(db2, "2026-02-01T00:00:00.000Z");
  refresh(db2, { publishedAt: ORIGINAL, now: "2026-02-04T00:01:00.000Z" });
  assert.equal(row(db2).reposted_at, "2026-02-04T00:01:00.000Z", "3d0h01m is a repost");
});

test("an ATS that re-dates its own repost is believed", () => {
  // The source did the right thing, so there is nothing to override. Overriding anyway would
  // replace a real publish time with our observation time, which is strictly less accurate.
  const db = freshDb();
  refresh(db, { publishedAt: ORIGINAL, now: "2026-01-10T10:00:00.000Z" });
  close(db, "2026-02-01T10:00:00.000Z");

  const ATS_REPOST_DATE = "2026-02-20T08:00:00.000Z";
  refresh(db, { publishedAt: ATS_REPOST_DATE, now: "2026-02-22T10:00:00.000Z" });

  const after = row(db);
  assert.equal(after.published_at, ATS_REPOST_DATE, "the source's own date wins");
  assert.equal(after.reposted_at, "2026-02-22T10:00:00.000Z", "still recorded as a repost");
});

test("a later edit does not restore the stale source date", () => {
  // published_at is deliberately outside the fingerprint (Workday publishes relative dates, so
  // including it rewrote 5.6M rows a day). That means an ordinary content edit re-runs this upsert
  // carrying January's date again -- and without the second CASE branch the repost would silently
  // lose its freshness weeks after the fact.
  const db = freshDb();
  refresh(db, { publishedAt: ORIGINAL, now: "2026-01-10T10:00:00.000Z" });
  close(db, "2026-02-01T10:00:00.000Z");
  refresh(db, { publishedAt: ORIGINAL, now: "2026-02-22T10:00:00.000Z" });

  // The employer edits the title a week later. Same stale published_at from the ATS.
  refresh(db, { publishedAt: ORIGINAL, fingerprint: "fp-2", now: "2026-03-01T10:00:00.000Z" });

  assert.equal(row(db).published_at, "2026-02-22T10:00:00.000Z", "the repost date survives the edit");
});

test("a genuinely newer date still wins over a recorded repost", () => {
  // The sticky branch must not freeze the column: if the source later publishes a date after the
  // repost, that is real news and belongs in the table.
  const db = freshDb();
  refresh(db, { publishedAt: ORIGINAL, now: "2026-01-10T10:00:00.000Z" });
  close(db, "2026-02-01T10:00:00.000Z");
  refresh(db, { publishedAt: ORIGINAL, now: "2026-02-22T10:00:00.000Z" });

  refresh(db, { publishedAt: "2026-03-15T10:00:00.000Z", fingerprint: "fp-3", now: "2026-03-20T10:00:00.000Z" });

  assert.equal(row(db).published_at, "2026-03-15T10:00:00.000Z");
});

test("a posting that never closed is untouched by any of this", () => {
  const db = freshDb();
  refresh(db, { publishedAt: ORIGINAL, now: "2026-01-10T10:00:00.000Z" });
  refresh(db, { publishedAt: ORIGINAL, fingerprint: "fp-2", now: "2026-03-01T10:00:00.000Z" });

  const after = row(db);
  assert.equal(after.published_at, ORIGINAL);
  assert.equal(after.reposted_at, null);
});
