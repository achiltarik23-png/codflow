/**
 * WhatsApp Widget — storage access.
 *
 * One function, and it exists for one rule: the default config is stored as
 * NULL, never as an equivalent blob. That keeps "never configured" and
 * "configured back to nothing" the same row state, and makes the documented
 * rollback (`UPDATE stores SET whatsapp_widget_json = NULL`) the same thing a
 * merchant can do from the dashboard.
 *
 * There is deliberately no read function here. The storefront already selects
 * the store projection in `getStoreConfig`, and the dashboard already looks
 * the store up by `getStore` — a read helper would add a query to one of them
 * to avoid a `parse` call in the other.
 */

import { eq } from "drizzle-orm";
import { stores } from "../db/schema";
import type { AppDb } from "../db/client";
import {
  isDefaultWhatsAppWidgetConfig,
  serializeWhatsAppWidgetConfig,
  type WhatsAppWidgetConfig,
} from "../whatsapp-widget/config";

export async function saveWhatsAppWidgetConfig(
  db: AppDb,
  storeId: string,
  config: WhatsAppWidgetConfig,
): Promise<WhatsAppWidgetConfig> {
  await db
    .update(stores)
    .set({
      whatsappWidgetJson: isDefaultWhatsAppWidgetConfig(config)
        ? null
        : serializeWhatsAppWidgetConfig(config),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(stores.id, storeId))
    .run();

  return config;
}
