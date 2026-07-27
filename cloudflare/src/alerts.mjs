// Error reporting, in two halves: something has to RECORD what went wrong, and something has to TELL
// someone. Cloudflare's observability already does the first (wrangler.jsonc turns it on, so logs are
// retained and searchable in the dashboard) -- but only if the error is actually logged, and only if
// someone thinks to go and look. Neither was true.
//
// Every failure is now logged as one structured JSON line, which is what makes it findable in the
// dashboard rather than a stack trace buried in prose. Then it goes to whichever channels are
// configured -- all of them, because an operator wanting both a chat ping and an email is a normal
// thing to want, not a choice to be forced. None configured is fine: the log line is still written.
//
// EMAIL, through Cloudflare's own Email Routing. No third-party account, no API key to leak, free,
// and it can only send to an address already verified on the account -- which is a limitation
// everywhere except here, where the only recipient is the person who owns it.
//   1. Cloudflare dashboard -> the aboard.cc zone -> Email -> Email Routing -> enable
//   2. add your own address as a destination and click the link it emails you
//   3. add the binding to cloudflare/wrangler.jsonc:
//        "send_email": [{ "name": "SEND_EMAIL" }]
//   4. npx wrangler secret put ALERT_EMAIL_TO     (the verified address)
//      npx wrangler secret put ALERT_EMAIL_FROM   (anything@aboard.cc)
//
// EMAIL, through Resend, if you would rather not enable Email Routing or want to send somewhere
// unverified. Needs an account and a key, works immediately, sends anywhere.
//   npx wrangler secret put RESEND_API_KEY
//   npx wrangler secret put ALERT_EMAIL_TO
//   npx wrangler secret put ALERT_EMAIL_FROM     (a domain verified with Resend)
//
// CHAT, if you already live in one.
//   npx wrangler secret put ALERT_WEBHOOK
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

// One RFC 5322 message, built by hand rather than pulling in a MIME library for six headers. Plain
// text only: an alert is read on a phone at an inconvenient hour and has nothing to lay out.
function mimeMessage({ from, to, subject, body }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    // Newlines in a header are header injection, so a subject that ever came from outside is folded
    // to one line here rather than trusted. Today it never does; that is not a reason to allow it.
    `Subject: ${subject.replace(/[\r\n]+/g, " ").slice(0, 180)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    `Message-ID: <${crypto.randomUUID()}@aboard.cc>`,
    `Date: ${new Date().toUTCString()}`,
    "",
    body,
  ].join("\r\n");
}

async function sendViaEmailRouting(env, subject, body) {
  // Imported here, not at the top of the file: `cloudflare:email` is a Workers built-in and does not
  // exist in Node, where this module is also imported by the test suite.
  const { EmailMessage } = await import("cloudflare:email");
  const from = env.ALERT_EMAIL_FROM;
  const to = env.ALERT_EMAIL_TO;
  await env.SEND_EMAIL.send(new EmailMessage(from, to, mimeMessage({ from, to, subject, body })));
}

async function sendViaResend(env, subject, body) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.ALERT_EMAIL_FROM,
      to: [env.ALERT_EMAIL_TO],
      subject,
      text: body,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Resend returned ${response.status}`);
}

async function sendViaWebhook(env, subject, body, extra) {
  const text = `${subject}\n${body}`;
  const response = await fetch(env.ALERT_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Slack reads `text`, Discord reads `content`, anything else gets the structured fields.
    body: JSON.stringify({ text, content: text, subject, ...extra }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`webhook returned ${response.status}`);
}

/**
 * Deliver one alert to every channel that is configured, and let a broken channel be one broken
 * channel. allSettled, not all: an expired Resend key must not stop the email that Cloudflare would
 * have delivered, and neither must stop the log line that is already written.
 */
async function deliver(env, subject, body, extra = {}) {
  const sends = [];
  if (env?.SEND_EMAIL && env.ALERT_EMAIL_TO && env.ALERT_EMAIL_FROM) {
    sends.push(["email (Cloudflare)", sendViaEmailRouting(env, subject, body)]);
  } else if (env?.RESEND_API_KEY && env.ALERT_EMAIL_TO && env.ALERT_EMAIL_FROM) {
    sends.push(["email (Resend)", sendViaResend(env, subject, body)]);
  }
  if (env?.ALERT_WEBHOOK) sends.push(["webhook", sendViaWebhook(env, subject, body, extra)]);
  if (!sends.length) return;

  const results = await Promise.allSettled(sends.map(([, promise]) => promise));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      // Logged, never rethrown. This runs inside catch blocks and inside waitUntil; a reporter that
      // can fail the thing it is reporting on is a second bug stacked on the first.
      console.error(JSON.stringify({
        level: "error",
        context: "alert delivery",
        channel: sends[index][0],
        message: String(result.reason),
      }));
    }
  });
}

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
 * Report a failure. Always logs; notifies through every configured channel when the same failure has
 * not already been sent in the last five minutes.
 *
 * Never throws and never rejects: this is called from catch blocks, and a reporter that can fail is
 * a second bug on top of the first one.
 *
 * @param {object} env worker bindings; every alert channel is optional
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

  // Keyed on context + message, NOT the stack: the same fault from a thousand requests is one thing
  // to be told about, and its stack differs by frame addresses.
  if (!shouldSend(`${context}::${message}`, Date.now())) return;
  await deliver(env, `aboard: ${context}`, `${message}\n\n${entry.stack ?? ""}`.trim(), entry);
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
  // Nothing configured means nothing to tell, and the five reads it costs would be wasted.\n  const configured = env?.ALERT_WEBHOOK\n    || (env?.ALERT_EMAIL_TO && (env?.SEND_EMAIL || env?.RESEND_API_KEY));\n  if (!configured) return { checked: false };
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
    await deliver(
      env,
      `aboard daily check — ${problems.length} problem${problems.length === 1 ? "" : "s"}`,
      problems.map((line) => `• ${line}`).join("\n"),
      { problems },
    );
    return { checked: true, problems: problems.length };
  } catch (error) {
    console.error(JSON.stringify({ level: "error", context: "reportHealth", message: String(error) }));
    return { checked: false };
  }
}
