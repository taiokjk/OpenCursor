import { describe, expect, it, vi } from "vitest";
vi.mock("vscode", () => ({ EventEmitter: class { event = () => ({ dispose() {} }); fire() {} } }));
vi.mock("../stores/featureStore", () => ({ MODEL_CATALOG: [] }));
import { ChatHTTPError } from "./provider";
import { formatCountdown, parseQuotaResetTime, resolveQuotaResumeAt } from "./quotaRetry";

describe("parseQuotaResetTime", () => {
  it("parses exact clock times with seconds like 1:59:59 PM in local time", () => {
    const now = new Date(2026, 10, 1, 12, 40, 9, 0); // Nov 1, 2026, 12:40:09 PM local
    const parsed = parseQuotaResetTime("Claude Code quota expired until 1:59:59 PM", now);
    expect(parsed).not.toBeNull();
    const expected = new Date(2026, 10, 1, 13, 59, 59, 0).getTime() - now.getTime();
    expect(parsed!.waitMs).toBe(expected);
  });

  it("parses claude-auto-retry banner formats with timezone", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    const parsed = parseQuotaResetTime("You've hit your session limit · resets 2pm (UTC)", now);
    expect(parsed).not.toBeNull();
    // 2 hours + 5s margin for coarse minute/hour banner
    expect(parsed!.waitMs).toBe(2 * 3600_000 + 5_000);
  });

  it("parses dated weekly reset banners", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    const parsed = parseQuotaResetTime("Weekly limit reached · resets Nov 3 at 10am (UTC)", now);
    expect(parsed).not.toBeNull();
    const target = Date.UTC(2026, 10, 3, 10, 0, 0) - now.getTime() + 5_000;
    expect(parsed!.waitMs).toBe(target);
  });

  it("parses relative retry durations in seconds, minutes, and hours", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    expect(parseQuotaResetTime("claude-code accounts are temporarily unavailable. Retry in 120 seconds.", now)?.waitMs).toBe(120_000);
    expect(parseQuotaResetTime("Rate limit reached, try again in 15 minutes", now)?.waitMs).toBe(15 * 60_000);
    expect(parseQuotaResetTime("Usage limit reached, wait 2 hours", now)?.waitMs).toBe(2 * 3600_000);
  });
});

describe("resolveQuotaResumeAt", () => {
  it("prefers authoritative OAuth usage window resetsAt when exhausted", async () => {
    const now = 1_762_000_000_000;
    const resetAt = now + 4_790_000;
    const error = new ChatHTTPError(429, "claude-code 429: rate_limit_error");
    const resumeAt = await resolveQuotaResumeAt({
      error,
      now,
      fetchLimits: async () => [
        { remaining: 0, resetsAt: resetAt },
        { remaining: 40, resetsAt: now + 86_400_000 },
      ],
    });
    expect(resumeAt).toBe(resetAt);
  });

  it("uses retryAfterMs when greater than fallback cooldown or when usage limits are unavailable", async () => {
    const now = 1_762_000_000_000;
    const error = new ChatHTTPError(429, "claude-code 429: rate_limit_error", 180_000);
    const resumeAt = await resolveQuotaResumeAt({
      error,
      now,
      fetchLimits: vi.fn().mockRejectedValue(new Error("offline")),
    });
    expect(resumeAt).toBe(now + 180_000);
  });

  it("falls back to parsed message reset time and then default 60s backoff", async () => {
    const now = new Date(2026, 10, 1, 12, 40, 0, 0).getTime();
    const withMsg = new ChatHTTPError(429, "5-hour limit reached - resets 1:59:59 PM");
    const expectedTarget = new Date(2026, 10, 1, 13, 59, 59, 0).getTime();
    expect(await resolveQuotaResumeAt({ error: withMsg, now })).toBe(expectedTarget);

    const generic429 = new ChatHTTPError(429, "Too Many Requests");
    expect(await resolveQuotaResumeAt({ error: generic429, now })).toBe(now + 60_000);
  });
});

describe("formatCountdown", () => {
  it("formats hours, minutes, and seconds cleanly", () => {
    expect(formatCountdown(4_790_000)).toBe("1h 19m 50s");
    expect(formatCountdown(125_000)).toBe("2m 5s");
    expect(formatCountdown(9_000)).toBe("9s");
    expect(formatCountdown(0)).toBe("0s");
  });
});
