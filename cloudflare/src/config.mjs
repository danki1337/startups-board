export const PROVIDER_QUEUE_BINDINGS = Object.freeze({
  ashby: "QUEUE_ASHBY",
  bamboohr: "QUEUE_BAMBOOHR",
  gem: "QUEUE_GEM",
  getro: "QUEUE_GETRO",
  greenhouse: "QUEUE_GREENHOUSE",
  icims: "QUEUE_ICIMS",
  lever: "QUEUE_LEVER",
  paylocity: "QUEUE_PAYLOCITY",
  rippling: "QUEUE_RIPPLING",
  smartrecruiters: "QUEUE_SMARTRECRUITERS",
  sparkhire: "QUEUE_SPARKHIRE",
  workday: "QUEUE_WORKDAY",
});

// How soon an active board is looked at again, as a ladder indexed by how many CONSECUTIVE
// refreshes have found nothing. A board that just changed sits at rung 0; each empty-handed refresh
// moves it one rung down; any change puts it straight back to the top.
//
// This replaced a flat 12 hours for everything, and the reason is measured. Over 24h, 89,109 of
// 128,690 completed refreshes -- 69.2% -- changed not one row. And that waste is not spread evenly:
// across 3 days (roughly 6 refreshes per board), 13,326 boards changed on ZERO of them while ~2,000
// changed on every single one. Quiet is a stable property of a board, not noise, which is exactly
// the condition under which spending the crawl budget where the churn is actually works.
//
// Modelling the observed distribution against this ladder gives ~92,200 refreshes/day, against
// 92,060 today: the total crawl budget is unchanged. What changes is where it goes. The boards that
// actually post move from 2 refreshes a day to 8 -- average detection lag 1.5h instead of 6h -- and
// the dormant third drops to one every other day, which costs nothing because nothing was there.
//
// The floor is 3h rather than 1h deliberately: capacity is 96 crons/day x 2,000 boards = 192,000,
// and a floor low enough to let a large set converge on it would blow through that ceiling and
// through the politeness budget of the ATSs that already push back (Getro answers 530 at
// concurrency 2).
export const ACTIVE_REFRESH_LADDER_HOURS = Object.freeze([3, 6, 12, 24, 48]);
export const EMPTY_REFRESH_HOURS = 96;
export const INVALID_REFRESH_HOURS = 24 * 30;
export const ERROR_BASE_DELAY_MINUTES = 15;
// Consecutive "not a job list" responses required before a board's postings are closed. A single
// invalid response is far more often a bot challenge or a truncated body than a dead board, and
// acting on one used to wipe the board's entire listing -- so closure needs corroboration.
export const INVALID_CLOSE_STRIKES = 3;
// A snapshot that parses but carries ZERO jobs closes a board immediately only when the board had
// fewer active jobs than this; at or above it, the empty answer needs the same consecutive-strikes
// corroboration an invalid response needs. Boards genuinely emptying out wind down one posting at
// a time and pass under the threshold on the way; a 3,000-job board reporting zero overnight is a
// bot challenge with a 200 status, not a hiring freeze.
export const EMPTY_CLOSE_MIN_ACTIVE = 10;

// Clamped rather than indexed directly, so a quiet_syncs that has run past the end of the ladder
// (or arrives negative from a bad write) still lands on a real rung instead of undefined, which
// would make the interval NaN and the board unschedulable forever.
export function activeRefreshHours(quietSyncs = 0) {
  const rung = Math.min(ACTIVE_REFRESH_LADDER_HOURS.length - 1, Math.max(0, Math.floor(quietSyncs) || 0));
  return ACTIVE_REFRESH_LADDER_HOURS[rung];
}

export function queueForProvider(env, provider) {
  const binding = PROVIDER_QUEUE_BINDINGS[provider];
  return binding ? env[binding] : null;
}

// 429 is the host rate limiting; 530 is what Getro answers when pushed (a Cloudflare origin code
// used the same way). Both mean "the PROVIDER wants less traffic", which no per-board error ladder
// can express -- so they get their own, longer backoff and are never retried in place.
export function isRateLimitError(message) {
  return /\bHTTP (?:429|530)\b/.test(message ?? "");
}

// Hours, not the error ladder's minutes: measured on production, the 15-minute ladder walked
// 45,687 Paylocity refreshes into the same 429 in one day -- each burning its queue retries and
// ~13 rows of failure bookkeeping. Doubles per consecutive failure, capped at a day. The ±25%
// jitter matters as much as the length: every board of a provider tends to hit the limit in the
// same minute, and without it they all come back in the same minute too.
export function rateLimitNextSyncAt(failureCount = 1, now = Date.now()) {
  const hours = Math.min(24, 2 ** Math.max(1, Math.floor(failureCount) || 1));
  const jitter = 0.75 + Math.random() * 0.5;
  return new Date(now + hours * 60 * 60 * 1_000 * jitter).toISOString();
}

/**
 * @param {string} status
 * @param {number} failureCount consecutive failures, for the error backoff
 * @param {number} now
 * @param {number} quietSyncs consecutive refreshes that changed nothing; picks the active rung
 */
export function nextSyncAt(status, failureCount = 0, now = Date.now(), quietSyncs = 0) {
  let milliseconds;
  if (status === "active") milliseconds = activeRefreshHours(quietSyncs) * 60 * 60 * 1_000;
  else if (status === "empty") milliseconds = EMPTY_REFRESH_HOURS * 60 * 60 * 1_000;
  else if (status === "invalid") milliseconds = INVALID_REFRESH_HOURS * 60 * 60 * 1_000;
  else {
    const minutes = Math.min(24 * 60, ERROR_BASE_DELAY_MINUTES * 2 ** Math.max(0, failureCount));
    milliseconds = minutes * 60 * 1_000;
  }
  return new Date(now + milliseconds).toISOString();
}
