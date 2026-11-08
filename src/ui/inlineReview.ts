/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";
import { pendingChanges, type ChangeScope, type PendingChange } from "../stores/pendingChanges";
import { changedLinesSince, computeHunks, mapLineForward } from "../shared/lineDiff";
import { safePath } from "../context/workspaceUtils";
import { createHash } from "node:crypto";

const SCHEME = "ocursor-inline-original";
const ORIGINALS = new Map<string, string>();
const originalsChanged = new vscode.EventEmitter<vscode.Uri>();

interface DiffEntry { path: string; scope?: ChangeScope; snapshotId?: string }
function snapshotId(change: PendingChange): string {
  return createHash("sha256").update(JSON.stringify([change.before, change.after, change.owner])).digest("hex");
}
function beforeUriFor(entry: DiffEntry, side = "before"): vscode.Uri {
  // Build via `from` rather than `parse`: a path like `/workspace/lib/a.ts`
  // would otherwise be parsed as an authority ("//workspace").
  const p = entry.path.replace(/\\/g, "/");
  const query = new URLSearchParams({ side, ...(entry.scope ? { conversation: entry.scope.conversationId, snapshot: entry.snapshotId! } : { overview: "all-pending" }) }).toString();
  return vscode.Uri.from({ scheme: SCHEME, path: p.startsWith("/") ? p : `/${p}`, query });
}

function fileUriFor(relPath: string): vscode.Uri | undefined {
  try {
    return vscode.Uri.file(safePath(relPath));
  } catch {
    return undefined;
  }
}

// The review opens VS Code's normal diff editor and honours the user's own
// `diffEditor.renderSideBySide` preference; we never write editor settings.

/** Push the latest "before" text into an already-open diff without touching tabs. */
function changeForDiff(entry: DiffEntry) {
  return entry.scope ? pendingChanges.snapshots(entry.path, entry.scope).find(change => snapshotId(change) === entry.snapshotId) : pendingChanges.get(entry.path);
}
function refreshOriginal(entry: DiffEntry) {
  const change = changeForDiff(entry);
  if (!change) return false;
  // Firing makes VS Code re-read the virtual document and recompute the diff,
  // so only announce content that actually changed.
  const publish = (uri: vscode.Uri, text: string) => {
    const key = uri.toString();
    if (ORIGINALS.get(key) === text) return;
    ORIGINALS.set(key, text);
    originalsChanged.fire(uri);
  };
  publish(beforeUriFor(entry), change.before);
  if (entry.scope) publish(beforeUriFor(entry, "after"), change.after);
  return true;
}

/** Open the inline diff for a tracked change. Only ever called from an explicit user action. */
async function showInlineDiff(relPath: string, preserveFocus = true, scope?: ChangeScope) {
  const fileUri = fileUriFor(relPath);
  if (!fileUri) return;
  const entry: DiffEntry = { path: fileUri.fsPath, scope: scope ? { ...scope } : undefined };
  let label = "all pending changes";
  if (scope) {
    const snapshots = pendingChanges.snapshots(entry.path, scope);
    if (!snapshots.length) return;
    const selected = snapshots.length === 1 ? { change: snapshots[0], index: 0 } : await vscode.window.showQuickPick(snapshots.map((change, index) => ({
      label: `Edit ${index + 1}`, description: `Chat ${scope.conversationId.slice(0, 8)}${change.owner?.turnIndex === undefined ? "" : ` · turn ${change.owner.turnIndex + 1}`}`,
      detail: change.owner?.runId ? `Run ${change.owner.runId}` : undefined, change, index,
    })), { placeHolder: "Choose this conversation's edit to review" });
    if (!selected) return;
    entry.snapshotId = snapshotId(selected.change);
    label = `chat ${scope.conversationId.slice(0, 8)} · edit ${selected.index + 1}${selected.change.owner?.turnIndex === undefined ? "" : ` · turn ${selected.change.owner.turnIndex + 1}`}`;
  }
  if (!refreshOriginal(entry)) return;
  const before = beforeUriFor(entry);
  await vscode.commands.executeCommand(
    "vscode.diff",
    before,
    scope ? beforeUriFor(entry, "after") : fileUri,
    `${relPath.split(/[\\/]/).pop()} (${label})`,
    { preserveFocus, preview: false, viewColumn: vscode.ViewColumn.Active }
  );
  openDiffs.set(before.toString(), entry);
}

/** Close any inline-diff tab we opened for `relPath`. */
async function closeInlineDiff(entry: DiffEntry) {
  const target = beforeUriFor(entry).toString();
  const doomed: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputTextDiff && input.original.toString() === target) doomed.push(tab);
    }
  }
  if (doomed.length) await vscode.window.tabGroups.close(doomed, true);
  ORIGINALS.delete(target);
  ORIGINALS.delete(beforeUriFor(entry, "after").toString());
}

