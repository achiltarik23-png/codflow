/**
 * Webhook secret envelope — round-trip tests
 *
 * The carrier signing secret is an HMAC KEY, so it must stay recoverable and
 * can only be protected by encryption. These tests pin the envelope contract
 * that the webhook handlers depend on:
 *
 *   - a sealed value is recognisable and decrypts back to the exact input
 *   - a legacy clear-text value still opens (rows written before encryption
 *     existed must keep working until each merchant re-saves their secret)
 *   - the key is authenticated: a wrong key fails rather than returning garbage
 *   - nothing here throws a secret into a message
 */

import { describe, it, expect } from "vitest";
import {
  isEncryptedWebhookSecret,
  openWebhookSecret,
  sealWebhookSecret,
} from "./webhook-secret";

/** 32 bytes hex — the shape WEBHOOK_ENCRYPTION_KEY must have. */
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

/** Shapes taken from the real carriers, never real values. */
const YALIDINE_SECRET = "yalidine-shared-secret-value";
const ZR_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

describe("webhook secret envelope", () => {
  describe("seal / open round-trip", () => {
    it("restores a ZR Svix secret exactly", async () => {
      const sealed = await sealWebhookSecret(ZR_SECRET, KEY_A);

      expect(isEncryptedWebhookSecret(sealed)).toBe(true);
      expect(sealed).not.toContain(ZR_SECRET);
      expect(sealed.startsWith("enc:v1:")).toBe(true);
      await expect(openWebhookSecret(sealed, KEY_A)).resolves.toBe(ZR_SECRET);
    });

    it("restores a Yalidine secret exactly", async () => {
      const sealed = await sealWebhookSecret(YALIDINE_SECRET, KEY_A);

      expect(sealed).not.toContain(YALIDINE_SECRET);
      await expect(openWebhookSecret(sealed, KEY_A)).resolves.toBe(YALIDINE_SECRET);
    });

    it("produces a different ciphertext each time — a fresh IV per seal", async () => {
      const first = await sealWebhookSecret(ZR_SECRET, KEY_A);
      const second = await sealWebhookSecret(ZR_SECRET, KEY_A);

      expect(first).not.toBe(second);
      await expect(openWebhookSecret(first, KEY_A)).resolves.toBe(ZR_SECRET);
      await expect(openWebhookSecret(second, KEY_A)).resolves.toBe(ZR_SECRET);
    });

    it("handles an empty string without producing an invalid envelope", async () => {
      const sealed = await sealWebhookSecret("", KEY_A);

      expect(isEncryptedWebhookSecret(sealed)).toBe(true);
      await expect(openWebhookSecret(sealed, KEY_A)).resolves.toBe("");
    });

    it("preserves non-ASCII secrets byte for byte", async () => {
      const secret = "clé-partagée-مفتاح-🔐";
      const sealed = await sealWebhookSecret(secret, KEY_A);

      await expect(openWebhookSecret(sealed, KEY_A)).resolves.toBe(secret);
    });
  });

  describe("legacy clear-text rows", () => {
    it("opens a value that was never sealed", async () => {
      expect(isEncryptedWebhookSecret(ZR_SECRET)).toBe(false);
      await expect(openWebhookSecret(ZR_SECRET, KEY_A)).resolves.toBe(ZR_SECRET);
    });

    it("opens a legacy value even when no key is configured", async () => {
      // A key that arrived after the row was written must not strand it.
      await expect(openWebhookSecret(YALIDINE_SECRET, "")).resolves.toBe(YALIDINE_SECRET);
    });

    it("returns null for an absent secret", async () => {
      await expect(openWebhookSecret(null, KEY_A)).resolves.toBeNull();
      await expect(openWebhookSecret(undefined, KEY_A)).resolves.toBeNull();
    });
  });

  describe("failure modes", () => {
    it("refuses to seal when the key is missing", async () => {
      await expect(sealWebhookSecret(ZR_SECRET, "")).rejects.toThrow(/WEBHOOK_ENCRYPTION_KEY/);
    });

    it("refuses a malformed key rather than storing plaintext", async () => {
      await expect(sealWebhookSecret(ZR_SECRET, "too-short")).rejects.toThrow(/32 bytes/);
    });

    it("refuses to open a sealed value with the wrong key", async () => {
      const sealed = await sealWebhookSecret(ZR_SECRET, KEY_A);

      await expect(openWebhookSecret(sealed, KEY_B)).rejects.toBeTruthy();
    });

    it("refuses to open a sealed value when the key is missing", async () => {
      const sealed = await sealWebhookSecret(ZR_SECRET, KEY_A);

      await expect(openWebhookSecret(sealed, "")).rejects.toThrow(/WEBHOOK_ENCRYPTION_KEY/);
    });

    it("rejects a tampered ciphertext — GCM must authenticate", async () => {
      const sealed = await sealWebhookSecret(ZR_SECRET, KEY_A);
      const [, iv, ciphertext] = sealed.split(":");
      // Flip one byte of the last base64 block.
      const flipped = ciphertext.slice(0, -1) + (ciphertext.endsWith("A") ? "B" : "A");
      const tampered = `enc:v1:${iv}:${flipped}`;

      await expect(openWebhookSecret(tampered, KEY_A)).rejects.toBeTruthy();
    });

    it("never includes the secret in an error message", async () => {
      const sealed = await sealWebhookSecret(ZR_SECRET, KEY_A);

      const message = await openWebhookSecret(sealed, KEY_B).catch((err: Error) => err.message);

      expect(message).not.toContain(ZR_SECRET);
      expect(message).not.toContain(YALIDINE_SECRET);
    });
  });
});