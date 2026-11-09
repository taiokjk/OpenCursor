/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { expect, it } from "vitest";
import { cleanRefinedText, protectMentions, restoreMentions } from "./promptRefiner";

const file = '<attached type="file" title="loop.ts" content="src/agent/loop.ts" />';
const rule = '<attached type="rule" title="style" content=".cursor/rules/style.md" />';

it("round-trips mention tags through placeholders", () => {
	const { text, tags } = protectMentions(`fix ${file} using ${rule}`);
	expect(text).toBe("fix [[REF1]] using [[REF2]]");
	expect(restoreMentions("Fix the bug in [[REF1]], following [[REF2]].", tags)).toBe(`Fix the bug in ${file}, following ${rule}.`);
});

it("appends mentions the model dropped and ignores duplicates or unknown refs", () => {
	const { tags } = protectMentions(`${file} ${rule}`);
	expect(restoreMentions("Use [[REF2]] and [[REF2]] and [[REF9]].", tags)).toBe(`Use ${rule} and  and .\n\n${file}`);
});

it("leaves text without mentions alone", () => {
	expect(protectMentions("plain")).toEqual({ text: "plain", tags: [] });
	expect(restoreMentions("Plain.", [])).toBe("Plain.");
});

it("strips a whole-reply fence and a label", () => {
	expect(cleanRefinedText("```markdown\nDo the thing.\n```")).toBe("Do the thing.");
	expect(cleanRefinedText("Here is the refined prompt:\nDo the thing.")).toBe("Do the thing.");
	expect(cleanRefinedText("Keep ```code``` inline.")).toBe("Keep ```code``` inline.");
});
