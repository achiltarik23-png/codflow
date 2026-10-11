/**
 * Webhook ingress rate limit.
 *
 * `/webhooks/*` is the platform's only unauthenticated write path: the request
 * arrives, the handler reads the carrier row, and — before signature
 * verification — that is already one D1 query the attacker chose to trigger.
 * The RATE_LIMIT KV namespace is bound and already guards MCP and the OTP
 * endpoints; these routes were the gap.
 *
 * Deliberately coarse and deliberately fail-open:
 *
 *   • a KV failure allows the delivery. Dropping a real delivery event strands
 *     a parcel and a merchant's customer, which costs far more than the flood
 *     this guard exists to blunt.
 *   • the threshold is an ARBITRATION, not a measurement. `webhook_events` was
 *     empty when this was written, so there is no observed carrier volume to
 *     calibrate against. 300/minute sits far above any plausible batch while
 *     still bounding the damage from a single source. Re-tune it once real
 *     volumes exist — see the note on WEBHOOK_RATE_LIMIT_MAX_REQUESTS.
 *
 * Identity is the client IP, which is the only thing available before the
 * signature is verified. A request with no IP header falls into one shared
 * bucket rather than being refused: refusing would break every environment
 * that does not set the header, and disabling the guard would reopen the hole.
 */

import type { Context, Next } from "hono";
import type { AppContext } from "@/types/app";

/** Rolling window length. Aligned with the MCP guard. */
export const WEBHOOK_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * Per-IP budget per window.
 *
 * ARBITRARY — no telemetry backs it. `webhook_events` held 0 rows when this was
 * written, so nothing observed the real rate at which Yalidine or ZR Express
 * deliver. Carriers batch: a busy afternoon for one merchant is plausibly tens
 * of events, not hundreds. 300 is chosen to stay well clear of that while
 * still capping a single source.
 *
 * RE-TUNE once `webhook_events` has rows:
 *   SELECT result, COUNT(*) FROM webhook_events
 *    WHERE created_at > datetime('now', '-7 days') GROUP BY result;
 * and take a high multiple of the observed peak per carrier. Do not lower it
 * without knowing a merchant's busiest minute — a false positive here means a
 * shopper's parcel stops updating.
 */
export const WEBHOOK_RATE_LIMIT_MAX_REQUESTS = 300;

/** Bucket name used when the request carries no usable IP. */
const NO_IP_BUCKET = "no-ip";

export type WebhookRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Client IP from the platform header, with the usual proxy fallback.
 *
 * Returns the shared bucket rather than null when nothing is available — see
 * the module header.
 */
export function webhookClientIp(c: Context<AppContext>): string {
  const direct = c.req.header("CF-Connecting-IP")?.trim();
  if (direct) return direct;

  const forwarded = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;

  return NO_IP_BUCKET;
}

/**
 * Coarse fixed-window counter in KV, keyed per provider so one carrier's
 * traffic can never consume another's budget.
 *
 * Fail-open on a missing binding, a KV error, or a non-numeric counter.
 */
export async function checkWebhookRateLimit(
  kv: KVNamespace | undefined,
  provider: string,
  ip: string,
): Promise<WebhookRateLimitResult> {
  if (!kv) return { allowed: true };

  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowIndex = Math.floor(nowSeconds / WEBHOOK_RATE_LIMIT_WINDOW_SECONDS);
  const key = `webhook:rl:${provider}:${ip}:${windowIndex}`;

  try {
    const current = await kv.get(key);
    const count = current !== null ? Number(current) : 0;
    if (!Number.isFinite(count) || count < 0) return { allowed: true };

    if (count >= WEBHOOK_RATE_LIMIT_MAX_REQUESTS) {
      return {
        allowed: false,
        retryAfterSeconds: WEBHOOK_RATE_LIMIT_WINDOW_SECONDS - (nowSeconds % WEBHOOK_RATE_LIMIT_WINDOW_SECONDS),
      };
    }

    await kv.put(key, String(count + 1), {
      expirationTtl: WEBHOOK_RATE_LIMIT_WINDOW_SECONDS * 2,
    });
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}

/**
 * Middleware for one carrier's delivery route.
 *
 * The Yalidine CRC challenge (GET) is deliberately exempt: the carrier disables
 * a webhook automatically after repeated failures, so a rate-limit false
 * positive on that endpoint costs the merchant their whole delivery feed. It
 * is also cheap — it echoes a token and touches no database.
 */
export function webhookRateLimit(provider: string) {
  return async (c: Context<AppContext>, next: Next) => {
    if (c.req.method !== "POST") return next();

    const result = await checkWebhookRateLimit(
      c.env.RATE_LIMIT,
      provider,
      webhookClientIp(c),
    );

    if (result.allowed) return next();

    c.header("Retry-After", String(result.retryAfterSeconds));
    return c.json(
      {
        error: "Webhook rate limit exceeded",
        code: "WEBHOOK_RATE_LIMITED",
        category: "SYSTEM",
        retryAfterSeconds: result.retryAfterSeconds,
      },
      429,
    );
  };
}