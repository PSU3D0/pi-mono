import { describe, expect, it } from "vitest";
import {
	buildClaudeCodeSystemBlocks,
	CLAUDE_CODE_VERSION,
} from "../src/providers/anthropic-oauth-cloak.js";

interface TextBlock {
	type: "text";
	text: string;
	cache_control?: unknown;
}

describe("buildClaudeCodeSystemBlocks", () => {
	const basePayload = new TextEncoder().encode(
		JSON.stringify({ messages: [{ role: "user", content: "ping" }] }),
	);

	it("returns exactly 9 text blocks", () => {
		const blocks = buildClaudeCodeSystemBlocks({
			payload: basePayload,
			userSystemText: "",
			toolNames: [],
		});
		expect(blocks.length).toBe(9);
		for (const b of blocks) {
			expect(b.type).toBe("text");
			expect(typeof b.text).toBe("string");
			expect(b.text.length).toBeGreaterThan(0);
		}
	});

	it("places the billing header at system[0]", () => {
		const blocks = buildClaudeCodeSystemBlocks({
			payload: basePayload,
			userSystemText: "",
			toolNames: [],
		});
		expect(blocks[0].text.startsWith("x-anthropic-billing-header:")).toBe(true);
		expect(blocks[0].text).toMatch(/cc_version=2\.1\.108\.[0-9a-f]{3};/);
		expect(blocks[0].text).toMatch(/cc_entrypoint=cli;/);
		expect(blocks[0].text).toMatch(/cch=[0-9a-f]{5};/);
	});

	it("places the 'You are Claude Code' identifier at system[1]", () => {
		const blocks = buildClaudeCodeSystemBlocks({
			payload: basePayload,
			userSystemText: "",
			toolNames: [],
		});
		expect(blocks[1].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
	});

	it("places Intro/System/DoingTasks/Actions at indices 2..5", () => {
		const blocks = buildClaudeCodeSystemBlocks({
			payload: basePayload,
			userSystemText: "",
			toolNames: [],
		});
		expect(blocks[2].text).toMatch(/interactive agent that helps users with software engineering/);
		expect(blocks[3].text.startsWith("# System")).toBe(true);
		expect(blocks[4].text.startsWith("# Doing tasks")).toBe(true);
		expect(blocks[5].text.startsWith("# Executing actions with care")).toBe(true);
	});

	it("places the dynamic 'Using your tools' at index 6", () => {
		const blocks = buildClaudeCodeSystemBlocks({
			payload: basePayload,
			userSystemText: "",
			toolNames: ["TaskCreate", "Bash"],
		});
		expect(blocks[6].text.startsWith("# Using your tools")).toBe(true);
		expect(blocks[6].text).toMatch(/TaskCreate/);
	});

	it("references TodoWrite in the 'Using your tools' block when only TodoWrite is present", () => {
		const blocks = buildClaudeCodeSystemBlocks({
			payload: basePayload,
			userSystemText: "",
			toolNames: ["TodoWrite", "Read"],
		});
		expect(blocks[6].text).toMatch(/TodoWrite/);
	});

	it("places ToneAndStyle at index 7 and OutputEfficiency at index 8", () => {
		const blocks = buildClaudeCodeSystemBlocks({
			payload: basePayload,
			userSystemText: "",
			toolNames: [],
		});
		expect(blocks[7].text.startsWith("# Tone and style")).toBe(true);
		expect(blocks[8].text.startsWith("# Output efficiency")).toBe(true);
	});

	it("uses the user's system text to compute the build fingerprint", () => {
		const blocksA = buildClaudeCodeSystemBlocks({
			payload: basePayload,
			userSystemText: "first user prompt for fp A",
			toolNames: [],
		});
		const blocksB = buildClaudeCodeSystemBlocks({
			payload: basePayload,
			userSystemText: "completely different text",
			toolNames: [],
		});
		const fpA = blocksA[0].text.match(/cc_version=2\.1\.108\.([0-9a-f]{3})/)?.[1];
		const fpB = blocksB[0].text.match(/cc_version=2\.1\.108\.([0-9a-f]{3})/)?.[1];
		expect(fpA).not.toBe(fpB);
	});

	it("uses the payload bytes to compute the cch value", () => {
		const payload1 = new TextEncoder().encode(JSON.stringify({ messages: [{ role: "user", content: "a" }] }));
		const payload2 = new TextEncoder().encode(JSON.stringify({ messages: [{ role: "user", content: "b" }] }));

		const cch1 = buildClaudeCodeSystemBlocks({ payload: payload1, userSystemText: "", toolNames: [] })[0].text.match(/cch=([0-9a-f]{5})/)?.[1];
		const cch2 = buildClaudeCodeSystemBlocks({ payload: payload2, userSystemText: "", toolNames: [] })[0].text.match(/cch=([0-9a-f]{5})/)?.[1];
		expect(cch1).not.toBe(cch2);
	});

	it("honors a custom entrypoint and workload", () => {
		const blocks = buildClaudeCodeSystemBlocks({
			payload: basePayload,
			userSystemText: "",
			toolNames: [],
			entrypoint: "vscode",
			workload: "interactive",
		});
		expect(blocks[0].text).toMatch(/cc_entrypoint=vscode;/);
		expect(blocks[0].text).toMatch(/cc_workload=interactive;/);
	});

	it("uses CLAUDE_CODE_VERSION by default", () => {
		const blocks = buildClaudeCodeSystemBlocks({
			payload: basePayload,
			userSystemText: "",
			toolNames: [],
		});
		expect(blocks[0].text).toMatch(new RegExp(`cc_version=${CLAUDE_CODE_VERSION.replace(/\./g, "\\.")}\\.`));
	});
});
