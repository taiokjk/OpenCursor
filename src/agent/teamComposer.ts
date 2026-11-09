/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { SubagentDef } from "../stores/featureStore";
import { builtinSubagentOverrides, withBuiltinTeams, withBuiltinTeamSubagents, withoutBuiltinTeams, withoutBuiltinTeamSubagents, type BuiltinSubagentOverrides, type TeamDef } from "./teams";

/** A model the composer may assign, as shown to the planner. */
export interface ComposerModel {
	id: string;
	name: string;
	providerName?: string;
}

/** The parts of the feature config a composition reads and overwrites. */
export interface TeamSetup {
	subagents: SubagentDef[];
	teams: TeamDef[];
	activeTeamIds: string[];
	subagentModel: string;
}

/**
 * A dated copy of a team setup the user can restore later. Stored in the same
 * compact form as the feature store: built-ins as field overrides only, so
 * history does not carry a copy of every shipped prompt.
 */
export interface TeamSnapshot {
	id: string;
	createdAt: number;
	label: string;
	/** Planner model that produced this setup, when it came from a composition. */
	planner?: string;
	subagents: SubagentDef[];
	builtinSubagentOverrides: BuiltinSubagentOverrides;
	teams: TeamDef[];
	activeTeamIds: string[];
	subagentModel: string;
}

export interface ComposedTeam {
	name: string;
	description: string;
	subagentIds: string[];
}

/** Validated planner output: every model and member id is known to be real. */
export interface Composition {
	subagentModel: string;
	assignments: { subagentId: string; model: string; reason?: string }[];
	teams: ComposedTeam[];
	notes?: string;
}

export const MAX_TEAM_SNAPSHOTS = 30;

export function buildComposerPrompt(setup: Pick<TeamSetup, "subagents">, models: ComposerModel[]): { system: string; user: string } {
	const system = `You staff a software development team of AI subagents. You decide which language model each specialist runs on, and which squads to form.

Judge each model from what you know about it: reasoning depth, coding ability, speed, cost and quota weight. Assign deliberately:
- Strong reasoning models go to roles that plan, design or judge: product scoping, architecture, threat modeling, security audit, code review. These run briefly, so quality matters more than cost.
- Fast, lightweight, quota-friendly models go to roles that execute an existing plan or produce volume: implementation, tests, docs, codebase exploration, devops chores.
- Spread load across the available models when quality allows; do not put every role on one model.
- Only use model ids from the provided list, copied exactly. Only use subagent ids from the provided roster.

Also propose 2 to 5 squads (teams) built from the roster, each with a clear purpose, plus the default model for any subagent without an explicit assignment (usually the best lightweight model).

Reply with ONLY a JSON object, no prose and no code fence:
{"subagentModel":"<model id>","assignments":[{"subagentId":"<id>","model":"<model id>","reason":"<short why>"}],"teams":[{"name":"<name>","description":"<when to assign it>","subagentIds":["<id>"]}],"notes":"<one or two sentences on the overall strategy>"}`;
	const modelLines = models.map((m) => `- ${m.id}  (${m.name}${m.providerName ? `, via ${m.providerName}` : ""})`).join("\n");
	const roster = setup.subagents
		.map((s) => `- ${s.id}: ${s.name}${s.readonly ? " [read-only]" : ""}: ${s.description}`)
		.join("\n");
	const user = `Available models:\n${modelLines}\n\nSubagent roster (assign a model to every one):\n${roster}`;
	return { system, user };
}

