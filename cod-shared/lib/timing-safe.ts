/**
 * Constant-time string comparison.
 *
 * `===` on strings returns at the first differing character, so response time
 * leaks how much of a candidate matched. That is a byte-by-byte oracle: an
 * attacker who can time responses can rebuild a secret without ever holding it.
 *
 * The length is compared first and returns early. That leaks only the length,
 * which for every use here (a fixed-size SHA-256 digest) is public. The content
 * comparison then runs to completion with no early exit.
 *
 * Lives in cod-shared so both webhook verifiers use the same primitive — the
 * point of extracting it is that the Svix verifier was using `===` while the
 * Yalidine one had this, two directories apart.
 */

/** Constant-time equality — same length requirement, no early exit. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}