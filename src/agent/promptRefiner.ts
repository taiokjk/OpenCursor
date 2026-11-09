/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/** Composer mention pills serialize to these tags; the agent resolves them later. */
const MENTION_TAG = /<attached\s+(?:[\w-]+\s*=\s*"[^"]*"\s*)+\/?>/g;

export const REFINE_SYSTEM_PROMPT = `You rewrite a developer's draft message to an AI coding agent so the agent can act on it well.

Make it clear, specific and complete:
- State the goal first, then the relevant details, constraints and the expected result.
- Keep every fact, file, name, error message, code snippet and requirement from the draft. Never invent new requirements, files or details.
- Fix ambiguity and grammar; split run-on requests into short steps or bullets when that helps.
- Keep the author's voice and intent. Keep it concise: no filler, no greetings, no explanation of your changes.
- Tokens like [[REF1]] stand for attached files or context. Copy each one exactly, once, where it fits best.
- Keep code blocks and inline code byte-for-byte identical.

Reply with ONLY the rewritten message.`;

/** Swap mention tags for stable placeholders so the model cannot mangle them. */
export function protectMentions(text: string): { text: string; tags: string[] } {
	const tags: string[] = [];
	const protectedText = text.replace(MENTION_TAG, (tag) => {
		tags.push(tag);
		return `[[REF${tags.length}]]`;
	});
	return { text: protectedText, tags };
}

/**
 * Put the original mention tags back. Any placeholder the model dropped is
 * appended so no attached context is silently lost; duplicates are removed.
 */
export function restoreMentions(refined: string, tags: string[]): string {
	const used = new Set<number>();
	let out = refined.replace(/\[\[REF(\d+)\]\]/g, (match, n: string) => {
		const index = Number(n) - 1;
		if (!tags[index] || used.has(index)) return "";
		used.add(index);
		return tags[index];
	});
	const missing = tags.filter((_, index) => !used.has(index));
	if (missing.length) out = `${out.trimEnd()}\n\n${missing.join(" ")}`;
	return out;
}

/** Strip wrappers models add despite instructions: a whole-reply code fence or a "Refined prompt:" label. */
export function cleanRefinedText(text: string): string {
	let out = text.trim();
	const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(out);
	if (fenced) out = fenced[1].trim();
	out = out.replace(/^(?:here(?:'s| is) )?(?:the )?(?:refined|rewritten|improved) (?:prompt|message)\s*:\s*\n?/i, "");
	return out.trim();
}
