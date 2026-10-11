/**
 * Store Authentication Middleware
 *
 * Validates the X-Store-API-Key header by comparing a SHA-256 hash
 * of the provided key against the stored hash in store_api_keys.
 */

import { Context, Next } from "hono";
import type { AppContext } from "@/types";
import { getDb } from "@/db";
import { storeApiKeys } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashStoreApiKey } from "../../../cod-shared/lib/store-api-key";

export async function storeAuthMiddleware(c: Context<AppContext>, next: Next) {
  const rawKey = c.req.header("X-Store-API-Key");
  if (!rawKey) {
    return c.json({ error: "Missing store API key" }, 401);
  }

  try {
    const db = getDb(c.env.DB);
    const keyHash = await hashStoreApiKey(rawKey);

    const record = await db
      .select()
      .from(storeApiKeys)
      .where(eq(storeApiKeys.keyHash, keyHash))
      .get();

    if (!record) {
      return c.json({ error: "Invalid store API key" }, 401);
    }

    c.set("storeId", record.storeId);

    // Update lastUsedAt fire-and-forget (non-critical)
    db.update(storeApiKeys)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(storeApiKeys.id, record.id))
      .run()
      .catch(() => {});

    await next();
  } catch (err) {
    console.error("[storeAuth]", err);
    return c.json({ error: "Authentication failed" }, 500);
  }
}