/**
 * Changed-line highlight for when the file is opened as a normal editor rather
 * than through the inline diff (the diff editor draws its own colours).
 */
const addedDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
  overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
  borderColor: new vscode.ThemeColor("diffEditor.insertedTextBorder"),
  borderWidth: "0 0 0 2px",
  borderStyle: "solid",
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

/** Pending changes by editor path, rebuilt only when the pending set changes. */
let changesByPath: Map<string, PendingChange> | undefined;
function pendingByPath(): Map<string, PendingChange> {
  if (!changesByPath) {
    changesByPath = new Map();
    for (const change of pendingChanges.list()) {
      const uri = fileUriFor(change.path);
      if (uri && !changesByPath.has(uri.fsPath)) changesByPath.set(uri.fsPath, change);
    }
  }
  return changesByPath;
}

/** Map an open editor to the pending change (if any) covering its document. */
function changeForEditor(editor: vscode.TextEditor) {
  return pendingByPath().get(editor.document.uri.fsPath);
}

/** Editors we painted, so ones without a change are cleared once rather than on every refresh. */
const decorated = new WeakSet<vscode.TextEditor>();
function refreshEditor(editor: vscode.TextEditor) {
  const change = changeForEditor(editor);
  if (!change || change.previewOnly) {
    if (decorated.has(editor)) { editor.setDecorations(addedDecoration, []); decorated.delete(editor); }
    return;
  }
  decorated.add(editor);
  // Track the agent's lines through the live text so the user's own unrelated
  // edits are never painted as agent changes.
  const lastLine = Math.max(editor.document.lineCount - 1, 0);
  const added: vscode.Range[] = [];
  for (const line of changedLinesSince(change.before, change.after, editor.document.getText())) {
    if (line > lastLine) break;
    added.push(new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length));
  }
  editor.setDecorations(addedDecoration, added);
}

/** Lets editor title actions appear only on files with pending agent edits. */
const CHANGED_FILES_CONTEXT = "ocursor.agentChangedFiles";
let publishedContext: string | undefined;
function publishChangedFilesContext() {
  const paths = [...pendingByPath().keys()];
  const key = paths.join("\n");
  if (key === publishedContext) return;
  publishedContext = key;
  void vscode.commands.executeCommand("setContext", CHANGED_FILES_CONTEXT, paths);
}

function editorFilePath(uri?: vscode.Uri): string | undefined {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  return target?.scheme === "file" ? target.fsPath : undefined;
}

/**
 * Rejection works on disk, so unsaved typing in the file must be saved first;
 * otherwise the store would refuse to touch a dirty document.
 */
async function ensureSaved(paths: string[]): Promise<boolean> {
  const dirty = vscode.workspace.textDocuments.filter(doc => doc.isDirty && doc.uri.scheme === "file" && paths.includes(doc.uri.fsPath));
  if (!dirty.length) return true;
  const choice = await vscode.window.showWarningMessage(
    `Save your unsaved edits in ${dirty.length === 1 ? dirty[0].uri.fsPath.split(/[\\/]/).pop() : `${dirty.length} files`} before rejecting the agent's changes? Your edits are kept.`,
    { modal: true }, "Save and Reject");
  if (choice !== "Save and Reject") return false;
  for (const doc of dirty) if (!await doc.save()) return false;
  return true;
}

async function runReviewAction(action: () => Promise<void>) {
  try { await action(); }
  catch (error) { void vscode.window.showErrorMessage(`OpenCursor: ${error instanceof Error ? error.message : String(error)}`); }
}

function pendingPathFor(uri?: vscode.Uri): string | undefined {
  const file = editorFilePath(uri);
  return file ? pendingByPath().get(file)?.path : undefined;
}

/**
 * Accept/Reject links above each agent block. Block indexes match the store's
 * unscoped hunks (first original → latest agent text); the agent-side start
 * line travels with the command so a click on a stale lens is refused rather
 * than applied to a different block.
 */
const codeLensesChanged = new vscode.EventEmitter<void>();
const blockLenses: vscode.CodeLensProvider = {
  onDidChangeCodeLenses: codeLensesChanged.event,
  provideCodeLenses(document) {
    if (document.uri.scheme !== "file") return [];
    const change = pendingByPath().get(document.uri.fsPath);
    if (!change || change.previewOnly) return [];
    const text = document.getText();
    const lastLine = Math.max(document.lineCount - 1, 0);
    return computeHunks(change.before, change.after).flatMap((hunk, index) => {
      const line = Math.min(mapLineForward(change.after, text, hunk.startLine), lastLine);
      const range = new vscode.Range(line, 0, line, 0);
      const args = [change.path, index, hunk.startLine];
      return [
        new vscode.CodeLens(range, { title: "$(check) Accept", tooltip: "Keep this agent change", command: "ocursor.acceptBlock", arguments: args }),
        new vscode.CodeLens(range, { title: "$(discard) Reject", tooltip: "Undo this agent change", command: "ocursor.rejectBlock", arguments: args }),
      ];
    });
  },
};