/** Pull the first balanced JSON object out of a reply that may include fences or chatter. */
function extractJson(text: string): unknown {
	const unfenced = text.replace(/```(?:json)?/gi, "");
	const start = unfenced.indexOf("{");
	if (start < 0) throw new Error("The planner did not return JSON.");
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < unfenced.length; i++) {
		const ch = unfenced[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) return JSON.parse(unfenced.slice(start, i + 1));
	}
	throw new Error("The planner's JSON reply was cut off.");
}

const bare = (id: string) => {
	const i = id.indexOf("::");
	return (i >= 0 ? id.slice(i + 2) : id).toLowerCase();
};

/** Map a model id the planner wrote back onto an allowed id (models often drop the provider scope). */
function resolveModel(raw: unknown, allowed: string[]): string | undefined {
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	const value = raw.trim();
	return allowed.find((id) => id === value) ?? allowed.find((id) => bare(id) === bare(value));
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Validate the planner's reply against the real roster and model list.
 * Unknown ids are dropped rather than trusted; a reply with no usable
 * assignment is rejected so a bad answer never wipes the current setup.
 */
export function parseComposition(text: string, subagents: SubagentDef[], allowedModels: string[]): Composition {
	const data = extractJson(text) as Record<string, unknown>;
	if (!data || typeof data !== "object") throw new Error("The planner returned an unexpected reply.");
	const ids = new Set(subagents.map((s) => s.id));
	const byName = new Map(subagents.map((s) => [s.name.toLowerCase(), s.id]));
	const subagentId = (raw: unknown) => {
		const v = str(raw);
		return ids.has(v) ? v : byName.get(v.toLowerCase());
	};

	const assignments: Composition["assignments"] = [];
	const seen = new Set<string>();
	for (const entry of Array.isArray(data.assignments) ? data.assignments : []) {
		const e = entry as Record<string, unknown>;
		const sid = subagentId(e?.subagentId);
		const model = resolveModel(e?.model, allowedModels);
		if (!sid || !model || seen.has(sid)) continue;
		seen.add(sid);
		assignments.push({ subagentId: sid, model, ...(str(e.reason) ? { reason: str(e.reason) } : {}) });
	}
	if (!assignments.length) throw new Error("The planner did not assign any of the selected models to a subagent.");

	const teams: ComposedTeam[] = [];
	const teamNames = new Set<string>();
	for (const entry of Array.isArray(data.teams) ? data.teams : []) {
		const t = entry as Record<string, unknown>;
		const name = str(t?.name);
		const members = [...new Set((Array.isArray(t?.subagentIds) ? t.subagentIds : []).map(subagentId).filter((x): x is string => !!x))];
		if (!name || !members.length || teamNames.has(name.toLowerCase())) continue;
		teamNames.add(name.toLowerCase());
		teams.push({ name, description: str(t.description), subagentIds: members });
	}

	const subagentModel = resolveModel(data.subagentModel, allowedModels) ?? mostUsed(assignments.map((a) => a.model));
	return { subagentModel, assignments, teams, ...(str(data.notes) ? { notes: str(data.notes) } : {}) };
}

function mostUsed(models: string[]): string {
	const counts = new Map<string, number>();
	for (const m of models) counts.set(m, (counts.get(m) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Overwrite the setup with a composition. Subagents keep their prompts and
 * identity; only models change. Custom teams are replaced by the composed
 * squads, which become the active teams. Built-in teams stay available.
 */
export function applyComposition(setup: TeamSetup, composition: Composition, newId: () => string): TeamSetup {
	const modelFor = new Map(composition.assignments.map((a) => [a.subagentId, a.model]));
	const subagents = setup.subagents.map((s) => (modelFor.has(s.id) ? { ...s, model: modelFor.get(s.id) } : s));
	const builtinTeams = setup.teams.filter((t) => t.builtin);
	const composed: TeamDef[] = composition.teams.map((t) => ({ id: newId(), name: t.name, description: t.description, subagentIds: t.subagentIds }));
	return {
		subagents,
		teams: [...builtinTeams, ...composed],
		activeTeamIds: composed.length ? composed.map((t) => t.id) : setup.activeTeamIds.filter((id) => builtinTeams.some((t) => t.id === id)),
		subagentModel: composition.subagentModel,
	};
}

export function takeSnapshot(setup: TeamSetup, label: string, id: string, createdAt: number, planner?: string): TeamSnapshot {
	return {
		id,
		createdAt,
		label,
		...(planner ? { planner } : {}),
		subagents: withoutBuiltinTeamSubagents(setup.subagents).map((s) => ({ ...s })),
		builtinSubagentOverrides: builtinSubagentOverrides(setup.subagents),
		teams: withoutBuiltinTeams(setup.teams).map((t) => ({ ...t, subagentIds: [...t.subagentIds] })),
		activeTeamIds: [...setup.activeTeamIds],
		subagentModel: setup.subagentModel,
	};
}

/** Expand a snapshot back into a full setup, with built-ins re-injected from source. */
export function restoreSnapshot(snapshot: TeamSnapshot): TeamSetup {
	return {
		subagents: withBuiltinTeamSubagents(snapshot.subagents ?? [], snapshot.builtinSubagentOverrides ?? {}),
		teams: withBuiltinTeams(snapshot.teams ?? []),
		activeTeamIds: [...(snapshot.activeTeamIds ?? [])],
		subagentModel: snapshot.subagentModel ?? "",
	};
}

/** Newest first, capped so global state stays small. */
export function addSnapshot(history: TeamSnapshot[], snapshot: TeamSnapshot): TeamSnapshot[] {
	return [snapshot, ...history].slice(0, MAX_TEAM_SNAPSHOTS);
}

/** True when two setups would behave identically (used to avoid duplicate history entries). */
export function sameSetup(a: TeamSetup | TeamSnapshot, b: TeamSetup | TeamSnapshot): boolean {
	const key = (s: TeamSetup | TeamSnapshot) => {
		// Live configs also carry builtinSubagentOverrides, so detect snapshots by their timestamp.
		const full = "createdAt" in s ? restoreSnapshot(s) : s;
		return JSON.stringify({
			m: full.subagentModel,
			a: [...full.activeTeamIds].sort(),
			s: full.subagents.map((x) => [x.id, x.model ?? "", x.name, x.prompt, x.readonly, x.description]),
			t: full.teams.map((x) => [x.id, x.name, x.description, x.subagentIds]),
		});
	};
	return key(a) === key(b);
}
