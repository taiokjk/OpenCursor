/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { afterEach, expect, it, vi } from "vitest";
const host = vi.hoisted(() => ({ commands: new Map<string, (...args: any[]) => any>(), provider: undefined as any, tabs: [] as any[], close: vi.fn(async () => true), execute: vi.fn(async (..._args: any[]) => undefined), pick: vi.fn(async (items: any[]) => items.at(-1)), onChange: undefined as any, lenses: undefined as any }));
vi.mock("vscode", () => {
  class Uri {
    constructor(readonly scheme: string, readonly path: string, readonly query = "") {}
    get fsPath() { return this.path; }
    toString() { return `${this.scheme}:${this.path}?${this.query}`; }
    static from(value: any) { return new Uri(value.scheme, value.path, value.query); }
    static file(value: string) { return new Uri("file", value); }
  }
  class EventEmitter { event = () => ({ dispose() {} }); fire() {} dispose() {} }
  class TabInputTextDiff { constructor(readonly original: Uri, readonly modified: Uri) {} }
  class CodeLens { constructor(readonly range: any, readonly command: any) {} }
  return { Uri, EventEmitter, TabInputTextDiff, CodeLens,
    languages: { registerCodeLensProvider: (_selector: unknown, provider: any) => { host.lenses = provider; return { dispose() {} }; } },
    Range: class { constructor(...range: number[]) { Object.assign(this, { range }); } }, ThemeColor: class {}, OverviewRulerLane: {}, DecorationRangeBehavior: {}, ViewColumn: {}, ConfigurationTarget: {},
    workspace: { textDocuments: [], workspaceFolders: [], getConfiguration: () => ({ inspect: () => ({}), get: () => false, update: async () => {} }), registerTextDocumentContentProvider: (_scheme: string, provider: any) => { host.provider = provider; return { dispose() {} }; }, onDidChangeTextDocument: (listener: any) => { host.onChange = listener; return { dispose() {} }; } },
    commands: { registerCommand: (name: string, callback: any) => { host.commands.set(name, callback); return { dispose() {} }; }, executeCommand: host.execute },
    window: { visibleTextEditors: [], tabGroups: { all: [{ tabs: host.tabs }], close: host.close }, createTextEditorDecorationType: () => ({ dispose() {} }), onDidChangeVisibleTextEditors: () => ({ dispose() {} }), showQuickPick: host.pick, showInformationMessage: vi.fn(), showErrorMessage: vi.fn(), showWarningMessage: vi.fn() },
  };
});
vi.mock("../context/workspaceUtils", () => ({ safePath: (value: string) => value }));
import * as vscode from "vscode";
import { pendingChanges } from "../stores/pendingChanges";
import { registerInlineReview } from "./inlineReview";

const subscriptions: Array<{ dispose(): unknown }> = [];
afterEach(() => { for (const subscription of subscriptions.splice(0)) subscription.dispose(); pendingChanges.acceptAll(); host.tabs.length = 0; (vscode.window.visibleTextEditors as any[]).length = 0; host.execute.mockClear(); host.close.mockClear(); vi.useRealTimers(); });

