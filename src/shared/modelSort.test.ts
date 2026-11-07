/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { compareModels, sortModels } from "./modelSort";

describe("modelSort best-to-worst ordering", () => {
  it("groups same-family Claude generations together in Opus -> Sonnet -> Haiku order", () => {
    const input = [
      "claude-haiku-5-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5-5",
      "claude-opus-4-5-20251101",
      "claude-opus-5-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-6",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-fable-5-1",
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-fable-5",
      "claude-opus-4-5",
      "claude-haiku-4-5",
    ];
    expect(sortModels(input)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-opus-4-5",
      "claude-opus-4-5-20251101",
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
    ]);
  });

  it("orders Antigravity models deterministically from best to worst regardless of refresh map order", () => {
    const scrambleA = [
      "claude-sonnet-5-5-low",
      "gemini-4-argon-high",
      "claude-opus-5-5-medium",
      "tab_flash_lite_preview",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-low",
      "gpt-oss-120b-medium",
      "gemini-2.5-flash-lite",
      "gemini-3.1-flash-image",
      "gemini-2.5-flash",
      "claude-sonnet-5-5-medium",
      "claude-opus-5-5-low",
      "gemini-2.5-pro",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-tiered",
      "gemini-2.5-flash-thinking",
      "tab_jump_flash_lite_preview",
      "claude-opus-5-5-high",
      "gemini-4-argon-medium",
      "claude-sonnet-5-5-high",
      "gemini-3-flash",
      "gemini-4-argon-low",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash-lite",
      "gemini-3.8-flash",
    ];
    const scrambleB = [...scrambleA].reverse();

    const sortedA = sortModels(scrambleA);
    const sortedB = sortModels(scrambleB);

    expect(sortedA).toEqual(sortedB);
    expect(sortedA).toEqual([
      "claude-opus-5-5-high",
      "claude-opus-5-5-medium",
      "claude-opus-5-5-low",
      "claude-sonnet-5-5-high",
      "claude-sonnet-5-5-medium",
      "claude-sonnet-5-5-low",
      "gemini-4-argon-high",
      "gemini-4-argon-medium",
      "gemini-4-argon-low",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash",
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-tiered",
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-lite",
      "gemini-3-flash",
      "gemini-2.5-pro",
      "gemini-2.5-flash-thinking",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gpt-oss-120b-medium",
      "tab_flash_lite_preview",
      "tab_jump_flash_lite_preview",
    ]);
  });

  it("orders Token Usage models best-to-worst instead of jumping by lastUsed timestamp", () => {
    const usageKeys = [
      "gemini-3.8-flash-medium",
      "claude-haiku-5-5",
      "gemini-4-argon-medium",
      "claude-opus-5-5",
      "gemini-3.8-flash-high",
      "claude-sonnet-5-5",
    ];
    expect(usageKeys.sort(compareModels)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "gemini-4-argon-medium",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
    ]);
  });

  it("preserves Session before Weekly quota windows while sorting per-model quota limits", () => {
    const claudeWindows = [
      { label: "Weekly sonnet (7d)" },
      { label: "Weekly (7d)" },
      { label: "Session (5h)" },
      { label: "Weekly opus (7d)" },
    ];
    expect(sortModels(claudeWindows).map((w) => w.label)).toEqual([
      "Session (5h)",
      "Weekly (7d)",
      "Weekly opus (7d)",
      "Weekly sonnet (7d)",
    ]);
  });
});
