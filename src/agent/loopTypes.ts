/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { SamplingParams, ModelParams } from "./provider";
import type { OAuthKind } from "./oauth";
import type { AskQuestionItem } from "./tools";
import type { AgentEvent, Attachment, Mode, Step } from "./types";
import type { SubagentDef } from "../stores/featureStore";
import type { TeamDef } from "./teams";
import type { ContextState } from "./contextState";

/** User's answer to a failed context summarization. Omitted fields fall back to the automatic choice. */
export type CompactionDecision =
	| { action: "retry"; model?: string; thinkingLevel?: string }
	| { action: "trim" };

/** Every input needed to drive a single {@link runAgent} run. */
export interface RunAgentOptions {
	workspaceRoot?: string;
	executionProfile?: import("./execution").ExecutionProfile;
	/** Host capability ceiling, inherited by every child. */
	unavailableTools?: string[];
	runId?: string;
	goal?: { objective: string; status: string; tokenBudget?: number; tokensUsed: number };
	onGoalUsage?: (deltaTokens: number) => void;
	onGoalStatus?: (status: "active" | "paused" | "blocked" | "budgetLimited" | "complete") => void;
	/** Internal parent budget ceiling, shared by concurrently running children. */
	budgetExhausted?: () => boolean;
	drainSteering?: () => string[] | Promise<string[]>;
	onRunEvent?: (event: { type: string; at: number; data?: unknown }) => Promise<void>;
	apiBaseUrl: string;
	apiKey: string;
	/** Live same-provider credential pool, shared by child and summary requests. */
	apiKeyPool?: import("./provider/apiKeyPool").ApiKeyPool;
	model: string;
	mode: Mode;
	prompt: string;
	attachments?: Attachment[];
	history: Step[];
	/** Mutable working-memory checkpoint; persist beside the full transcript. */
	contextState?: ContextState;
	/** Continue directly from the existing `history` checkpoint without appending a new user step (429 resume path). */
	resumeFromCheckpoint?: boolean;
	changeOwner?: import("../stores/pendingChanges").ChangeOwner;
	/** Stable conversation key for transports that support prompt cache routing. */
	promptCacheKey?: string;
	/** Conversation owner for retained terminal evidence, shared by parent and children. */
	shellOwnerKey?: string;
	maxTokens?: number;
	/** Max loop steps before pausing (0/undefined = default 200). */
	maxSteps?: number;
	/** Keep going past the step limit instead of pausing. */
	autoContinue?: boolean;
	/** Model context window (tokens). History is trimmed to fit, reserving maxTokens for the reply. */
	contextTokens?: number;
	sampling?: SamplingParams;
	modelParams?: ModelParams;
	anthropic?: boolean;
	/** OAuth account provider (Claude Code / Codex) for this run. */
	oauthKind?: OAuthKind;
	systemPromptOverride?: string;
	extraInstructions?: string;
	enableFileReading: boolean;
	enableTerminalSuggestions: boolean;
	enableWorkspaceContext?: boolean;
	enableWebSearch?: boolean;
	enableWebFetch?: boolean;
	approve?: (toolName: string, input: any, callId?: string) => Promise<boolean | { approved: false; blockedSubject: string }>;
	isSubagent?: boolean;
	/** Read-only parent brief and original user requests for a delegated run. */
	inheritedContext?: { instructions: string; userRequests: string; summary?: string };
	customSubagents?: SubagentDef[];
	/** All configured subagent teams. */
	teams?: TeamDef[];
	/** Teams assigned to this run (Project mode). */
	activeTeamIds?: string[];
	/** Default model for subagents ("" = inherit this run's model). */
	subagentModel?: string;
	/** Model ids selectable for this run's provider; a Task model outside this list is ignored. */
	availableModels?: string[];
	/** Resolve options and provider routing for a different child/summary/resumed model. */
	resolveModelOptions?: (model: string) =>
		| Partial<Pick<RunAgentOptions, "model" | "apiBaseUrl" | "apiKey" | "apiKeyPool" | "anthropic" | "oauthKind" | "contextTokens" | "maxTokens" | "modelParams" | "sampling">>
		| Promise<Partial<Pick<RunAgentOptions, "model" | "apiBaseUrl" | "apiKey" | "apiKeyPool" | "anthropic" | "oauthKind" | "contextTokens" | "maxTokens" | "modelParams" | "sampling">>>;
	/** Called when a subagent starts, so the UI can offer a per-subagent stop. */
	registerSubagentAbort?: (callId: string, abort: () => void) => void;
	/** Ask the user clarifying questions via the chat UI (ask_question tool). */
	askUser?: (callId: string, header: string | undefined, questions: AskQuestionItem[], signal?: AbortSignal) => Promise<Record<string, string[]>>;
	/** Pause in-place on 429 quota exhaustion until `resumeAt` or manual user resume (optionally switching model). */
	waitForQuotaReset?: (resumeAt: number, signal: AbortSignal, callId?: string) => Promise<"timer" | "manual" | { action: "manual"; model?: string }>;
	/** Pause after a failed context summary until the user retries or accepts trimming. Absent = trim immediately. */
	waitForCompactionDecision?: (signal: AbortSignal, callId?: string) => Promise<CompactionDecision>;
	/**
	 * Called at safe boundaries (before each step, before each tool call). Resolves
	 * immediately unless the user paused the run; then it resolves on resume or abort.
	 * It never rejects, so callers keep their normal abort handling.
	 */
	waitIfPaused?: (signal: AbortSignal, callId?: string) => Promise<void>;
	onAfterRun?: () => void;
	/** Blocking before-shell hook: resolves with a block reason to veto the command. */
	onBeforeShell?: (command: string, signal?: AbortSignal) => Promise<string | undefined> | void;
	onAfterEdit?: (path: string) => void;
	/**
	 * Generic hook trigger for the remaining events (beforeMcp, beforeReadFile, subagentStop, preCompact).
	 * For blocking "before" events the resolved string (if any) vetoes the action.
	 */
	onHook?: (event: import("../integrations/hooksRunner").TriggerEvent, context: Record<string, string>, tool?: string, signal?: AbortSignal) => Promise<string | undefined> | void;
	signal: AbortSignal;
	emit: (e: AgentEvent) => void;
}
