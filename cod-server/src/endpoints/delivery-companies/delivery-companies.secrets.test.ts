/**
 * Delivery Companies — credentials never leave the API
 *
 * Regression guard for the delivery-companies responses.
 *
 * `sanitize()` in cod-shared/queries/delivery-companies.ts strips credentials
 * before a company record is returned. It handled apiToken and apiUserGuid but
 * not webhookSecret, so `GET /api/delivery-companies`,
 * `GET /api/delivery-companies/:id`, `POST` and `PATCH` all returned the
 * carrier's HMAC key in clear text to anyone holding `delivery:read` — a staff
 * role, not necessarily an admin.
 *
 * Possession of that key is enough to forge a delivery event: choose a tracking
 * number, choose a status, and the forged "delivered" verifies as signed.
 *
 * Runs against real D1 (createTestD1) because the leak lived in a projection,
 * and a mocked db proves nothing about what a projection emits.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1, type TestD1 } from "@/test-utils/d1";
import * as schema from "@/db/schema";
import {
  getAllDeliveryCompanies,
  getDeliveryCompanyByCode,
  getDeliveryCompanyById,
} from "../../../../cod-shared/queries/delivery-companies";

let harness: TestD1;

const API_TOKEN = "tok-super-secret-api-token";
const USER_GUID = "guid-super-secret";
const WEBHOOK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

async function seedCompany(id: string, code: string, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  await harness.db.insert(schema.deliveryCompanies).values({
    id,
    name: `Carrier ${code}`,
    nameAr: `ناقل ${code}`,
    code,
    active: true,
    apiToken: API_TOKEN,
    apiUserGuid: USER_GUID,
    webhookSecret: WEBHOOK_SECRET,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as typeof schema.deliveryCompanies.$inferInsert);
  return id;
}

beforeAll(async () => {
  harness = await createTestD1();
}, 120_000);

afterAll(async () => {
  await harness?.dispose();
});

beforeEach(async () => {
  await harness.db.delete(schema.deliveryCompanies);
});

/** Every property name that must not survive into an API response. */
const SECRET_FIELDS = ["apiToken", "apiUserGuid", "webhookSecret"];

function expectNoSecrets(record: Record<string, unknown> | null | undefined) {
  expect(record).not.toBeNull();
  for (const field of SECRET_FIELDS) {
    expect(record).not.toHaveProperty(field);
  }
  // Belt and braces: the literal values must appear nowhere in the payload.
  const serialised = JSON.stringify(record);
  expect(serialised).not.toContain(API_TOKEN);
  expect(serialised).not.toContain(USER_GUID);
  expect(serialised).not.toContain(WEBHOOK_SECRET);
  expect(serialised).not.toContain("whsec_");
}

describe("delivery company credentials never leave the API", () => {
  it("GET /:id returns booleans, not the credentials", async () => {
    const id = await seedCompany("comp-secrets-1", "yalidine");

    const company = await getDeliveryCompanyById(harness.db, id);

    expectNoSecrets(company as unknown as Record<string, unknown>);
    expect(company?.isConnected).toBe(true);
    expect(company?.hasWebhookSecret).toBe(true);
  });

  it("GET / list returns booleans, not the credentials", async () => {
    await seedCompany("comp-secrets-2", "yalidine");
    await seedCompany("comp-secrets-3", "zr_express");

    const companies = await getAllDeliveryCompanies(harness.db);

    expect(companies).toHaveLength(2);
    for (const company of companies) {
      expectNoSecrets(company as unknown as Record<string, unknown>);
      expect(company.isConnected).toBe(true);
      expect(company.hasWebhookSecret).toBe(true);
    }
  });

  it("reports the missing credential as false rather than leaking null-vs-set", async () => {
    const id = await seedCompany("comp-secrets-4", "yalidine", {
      apiToken: null,
      apiUserGuid: null,
      webhookSecret: null,
    });

    const company = await getDeliveryCompanyById(harness.db, id);

    expectNoSecrets(company as unknown as Record<string, unknown>);
    expect(company?.isConnected).toBe(false);
    expect(company?.hasWebhookSecret).toBe(false);
  });

  it("keeps the webhook status mapping readable — it is configuration, not a credential", async () => {
    const id = await seedCompany("comp-secrets-5", "zr_express", {
      webhookStatusMapping: JSON.stringify({ delivered: ["Livré"] }),
    });

    const company = await getDeliveryCompanyById(harness.db, id);

    expectNoSecrets(company as unknown as Record<string, unknown>);
    expect(company?.webhookStatusMapping).toBe('{"delivered":["Livré"]}');
  });

  /**
   * getDeliveryCompanyByCode is the raw accessor used by the webhook handlers,
   * which need the real key to recompute an HMAC. It must stay unsanitised —
   * and it must stay internal. This test pins that it is the ONLY accessor
   * carrying the secret, so a future "just return the company" route is visible.
   */
  it("getDeliveryCompanyByCode is the raw internal accessor", async () => {
    await seedCompany("comp-secrets-6", "yalidine");

    const raw = await getDeliveryCompanyByCode(harness.db, "yalidine");

    expect(raw?.webhookSecret).toBe(WEBHOOK_SECRET);
  });
});