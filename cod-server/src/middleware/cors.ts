/**
 * CORS Middleware
 *
 * Fail-closed by construction. A response carries
 * `Access-Control-Allow-Origin` only when the request's `Origin` is explicitly
 * listed in `ALLOWED_ORIGINS`. There is no wildcard and no origin reflection:
 * a missing, empty or malformed setting denies every cross-origin read instead
 * of granting them.
 *
 * Why this shape: the previous version decided openness from two variables and
 * defaulted to open. Missing `ALLOWED_ORIGINS`, or an `ENVIRONMENT` that was
 * not exactly the string "production", fell through to echoing the request's
 * origin back with `Access-Control-Allow-Credentials: true` — any website could
 * then read this API. A security decision must fail shut, so `ALLOWED_ORIGINS`
 * is now the single source of truth and `ENVIRONMENT` plays no part here.
 *
 * A request without an `Origin` header (server-to-server, carrier webhooks,
 * curl, cron) gets no CORS headers at all — there is no origin to authorise.
 */

import { Context, Next } from "hono";
import type { AppContext } from "@/types/app";

const ALLOWED_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOWED_REQUEST_HEADERS =
  "Content-Type, X-API-Key, X-Store-API-Key, Accept, Authorization";
/** Response headers readable by the browser. API key headers are REQUEST
 * headers — exposing them here would only widen the surface if a handler ever
 * echoed one back. */
const EXPOSED_RESPONSE_HEADERS = "Content-Type";
const PREFLIGHT_MAX_AGE = "86400";

/**
 * Parse the configured allow-list. Entries are trimmed and stripped of a
 * trailing slash so `https://store.example.com/` matches the origin the
 * browser sends (`https://store.example.com`). A literal `*` is discarded
 * rather than honoured — the wildcard is the thing this middleware exists to
 * make impossible.
 */
function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => origin.length > 0 && origin !== "*");
}

/**
 * Normalise an inbound Origin, or null when it must never be authorised.
 *
 * `"null"` is what a browser sends for a sandboxed iframe, a `data:` document or
 * `file://` — all attacker-reachable framings that share one opaque origin. It
 * is never matchable. `*` is likewise never a legitimate request origin.
 */
function normalizeRequestOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  const origin = raw.trim().replace(/\/+$/, "");
  if (origin === "" || origin === "null" || origin === "*") return null;
  return origin;
}

/** The origin to authorise, or null when the request gets no CORS headers. */
function resolveAllowedOrigin(
  requestOrigin: string | undefined,
  allowedOrigins: string[],
): string | null {
  const origin = normalizeRequestOrigin(requestOrigin);
  if (!origin) return null;
  return allowedOrigins.includes(origin) ? origin : null;
}

export async function corsMiddleware(c: Context<AppContext>, next: Next) {
  const requestOrigin = c.req.header("origin");
  const allowedOrigin = resolveAllowedOrigin(
    requestOrigin,
    parseAllowedOrigins(c.env.ALLOWED_ORIGINS),
  );

  const applyCorsHeaders = () => {
    // Declared only when an Origin was sent: without one the response is
    // origin-independent, so caches stay unfragmented for the R2 image paths
    // that are cached for a year. When one is sent, this is mandatory — the
    // response differs per origin and a shared cache must not mix them.
    if (requestOrigin) c.header("Vary", "Origin");

    if (!allowedOrigin) return;

    c.header("Access-Control-Allow-Origin", allowedOrigin);
    c.header("Access-Control-Allow-Methods", ALLOWED_METHODS);
    c.header("Access-Control-Allow-Headers", ALLOWED_REQUEST_HEADERS);
    c.header("Access-Control-Expose-Headers", EXPOSED_RESPONSE_HEADERS);
    c.header("Access-Control-Max-Age", PREFLIGHT_MAX_AGE);
    // Safe to send only because `allowedOrigin` is a specific, listed origin.
    c.header("Access-Control-Allow-Credentials", "true");
  };

  applyCorsHeaders();

  if (c.req.method === "OPTIONS") {
    // An unauthorised preflight is refused outright. Returning 204 with no
    // ACAO would also be blocked by the browser, but 403 says "denied"
    // instead of leaving a half-formed answer to be interpreted.
    if (!allowedOrigin) return c.body(null, 403);

    return c.body(null, 204, {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": ALLOWED_METHODS,
      "Access-Control-Allow-Headers": ALLOWED_REQUEST_HEADERS,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": PREFLIGHT_MAX_AGE,
      Vary: "Origin",
    });
  }

  await next();

  // Handlers that return a raw `new Response(...)` (streamed PDFs, R2 objects)
  // bypass Hono's prepared-header application, so the headers set before
  // `next()` never reach them — re-apply on the final response.
  applyCorsHeaders();
}