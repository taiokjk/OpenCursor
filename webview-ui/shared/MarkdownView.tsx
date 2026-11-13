/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import { renderMarkdownBlocks } from "./markdown";

interface MountedBlock { html: string; nodes: ChildNode[] }

/**
 * Keep `root`'s children in sync with `blocks`, touching only blocks that
 * changed. Streaming appends to the trailing block, so earlier blocks keep
 * their DOM (no re-layout, and text selections inside them survive).
 */
export function patchMarkdownBlocks(root: HTMLElement, mounted: MountedBlock[], blocks: readonly string[]): void {
  let same = 0;
  while (same < mounted.length && same < blocks.length && mounted[same].html === blocks[same]) same++;
  for (let index = same; index < mounted.length; index++) for (const node of mounted[index].nodes) node.remove();
  mounted.length = same;
  for (let index = same; index < blocks.length; index++) {
    const template = document.createElement("template");
    template.innerHTML = blocks[index];
    // The sanitizer drops <button>, so the copy control is added after it ran.
    for (const block of Array.from(template.content.querySelectorAll(".code-block"))) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "code-copy";
      button.textContent = "Copy";
      button.title = "Copy code";
      button.setAttribute("aria-label", "Copy code");
      block.append(button);
    }
    const nodes = Array.from(template.content.childNodes);
    root.append(template.content);
    mounted.push({ html: blocks[index], nodes });
  }
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch { /* fall through: the async API can be denied inside a webview */ }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.append(area);
  area.select();
  try { if (!document.execCommand("copy")) throw new Error("copy rejected"); }
  finally { area.remove(); }
}

/** Copy the code next to a clicked copy button and confirm on the button itself. */
export function copyCodeFromButton(button: HTMLElement): void {
  const code = button.closest(".code-block")?.querySelector("pre")?.textContent ?? "";
  const show = (label: string) => {
    button.textContent = label;
    window.clearTimeout(Number(button.dataset.timer));
    button.dataset.timer = String(window.setTimeout(() => { button.textContent = "Copy"; }, 1500));
  };
  writeClipboard(code.replace(/\n$/, "")).then(() => show("Copied"), () => show("Failed"));
}

/** Sanitized markdown, updated block by block instead of replacing all innerHTML. */
export const MarkdownView = React.memo(function MarkdownView({ text, autoDirection = true }: { text: string; autoDirection?: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const mounted = React.useRef<MountedBlock[]>([]);
  React.useLayoutEffect(() => {
    if (ref.current) patchMarkdownBlocks(ref.current, mounted.current, renderMarkdownBlocks(text));
  }, [text]);
  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const button = (event.target as Element).closest?.<HTMLElement>("button.code-copy");
    if (button && event.currentTarget.contains(button)) copyCodeFromButton(button);
  };
  return <div ref={ref} className="markdown-content" dir={autoDirection ? "auto" : undefined} onClick={onClick} />;
});
