// Error reporting, in two halves: something has to RECORD what went wrong, and something has to TELL
// someone. Cloudflare's observability already does the first (wrangler.jsonc turns it on, so logs are
// retained and searchable in the dashboard) -- but only if the error is actually logged, and only if
// someone thinks to go and look. Neither was true.
//
// So: every failure is logged as one structured JSON line, which is what makes it findable in the
// dashboard rather than a stack trace buried in prose; and if ALERT_WEBHOOK is set, it is also
// pushed somewhere a person will see it. No third-party SDK, no account, no bundle weight -- a
// webhook URL is the one piece only the operator can supply, and everything still works without it.
//
//   npx wrangler secret put ALERT_WEBHOOK --config cloudflare/wrangler.jsonc
//
// Slack and Discord both accept a bare JSON body with a `text`/`content` field, which is why both
// are sent; anything else receives the structured payload and can read whichever it likes.

// One isolate's memory of what it has already shouted about. Isolates are short-lived and there are
// many, so this is a damper rather than a guarantee -- and a damper is the point: the failure mode
// worth designing against is a burst of thousands of identical errors turning a webhook into a
// denial-of-service against its own channel, not the occasional duplicate.
const lastSent = new Map();
const ALERT_COOLDOWN_MS = 5 * 60_000;
// Bounded, because an unbounded Map keyed on error text is a slow leak in a long-lived isolate.
const MAX_TRACKED_KEYS = 64;

function shouldSend(key, now) {
  const previous = lastSent.get(key);
  if (previous && now - previous < ALERT_COOLDOWN_MS) return false;
  if (lastSent.size >= MAX_TRACKED_KEYS) {
    // Oldest first, which for a Map is insertion order -- good enough to keep this bounded.
    lastSent.delete(lastSent.keys().next().value);
  }
  lastSent.set(key, now);
  return true;
}

/**
 * Report a failure. Always logs; notifies when a webhook is configured and the same failure has not
 * already been sent in the last five minutes.
 *
 * Never throws and never rejects: this is called from catch blocks, and a reporter that can fail is
 * a second bug on top of the first one.
 *
 * @param {object} env worker bindings; ALERT_WEBHOOK is optional
 * @param {string} context where it happened, e.g. "fetch GET /api/jobs"
 * @param {unknown} error the thrown value, which is not necessarily an Error
 * @param {object} [extra] anything else worth having in the log line
 */
export async function reportError(env, context, error, extra = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const entry = {
    level: "error",
    context,
    message,
    stack: error instanceof Error ? error.stack?.split("\n").slice(0, 4).join(" | ") : undefined,
    ...extra,
    at: new Date().toISOString(),
  };
  // One line, one JSON object. The dashboard indexes the fields, so "context = fetch GET /api/jobs"
  // is a query rather than a text search.
  console.error(JSON.stringify(entry));

  const webhook = env?.ALERT_WEBHOOK;
  if (!webhook) return;
  // Keyed on context + message, NOT the stack: the same fault from a thousand requests is one thing
  // to be told about, and its stack differs by frame addresses.
  if (!shouldSend(`${context}::${message}`, Date.now())) return;

  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `aboard: ${context} — ${message}`,
        content: `aboard: ${context} — ${message}`,
        ...entry,
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // A webhook that is down must not take the request down with it. The console line above is
    // already written, so nothing is lost that was not already recorded.
  }
}

/**
 * The daily "is anything wrong?" pass. Alerting only on exceptions means silence when the site is
 * merely BROKEN rather than throwing -- a provider rejecting every refresh, or the failure backlog
 * climbing, produces no exception at all and would never have been noticed.
 *
 * Sends only when something crosses a threshold, so a healthy day is silent and a message means
 * something.
 */
export async function reportHealth(env) {
  if (!env?.ALERT_WEBHOOK) return { checked: false };
  try {
    const [failures, providers] = await env.DB.batch([
      env.DB.prepare("SELECT count(*) AS count FROM failed_tasks WHERE resolved_at IS NULL"),
      env.DB.prepare("SELECT provider, successful_runs, failed_runs, active_jobs FROM provider_health ORDER BY provider"),
    ]);
    const unresolved = Number(failures.results?.[0]?.count ?? 0);
    const rows = providers.results ?? [];

    const problems = [];
    // A provider is judged on its RATE, not its count: greenhouse fails 584 times against 47,910
    // successes and is fine; paylocity fails more often than it succeeds and is not.
    for (const row of rows) {
      const ok = Number(row.successful_runs ?? 0);
      const bad = Number(row.failed_runs ?? 0);
      const total = ok + bad;
      if (total < 100) continue; // too little history to judge
      const rate = bad / total;
      if (rate >= 0.25) {
        problems.push(`${row.provider} failing ${Math.round(rate * 100)}% of refreshes (${bad.toLocaleString()} of ${total.toLocaleString()})`);
      }
    }
    if (unresolved >= 10_000) problems.push(`${unresolved.toLocaleString()} unresolved failed tasks`);
    // Zero active jobs anywhere is the one shape that means the site is showing an empty table.
    const active = rows.reduce((sum, row) => sum + Number(row.active_jobs ?? 0), 0);
    if (active === 0) problems.push("no active jobs in the index at all");

    if (!problems.length) return { checked: true, problems: 0 };
    const text = `aboard daily check — ${problems.length} problem(s):\n• ${problems.join("\n• ")}`;
    await fetch(env.ALERT_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, content: text, problems, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(5_000),
    });
    return { checked: true, problems: problems.length };
  } catch (error) {
    console.error(JSON.stringify({ level: "error", context: "reportHealth", message: String(error) }));
    return { checked: false };
  }
}
