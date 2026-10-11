export async function hashStoreApiKey(rawKey: string): Promise<string> {
  const data = new TextEncoder().encode(rawKey);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function generateStoreApiKey(): string {
  return `sk_store_${crypto.randomUUID().replace(/-/g, "")}`;
}
