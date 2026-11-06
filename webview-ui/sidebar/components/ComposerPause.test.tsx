/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

vi.mock("../../shared/vscode", () => ({ vscode: { postMessage: vi.fn() } }));

let root: Root, container: HTMLDivElement;

function render(props: Partial<React.ComponentProps<typeof Composer>>) {
  act(() => root.render(
    <Composer mode="agent" onMode={vi.fn()} models={[]} modelList={[]} selectedModel="" onSelectModel={vi.fn()}
      onSaveModelOptions={vi.fn()} onResetModelOptions={vi.fn()} isRunning={false} onSubmit={vi.fn()} onCancel={vi.fn()} {...props} />,
  ));
}
const pauseButton = () => container.querySelector<HTMLButtonElement>(".pause-btn");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("pause control", () => {
  it("is hidden when idle and while editing", () => {
    render({ isRunning: false, onTogglePause: vi.fn() });
    expect(pauseButton()).toBeNull();
    render({ isRunning: true, editing: true, onTogglePause: vi.fn() });
    expect(pauseButton()).toBeNull();
  });

  it("offers Pause while running and reports each state through its label", () => {
    const toggle = vi.fn();
    render({ isRunning: true, onTogglePause: toggle });
    expect(pauseButton()?.getAttribute("aria-label")).toBe("Pause");
    expect(pauseButton()?.getAttribute("aria-pressed")).toBe("false");
    act(() => pauseButton()!.click());
    expect(toggle).toHaveBeenCalledTimes(1);

    render({ isRunning: true, pause: "pending", onTogglePause: toggle });
    expect(pauseButton()?.getAttribute("aria-label")).toBe("Cancel pause");
    expect(pauseButton()?.getAttribute("aria-pressed")).toBe("true");

    render({ isRunning: true, pause: "paused", onTogglePause: toggle });
    expect(pauseButton()?.getAttribute("aria-label")).toBe("Resume");
  });

  it("keeps Stop available while paused", () => {
    const cancel = vi.fn();
    render({ isRunning: true, pause: "paused", onTogglePause: vi.fn(), onCancel: cancel });
    const stop = container.querySelector<HTMLButtonElement>('button[aria-label="Stop"]')!;
    act(() => stop.click());
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
