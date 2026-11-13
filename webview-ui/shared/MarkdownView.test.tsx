/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copyCodeFromButton, patchMarkdownBlocks } from "./MarkdownView";
import { renderMarkdownBlocks } from "./markdown";

let root: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => { root.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const mountCode = (source: string) => {
  patchMarkdownBlocks(root, [], renderMarkdownBlocks(source));
  return root.querySelector<HTMLButtonElement>("button.code-copy")!;
};

it("adds a copy button to each fenced code block and none to inline code", () => {
  patchMarkdownBlocks(root, [], renderMarkdownBlocks("Use `x` here.\n\n```js\nconst a = 1;\n```\n\n```py\nprint(1)\n```"));
  expect(root.querySelectorAll(".code-block button.code-copy")).toHaveLength(2);
  expect(root.querySelectorAll("p button")).toHaveLength(0);
});

it("copies the code text without the trailing newline and confirms on the button", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const button = mountCode("```js\nconst a = 1;\nconsole.log(a);\n```");
  copyCodeFromButton(button);
  await vi.advanceTimersByTimeAsync(0);
  expect(writeText).toHaveBeenCalledWith("const a = 1;\nconsole.log(a);");
  expect(button.textContent).toBe("Copied");
  await vi.advanceTimersByTimeAsync(1500);
  expect(button.textContent).toBe("Copy");
});

it("falls back to a selection copy when the clipboard API is denied", async () => {
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  const exec = vi.fn(() => true);
  (document as any).execCommand = exec;
  const button = mountCode("```\nplain\n```");
  copyCodeFromButton(button);
  await vi.advanceTimersByTimeAsync(0);
  expect(exec).toHaveBeenCalledWith("copy");
  expect(button.textContent).toBe("Copied");
  expect(document.querySelector("textarea")).toBeNull();
});

it("reports a failure instead of claiming the copy worked", async () => {
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  (document as any).execCommand = vi.fn(() => false);
  const button = mountCode("```\nplain\n```");
  copyCodeFromButton(button);
  await vi.advanceTimersByTimeAsync(0);
  expect(button.textContent).toBe("Failed");
});