function blockStillCurrent(path: string, index: number, startLine: number): boolean {
  const change = pendingChanges.get(path);
  const current = change && !change.previewOnly && computeHunks(change.before, change.after)[index]?.startLine === startLine;
  if (!current) void vscode.window.showInformationMessage("OpenCursor: the agent's changes in this file were updated. Try again on the refreshed block.");
  return !!current;
}

async function reviewBlock(path: string, index: number, startLine: number, reject: boolean) {
  await runReviewAction(async () => {
    if (!blockStillCurrent(path, index, startLine)) return;
    if (reject) {
      const uri = fileUriFor(path);
      if (!uri || !await ensureSaved([uri.fsPath])) return;
      await pendingChanges.rejectHunk(path, index);
    } else await pendingChanges.acceptHunk(path, index);
  });
}

let refreshTimer: NodeJS.Timeout | undefined;
/** Paths we currently have an inline-diff tab open for. */
const openDiffs = new Map<string, DiffEntry>();

/**
 * Never opens or focuses anything. Agent edits only refresh the content of
 * diffs the user opened themselves, close ones whose change is gone, and
 * repaint changed-line highlights in already-visible editors.
 */
async function sync() {
  for (const [key, entry] of [...openDiffs]) {
    if (!changeForDiff(entry)) {
      openDiffs.delete(key);
      await closeInlineDiff(entry);
    } else {
      // Update the virtual "before" document in place — no vscode.diff call,
      // so an edit can never pull the editor onto a diff tab.
      refreshOriginal(entry);
    }
  }

  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.scheme === "file") refreshEditor(editor);
  }
  publishChangedFilesContext();
  codeLensesChanged.fire();
}

function scheduleSync() {
  changesByPath = undefined;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void sync(), 80);
}

/**
 * Typing only moves highlights in the edited document. Diff originals depend on
 * the pending snapshot, not the live text, so keystrokes never refresh them.
 */
let typingTimer: NodeJS.Timeout | undefined;
const typedDocuments = new Set<vscode.TextDocument>();
function scheduleHighlights(document: vscode.TextDocument) {
  typedDocuments.add(document);
  if (typingTimer) return;
  typingTimer = setTimeout(() => {
    typingTimer = undefined;
    const documents = new Set(typedDocuments);
    typedDocuments.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      if (documents.has(editor.document)) refreshEditor(editor);
    }
  }, 150);
}

/** Register the inline diff view, its virtual original-content provider, and highlights. */
export function registerInlineReview(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      onDidChange: originalsChanged.event,
      provideTextDocumentContent: (uri) => ORIGINALS.get(uri.toString()) ?? "",
    }),
    vscode.commands.registerCommand("ocursor.viewDiff", async (path: string, scope?: ChangeScope) => {
      await showInlineDiff(path, false, scope);
    }),
    // Editor title actions receive the editor's URI; the palette falls back to the active editor.
    vscode.commands.registerCommand("ocursor.acceptFileChanges", (uri?: vscode.Uri) => runReviewAction(async () => {
      const file = pendingPathFor(uri);
      if (file) await pendingChanges.accept(file);
    })),
    vscode.commands.registerCommand("ocursor.acceptBlock", (path: string, index: number, startLine: number) => reviewBlock(path, index, startLine, false)),
    vscode.commands.registerCommand("ocursor.rejectBlock", (path: string, index: number, startLine: number) => reviewBlock(path, index, startLine, true)),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, blockLenses),
    codeLensesChanged,
    vscode.commands.registerCommand("ocursor.acceptAllChanges", () => runReviewAction(() => pendingChanges.acceptAll())),
    vscode.commands.registerCommand("ocursor.rejectAllChanges", () => runReviewAction(async () => {
      const paths = [...pendingByPath().keys()];
      if (!paths.length || !await ensureSaved(paths)) return;
      await pendingChanges.rejectAll();
    })),
    addedDecoration,
    originalsChanged,
    { dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); if (typingTimer) clearTimeout(typingTimer); typingTimer = undefined; typedDocuments.clear(); publishedContext = undefined; } },
    { dispose: pendingChanges.onChange(scheduleSync) },
    vscode.window.onDidChangeVisibleTextEditors(() => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.scheme === "file") refreshEditor(editor);
      }
    }),
    // Typing only refreshes highlights — re-opening diff tabs on every keystroke
    // would thrash the editor.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file" || !e.contentChanges.length) return;
      if (!pendingByPath().has(e.document.uri.fsPath)) return;
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === e.document) { scheduleHighlights(e.document); return; }
      }
    })
  );
  scheduleSync();
}
