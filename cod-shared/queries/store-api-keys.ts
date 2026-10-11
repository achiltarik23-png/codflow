import { eq } from "drizzle-orm";
import { storeApiKeys } from "../db/schema";
import type { AppDb } from "../db/client";
import { generateStoreApiKey, hashStoreApiKey } from "../lib/store-api-key";

export async function hasStoreApiKey(db: AppDb, storeId: string): Promise<boolean> {
  const row = await db
    .select({ id: storeApiKeys.id })
    .from(storeApiKeys)
    .where(eq(storeApiKeys.storeId, storeId))
    .get();

  return Boolean(row);
}

export async function rotateStoreApiKey(
  db: AppDb,
  storeId: string,
): Promise<{ apiKey: string }> {
  const apiKey = generateStoreApiKey();
  const keyHash = await hashStoreApiKey(apiKey);
  const now = new Date().toISOString();

  await db.batch([
    db.delete(storeApiKeys).where(eq(storeApiKeys.storeId, storeId)),
    db.insert(storeApiKeys).values({
      id: crypto.randomUUID(),
      storeId,
      keyHash,
      name: "default",
      createdAt: now,
    }),
  ]);

  return { apiKey };
}
