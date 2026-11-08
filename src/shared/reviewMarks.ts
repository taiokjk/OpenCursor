/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { computeHunks, editsOverlap } from "./lineDiff";

/** Inside a modified line: new text spans and the old text each one replaced. */
export interface ModifiedLine { line: number; added: Array<[number, number]>; removed: Array<{ column: number; text: string }> }
/** Lines the agent deleted, shown attached to a neighbouring line of the current text. */
export interface Removal { line: number; placement: "above" | "below"; lines: string[] }
export interface ReviewMarks { addedLines: number[]; modifiedLines: ModifiedLine[]; removals: Removal[] }

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
/** Below this share of unchanged characters a word diff is noise; show a whole-line replacement. */
const MIN_SIMILARITY = 0.4;

const splitLines = (text: string) => text.length ? text.split("\n") : [];
const stripCr = (line: string) => line.endsWith("\r") ? line.slice(0, -1) : line;

/** Word-level diff of one replaced line, in columns of the new line. */
export function wordDiff(oldLine: string, newLine: string): Omit<ModifiedLine, "line"> {
  oldLine = stripCr(oldLine); newLine = stripCr(newLine);
  const a = oldLine.match(TOKEN) ?? [], b = newLine.match(TOKEN) ?? [];
  // Tokens never contain "\n", so the line diff doubles as a token diff.
  // Merge changes separated only by whitespace so "checks include" reads as one replaced phrase.
  const hunks: Array<{ beforeStart: number; beforeEnd: number; startLine: number; afterEnd: number }> = [];
  for (const h of computeHunks(a.join("\n"), b.join("\n"))) {
    const prior = hunks[hunks.length - 1];
    const span = { beforeStart: h.beforeStart, beforeEnd: h.beforeEnd, startLine: h.startLine, afterEnd: h.startLine + h.afterLines.length };
    if (prior && b.slice(prior.afterEnd, span.startLine).every(t => !t.trim()) && a.slice(prior.beforeEnd, span.beforeStart).every(t => !t.trim())) {
      prior.beforeEnd = span.beforeEnd; prior.afterEnd = span.afterEnd;
    } else hunks.push(span);
  }
  const changed = hunks.reduce((sum, h) => sum + a.slice(h.beforeStart, h.beforeEnd).join("").length + b.slice(h.startLine, h.afterEnd).join("").length, 0);
  if (1 - changed / Math.max(1, oldLine.length + newLine.length) < MIN_SIMILARITY) {
    return { added: newLine.length ? [[0, newLine.length]] : [], removed: oldLine.length ? [{ column: 0, text: oldLine }] : [] };
  }
  const columns = [0];
  for (const token of b) columns.push(columns[columns.length - 1] + token.length);
  const added: Array<[number, number]> = [], removed: ModifiedLine["removed"] = [];
  for (const h of hunks) {
    const column = columns[h.startLine];
    if (h.beforeEnd > h.beforeStart) removed.push({ column, text: a.slice(h.beforeStart, h.beforeEnd).join("") });
    if (h.afterEnd > h.startLine) added.push([column, columns[h.afterEnd]]);
  }
  return { added, removed };
}

/**
 * What to paint for the agent's before→after change on the live `current` text:
 * pure additions as whole green lines, modified lines with a word diff (old
 * words struck through in red), and deleted lines attached to their neighbour.
 * Lines the user rewrote since `after` are not attributed to the agent, except
 * where they overlap the agent's block, which then stays marked as changed.
 */
export function reviewMarks(before: string, after: string, current: string): ReviewMarks {
  const marks: ReviewMarks = { addedLines: [], modifiedLines: [], removals: [] };
  const agent = computeHunks(before, after);
  if (!agent.length) return marks;
  const later = computeHunks(after, current);
  const currentLines = splitLines(current);
  const afterCount = splitLines(after).length;
  // Where each `after` line (plus the end-of-file anchor) sits in `current`; -1 if the user changed it.
  const position = new Int32Array(afterCount + 1);
  let offset = 0, line = 0;
  for (const h of later) {
    for (; line < h.beforeStart; line++) position[line] = line + offset;
    for (; line < h.beforeEnd; line++) position[line] = -1;
    offset = h.startLine + h.afterLines.length - h.beforeEnd;
  }
  for (; line <= afterCount; line++) position[line] = line + offset;
  const nextMapped = (from: number) => {
    for (let i = from; i <= afterCount; i++) if (position[i] >= 0) return position[i];
    return currentLines.length;
  };
  const anchorAt = (mapped: number): Pick<Removal, "line" | "placement"> => mapped >= currentLines.length
    ? { line: Math.max(0, currentLines.length - 1), placement: "below" }
    : { line: mapped, placement: "above" };

  for (const h of agent) {
    const kept = Math.min(h.beforeLines.length, h.afterLines.length);
    let lastMapped = -1;
    for (let i = 0; i < h.afterLines.length; i++) {
      const mapped = position[h.startLine + i];
      if (mapped < 0) continue;
      lastMapped = mapped;
      if (i < kept) marks.modifiedLines.push({ line: mapped, ...wordDiff(h.beforeLines[i], currentLines[mapped]) });
      else marks.addedLines.push(mapped);
    }
    if (h.beforeLines.length > h.afterLines.length) {
      const lines = h.beforeLines.slice(kept).map(stripCr);
      const anchor = lastMapped >= 0 ? { line: lastMapped, placement: "below" as const } : anchorAt(nextMapped(h.startLine + h.afterLines.length));
      marks.removals.push({ ...anchor, lines });
    }
  }
  const agentEdits = agent.map((h) => ({ start: h.startLine, end: h.startLine + h.afterLines.length, lines: [] }));
  for (const h of later) {
    const edit = { start: h.beforeStart, end: h.beforeEnd, lines: [] };
    if (agentEdits.some((a) => editsOverlap(a, edit))) for (let i = 0; i < h.afterLines.length; i++) marks.addedLines.push(h.startLine + i);
  }
  marks.addedLines = [...new Set(marks.addedLines)].sort((a, b) => a - b);
  return marks;
}
