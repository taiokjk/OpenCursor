/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { addSnapshot, applyComposition, buildComposerPrompt, enableModels, matchSelectedModels, setupModels, MAX_TEAM_SNAPSHOTS, parseComposition, restoreSnapshot, sameSetup, takeSnapshot, type TeamSetup } from "./teamComposer";
import { BUILTIN_TEAM_SUBAGENTS, withBuiltinTeams, withBuiltinTeamSubagents } from "./teams";

const subagents = [
	{ id: "arch", name: "Architect", description: "Designs", prompt: "p1", readonly: true, model: "old::m" },
	{ id: "dev", name: "Backend Developer", description: "Builds", prompt: "p2", readonly: false },
];
const setup: TeamSetup = {
	subagents,
	teams: [
		{ id: "builtin-1", name: "Built-in", description: "", subagentIds: ["arch"], builtin: true },
		{ id: "custom-1", name: "Old custom", description: "", subagentIds: ["dev"] },
	],
	activeTeamIds: ["custom-1"],
	subagentModel: "old::m",
};
const allowed = ["__oauth__:claude-code::claude-opus-5-5", "__oauth__:antigravity::gemini-3.8-flash"];

describe("parseComposition", () => {
	it("accepts fenced JSON, bare model ids and subagent names", () => {
		const reply = "Here you go:\n```json\n" + JSON.stringify({
			subagentModel: "gemini-3.8-flash",
			assignments: [
				{ subagentId: "arch", model: "claude-opus-5-5", reason: "planning" },
				{ subagentId: "Backend Developer", model: "__oauth__:antigravity::gemini-3.8-flash" },
			],
			teams: [{ name: "Squad", description: "Ship it", subagentIds: ["arch", "dev", "ghost"] }],
			notes: "Plan big, build cheap.",
		}) + "\n```";
		const c = parseComposition(reply, subagents, allowed);
		expect(c.subagentModel).toBe(allowed[1]);
		expect(c.assignments).toEqual([
			{ subagentId: "arch", model: allowed[0], reason: "planning" },
			{ subagentId: "dev", model: allowed[1] },
		]);
		expect(c.teams).toEqual([{ name: "Squad", description: "Ship it", subagentIds: ["arch", "dev"] }]);
		expect(c.notes).toBe("Plan big, build cheap.");
	});

	it("drops models outside the selection and rejects a reply with no usable assignment", () => {
		const reply = JSON.stringify({ assignments: [{ subagentId: "arch", model: "gpt-unknown" }] });
		expect(() => parseComposition(reply, subagents, allowed)).toThrow(/did not assign/);
		expect(() => parseComposition("no json here", subagents, allowed)).toThrow(/JSON/);
	});

	it("falls back to the most used model when the default is missing", () => {
		const reply = JSON.stringify({ assignments: [{ subagentId: "arch", model: allowed[1] }, { subagentId: "dev", model: allowed[1] }] });
		expect(parseComposition(reply, subagents, allowed).subagentModel).toBe(allowed[1]);
	});
});

describe("applyComposition", () => {
	it("changes only models, replaces custom teams and activates the new ones", () => {
		let n = 0;
		const next = applyComposition(setup, {
			subagentModel: allowed[1],
			assignments: [{ subagentId: "arch", model: allowed[0] }],
			teams: [{ name: "Squad", description: "", subagentIds: ["arch", "dev"] }],
		}, () => `new-${++n}`);
		expect(next.subagents[0]).toMatchObject({ id: "arch", model: allowed[0], prompt: "p1" });
		expect(next.subagents[1]).toEqual(subagents[1]);
		expect(next.teams.map((t) => t.id)).toEqual(["builtin-1", "new-1"]);
		expect(next.activeTeamIds).toEqual(["new-1"]);
		expect(next.subagentModel).toBe(allowed[1]);
	});
});

