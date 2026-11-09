/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor, AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SubagentsPanel } from "./SubagentsPanel";
import { EMPTY_FEATURES, type FeatureConfig } from "../features";
import { BUILTIN_TEAM_SUBAGENTS } from "../../../src/agent/teams";
import { vscode } from "../../shared/vscode";

vi.mock("../../shared/vscode", () => ({ vscode: { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() } }));

let root: Root, container: HTMLDivElement;
const save = vi.fn();
const preset = BUILTIN_TEAM_SUBAGENTS[0];
const NO_OVERRIDES: Partial<FeatureConfig> = {};
function Harness({ initial = NO_OVERRIDES }: { initial?: Partial<FeatureConfig> }) {
  const [features, setFeatures] = React.useState<FeatureConfig>({ ...EMPTY_FEATURES,
    subagents: [{ ...preset }, { ...preset, id: "custom", name: "Custom agent", builtin: false }],
    teams: [{ id: "test-team", name: "Team", description: "Team", subagentIds: [preset.id, "custom"] }],
    ...initial,
  });
  React.useEffect(() => setFeatures((current) => ({ ...current, ...initial })), [initial]);
  return <SubagentsPanel features={features} setFeatures={patch => { save(patch); setFeatures(current => ({ ...current, ...patch })); }} models={[]} />;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  save.mockClear();
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const rows = () => [...container.querySelectorAll<HTMLTableRowElement>('[aria-label="Subagents"] tbody tr')];
const click = (element: Element | null) => { expect(element).not.toBeNull(); act(() => (element as HTMLElement).click()); };
function setField(field: HTMLInputElement | HTMLTextAreaElement, text: string) {
  act(() => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("edits built-ins in place, resets them, and never offers deletion", () => {
  expect(rows()[0].querySelector('[title="Delete subagent"]')).toBeNull();
  click(rows()[0].querySelector('[title="Edit subagent"]'));
  const dialog = document.querySelector('[role="dialog"]')!;
  setField(dialog.querySelector('input')!, "Updated specialist");
  setField(dialog.querySelector('textarea')!, "Updated instructions");
  click([...dialog.querySelectorAll('button')].find(button => button.textContent === "Save Changes")!);
  expect(save.mock.calls[save.mock.calls.length - 1][0].subagents).toHaveLength(2);
  expect(save.mock.calls[save.mock.calls.length - 1][0].subagents[0]).toMatchObject({ id: preset.id, builtin: true, name: "Updated specialist", prompt: "Updated instructions" });
  expect(rows()[0].textContent).toContain("Updated specialist");
  expect(rows()[0].querySelector('[title="Delete subagent"]')).toBeNull();
  click(rows()[0].querySelector('[title="Reset subagent to defaults"]'));
  expect(save.mock.calls[save.mock.calls.length - 1][0].subagents[0]).toEqual(preset);
  expect(rows()[0].textContent).toContain(preset.name);
});

it("needs a planner before composing, then posts the planner and selected models", () => {
  const post = vi.mocked(vscode.postMessage);
  post.mockClear();
  const run = () => container.querySelector<HTMLButtonElement>(".tc-run")!;
  expect(run().disabled).toBe(true);
  act(() => root.render(<Harness initial={{ teamComposerModel: "planner", teamComposerModels: ["a", "b"] }} />));
  expect(run().disabled).toBe(false);
  click(run());
  expect(post).toHaveBeenCalledWith({ type: "composeTeam", planner: "planner", models: ["a", "b"], saveHistory: true });
  expect(run().textContent).toContain("Composing");
  act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "teamComposeStatus", state: "error", error: "Bad JSON." } })));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Your setup was not changed");
  expect(run().disabled).toBe(false);
});

it("lists dated snapshots and restores one after confirmation", () => {
  const post = vi.mocked(vscode.postMessage);
  post.mockClear();
  const snapshot = { id: "s1", createdAt: Date.UTC(2026, 10, 9, 14, 0, 0), label: "Before composition", subagents: [], builtinSubagentOverrides: { [preset.id]: { model: "m1" } }, teams: [], activeTeamIds: [], subagentModel: "m2" };
  act(() => root.render(<Harness initial={{ teamSnapshots: [snapshot] }} />));
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Team setup history"]')!;
  expect([...select.options].map((o) => o.value)).toEqual(["current", "s1"]);
  expect(select.options[1].textContent).toContain("Before composition");
  act(() => { select.value = "s1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.querySelector(".tc-snapshot")?.textContent).toContain(`${preset.name} → m1`);
  click([...container.querySelectorAll("button")].find((b) => b.textContent === "Restore")!);
  const dialog = document.querySelector('[role="dialog"]')!;
  click([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Restore")!);
  expect(post).toHaveBeenCalledWith({ type: "restoreTeamSnapshot", id: "s1" });
  act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "teamComposeStatus", state: "restored", enabled: ["m1"] } })));
  expect(container.querySelector(".tc-status")?.textContent).toContain("Enabled 1 model it uses: m1");
});

it("still deletes custom agents and removes only their team membership", () => {
  click(rows()[1].querySelector('[title="Delete subagent"]'));
  const dialog = document.querySelector('[role="dialog"]')!;
  click([...dialog.querySelectorAll('button')].find(button => button.textContent === "Delete")!);
  expect(save.mock.calls[save.mock.calls.length - 1][0].subagents).toEqual([preset]);
  expect(save.mock.calls[save.mock.calls.length - 1][0].teams[0].subagentIds).toEqual([preset.id]);
});
