/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { applyEvent, applyToBlocks, forceSettleOpenWork, type AssistantTurn, type Turn } from "./turns";

const running = { type: "compaction", status: "running", model: "m1", thinkingLevel: "minimal" } as const;
const paused = { type: "compaction", status: "failed", model: "m1", thinkingLevel: "minimal", error: "boom", paused: true } as const;
const retry = { type: "compaction", status: "running", model: "m2", thinkingLevel: "high" } as const;

describe("compaction blocks", () => {
  it("keeps one card through pause and retry, without leaking the old error", () => {
    let turns: Turn[] = [{ role: "user", text: "go" }];
    for (const ev of [running, paused]) turns = applyEvent(turns, ev);
    expect((turns[1] as AssistantTurn).blocks).toEqual([{ kind: "compaction", status: "failed", model: "m1", thinkingLevel: "minimal", error: "boom", paused: true }]);
    turns = applyEvent(turns, retry);
    expect((turns[1] as AssistantTurn).blocks).toEqual([{ kind: "compaction", status: "running", model: "m2", thinkingLevel: "high" }]);
  });

  it("applies the same replacement inside a subagent stream", () => {
    const blocks = [running, paused, retry].reduce(applyToBlocks, []);
    expect(blocks).toEqual([{ kind: "compaction", status: "running", model: "m2", thinkingLevel: "high" }]);
  });

  it("settles a paused card as failed when the run stops", () => {
    const turns = applyEvent(applyEvent([{ role: "user", text: "go" }], running), paused);
    const settled = forceSettleOpenWork(turns, "cancelled");
    expect((settled[1] as AssistantTurn).blocks).toEqual([{ kind: "compaction", status: "failed", model: "m1", thinkingLevel: "minimal", error: "boom" }]);
  });
});
