import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import { streamSimple } from "../src/stream.js";
import type { Context, Tool } from "../src/types.js";

interface ClaudeCodeAuthFile {
	claudeAiOauth?: { accessToken?: string; expiresAt?: number };
}

function loadClaudeCodeOAuthToken(): string | undefined {
	const path = join(homedir(), ".claude", ".credentials.json");
	if (!existsSync(path)) return undefined;
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as ClaudeCodeAuthFile;
	const t = parsed.claudeAiOauth?.accessToken;
	const exp = parsed.claudeAiOauth?.expiresAt ?? 0;
	if (!t || (exp > 0 && exp < Date.now())) return undefined;
	return t;
}

const token = loadClaudeCodeOAuthToken();
const shouldRun = process.env.RUN_LIVE_CLAUDE_CODE === "1" && Boolean(token);

describe.skipIf(!shouldRun)("Live tool-call round-trip through OAuth cloaking", () => {
	it("round-trips 'bash' (lowercase) correctly — model calls, we get back 'bash' not 'Bash'", async () => {
		const model = getModel("anthropic", "claude-opus-4-7");
		const bashTool: Tool = {
			name: "bash", // pi-mono's lowercase tool name
			description: "Run a bash command",
			parameters: Type.Object({ command: Type.String({ description: "Command to run" }) }),
		};
		const context: Context = {
			systemPrompt: "You are a coding agent.",
			messages: [
				{
					role: "user",
					content: "Run `echo hello` via the bash tool. Call the tool exactly once.",
					timestamp: Date.now(),
				},
			],
			tools: [bashTool],
		};

		const events = streamAnthropic(model, context, { apiKey: token! });

		let toolCallName: string | undefined;
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		for await (const event of events) {
			if (event.type === "toolcall_end") {
				const call = event.partial.content[event.contentIndex];
				if (call.type === "toolCall") toolCallName = call.name;
			}
			if (event.type === "done") {
				stopReason = event.reason;
				errorMessage = event.message.errorMessage;
			}
		}

		console.log("[live-tool] stopReason:", stopReason);
		console.log("[live-tool] errorMessage:", errorMessage ?? "(none)");
		console.log("[live-tool] toolCallName received back:", JSON.stringify(toolCallName));

		expect(errorMessage).toBeFalsy();
		expect(stopReason).toBe("toolUse");
		// This is the regression we're chasing: pi-mono registers tools with
		// their original casing; after canonical rename + reverse, we MUST get
		// back "bash", not "Bash".
		expect(toolCallName).toBe("bash");
	}, 60_000);

	// pi-mono's coding-agent uses streamSimple, not streamAnthropic directly.
	// Verify the same round-trip holds through the simple-stream dispatcher.
	it("round-trips 'bash' through streamSimple (pi-mono's actual call path)", async () => {
		const model = getModel("anthropic", "claude-opus-4-7");
		const bashTool: Tool = {
			name: "bash",
			description: "Run a bash command",
			parameters: Type.Object({ command: Type.String({ description: "Command to run" }) }),
		};
		const context: Context = {
			systemPrompt: "You are a coding agent.",
			messages: [
				{
					role: "user",
					content: "Run `echo hello` via the bash tool. Call the tool exactly once.",
					timestamp: Date.now(),
				},
			],
			tools: [bashTool],
		};

		const events = streamSimple(model, context, { apiKey: token! });

		let toolCallName: string | undefined;
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		for await (const event of events) {
			if (event.type === "toolcall_end") {
				const call = event.partial.content[event.contentIndex];
				if (call.type === "toolCall") toolCallName = call.name;
			}
			if (event.type === "done") {
				stopReason = event.reason;
				errorMessage = event.message.errorMessage;
			}
		}

		console.log("[live-tool/simple] toolCallName:", JSON.stringify(toolCallName));
		console.log("[live-tool/simple] stopReason:", stopReason);
		console.log("[live-tool/simple] errorMessage:", errorMessage ?? "(none)");
		expect(errorMessage).toBeFalsy();
		expect(stopReason).toBe("toolUse");
		expect(toolCallName).toBe("bash");
	}, 60_000);
});
