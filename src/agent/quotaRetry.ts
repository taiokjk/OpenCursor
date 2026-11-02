/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const ABSOLUTE_RESET_REGEX = /(?:resets?\s+(?:on\s+)?|(?:expired\s+)?until\s+)(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;
const RELATIVE_RESET_REGEX = /(?:try again|wait|resets?\s+in|retry\s+in)[:\s]\s*(?:for\s+)?(?:in\s+)?(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/i;

const RESET_GRACE_MS = 60 * 60 * 1000;
const COARSE_MARGIN_MS = 5_000;
export const DEFAULT_QUOTA_BACKOFF_MS = 60_000;
export const MAX_QUOTA_RETRIES = 5;

export interface ParsedQuotaReset {
  waitMs: number;
  exact: boolean;
}

export function parseQuotaResetTime(text: string, now: Date = new Date()): ParsedQuotaReset | null {
  if (!text) return null;

  const relMatch = text.match(RELATIVE_RESET_REGEX);
  if (relMatch) {
    const amount = Number(relMatch[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unit = relMatch[2].toLowerCase();
    const mult = unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1_000;
    return { waitMs: Math.ceil(amount * mult), exact: unit.startsWith("s") };
  }

  const absMatch = text.match(ABSOLUTE_RESET_REGEX);
  if (!absMatch) return null;

  const monthIdx = absMatch[1] ? MONTHS.indexOf(absMatch[1].toLowerCase()) : -1;
  if (absMatch[1] && monthIdx === -1) return null;

  let hour = parseInt(absMatch[3], 10);
  const minute = absMatch[4] ? parseInt(absMatch[4], 10) : 0;
  const second = absMatch[5] !== undefined ? parseInt(absMatch[5], 10) : undefined;
  const ampm = absMatch[6]?.toLowerCase() || null;
  const timezone = absMatch[7]?.trim() || null;

  // Without am/pm, a colon, a date, or a timezone, require `resets` prefix to avoid matching prose numbers.
  if (!ampm && absMatch[4] === undefined && monthIdx === -1 && !timezone && !/resets?\b/i.test(absMatch[0])) {
    return null;
  }

  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  const sec = second ?? 0;
  if (hour > 23 || hour < 0 || minute > 59 || sec > 59) return null;

  const exact = second !== undefined;
  const marginMs = exact ? 0 : COARSE_MARGIN_MS;
  const ambiguous = !ampm && hour >= 1 && hour <= 12;

  let tz: string;
  try {
    tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return null;
  }

  const todayInTz = () => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const get = (t: string) => parseInt(parts.find((p) => p.type === t)!.value, 10);
    return { y: get("year"), mo: get("month") - 1, d: get("day") };
  };

  const getTargetTimestamp = (h: number, m: number, s: number, dayOffset = 0, date?: { y: number; mo: number; d: number }) => {
    let { y, mo, d } = date || todayInTz();
    if (dayOffset) {
      const norm = new Date(Date.UTC(y, mo, d + dayOffset));
      y = norm.getUTCFullYear();
      mo = norm.getUTCMonth();
      d = norm.getUTCDate();
    }

    const targetStr = `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    const guess = new Date(targetStr);

    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const rendered = (ts: number) => {
      const fp = fmt.formatToParts(new Date(ts));
      const get = (t: string) => parseInt(fp.find((p) => p.type === t)!.value, 10);
      return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    };
    const targetWall = Date.UTC(y, mo, d, h, m, s);

    let candidate = guess.getTime();
    let prev = candidate;
    for (let i = 0; i < 3; i++) {
      const diffMs = targetWall - rendered(candidate);
      if (diffMs === 0) break;
      prev = candidate;
      candidate += diffMs;
    }

    if (rendered(candidate) !== targetWall) {
      candidate = Math.max(candidate, prev);
    } else if (rendered(candidate + 3_600_000) === targetWall) {
      candidate += 3_600_000;
    }
    return candidate;
  };

  if (monthIdx !== -1) {
    const day = parseInt(absMatch[2], 10);
    if (day < 1 || day > 31) return null;
    const today = todayInTz();
    const sameYear = Date.UTC(today.y, monthIdx, day);
    const yesterday = Date.UTC(today.y, today.mo, today.d - 1);
    const y = sameYear >= yesterday ? today.y : today.y + 1;
    const date = { y, mo: monthIdx, d: day };
    const at = (h: number) => getTargetTimestamp(h, minute, sec, 0, date) - now.getTime();
    let target = at(hour);
    if (ambiguous) {
      const alt = at((hour + 12) % 24);
      const future = [target, alt].filter((x) => x > 0);
      target = future.length ? Math.min(...future) : Math.max(target, alt);
    }
    return { waitMs: Math.max(0, target) + marginMs, exact };
  }

  if (ambiguous) {
    const d1 = getTargetTimestamp(hour, minute, sec) - now.getTime();
    const d2 = getTargetTimestamp((hour + 12) % 24, minute, sec) - now.getTime();
    let target: number;
    if (d1 > 0 && d2 > 0) target = Math.min(d1, d2);
    else if (d1 > 0) target = d1;
    else if (d2 > 0) target = d2;
    else {
      const recent = Math.max(d1, d2);
      const earlyHour = d1 <= d2 ? hour : (hour + 12) % 24;
      target = recent > -RESET_GRACE_MS ? 0 : getTargetTimestamp(earlyHour, minute, sec, 1) - now.getTime();
    }
    return { waitMs: Math.max(0, target) + marginMs, exact };
  }

  const today = getTargetTimestamp(hour, minute, sec) - now.getTime();
  const diff = today >= 0
    ? today
    : today > -RESET_GRACE_MS
      ? 0
      : getTargetTimestamp(hour, minute, sec, 1) - now.getTime();
  return { waitMs: Math.max(0, diff) + marginMs, exact };
}

export async function resolveQuotaResumeAt(options: {
  error: unknown;
  now?: number;
  fetchLimits?: () => Promise<Array<{ remaining: number; resetsAt?: number }>>;
}): Promise<number> {
  const now = options.now ?? Date.now();
  const err = options.error as { message?: string; retryAfterMs?: number } | undefined;

  if (options.fetchLimits) {
    try {
      const limits = await options.fetchLimits();
      const futureExhausted = limits
        .filter((l) => l.remaining <= 0 && typeof l.resetsAt === "number" && l.resetsAt > now)
        .map((l) => l.resetsAt!);
      if (futureExhausted.length) {
        return Math.max(...futureExhausted);
      }
      const futureAny = limits
        .filter((l) => typeof l.resetsAt === "number" && l.resetsAt > now)
        .map((l) => l.resetsAt!);
      if (futureAny.length) {
        return Math.min(...futureAny);
      }
    } catch {
      /* fall through to header / message parsing */
    }
  }

  const retryAfterMs = Number(err?.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return now + Math.ceil(retryAfterMs);
  }

  const message = typeof err?.message === "string" ? err.message : String(options.error ?? "");
  const parsed = parseQuotaResetTime(message, new Date(now));
  if (parsed && parsed.waitMs > 0) {
    return now + parsed.waitMs;
  }

  return now + DEFAULT_QUOTA_BACKOFF_MS;
}

export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

export function waitUntilQuotaResumeAt(resumeAt: number, signal?: AbortSignal): Promise<"timer"> {
  const delayMs = Math.max(0, resumeAt - Date.now());
  return new Promise<"timer">((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve("timer");
    };
    const timer = setTimeout(done, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
