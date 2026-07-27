/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  handleOperatorRequest,
  queue as handleQueue,
  scheduled as handleScheduled,
} from "../../cloudflare/src/handlers.mjs";
import { reportError } from "../../cloudflare/src/alerts.mjs";

// Headers every response carries. Set here rather than in next.config because this entry is the one
// place EVERY response passes through -- the app router, the image optimizer and the operator
// endpoints alike -- and a header set in three places is a header that will disagree in three
// places.
//
// There is deliberately no Content-Security-Policy. A meaningful one for this app has to allow the
// framework's own inline hydration script, and a CSP written without testing that is either
// worthless ('unsafe-inline') or breaks the page outright. frame-ancestors is the part with real
// value here and X-Frame-Options covers it. Worth doing properly later; worth not guessing at now.
const SECURITY_HEADERS: Record<string, string> = {
  // Two years, and preload-eligible. The site is already HTTPS-only in practice; this is what makes
  // the FIRST request of a session use it too, which is the one a downgrade attack needs.
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  // The logo proxy already sends this per-response because it relays third-party bytes. Globally, it
  // is what stops a text/plain response being sniffed into something executable.
  "x-content-type-options": "nosniff",
  // Nothing here is worth framing, and a job board in an iframe is a clickjacking surface.
  "x-frame-options": "DENY",
  // Send the origin to other sites, the full URL to ourselves. A job board's URL carries the
  // reader's filters and search terms; those are theirs, not the ATS's.
  "referrer-policy": "strict-origin-when-cross-origin",
  // None of these are used, so none should be available to anything embedded or injected.
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

function withSecurityHeaders(response: Response): Response {
  // Headers are immutable on some responses (asset fetches, redirects), so the object is rebuilt
  // rather than mutated. Body is passed through untouched -- streaming responses stay streaming.
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!value) continue;
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ARCHIVE: R2Bucket;
  ADMIN_TOKEN?: string;
  // Optional. Set with `wrangler secret put ALERT_WEBHOOK` to have failures pushed somewhere a
  // person will see them; without it everything is still logged and searchable.
  ALERT_WEBHOOK?: string;
  QUEUE_ASHBY: Queue;
  QUEUE_BAMBOOHR: Queue;
  QUEUE_GEM: Queue;
  QUEUE_GETRO: Queue;
  QUEUE_GREENHOUSE: Queue;
  QUEUE_ICIMS: Queue;
  QUEUE_LEVER: Queue;
  QUEUE_PAYLOCITY: Queue;
  QUEUE_RIPPLING: Queue;
  QUEUE_SMARTRECRUITERS: Queue;
  QUEUE_SPARKHIRE: Queue;
  QUEUE_WORKDAY: Queue;
  QUEUE_DISCOVERY: Queue;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      const operatorResponse = await handleOperatorRequest(request, env);
      if (operatorResponse) return withSecurityHeaders(operatorResponse);

      if (url.pathname === "/_vinext/image") {
        const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
        return withSecurityHeaders(await handleImageOptimization(request, {
          fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
            return result.response();
          },
        }, allowedWidths));
      }

      return withSecurityHeaders(await handler.fetch(request, env, ctx));
    } catch (error) {
      // Nothing used to catch this. A request that threw produced an opaque platform 500 with no
      // body and no log line -- which is exactly what a sustained-load test turned up and what left
      // the cause unidentifiable, because the worker never got to say anything about it.
      //
      // waitUntil, so reporting cannot delay the reader's response: they get their error page now
      // and the webhook fires on the way out.
      ctx.waitUntil(reportError(env, `fetch ${request.method} ${url.pathname}`, error, {
        search: url.search.slice(0, 200),
        ray: request.headers.get("cf-ray") ?? undefined,
      }));
      return withSecurityHeaders(new Response("Something went wrong. Please try again.", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      }));
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    try {
      return await handleScheduled(controller, env, ctx);
    } catch (error) {
      // A cron that throws fails silently by design -- there is no reader to show an error to, which
      // is precisely why it needs reporting more than the request path does, not less.
      ctx.waitUntil(reportError(env, "scheduled", error, { cron: controller.cron }));
      throw error;
    }
  },

  async queue(batch: MessageBatch, env: Env) {
    try {
      return await handleQueue(batch, env);
    } catch (error) {
      await reportError(env, `queue ${batch.queue}`, error, { messages: batch.messages.length });
      throw error;
    }
  },
};

export default worker;
