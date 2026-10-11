/**
 * Webhook ingress rate limit — guard behaviour.
 *
 * The properties that matter operationally are the fail-open ones: a KV outage
 * must never strand a parcel. The threshold itself is an arbitrary value with
 * no telemetry behind it (see webhook-rate-limit.ts), so these tests pin the
 * contract around it, not the number's merit.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import {
  WEBHOOK_RATE_LIMIT_MAX_REQUESTS,
  WEBHOOK_RATE_LIMIT_WINDOW_SECONDS,
  checkWebhookRateLimit,
  webhookClientIp,
  webhookRateLimit,
} from "./webhook-rate-limit";
import type { AppContext } from "@/types/app";

/** In-memory stand-in for the KV namespace. */
function kvStub(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    kv: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
    } as unknown as KVNamespace,
  };
}

function appWith(kv: KVNamespace | undefined, path = "/webhooks/zr_express") {
  const app = new Hono<AppContext>();
  app.use("*", async (c, next) => {
    c.env = { RATE_LIMIT: kv } as any;
    await next();
  });
  app.use(path, webhookRateLimit("zr_express"));
  app.post(path, (c) => c.json({ received: true }));
  app.get(path, (c) => c.text("challenge"));
  return app;
}

describe("webhook rate limit", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("client identity", () => {
    const ctx = (headers: Record<string, string>) =>
      ({ req: { header: (n: string) => headers[n] } }) as any;

    it("prefers the platform header", () => {
      expect(webhookClientIp(ctx({ "CF-Connecting-IP": "41.100.1.1" }))).toBe("41.100.1.1");
    });

    it("falls back to the first X-Forwarded-For entry", () => {
      expect(
        webhookClientIp(ctx({ "X-Forwarded-For": "9.9.9.9, 10.0.0.1" })),
      ).toBe("9.9.9.9");
    });

    it("falls back to a shared bucket rather than refusing or disabling", () => {
      expect(webhookClientIp(ctx({}))).toBe("no-ip");
    });

    it("ignores an empty header rather than bucketing on it", () => {
      expect(webhookClientIp(ctx({ "CF-Connecting-IP": "   " }))).toBe("no-ip");
    });
  });

  describe("counter", () => {
    it("allows while under the budget and increments", async () => {
      const { kv, store } = kvStub();
      const key = `webhook:rl:zr_express:41.1.1.1:${
        Math.floor(Date.now() / 1000 / WEBHOOK_RATE_LIMIT_WINDOW_SECONDS)
      }`;

      await expect(checkWebhookRateLimit(kv, "zr_express", "41.1.1.1")).resolves.toEqual({
        allowed: true,
      });
      expect(store.get(key)).toBe("1");
    });

    it("allows again once the window rolls over", async () => {
      const previousWindow = Math.floor(Date.now() / 1000 / WEBHOOK_RATE_LIMIT_WINDOW_SECONDS) - 1;
      const { kv } = kvStub({
        [`webhook:rl:zr_express:41.1.1.1:${previousWindow}`]:
          String(WEBHOOK_RATE_LIMIT_MAX_REQUESTS),
      });

      await expect(checkWebhookRateLimit(kv, "zr_express", "41.1.1.1")).resolves.toEqual({
        allowed: true,
      });
    });

    it("blocks once the budget is spent, with a retry hint", async () => {
      const { kv } = kvStub();
      for (let i = 0; i < WEBHOOK_RATE_LIMIT_MAX_REQUESTS; i++) {
        await checkWebhookRateLimit(kv, "zr_express", "41.1.1.1");
      }

      const result = await checkWebhookRateLimit(kv, "zr_express", "41.1.1.1");

      expect(result.allowed).toBe(false);
      expect(result.allowed === false && result.retryAfterSeconds).toBeGreaterThan(0);
      expect(result.allowed === false && result.retryAfterSeconds).toBeLessThanOrEqual(
        WEBHOOK_RATE_LIMIT_WINDOW_SECONDS,
      );
    });

    it("keeps carriers in separate budgets", async () => {
      const { kv } = kvStub();
      for (let i = 0; i < WEBHOOK_RATE_LIMIT_MAX_REQUESTS; i++) {
        await checkWebhookRateLimit(kv, "zr_express", "41.1.1.1");
      }

      await expect(checkWebhookRateLimit(kv, "zr_express", "41.1.1.1")).resolves.toMatchObject({
        allowed: false,
      });
      await expect(checkWebhookRateLimit(kv, "yalidine", "41.1.1.1")).resolves.toEqual({
        allowed: true,
      });
    });
  });

  describe("fail-open paths", () => {
    it("allows everything when the KV binding is absent", async () => {
      await expect(checkWebhookRateLimit(undefined, "zr_express", "41.1.1.1")).resolves.toEqual({
        allowed: true,
      });
    });

    it("allows when KV throws", async () => {
      const kv = {
        get: vi.fn(async () => {
          throw new Error("KV down");
        }),
      } as unknown as KVNamespace;

      await expect(checkWebhookRateLimit(kv, "zr_express", "41.1.1.1")).resolves.toEqual({
        allowed: true,
      });
    });

    it("allows when the stored counter is not a number", async () => {
      const { kv } = kvStub();
      await kv.put("webhook:rl:zr_express:41.1.1.1:x", "not-a-number");

      await expect(
        checkWebhookRateLimit(kv, "zr_express", "41.1.1.1"),
      ).resolves.toEqual({ allowed: true });
    });

    it("serves the request normally when the binding is missing", async () => {
      const res = await appWith(undefined).request("/webhooks/zr_express", { method: "POST" });

      expect(res.status).toBe(200);
    });
  });

  describe("middleware", () => {
    it("answers 429 with Retry-After once the budget is gone", async () => {
      const { kv } = kvStub();
      const app = appWith(kv);
      const headers = { "CF-Connecting-IP": "41.1.1.1" };

      for (let i = 0; i < WEBHOOK_RATE_LIMIT_MAX_REQUESTS; i++) {
        await app.request("/webhooks/zr_express", { method: "POST", headers });
      }
      const res = await app.request("/webhooks/zr_express", { method: "POST", headers });

      expect(res.status).toBe(429);
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(await res.json()).toMatchObject({
        code: "WEBHOOK_RATE_LIMITED",
        error: "Webhook rate limit exceeded",
      });
    });

    it("does not rate-limit the Yalidine CRC challenge — a false positive there auto-disables the webhook", async () => {
      const { kv } = kvStub();
      const app = appWith(kv, "/webhooks/yalidine");
      const headers = { "CF-Connecting-IP": "41.1.1.1" };

      // Exhaust the POST budget first.
      for (let i = 0; i < WEBHOOK_RATE_LIMIT_MAX_REQUESTS; i++) {
        await app.request("/webhooks/yalidine", { method: "POST", headers });
      }
      expect((await app.request("/webhooks/yalidine", { method: "POST", headers })).status).toBe(429);

      // The GET challenge must still answer.
      const challenge = await app.request("/webhooks/yalidine", { method: "GET", headers });
      expect(challenge.status).toBe(200);
    });

    it("does not consume budget on a rejected preflight", async () => {
      const { kv, store } = kvStub();
      const app = appWith(kv);

      await app.request("/webhooks/zr_express", {
        method: "OPTIONS",
        headers: { "CF-Connecting-IP": "41.1.1.1" },
      });

      expect(store.size).toBe(0);
    });
  });
});