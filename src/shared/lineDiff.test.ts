/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { computeHunks, lineEdits, makeDiff, revertOnto, withoutHunk } from "./lineDiff";

function restore(before: string, after: string) {
  const lines = after.length ? after.split("\n") : [];
  for (const h of [...computeHunks(before, after)].reverse()) lines.splice(h.startLine, h.afterLines.length, ...h.beforeLines);
  return lines.join("\n");
}
describe("bounded production diff", () => {
  it("round-trips insertions, deletions, replacements, repeated lines and empty files", () => {
    const samples = ["", "a", "a\n", "a\nb\nc", "x\nx\nx", "one\ntwo\nthree\nfour"];
    for (const before of samples) for (const after of samples) expect(restore(before, after)).toBe(before);
  });
  it("preserves individual separated hunks", () => {
    expect(computeHunks("a\nb\nc\nd\ne", "A\nb\nc\nd\nE").map((h) => h.startLine)).toEqual([0, 4]);
  });
  it("handles a 50,000-line file with a one-line change without a quadratic allocation", () => {
    const before = Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 25000\n", "changed\n");
    const hunks = computeHunks(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].beforeLines).toEqual(["line 25000"]);
    expect(restore(before, after)).toBe(before);
  });
  it("bounded fallback still provides an exact reversible diff for adversarial data", () => {
    const before = "old\n".repeat(2_000), after = "new\n".repeat(2_000);
    expect(restore(before, after)).toBe(before);
    expect(makeDiff("large.txt", before, after).length).toBeLessThan(25_000);
  });
  it("anchors many distributed changes without merging unrelated lines", () => {
    const before = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 0\n", "first\n").replace("line 1500\n", "middle\n").replace("line 2999", "last");
    expect(computeHunks(before, after)).toHaveLength(3);
    expect(restore(before, after)).toBe(before);
  });
});

describe("three-way undo of an agent change", () => {
  const before = "a\nb\nc\nd\ne";
  const after = "a\nB\nc\nd\ne";
  it("is the plain original when nothing changed since", () => {
    expect(revertOnto(before, after, after)).toBe(before);
  });
  it.each([
    ["insert above", "top\na\nB\nc\nd\ne", "top\na\nb\nc\nd\ne"],
    ["insert below", "a\nB\nc\nd\ne\nbottom", "a\nb\nc\nd\ne\nbottom"],
    ["edit elsewhere", "a\nB\nc\nD\ne", "a\nb\nc\nD\ne"],
    ["delete elsewhere", "a\nB\nc\ne", "a\nb\nc\ne"],
    ["insert right after the change", "a\nB\nnew\nc\nd\ne", "a\nb\nnew\nc\nd\ne"],
  ])("keeps a user %s", (_label, current, expected) => {
    expect(revertOnto(before, after, current)).toBe(expected);
  });
  it.each([
    ["edits the changed line", "a\nB!\nc\nd\ne"],
    ["deletes the changed line", "a\nc\nd\ne"],
  ])("refuses when the user %s", (_label, current) => {
    expect(revertOnto(before, after, current)).toBeNull();
  });
  it("undoes pure insertions and deletions by the agent", () => {
    expect(revertOnto("a\nc", "a\nb\nc", "x\na\nb\nc")).toBe("x\na\nc");
    expect(revertOnto("a\nb\nc", "a\nc", "a\nc\nz")).toBe("a\nb\nc\nz");
  });
});

describe("small editor edits", () => {
  const apply = (current: string, next: string) => {
    let out = current;
    for (const { start, end, text } of [...lineEdits(current, next)].reverse()) out = out.slice(0, start) + text + out.slice(end);
    return out;
  };
  it.each([
    ["a\nb\nc", "a\nB\nc"], ["a\nb\nc", "a\nc"], ["a\nb\nc", "a\nb"], ["a\nb", "a\nb\nc"],
    ["a", "x\na"], ["", "a"], ["a", ""], ["a\nb\nc", "b"], ["a\n", "a\nb\n"], ["x\ny", "x\nmid\ny"],
  ])("turns %j into %j exactly", (current, next) => {
    expect(apply(current, next)).toBe(next);
  });
  it("touches only the changed lines", () => {
    expect(lineEdits("keep\nold\nkeep", "keep\nnew\nkeep")).toEqual([{ start: 5, end: 9, text: "new\n" }]);
  });
  it("undoes a single block without the others", () => {
    const [, second] = computeHunks("a\nb\nc\nd", "A\nb\nc\nD");
    expect(withoutHunk("A\nb\nc\nD", second)).toBe("A\nb\nc\nd");
  });
});
