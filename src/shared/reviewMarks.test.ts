/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { reviewMarks, wordDiff } from "./reviewMarks";

describe("agent review marks", () => {
  it("shows pure additions as whole added lines", () => {
    expect(reviewMarks("a\nc", "a\nb1\nb2\nc", "a\nb1\nb2\nc")).toEqual({ addedLines: [1, 2], modifiedLines: [], removals: [] });
  });

  it("shows pure deletions as removed text attached above the next line", () => {
    expect(reviewMarks("a\nb\nc", "a\nc", "a\nc")).toEqual({ addedLines: [], modifiedLines: [], removals: [{ line: 1, placement: "above", lines: ["b"] }] });
  });

  it("attaches a deletion at the end of the file below the last line", () => {
    expect(reviewMarks("a\nb", "a", "a").removals).toEqual([{ line: 0, placement: "below", lines: ["b"] }]);
  });

  it("shows a reworded line as modified with old words removed and new words added", () => {
    const marks = reviewMarks(
      "Additional checks include `pnpm run test:runtime`.",
      "Additional verification includes `pnpm run test:runtime`.",
      "Additional verification includes `pnpm run test:runtime`.");
    expect(marks.addedLines).toEqual([]);
    expect(marks.modifiedLines).toEqual([{ line: 0, added: [[11, 32]], removed: [{ column: 11, text: "checks include" }] }]);
  });

  it("splits a block into modified lines plus leftover added or removed lines", () => {
    const grow = reviewMarks("a\nold\nz", "a\nnew one\nextra\nz", "a\nnew one\nextra\nz");
    expect(grow.modifiedLines.map(m => m.line)).toEqual([1]);
    expect(grow.addedLines).toEqual([2]);
    const shrink = reviewMarks("a\none\ntwo\nz", "a\nONE\nz", "a\nONE\nz");
    expect(shrink.modifiedLines.map(m => m.line)).toEqual([1]);
    expect(shrink.removals).toEqual([{ line: 1, placement: "below", lines: ["two"] }]);
  });

  it("follows the agent's lines through unrelated user edits and never marks the user's lines", () => {
    const marks = reviewMarks("a\nb\nc", "a\nB\nc", "mine\na\nB\nC");
    expect(marks.modifiedLines.map(m => m.line)).toEqual([2]);
    expect(marks.addedLines).toEqual([]);
  });

  it("keeps a region the user edited inside the agent's block marked as changed", () => {
    expect(reviewMarks("a\nc", "a\nb1\nb2\nc", "a\nb1\nmine\nc").addedLines).toEqual([1, 2]);
  });

  it("is empty without a change", () => {
    expect(reviewMarks("a", "a", "a\nb")).toEqual({ addedLines: [], modifiedLines: [], removals: [] });
  });
});

describe("word diff", () => {
  it("falls back to a whole-line replacement when little is shared", () => {
    expect(wordDiff("completely different", "nothing alike here")).toEqual({ added: [[0, 18]], removed: [{ column: 0, text: "completely different" }] });
  });

  it("ignores a trailing carriage return", () => {
    expect(wordDiff("keep this old\r", "keep this new\r")).toEqual({ added: [[10, 13]], removed: [{ column: 10, text: "old" }] });
  });
});
