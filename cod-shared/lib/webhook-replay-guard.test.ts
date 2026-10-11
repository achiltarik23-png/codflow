/**
 * Yalidine replay guard — parsing and window behaviour.
 *
 * The load-bearing cases are the two that must never reject: an unreadable
 * timestamp and a carrier that legitimately backfills. Both have to leave
 * delivery updates working.
 */

import { describe, it, expect } from "vitest";
import {
  YALIDINE_REPLAY_WINDOW_MS,
  checkYalidineReplay,
  parseCarrierTimestamp,
} from "./webhook-replay-guard";

const NOW = Date.parse("2026-10-11T12:00:00Z");

describe("parseCarrierTimestamp", () => {
  it("reads the PHP-style form Yalidine actually sends", () => {
    expect(parseCarrierTimestamp("2026-10-11 09:30:00")).toBe(
      Date.parse("2026-10-11T09:30:00Z"),
    );
  });

  it("reads ISO-8601 with an explicit zone", () => {
    expect(parseCarrierTimestamp("2026-10-11T09:30:00.000Z")).toBe(
      Date.parse("2026-10-11T09:30:00.000Z"),
    );
  });

  it("reads ISO-8601 with an offset", () => {
    expect(parseCarrierTimestamp("2026-10-11T10:30:00+01:00")).toBe(
      Date.parse("2026-10-11T09:30:00Z"),
    );
  });

  it("reads the naive form as UTC, so the value does not depend on the host zone", () => {
    expect(parseCarrierTimestamp("2026-10-11 09:30:00")).toBe(
      parseCarrierTimestamp("2026-10-11T09:30:00Z"),
    );
  });

  it("returns null for absent or empty values", () => {
    expect(parseCarrierTimestamp(null)).toBeNull();
    expect(parseCarrierTimestamp(undefined)).toBeNull();
    expect(parseCarrierTimestamp("")).toBeNull();
    expect(parseCarrierTimestamp("   ")).toBeNull();
  });

  it("returns null for shapes it does not recognise instead of guessing", () => {
    // Date.parse would read the first as a year and the second as US MM/DD;
    // both resolve to a plausible date and the wrong freshness answer.
    expect(parseCarrierTimestamp("not-a-date")).toBeNull();
    expect(parseCarrierTimestamp("11/10/2026")).toBeNull();
    expect(parseCarrierTimestamp("1757592000")).toBeNull();
    expect(parseCarrierTimestamp("2026/10/11 10:00:00")).toBeNull();
  });
});

describe("checkYalidineReplay", () => {
  it("accepts a delivery from an hour ago", () => {
    expect(checkYalidineReplay("2026-10-11 11:00:00", NOW)).toEqual({ verdict: "fresh" });
  });

  it("accepts one at the edge of the window", () => {
    const edge = new Date(NOW - YALIDINE_REPLAY_WINDOW_MS + 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);

    expect(checkYalidineReplay(edge, NOW)).toEqual({ verdict: "fresh" });
  });

  it("flags one past the window", () => {
    const old = new Date(NOW - YALIDINE_REPLAY_WINDOW_MS - 60_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);

    const result = checkYalidineReplay(old, NOW);
    expect(result.verdict).toBe("stale");
    expect(result.verdict === "stale" && result.ageMs).toBeGreaterThan(
      YALIDINE_REPLAY_WINDOW_MS,
    );
  });

  it("flags a delivery dated years ago", () => {
    expect(checkYalidineReplay("2024-01-15 10:30:00", NOW).verdict).toBe("stale");
  });

  /**
   * The load-bearing case: a carrier changing its timestamp format must not
   * silently stop order updates. Unreadable means "no limit", never "reject".
   */
  it("applies no limit when the timestamp cannot be read", () => {
    expect(checkYalidineReplay("not-a-date", NOW)).toEqual({ verdict: "unusable" });
    expect(checkYalidineReplay(null, NOW)).toEqual({ verdict: "unusable" });
    expect(checkYalidineReplay(undefined, NOW)).toEqual({ verdict: "unusable" });
  });

  it("does not flag a clock that runs slightly ahead", () => {
    expect(checkYalidineReplay("2026-10-11 12:30:00", NOW).verdict).toBe("fresh");
  });

  it("reports an age so the audit log can say how late the delivery was", () => {
    const result = checkYalidineReplay("2026-10-01 12:00:00", NOW);

    expect(result.verdict).toBe("stale");
    expect(result.verdict === "stale" && result.ageMs).toBe(10 * 24 * 60 * 60 * 1000);
  });
});