describe("snapshots", () => {
	it("copies the setup, keeps newest first and caps history", () => {
		const snap = takeSnapshot(setup, "Before", "s1", 1000, "planner");
		snap.teams[0].subagentIds.push("arch");
		expect(setup.teams[1].subagentIds).toEqual(["dev"]);
		let history = [] as ReturnType<typeof takeSnapshot>[];
		for (let i = 0; i < MAX_TEAM_SNAPSHOTS + 5; i++) history = addSnapshot(history, takeSnapshot(setup, `#${i}`, `s${i}`, i));
		expect(history).toHaveLength(MAX_TEAM_SNAPSHOTS);
		expect(history[0].label).toBe(`#${MAX_TEAM_SNAPSHOTS + 4}`);
	});
});

it("stores built-ins compactly and restores them with their model overrides", () => {
	const preset = BUILTIN_TEAM_SUBAGENTS[0];
	const full: TeamSetup = {
		subagents: withBuiltinTeamSubagents([subagents[1]]).map((s) => (s.id === preset.id ? { ...s, model: allowed[0] } : s)),
		teams: withBuiltinTeams([setup.teams[1]]),
		activeTeamIds: ["custom-1"],
		subagentModel: allowed[1],
	};
	const snap = takeSnapshot(full, "Now", "s1", 1);
	expect(snap.subagents.map((s) => s.id)).toEqual(["dev"]);
	expect(snap.builtinSubagentOverrides[preset.id]).toEqual({ model: allowed[0] });
	expect(JSON.stringify(snap).length).toBeLessThan(2000);
	const back = restoreSnapshot(snap);
	expect(back.subagents.find((s) => s.id === preset.id)).toMatchObject({ model: allowed[0], prompt: preset.prompt });
	expect(sameSetup(back, full)).toBe(true);
	expect(sameSetup(snap, full)).toBe(true);
});

it("matches bare settings-page ids to provider-scoped routing ids", () => {
	const available = [
		{ id: "__oauth__:claude-code::claude-opus-5-5", modelId: "claude-opus-5-5" },
		{ id: "__oauth__:antigravity::gemini-3.8-flash", modelId: "gemini-3.8-flash" },
		{ id: "popular:openrouter::gemini-3.8-flash", modelId: "gemini-3.8-flash" },
	];
	const { matched, missing } = matchSelectedModels(available, ["claude-opus-5-5", "gemini-3.8-flash", "__oauth__:claude-code::claude-opus-5-5", "gone-model"]);
	expect(matched.map((m) => m.id)).toEqual(available.map((m) => m.id));
	expect(missing).toEqual(["gone-model"]);
});

it("enables a snapshot's models with the Models page switches", () => {
	const restored: TeamSetup = {
		...setup,
		subagentModel: "__oauth__:antigravity::gemini-3.8-flash",
		subagents: [
			{ ...subagents[0], model: "__oauth__:claude-code::claude-opus-5-5" },
			{ ...subagents[1], model: "llamacpp::qwen-local" },
		],
	};
	expect(setupModels(restored)).toEqual(["__oauth__:antigravity::gemini-3.8-flash", "__oauth__:claude-code::claude-opus-5-5", "llamacpp::qwen-local"]);
	const next = enableModels(
		{ enabledModels: ["gemini-3.8-flash"], disabledModels: ["claude-opus-5-5", "other"], disabledLocalModels: ["qwen-local"] },
		setupModels(restored),
	);
	expect(next.enabledModels).toEqual(["gemini-3.8-flash", "claude-opus-5-5"]);
	expect(next.disabledModels).toEqual(["other"]);
	expect(next.disabledLocalModels).toEqual([]);
	expect(next.turnedOn).toEqual(["__oauth__:claude-code::claude-opus-5-5", "llamacpp::qwen-local"]);
});

it("lists every model and roster member in the prompt", () => {
	const { user } = buildComposerPrompt(setup, [{ id: allowed[0], name: "Claude Opus 5.5", providerName: "Claude Code" }]);
	expect(user).toContain(allowed[0]);
	expect(user).toContain("arch: Architect [read-only]");
	expect(user).toContain("dev: Backend Developer");
});
