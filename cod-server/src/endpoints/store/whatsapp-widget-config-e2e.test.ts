/**
 * GET /store/config — the `whatsapp` projection, real-D1 E2E through the real
 * storefront router.
 *
 * Two claims are defended here, and both are the kind that fail silently:
 *
 *   1. Internal columns never leave the server. `getStoreConfig` uses an
 *      explicit storefront projection and resolves internal JSON columns before
 *      returning the payload.
 *   2. The widget costs no extra query. That is the reason the config lives on
 *      `stores` instead of its own table, and an architectural decision nobody
 *      can measure is one the next change quietly undoes. The statement count
 *      below is a ratchet: it may come down, never up without a reason.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppContext } from "@/types";
import { errorHandler } from "@/middleware/error";
import { openApiValidationHook } from "@/openapi/validation-hook";
import { createTestD1, type TestD1 } from "@/test-utils/d1";
import * as schema from "@/db/schema";
import storeRouter from "./routes";
import {
  DEFAULT_WHATSAPP_WIDGET_CONFIG,
  serializeWhatsAppWidgetConfig,
  type WhatsAppWidgetConfig,
} from "../../../../cod-shared/whatsapp-widget/config";

let harness: TestD1;
let app: OpenAPIHono<AppContext>;
let sqlLog: string[] = [];
const NOW = () => new Date().toISOString();
const STORE_ID = "store-wa-config";

/**
 * Wraps the D1 binding so every prepared statement is recorded. Drizzle
 * prepares each statement it sends, so this sees the full traffic without
 * changing any behaviour. Same technique as checkout-query-budget.e2e.test.ts.
 */
function recordingD1(d1: D1Database, log: string[]): D1Database {
  return new Proxy(d1, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "prepare") {
        return (query: string) => {
          log.push(query);
          return (value as D1Database["prepare"]).call(target, query);
        };
      }
      return typeof value === "function" ? (value as Function).bind(target) : value;
    },
  }) as D1Database;
}

beforeAll(async () => {
  harness = await createTestD1();

  app = new OpenAPIHono<AppContext>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    c.env = { DB: recordingD1(harness.raw, sqlLog) } as never;
    c.set("storeId", STORE_ID);
    await next();
  });
  app.onError(errorHandler);
  app.route("/store", storeRouter);
}, 120_000);

afterAll(async () => {
  await harness?.dispose();
});

beforeEach(async () => {
  await harness.db.delete(schema.stores);
  await harness.db.insert(schema.stores).values({
    id: STORE_ID,
    name: "متجر الاختبار",
    lang: "ar",
    createdAt: NOW(),
    updatedAt: NOW(),
  });
  sqlLog = [];
});

async function store(config: Partial<WhatsAppWidgetConfig>) {
  await harness.db
    .update(schema.stores)
    .set({
      whatsappWidgetJson: serializeWhatsAppWidgetConfig({
        ...DEFAULT_WHATSAPP_WIDGET_CONFIG,
        ...config,
        surfaces: { ...DEFAULT_WHATSAPP_WIDGET_CONFIG.surfaces, ...(config.surfaces ?? {}) },
      }),
    })
    .where(eq(schema.stores.id, STORE_ID));
}

async function config() {
  const res = await app.request("/store/config");
  const json = (await res.json()) as any;
  return { status: res.status, data: json.data };
}

const ON = { enabled: true, phone: "+213551234567" };

describe("GET /store/config — whatsapp", () => {
  it("is null for a store that never configured a widget", async () => {
    const { status, data } = await config();
    expect(status).toBe(200);
    expect(data.whatsapp).toBeNull();
  });

  it("carries the resolved widget once it is on", async () => {
    await store({ ...ON, agentName: "أمين", caption: "نرد خلال دقائق", position: "left" });

    const { data } = await config();

    expect(data.whatsapp).toMatchObject({
      href: "https://wa.me/213551234567",
      agentName: "أمين",
      caption: "نرد خلال دقائق",
      position: "left",
    });
  });

  it("is null while the widget is off, however complete the rest is", async () => {
    await store({ ...ON, enabled: false, agentName: "أمين" });
    expect((await config()).data.whatsapp).toBeNull();
  });

  it("is null when the stored number stopped being reachable", async () => {
    await store({ ...ON, phone: "0211234567" });
    expect((await config()).data.whatsapp).toBeNull();
  });

  it("keeps serving the storefront when the column holds nonsense", async () => {
    await harness.db
      .update(schema.stores)
      .set({ whatsappWidgetJson: "{ not json" })
      .where(eq(schema.stores.id, STORE_ID));

    const { status, data } = await config();

    expect(status).toBe(200);
    expect(data.whatsapp).toBeNull();
    expect(data.name).toBe("متجر الاختبار");
  });

  it("carries the surface map, so the theme never re-derives placement", async () => {
    await store({ ...ON, surfaces: { checkout: true, home: false } as never });

    const { data } = await config();

    expect(data.whatsapp.surfaces).toEqual({
      home: false,
      catalog: true,
      product: true,
      pages: true,
      thankYou: true,
      checkout: true,
      landing: false,
    });
  });
});

describe("the raw column never leaves the server", () => {
  it("is absent from the payload, configured or not", async () => {
    expect((await config()).data).not.toHaveProperty("whatsappWidgetJson");
    expect((await config()).data).not.toHaveProperty("storeApiKey");
    expect((await config()).data).not.toHaveProperty("store_api_key");

    await store({ ...ON, agentName: "أمين" });

    const { data } = await config();
    expect(data).not.toHaveProperty("whatsappWidgetJson");
    expect(data).not.toHaveProperty("whatsapp_widget_json");
    // The number itself is not public either — only the link built from it.
    expect(JSON.stringify(data)).not.toContain("+213551234567");
  });
});

describe("the widget costs no extra query", () => {
  it("reads `stores` exactly once, configured or not", async () => {
    await config();
    const withoutWidget = sqlLog.filter((sql) => /\bfrom\s+"?stores"?/i.test(sql)).length;

    await store(ON);
    sqlLog = [];
    await config();
    const withWidget = sqlLog.filter((sql) => /\bfrom\s+"?stores"?/i.test(sql)).length;

    expect(withoutWidget).toBe(1);
    // The whole argument for storing this on `stores` rather than in its own
    // table: the row is already being read, so the widget is free.
    expect(withWidget).toBe(withoutWidget);
  });

  it("never reads from a widget table, because there isn't one", async () => {
    await store(ON);
    sqlLog = [];
    await config();

    // The widget is part of the explicit stores projection. What must never
    // appear is a table of its own.
    const readsAWidgetTable = sqlLog.some((sql) =>
      /\b(from|join)\s+"?[a-z_]*whatsapp[a-z_]*"?/i.test(sql),
    );
    expect(readsAWidgetTable).toBe(false);
  });
});