it("isolates A/B/A snapshots and closes only the accepted conversation's native diff", async () => {
  vi.useFakeTimers();
  registerInlineReview({ subscriptions } as any);
  const file = "C:/fixture/provenance.txt", a = { conversationId: "chat-a", turnIndex: 0 }, b = { conversationId: "chat-b", turnIndex: 0 };
  pendingChanges.record(file, "start", "A1", true, a);
  pendingChanges.record(file, "A1", "A1\nB1", true, b);
  pendingChanges.record(file, "A1\nB1", "A2\nB1", true, { ...a, turnIndex: 2 });
  const snapshots = pendingChanges.snapshots(file, a);
  expect(snapshots.map(row => [row.before, row.after])).toEqual([["start", "A1"], ["A1\nB1", "A2\nB1"]]);
  snapshots[0].owner!.conversationId = "tampered";
  expect(pendingChanges.snapshots(file, a)).toHaveLength(2);
  await host.commands.get("ocursor.viewDiff")!(file, a);
  await host.commands.get("ocursor.viewDiff")!(file, b);
  const calls = host.execute.mock.calls;
  const aBefore = calls[0][1], aAfter = calls[0][2], bBefore = calls[1][1], bAfter = calls[1][2];
  expect(aBefore.toString()).not.toBe(bBefore.toString());
  expect(aAfter.scheme).toBe("ocursor-inline-original");
  expect(calls[0][3]).toContain("chat chat-a · edit 2 · turn 3");
  expect(host.provider.provideTextDocumentContent(aBefore)).toBe("A1\nB1");
  expect(host.provider.provideTextDocumentContent(aAfter)).toBe("A2\nB1");
  expect(host.provider.provideTextDocumentContent(bAfter)).toBe("A1\nB1");
  const aTab = { input: new vscode.TabInputTextDiff(aBefore, aAfter) }, bTab = { input: new vscode.TabInputTextDiff(bBefore, bAfter) };
  host.tabs.push(aTab, bTab);
  pendingChanges.accept(file, a);
  await vi.advanceTimersByTimeAsync(100);
  expect(host.close).toHaveBeenCalledWith([aTab], true);
  expect(pendingChanges.get(file, b)?.after).toBe("A1\nB1");
  expect(host.provider.provideTextDocumentContent(bAfter)).toBe("A1\nB1");
  expect(host.provider.provideTextDocumentContent(aAfter)).toBe("");
});

it("labels standalone file reviews as an aggregate and retains the live file document", async () => {
  vi.useFakeTimers(); registerInlineReview({ subscriptions } as any);
  const file = "C:/fixture/overview.txt";
  pendingChanges.record(file, "before", "after", true, { conversationId: "chat" });
  await host.commands.get("ocursor.viewDiff")!(file);
  const call = host.execute.mock.calls[0];
  expect(call[2].scheme).toBe("file");
  expect(call[3]).toContain("all pending changes");
  expect(host.provider.provideTextDocumentContent(call[1])).toBe("before");
});

it("publishes changed files for editor title actions and accepts one file or all files from them", async () => {
  vi.useFakeTimers(); registerInlineReview({ subscriptions } as any);
  const one = "C:/fixture/one.txt", two = "C:/fixture/two.txt";
  pendingChanges.record(one, "a", "b", true, { conversationId: "chat" });
  pendingChanges.record(two, "a", "b", true, { conversationId: "chat" });
  await vi.advanceTimersByTimeAsync(100);
  const contexts = () => host.execute.mock.calls.filter(call => call[0] === "setContext" && call[1] === "ocursor.agentChangedFiles");
  expect(contexts().at(-1)?.[2]).toEqual(expect.arrayContaining([pendingChanges.get(one)!.path, pendingChanges.get(two)!.path]));
  await host.commands.get("ocursor.acceptFileChanges")!(vscode.Uri.file(pendingChanges.get(one)!.path));
  expect(pendingChanges.has(one)).toBe(false);
  expect(pendingChanges.has(two)).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(contexts().at(-1)?.[2]).toEqual([pendingChanges.get(two)!.path]);
  await host.commands.get("ocursor.acceptAllChanges")!();
  await vi.advanceTimersByTimeAsync(100);
  expect(pendingChanges.count()).toBe(0);
  expect(contexts().at(-1)?.[2]).toEqual([]);
});

