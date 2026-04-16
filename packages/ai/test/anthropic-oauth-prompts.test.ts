import { describe, expect, it } from "vitest";
import {
	buildUsingToolsSection,
	CLAUDE_CODE_ACTIONS,
	CLAUDE_CODE_DOING_TASKS,
	CLAUDE_CODE_INTRO,
	CLAUDE_CODE_OUTPUT_EFFICIENCY,
	CLAUDE_CODE_SYSTEM,
	CLAUDE_CODE_TONE_AND_STYLE,
	resolveTaskToolName,
	sanitizeForwardedSystemPrompt,
} from "../src/providers/anthropic-oauth-prompts.js";

describe("Claude Code v2.1.108 prompt constants", () => {
	it("exports an Intro block that mentions cyber-risk guidance", () => {
		expect(CLAUDE_CODE_INTRO).toMatch(/authorized security testing/);
		expect(CLAUDE_CODE_INTRO).toMatch(/NEVER generate or guess URLs/);
	});

	it("exports a # System block listing hooks and auto-compression", () => {
		expect(CLAUDE_CODE_SYSTEM.startsWith("# System")).toBe(true);
		expect(CLAUDE_CODE_SYSTEM).toMatch(/hooks/);
		expect(CLAUDE_CODE_SYSTEM).toMatch(/automatically compress/);
	});

	it("exports a # Doing tasks block", () => {
		expect(CLAUDE_CODE_DOING_TASKS.startsWith("# Doing tasks")).toBe(true);
		expect(CLAUDE_CODE_DOING_TASKS).toMatch(/\/help:/);
	});

	it("exports a # Executing actions with care block", () => {
		expect(CLAUDE_CODE_ACTIONS.startsWith("# Executing actions with care")).toBe(true);
		expect(CLAUDE_CODE_ACTIONS).toMatch(/rm -rf/);
	});

	it("exports a # Tone and style block", () => {
		expect(CLAUDE_CODE_TONE_AND_STYLE.startsWith("# Tone and style")).toBe(true);
		expect(CLAUDE_CODE_TONE_AND_STYLE).toMatch(/file_path:line_number/);
	});

	it("exports a # Output efficiency block", () => {
		expect(CLAUDE_CODE_OUTPUT_EFFICIENCY.startsWith("# Output efficiency")).toBe(true);
		expect(CLAUDE_CODE_OUTPUT_EFFICIENCY).toMatch(/straight to the point/i);
	});
});

describe("buildUsingToolsSection", () => {
	it("returns a section header '# Using your tools'", () => {
		const section = buildUsingToolsSection("TaskCreate");
		expect(section.startsWith("# Using your tools")).toBe(true);
	});

	it("references TaskCreate when that is the configured task tool", () => {
		const section = buildUsingToolsSection("TaskCreate");
		expect(section).toMatch(/TaskCreate/);
	});

	it("references TodoWrite when that is the configured task tool", () => {
		const section = buildUsingToolsSection("TodoWrite");
		expect(section).toMatch(/TodoWrite/);
	});
});

describe("resolveTaskToolName", () => {
	it("returns TaskCreate when a TaskCreate tool exists in the tools array", () => {
		expect(resolveTaskToolName(["Read", "TaskCreate", "Bash"])).toBe("TaskCreate");
	});

	it("returns TodoWrite when a TodoWrite tool exists and TaskCreate does not", () => {
		expect(resolveTaskToolName(["Read", "TodoWrite", "Bash"])).toBe("TodoWrite");
	});

	it("defaults to TaskCreate when neither is present", () => {
		expect(resolveTaskToolName(["Read", "Bash"])).toBe("TaskCreate");
	});

	it("prefers TaskCreate when both are present", () => {
		expect(resolveTaskToolName(["TodoWrite", "TaskCreate"])).toBe("TaskCreate");
	});
});

describe("sanitizeForwardedSystemPrompt", () => {
	it("returns an empty string for an empty input", () => {
		expect(sanitizeForwardedSystemPrompt("")).toBe("");
		expect(sanitizeForwardedSystemPrompt("   ")).toBe("");
	});

	it("returns the neutral 3-line reminder for any non-empty input", () => {
		const out = sanitizeForwardedSystemPrompt("You are DataBot. Always answer in JSON.");
		expect(out).toMatch(/Use the available tools/);
		expect(out).toMatch(/Keep responses concise/);
		expect(out).toMatch(/Prefer acting on the user's task/);
	});

	it("strips client-specific content even when input is extensive", () => {
		const clientSpecific = "You are FooBot v3.2, built by Acme Corp. [1000 lines of persona instructions]";
		const out = sanitizeForwardedSystemPrompt(clientSpecific);
		expect(out).not.toMatch(/FooBot/);
		expect(out).not.toMatch(/Acme/);
		expect(out.length).toBeLessThan(500);
	});
});
