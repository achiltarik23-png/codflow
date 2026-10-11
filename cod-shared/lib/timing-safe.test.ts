/**
 * timingSafeEqual — behaviour contract.
 *
 * The security property is "no early exit on content", which a test cannot
 * observe directly. What it CAN observe is that the comparison accepts and
 * rejects correctly, handles non-ASCII, and does not throw on the shapes the
 * webhook verifiers hand it — including a missing segment, which is what an
 * attacker sends.
 */

import { describe, it, expect } from "vitest";
import { timingSafeEqual } from "./timing-safe";

const DIGEST = "a3f1c9e8b7d60542f1e9c8b7a60542f1e9c8b7a60542f1e9c8b7a60542f1e9";

describe("timingSafeEqual", () => {
  it("accepts identical strings", () => {
    expect(timingSafeEqual(DIGEST, DIGEST)).toBe(true);
  });

  it("accepts an empty pair", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("rejects a difference in the first character", () => {
    expect(timingSafeEqual(`z${DIGEST.slice(1)}`, DIGEST)).toBe(false);
  });

  it("rejects a difference in the last character", () => {
    const flipped = `${DIGEST.slice(0, -1)}${DIGEST.endsWith("9") ? "8" : "9"}`;
    expect(timingSafeEqual(flipped, DIGEST)).toBe(false);
  });

  it("rejects a difference in the middle — the case an early exit would leak", () => {
    const mid = Math.floor(DIGEST.length / 2);
    const flipped = `${DIGEST.slice(0, mid)}x${DIGEST.slice(mid + 1)}`;
    expect(timingSafeEqual(flipped, DIGEST)).toBe(false);
  });

  it("rejects different lengths", () => {
    expect(timingSafeEqual(DIGEST, DIGEST.slice(1))).toBe(false);
    expect(timingSafeEqual(DIGEST, `${DIGEST}0`)).toBe(false);
  });

  it("handles a base64 signature body, which is what Svix sends", () => {
    const b64 = "K7yHqA8bR2mXpQ1cVn0dTf3sZgL5wEjJ6uIhOpAsDfG=";
    expect(timingSafeEqual(b64, b64)).toBe(true);
    expect(timingSafeEqual(b64, `${b64.slice(0, -1)}X`)).toBe(false);
  });

  it("compares multi-byte characters by code unit without throwing", () => {
    expect(timingSafeEqual("clé-مفتاح", "clé-مفتاح")).toBe(true);
    expect(timingSafeEqual("clé-مفتاح", "clé-مفتا")).toBe(false);
  });

  it("treats a missing segment as unequal rather than throwing", () => {
    // An attacker controls the svix-signature header, so parts[1] can be absent.
    expect(timingSafeEqual(undefined as unknown as string, DIGEST)).toBe(false);
    expect(timingSafeEqual(DIGEST, undefined as unknown as string)).toBe(false);
    expect(timingSafeEqual(null as unknown as string, null as unknown as string)).toBe(false);
  });

  it("does not treat a non-string as an empty string", () => {
    expect(timingSafeEqual("" as string, undefined as unknown as string)).toBe(false);
  });
});