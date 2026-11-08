/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/** A bounded-memory line diff shared by tool output and inline review. */
export interface Hunk {
  startLine: number;
  endLine: number;
  beforeLines: string[];
  afterLines: string[];
  beforeStart: number;
  beforeEnd: number;
}

const CELL_LIMIT = 65_536;
const WORK_LIMIT = 2_000_000;
let cached: { before: string; after: string; hunks: Hunk[] } | undefined;

export function computeHunks(before: string, after: string): Hunk[] {
  if (before === after) return [];
  if (cached?.before === before && cached.after === after) return cached.hunks;
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];
  const hunks: Hunk[] = [];
  let work = 0;
  const add = (as: number, ae: number, bs: number, be: number) => {
    if (as === ae && bs === be) return;
    const prior = hunks[hunks.length - 1];
    if (prior && prior.beforeEnd === as && prior.startLine + prior.afterLines.length === bs) {
      prior.beforeEnd = ae;
      prior.beforeLines = prior.beforeLines.concat(a.slice(as, ae));
      prior.afterLines = prior.afterLines.concat(b.slice(bs, be));
      prior.endLine = Math.max(prior.startLine, be - 1);
    } else hunks.push({ startLine: bs, endLine: Math.max(bs, be - 1), beforeStart: as,
      beforeEnd: ae, beforeLines: a.slice(as, ae), afterLines: b.slice(bs, be) });
  };
  const diff = (as: number, ae: number, bs: number, be: number, depth: number) => {
    while (as < ae && bs < be && a[as] === b[bs]) { as++; bs++; }
    while (as < ae && bs < be && a[ae - 1] === b[be - 1]) { ae--; be--; }
    const n = ae - as, m = be - bs;
    if (!n || !m) { add(as, ae, bs, be); return; }
    work += n + m;
    if (work > WORK_LIMIT || depth > 48) { add(as, ae, bs, be); return; }
    if ((n + 1) * (m + 1) <= CELL_LIMIT) {
      const width = m + 1;
      const dp = new Uint32Array((n + 1) * width);
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
        dp[i * width + j] = a[as + i] === b[bs + j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
      }
      let i = 0, j = 0, ai = as, bj = bs;
      while (i < n && j < m) {
        if (a[as + i] === b[bs + j]) {
          add(ai, as + i, bj, bs + j); i++; j++; ai = as + i; bj = bs + j;
        } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) i++;
        else j++;
      }
      add(ai, ae, bj, be);
      return;
    }
    // Unique common lines provide patience-diff anchors. An adversarial region
    // without anchors becomes one honest replacement hunk instead of allocating
    // a quadratic matrix or blocking the extension host indefinitely.
    const left = new Map<string, number>();
    const right = new Map<string, number>();
    for (let i = as; i < ae; i++) left.set(a[i], left.has(a[i]) ? -1 : i);
    for (let i = bs; i < be; i++) right.set(b[i], right.has(b[i]) ? -1 : i);
    const pairs: [number, number][] = [];
    for (let i = as; i < ae; i++) {
      const j = right.get(a[i]);
      if (left.get(a[i]) === i && j !== undefined && j >= 0) pairs.push([i, j]);
    }
    if (!pairs.length) { add(as, ae, bs, be); return; }
    const tails: number[] = [], previous = new Int32Array(pairs.length).fill(-1);
    for (let i = 0; i < pairs.length; i++) {
      let lo = 0, hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (pairs[tails[mid]][1] < pairs[i][1]) lo = mid + 1; else hi = mid;
      }
      if (lo) previous[i] = tails[lo - 1];
      tails[lo] = i;
    }
    const anchors: [number, number][] = [];
    for (let k = tails[tails.length - 1]; k >= 0; k = previous[k]) anchors.push(pairs[k]);
    anchors.reverse();
    for (const [i, j] of anchors) {
      diff(as, i, bs, j, depth + 1); as = i + 1; bs = j + 1;
    }
    diff(as, ae, bs, be, depth + 1);
  };
  diff(0, a.length, 0, b.length, 0);
  // Keep a single small result, never retain large file bodies between renders.
  cached = before.length + after.length <= 2_000_000 ? { before, after, hunks } : undefined;
  return hunks;
}

/** A replacement of `base` lines [start, end) with `lines`. */
interface LineEdit { start: number; end: number; lines: string[] }

const splitLines = (text: string) => text.length ? text.split("\n") : [];