it("puts Accept and Reject links above each agent block, following the user's line shifts", async () => {
  vi.useFakeTimers(); registerInlineReview({ subscriptions } as any);
  const file = "C:/fixture/blocks.txt";
  pendingChanges.record(file, "a\nb\nc\nd", "A\nb\nc\nD", true, { conversationId: "chat" });
  await vi.advanceTimersByTimeAsync(100);
  const text = "mine\nA\nb\nc\nD";
  const lenses = host.lenses.provideCodeLenses({ uri: vscode.Uri.file(pendingChanges.list()[0].path), getText: () => text, lineCount: 5 });
  expect(lenses.map((lens: any) => [lens.range.range[0], lens.command.command, lens.command.arguments[1]])).toEqual([
    [1, "ocursor.acceptBlock", 0], [1, "ocursor.rejectBlock", 0],
    [4, "ocursor.acceptBlock", 1], [4, "ocursor.rejectBlock", 1],
  ]);
  expect(host.lenses.provideCodeLenses({ uri: vscode.Uri.file("C:/fixture/other.txt"), getText: () => "", lineCount: 1 })).toEqual([]);
});

it("refuses a stale block click instead of acting on a different block", async () => {
  vi.useFakeTimers(); registerInlineReview({ subscriptions } as any);
  const file = "C:/fixture/stale.txt";
  pendingChanges.record(file, "a\nb", "A\nb", true, { conversationId: "chat" });
  const path = pendingChanges.list()[0].path;
  await host.commands.get("ocursor.acceptBlock")!(path, 0, 5);
  expect(pendingChanges.has(file)).toBe(true);
  await host.commands.get("ocursor.acceptBlock")!(path, 0, 0);
  expect(pendingChanges.has(file)).toBe(false);
});

it("highlights only the agent's lines, not the user's separate edits", async () => {
  vi.useFakeTimers(); registerInlineReview({ subscriptions } as any);
  const file = "C:/fixture/attribution.txt";
  pendingChanges.record(file, "a\nb\nc", "a\nB\nc", true, { conversationId: "chat" });
  await vi.advanceTimersByTimeAsync(100);
  const text = "user\na\nB\nC";
  const editor = { setDecorations: vi.fn(), document: { uri: vscode.Uri.file(pendingChanges.list()[0].path), getText: () => text, lineCount: 4, lineAt: (line: number) => ({ text: text.split("\n")[line] }) } };
  (vscode.window.visibleTextEditors as any[]).push(editor);
  host.onChange({ document: editor.document, contentChanges: [{}] });
  await vi.advanceTimersByTimeAsync(200);
  expect(editor.setDecorations.mock.calls.at(-1)![1].map((range: any) => range.range[0])).toEqual([2]);
});

it("refreshes only the typed editor's highlights and never re-publishes diff originals per keystroke", async () => {
  vi.useFakeTimers(); registerInlineReview({ subscriptions } as any);
  const file = "C:/fixture/typing.txt";
  pendingChanges.record(file, "one", "one\ntwo", true, { conversationId: "chat" });
  await host.commands.get("ocursor.viewDiff")!(file);
  await vi.advanceTimersByTimeAsync(100);
  const fire = vi.spyOn(vscode.EventEmitter.prototype, "fire");
  let text = "one\ntwo";
  const editorFor = (path: string, read: () => string) => ({ setDecorations: vi.fn(), document: { uri: vscode.Uri.file(path), getText: read, get lineCount() { return read().split("\n").length; }, lineAt: (line: number) => ({ text: read().split("\n")[line] ?? "" }) } });
  const typed = editorFor(pendingChanges.list()[0].path, () => text), other = editorFor("C:/fixture/unrelated.txt", () => "plain");
  (vscode.window.visibleTextEditors as any[]).push(typed, other);
  for (let i = 0; i < 20; i++) { text += "x"; host.onChange({ document: typed.document, contentChanges: [{}] }); }
  host.onChange({ document: other.document, contentChanges: [{}] });
  await vi.advanceTimersByTimeAsync(200);
  expect(typed.setDecorations).toHaveBeenCalledTimes(1);
  expect(typed.setDecorations.mock.calls[0][1]).toHaveLength(1);
  expect(other.setDecorations).not.toHaveBeenCalled();
  expect(fire).not.toHaveBeenCalled();
  fire.mockRestore();
});
