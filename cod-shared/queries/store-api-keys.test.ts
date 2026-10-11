import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestD1, type TestD1 } from "@/test-utils/d1";
import * as schema from "@/db/schema";
import { hashStoreApiKey } from "../lib/store-api-key";
import { hasStoreApiKey, rotateStoreApiKey } from "./store-api-keys";

let harness: TestD1;
const STORE_ID = "store-api-key-test";

beforeAll(async () => {
  harness = await createTestD1();
}, 120_000);

afterAll(async () => {
  await harness?.dispose();
});

beforeEach(async () => {
  await harness.db.delete(schema.storeApiKeys);
  await harness.db.delete(schema.stores);
  await harness.db.insert(schema.stores).values({
    id: STORE_ID,
    name: "Key Test Store",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

describe("storefront API key lifecycle", () => {
  it("stores only the hash and returns the raw key for the one-time handoff", async () => {
    const result = await rotateStoreApiKey(harness.db, STORE_ID);

    expect(result.apiKey).toMatch(/^sk_store_[0-9a-f]{32}$/);
    expect(await hasStoreApiKey(harness.db, STORE_ID)).toBe(true);

    const row = await harness.db
      .select({ keyHash: schema.storeApiKeys.keyHash })
      .from(schema.storeApiKeys)
      .where(eq(schema.storeApiKeys.storeId, STORE_ID))
      .get();

    expect(row).toEqual({ keyHash: await hashStoreApiKey(result.apiKey) });
    expect(row?.keyHash).not.toContain(result.apiKey);
  });

  it("invalidates the previous key when rotating", async () => {
    const previous = await rotateStoreApiKey(harness.db, STORE_ID);
    const next = await rotateStoreApiKey(harness.db, STORE_ID);

    expect(next.apiKey).not.toBe(previous.apiKey);
    expect(await harness.db.select().from(schema.storeApiKeys)).toHaveLength(1);
    expect(await hashStoreApiKey(previous.apiKey)).not.toBe(
      (await harness.db.select().from(schema.storeApiKeys).get())?.keyHash,
    );
  });
});
