import type { Context } from "hono";
import type { AppContext } from "@/types";

export function publicImageUrl(c: Context<AppContext>, key: string): string {
  const mediaDomain = c.env.MEDIA_DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (mediaDomain) return `https://${mediaDomain}/${key}`;
  return `${new URL(c.req.url).origin}/images/${key}`;
}