/**
 * Whether two edits of the same base touch the same lines. Pure insertions only
 * conflict when they land strictly inside the other edit, or at the same point.
 */
function editsOverlap(a: LineEdit, b: LineEdit): boolean {
  const aEmpty = a.start === a.end, bEmpty = b.start === b.end;
  if (aEmpty && bEmpty) return a.start === b.start;
  if (aEmpty) return b.start < a.start && a.start < b.end;
  if (bEmpty) return a.start < b.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

/** The agent's change expressed as edits on `after` that restore `before`. */
const undoEdits = (before: string, after: string): LineEdit[] =>
  computeHunks(before, after).map((h) => ({ start: h.startLine, end: h.startLine + h.afterLines.length, lines: h.beforeLines }));

/** Later edits expressed as edits on `after` that produce `current`. */
const laterEdits = (after: string, current: string): LineEdit[] =>
  computeHunks(after, current).map((h) => ({ start: h.beforeStart, end: h.beforeEnd, lines: h.afterLines }));

/**
 * Three-way undo: remove the before→after change from `current` while keeping
 * edits made since `after`. Returns null when those later edits touch the same
 * lines as the change, so the caller never overwrites work it cannot separate.
 */
export function revertOnto(before: string, after: string, current: string): string | null {
  if (current === after) return before;
  const undo = undoEdits(before, after);
  const later = laterEdits(after, current);
  if (undo.some((u) => later.some((l) => editsOverlap(u, l)))) return null;
  // Insertions sort before a replacement at the same line, preserving order.
  const edits = [...undo, ...later].sort((x, y) => x.start - y.start || (x.end - x.start) - (y.end - y.start));
  const base = splitLines(after);
  const out: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    for (let i = cursor; i < edit.start; i++) out.push(base[i]);
    for (const line of edit.lines) out.push(line);
    cursor = edit.end;
  }
  for (let i = cursor; i < base.length; i++) out.push(base[i]);
  return out.join("\n");
}

/**
 * Lines of `current` that still show the before→after change. Later edits that
 * overlap the change stay highlighted (the region is mixed); unrelated later
 * edits elsewhere in the file are not attributed to the change.
 */
export function changedLinesSince(before: string, after: string, current: string): number[] {
  const undo = undoEdits(before, after);
  if (!undo.length) return [];
  const later = computeHunks(after, current);
  const lines = new Set<number>();
  // Map each unchanged `after` line to its position in `current`.
  let next = 0, offset = 0;
  const mapThrough = (limit: number, into: (line: number, mapped: number) => void) => {
    for (; next < limit; next++) into(next, next + offset);
  };
  const inChange = (line: number) => undo.some((u) => u.start <= line && line < u.end);
  for (const h of later) {
    mapThrough(h.beforeStart, (line, mapped) => { if (inChange(line)) lines.add(mapped); });
    next = h.beforeEnd;
    offset = h.startLine + h.afterLines.length - h.beforeEnd;
    const edit = { start: h.beforeStart, end: h.beforeEnd, lines: h.afterLines };
    if (undo.some((u) => editsOverlap(u, edit))) for (let i = 0; i < h.afterLines.length; i++) lines.add(h.startLine + i);
  }
  mapThrough(splitLines(after).length, (line, mapped) => { if (inChange(line)) lines.add(mapped); });
  return [...lines].sort((a, b) => a - b);
}

/** Where line `line` of `after` sits in `current`, following insertions and deletions made since. */
export function mapLineForward(after: string, current: string, line: number): number {
  let offset = 0;
  for (const h of computeHunks(after, current)) {
    if (line < h.beforeStart) break;
    if (line < h.beforeEnd) return h.startLine;
    offset = h.startLine + h.afterLines.length - h.beforeEnd;
  }
  return line + offset;
}

export function makeDiff(_filePath: string, before: string, after: string): string {
  const out: string[] = [];
  let chars = 0;
  for (const h of computeHunks(before, after)) {
    const lines = [`@@ -${h.beforeStart + 1},${h.beforeLines.length} +${h.startLine + 1},${h.afterLines.length} @@`,
      ...h.beforeLines.map((line) => `- ${line}`), ...h.afterLines.map((line) => `+ ${line}`)];
    for (const line of lines) {
      if (chars + line.length > 24_000) return out.join("\n") + "\n… (diff preview truncated; review the file for all changes)";
      out.push(line); chars += line.length + 1;
    }
  }
  return out.join("\n");
}
