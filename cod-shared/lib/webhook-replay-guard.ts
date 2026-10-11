/**
 * Yalidine replay guard.
 *
 * ## What this does and does not stop
 *
 * Yalidine signs the raw request body with a plain HMAC — unlike Svix, there
 * is no timestamp inside the signed content, so the signature alone carries no
 * notion of freshness. The `event_id` unique index blocks an exact replay, and
 * any edit to the body breaks the signature. So the residual exposure is
 * narrower than it looks: an attacker who captured valid signed bodies while
 * the secret leaked (see the `sanitize()` fix) can replay them, and will keep
 * being able to for as long as they are accepted.
 *
 * This window bounds that exposure. `occurred_at` is inside the signed body,
 * so for a VERIFIED delivery it is trustworthy and a sane age limit is sound.
 *
 * On the fail-open path `occurred_at` is attacker-controlled, so a window there
 * is theatre. The caller is expected to apply this only when the signature
 * verified; when it has not, today's behaviour is preserved unchanged.
 *
 * ## Why it never rejects
 *
 * A carrier that gets a non-200 retries, then disables the webhook after
 * repeated failures — losing the merchant their entire delivery feed. So this
 * returns a verdict, and the caller records the event as ignored. The request
 * still answers 200. A stale event simply does not move an order.
 *
 * ## Parsing
 *
 * Observed values are `YYYY-MM-DD HH:MM:SS` with no timezone (Yalidine is
 * PHP-backed). ISO-8601 is accepted too. A timestamp with no zone is read as
 * UTC; the worst case is the carrier's local offset — an hour, against a
 * window measured in days.
 *
 * An unparseable value returns "unusable", which callers must treat as
 * "apply no limit" — never as "reject". A format change at the carrier must
 * not silently stop delivery updates.
 */

/** Maximum age of a verified delivery, in milliseconds. Seven days. */
export const YALIDINE_REPLAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ReplayVerdict =
  | { verdict: "fresh" }
  | { verdict: "stale"; ageMs: number }
  | { verdict: "unusable" };

/**
 * Parse a carrier timestamp leniently.
 *
 * Returns null when the value is absent or not a shape we recognise — callers
 * must then apply no limit.
 */
export function parseCarrierTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Only `YYYY-MM-DD…` is accepted. Date.parse is far more permissive than it
  // looks: a bare number string becomes a YEAR ("1757592000"), and
  // "11/10/2026" resolves as US MM/DD. Both would sail through as valid dates
  // and then get the wrong answer about freshness. For a security control,
  // refusing an unreadable shape is strictly better than guessing one — the
  // caller then applies no limit, which is the compatible direction.
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]|$)/.test(trimmed)) return null;

  // `2026-09-07 10:00:00` → ISO with an explicit UTC zone, so the space form
  // is not re-interpreted as local time on whatever machine parses it.
  const normalised = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;

  const parsed = Date.parse(normalised);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Decide whether a verified delivery is too old to apply.
 *
 * "unusable" means the timestamp could not be read and no limit applies.
 */
export function checkYalidineReplay(
  occurredAt: string | null | undefined,
  nowMs: number = Date.now(),
): ReplayVerdict {
  const parsed = parseCarrierTimestamp(occurredAt);
  if (parsed === null) return { verdict: "unusable" };

  const ageMs = nowMs - parsed;
  if (ageMs > YALIDINE_REPLAY_WINDOW_MS) return { verdict: "stale", ageMs };
  return { verdict: "fresh" };
}