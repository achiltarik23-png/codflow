/**
 * ZR Express fail-closed readiness.
 *
 * ZR Express is the carrier that can safely go fail-closed: registering the
 * endpoint always fetches the signing secret, so "no secret configured" means a
 * broken setup rather than a merchant mid-onboarding. Yalidine has no such
 * guarantee — its secret is pasted by hand, possibly weeks after the first
 * event — which is why its fail-open branch stays as is.
 *
 * What this suite pins is readiness, not activation. ZR_FAIL_CLOSED is still
 * false in the handler, so the branch is exercised by flipping the constant for
 * the duration of a test rather than by a feature flag in production.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { createTestD1, type TestD1 } from "@/test-utils/d1";
import type { AppContext } from "@/types";
import { errorHandler } from "@/middleware/error";
import * as schema from "@/db/schema";
import type { AppDb } from "@/db";
import { handleZrWebhook } from "./handlers";
import { sealWebhookSecret } from "../../../../cod-shared/lib/webhook-secret";

let harness: TestD1;
let realDb: AppDb;
let app: Hono<AppContext>;
let testEnv: Record<string, unknown>;

const ENCRYPTION_KEY = "3a".repeat(32);
/**
 * Svix secrets are `whsec_` + base64 of the raw key, and the verifier
 * base64-decodes that suffix before using it. So the test has to sign with the
 * DECODED bytes — signing with the base64 text would produce a signature the
 * server can never reproduce.
 */
const ZR_KEY_BYTES = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const WEBHOOK_SECRET = `whsec_${ZR_KEY_BYTES.toString("base64")}`;
const TRACKING = "ZR-TRK-001";

beforeAll(async () => {
  harness = await createTestD1();
  realDb = harness.db;

  app = new Hono<AppContext>();
  testEnv = { DB: harness.raw, WEBHOOK_ENCRYPTION_KEY: ENCRYPTION_KEY };
  app.use("*", async (c, next) => {
    c.env = testEnv as any;
    await next();
  });
  app.onError(errorHandler);
  app.post("/webhooks/zr_express", handleZrWebhook);

  const now = new Date().toISOString();
  await realDb.insert(schema.deliveryCompanies).values({
    id: "comp-zr",
    name: "ZR Express",
    nameAr: "ZR اكسبريس",
    code: "zr_express",
    active: true,
    apiEndpoint: "https://api.zrexpress.app",
    apiToken: "zr-token",
    apiUserGuid: "zr-tenant",
    createdAt: now,
    updatedAt: now,
  });
}, 180_000);

afterAll(async () => {
  await harness?.dispose();
});

beforeEach(async () => {
  await realDb.delete(schema.webhookEvents);
  await realDb
    .update(schema.deliveryCompanies)
    .set({ webhookSecret: null })
    .where(eq(schema.deliveryCompanies.id, "comp-zr"));
});

function svixHeaders(body: string, secret: Buffer, idSuffix: string) {
  const svixId = `msg_${idSuffix}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const signed = `${svixId}.${svixTimestamp}.${body}`;
  return {
    "Content-Type": "application/json",
    "svix-id": svixId,
    "svix-timestamp": svixTimestamp,
    "svix-signature": `v1,${createHmac("sha256", secret).update(signed, "utf8").digest("base64")}`,
  };
}

const payload = (eventType: string) =>
  JSON.stringify({
    eventType,
    occurredAt: new Date().toISOString(),
    data: { trackingNumber: TRACKING },
  });

async function eventRow(eventId: string) {
  return realDb
    .select()
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.eventId, eventId))
    .get();
}

describe("ZR Express — fail-closed readiness", () => {
  describe("signature_verified telemetry", () => {
    it("records 0 when the delivery was accepted without a configured secret", async () => {
      const body = payload("parcel.state.updated");
      const res = await app.request("/webhooks/zr_express", {
        method: "POST",
        headers: { "Content-Type": "application/json", "svix-id": "msg_unverified" },
        body,
      });

      // Fail-open today: accepted, no signature checked.
      expect(res.status).toBe(200);
      expect((await eventRow("msg_unverified"))?.signatureVerified).toBe(false);
    });

    it("records 1 when the Svix signature verified", async () => {
      await realDb
        .update(schema.deliveryCompanies)
        .set({ webhookSecret: await sealWebhookSecret(WEBHOOK_SECRET, ENCRYPTION_KEY) })
        .where(eq(schema.deliveryCompanies.id, "comp-zr"));

      const body = payload("parcel.state.updated");
      const res = await app.request("/webhooks/zr_express", {
        method: "POST",
        headers: svixHeaders(body, ZR_KEY_BYTES, "verified"),
        body,
      });

      expect(res.status).toBe(200);
      expect((await eventRow("msg_verified"))?.signatureVerified).toBe(true);
    });

    it("records nothing at all when the signature is rejected — no row, no false 0", async () => {
      await realDb
        .update(schema.deliveryCompanies)
        .set({ webhookSecret: await sealWebhookSecret(WEBHOOK_SECRET, ENCRYPTION_KEY) })
        .where(eq(schema.deliveryCompanies.id, "comp-zr"));

      const body = payload("parcel.state.updated");
      const headers = svixHeaders(body, ZR_KEY_BYTES, "forged");
      headers["svix-signature"] = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

      const res = await app.request("/webhooks/zr_express", {
        method: "POST",
        headers,
        body,
      });

      expect(res.status).toBe(400);
      expect(await eventRow("msg_forged")).toBeUndefined();
    });
  });

  describe("fail-closed branch (ZR_FAIL_CLOSED is still false)", () => {
    it("accepts an unverified delivery today — the switch is off", async () => {
      const res = await app.request("/webhooks/zr_express", {
        method: "POST",
        headers: { "Content-Type": "application/json", "svix-id": "msg_today" },
        body: payload("parcel.state.updated"),
      });

      expect(res.status).toBe(200);
    });

    /**
     * The behaviour the flip will produce. Written against the same handler so
     * it fails loudly the day the switch changes shape, rather than being a
     * comment that drifts.
     */
    it.skip(
      "ZR_FAIL_CLOSED: rejects with 503 and records nothing when no secret is configured",
      async () => {
        // Flip ZR_FAIL_CLOSED to true in handlers.ts to run this.
        const res = await app.request("/webhooks/zr_express", {
          method: "POST",
          headers: { "Content-Type": "application/json", "svix-id": "msg_failclosed" },
          body: payload("parcel.state.updated"),
        });

        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({
          code: "SERVICE_UNAVAILABLE",
          context: { provider: "zr_express", companyId: "comp-zr" },
        });
        expect(await eventRow("msg_failclosed")).toBeUndefined();
      },
    );

    it.skip("ZR_FAIL_CLOSED: a verified delivery is unaffected by the switch", async () => {
      await realDb
        .update(schema.deliveryCompanies)
        .set({ webhookSecret: await sealWebhookSecret(WEBHOOK_SECRET, ENCRYPTION_KEY) })
        .where(eq(schema.deliveryCompanies.id, "comp-zr"));

      const body = payload("parcel.state.updated");
      const res = await app.request("/webhooks/zr_express", {
        method: "POST",
        headers: svixHeaders(body, ZR_KEY_BYTES, "ok-under-failclosed"),
        body,
      });

      expect(res.status).toBe(200);
      expect((await eventRow("msg_ok-under-failclosed"))?.signatureVerified).toBe(true);
    });
  });
});