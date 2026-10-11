/**
 * CORS Middleware Tests
 *
 * The contract these tests defend: an `Access-Control-Allow-Origin` header is
 * emitted ONLY for an origin listed in `ALLOWED_ORIGINS`. Every other case —
 * unlisted origin, missing setting, wildcard setting, `Origin: null` — must
 * produce a response with no CORS headers at all.
 *
 * The previous suite asserted the opposite: it locked in origin reflection when
 * `ALLOWED_ORIGINS` was absent, under a test name that claimed it expected a
 * wildcard. That made the fail-open path impossible to remove by accident.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { corsMiddleware } from "./cors";
import type { AppContext } from "@/types/app";

function buildApp(env: Record<string, unknown>) {
  const app = new Hono<AppContext>();
  app.use("*", async (c, next) => {
    c.env = env as any;
    await next();
  });
  app.use("*", corsMiddleware);
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

const PRODUCTION = {
  ENVIRONMENT: "production",
  ALLOWED_ORIGINS: "https://app.example.com,https://store.example.com",
};

describe("CORS Middleware", () => {
  let app: Hono<AppContext>;

  beforeEach(() => {
    app = buildApp(PRODUCTION);
  });

  describe("listed origins", () => {
    it("echoes a whitelisted origin with credentials", async () => {
      const res = await app.request("/test", {
        headers: { origin: "https://app.example.com" },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
      expect(res.headers.get("Vary")).toBe("Origin");
    });

    it("accepts every entry of a multi-origin list", async () => {
      const res = await app.request("/test", {
        headers: { origin: "https://store.example.com" },
      });

      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://store.example.com");
    });

    it("matches a configured origin written with a trailing slash", async () => {
      const withSlash = buildApp({ ...PRODUCTION, ALLOWED_ORIGINS: "https://app.example.com/" });

      const res = await withSlash.request("/test", {
        headers: { origin: "https://app.example.com" },
      });

      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
    });

    it("keeps Authorization and the API key headers allowed for preflight", async () => {
      const res = await app.request("/test", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
          "Access-Control-Request-Method": "POST",
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
      expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Store-API-Key");
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    });
  });

  describe("unlisted origins get no CORS headers", () => {
    it("sends nothing to an unknown origin — never the first listed one", async () => {
      const res = await app.request("/test", {
        headers: { origin: "https://evil.com" },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    });

    it("sends nothing to the literal null origin", async () => {
      const res = await app.request("/test", {
        headers: { origin: "null" },
      });

      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("sends nothing when the request carries no Origin header", async () => {
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("does not let a prefix of a listed origin through", async () => {
      const res = await app.request("/test", {
        headers: { origin: "https://app.example.com.evil.com" },
      });

      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });

  describe("a broken allow-list denies everything", () => {
    it("denies when production has no ALLOWED_ORIGINS", async () => {
      const unset = buildApp({ ENVIRONMENT: "production" });

      const res = await unset.request("/test", {
        headers: { origin: "https://app.example.com" },
      });

      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("denies when ALLOWED_ORIGINS is a literal wildcard", async () => {
      const wildcard = buildApp({ ENVIRONMENT: "production", ALLOWED_ORIGINS: "*" });

      const res = await wildcard.request("/test", {
        headers: { origin: "https://evil.com" },
      });

      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    });

    it("denies when ALLOWED_ORIGINS holds only separators and spaces", async () => {
      const blank = buildApp({ ENVIRONMENT: "production", ALLOWED_ORIGINS: " , " });

      const res = await blank.request("/test", {
        headers: { origin: "https://app.example.com" },
      });

      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("ignores ENVIRONMENT entirely — an unknown value is not a bypass", async () => {
      // The old middleware opened up for anything that was not exactly
      // "production", so a typo in one deploy silently granted every origin.
      const typo = buildApp({
        ENVIRONMENT: "PRODUCTION",
        ALLOWED_ORIGINS: "https://app.example.com",
      });

      const allowed = await typo.request("/test", {
        headers: { origin: "https://app.example.com" },
      });
      expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");

      const denied = await typo.request("/test", {
        headers: { origin: "https://evil.com" },
      });
      expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("still serves development with an explicit list", async () => {
      const dev = buildApp({
        ENVIRONMENT: "development",
        ALLOWED_ORIGINS: "http://localhost:4321",
      });

      const allowed = await dev.request("/test", {
        headers: { origin: "http://localhost:4321" },
      });
      expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4321");

      const denied = await dev.request("/test", {
        headers: { origin: "http://localhost:9999" },
      });
      expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });

  describe("preflight", () => {
    it("refuses an unauthorised origin with 403 and no CORS headers", async () => {
      const res = await app.request("/test", {
        method: "OPTIONS",
        headers: {
          origin: "https://evil.com",
          "Access-Control-Request-Method": "POST",
        },
      });

      expect(res.status).toBe(403);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("refuses a preflight that carries no Origin header", async () => {
      const res = await app.request("/test", {
        method: "OPTIONS",
        headers: { "Access-Control-Request-Method": "POST" },
      });

      expect(res.status).toBe(403);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });

  describe("response hygiene", () => {
    it("never exposes API key headers to the browser", async () => {
      const res = await app.request("/test", {
        headers: { origin: "https://app.example.com" },
      });

      const exposed = res.headers.get("Access-Control-Expose-Headers") ?? "";
      expect(exposed).not.toContain("X-API-Key");
      expect(exposed).not.toContain("X-Store-API-Key");
    });

    it("does not duplicate the allow-origin header", async () => {
      const res = await app.request("/test", {
        headers: { origin: "https://app.example.com" },
      });

      const occurrences = [...res.headers.keys()].filter(
        (k) => k === "access-control-allow-origin",
      );
      expect(occurrences).toHaveLength(1);
    });
  });

  describe("Raw Response handlers (streamed bodies)", () => {
    beforeEach(() => {
      app = buildApp(PRODUCTION);
    });

    // Regression: handlers returning a raw `new Response(...)` (label PDF
    // proxy, R2 image streaming) bypass Hono's prepared-header application,
    // so headers set before next() never reached them and the browser
    // blocked the response with a CORS error despite the 200.
    it("adds CORS headers to a raw Response for a listed origin", async () => {
      app.get("/raw", () =>
        new Response("raw-body", {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      );

      const res = await app.request("/raw", {
        headers: { origin: "https://app.example.com" },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    });

    it("adds no CORS headers to a raw Response for an unlisted origin", async () => {
      app.get("/raw", () => new Response("raw-body", { status: 200 }));

      const res = await app.request("/raw", {
        headers: { origin: "https://evil.com" },
      });

      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });
});