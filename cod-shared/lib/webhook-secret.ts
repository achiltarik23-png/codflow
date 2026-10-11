/**
 * Webhook secret envelope — encryption at rest for carrier HMAC keys.
 *
 * ## Why encryption and not hashing
 *
 * The storefront API key (a bearer token) is compared by hash, so it never
 * needs its original value. A webhook secret cannot work that way: it is the
 * KEY of an HMAC, and verifying a delivery means recomputing
 * `HMAC(body, secret)`. A hash cannot reproduce those bytes. Encryption is the
 * only option that keeps verification possible.
 *
 * ## Format
 *
 *   enc:v1:<base64 iv>:<base64 ciphertext+tag>
 *
 * The prefix makes the scheme self-describing, which is what lets `open` keep
 * reading rows written before this existed: anything without the prefix is
 * returned untouched. No migration, no backfill, no column change — a secret
 * is upgraded the next time it is written.
 *
 * ## Algorithm
 *
 * AES-256-GCM via WebCrypto. The 12-byte IV is random per seal and stored
 * alongside the ciphertext; GCM authenticates, so a tampered row fails to
 * open rather than decrypting to garbage.
 */

const PREFIX = "enc:v1";
const IV_BYTES = 12;

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

/** 32 bytes, hex-encoded, exactly as stored in the Worker secret. */
function keyBytesFromHex(hex: string): Uint8Array {
  const clean = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(
      "WEBHOOK_ENCRYPTION_KEY must be 32 bytes hex-encoded (64 characters)",
    );
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** True when the stored value is already an encrypted envelope. */
export function isEncryptedWebhookSecret(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(`${PREFIX}:`);
}

/**
 * Encrypt a webhook secret. Returns an `enc:v1:…` envelope.
 *
 * Throws when the key is missing or malformed — storing plaintext while
 * believing it is sealed would be the worst outcome, so this fails loudly
 * rather than degrading.
 */
export async function sealWebhookSecret(plain: string, encryptionKeyHex: string): Promise<string> {
  if (!encryptionKeyHex) {
    throw new Error(
      "WEBHOOK_ENCRYPTION_KEY is not set — refusing to store a webhook secret unsealed",
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytesFromHex(encryptionKeyHex),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plain),
    ),
  );
  return `${PREFIX}:${encodeBase64(iv)}:${encodeBase64(ciphertext)}`;
}

/**
 * Decrypt an `enc:v1:…` envelope back to the raw secret.
 *
 * A value without the prefix is returned as-is: rows written before this
 * existed are still clear text in D1, and failing them closed would break
 * every carrier until each merchant re-saved its secret. Those rows upgrade on
 * their next write.
 */
export async function openWebhookSecret(
  stored: string | null | undefined,
  encryptionKeyHex: string,
): Promise<string | null> {
  if (!stored) return null;
  if (!isEncryptedWebhookSecret(stored)) return stored;

  if (!encryptionKeyHex) {
    throw new Error(
      "WEBHOOK_ENCRYPTION_KEY is not set — cannot open an encrypted webhook secret",
    );
  }
  // `enc:v1:<iv>:<ciphertext>` splits into four segments: "enc", "v1", iv, ct.
  const [, , ivPart, ciphertextPart] = stored.split(":");
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytesFromHex(encryptionKeyHex),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64(ivPart) },
    key,
    decodeBase64(ciphertextPart),
  );
  return new TextDecoder().decode(plain);
}