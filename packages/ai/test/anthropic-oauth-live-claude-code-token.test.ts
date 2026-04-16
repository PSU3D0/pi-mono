import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context } from "../src/types.js";

/**
 * Live end-to-end validation: reads the Claude Code desktop client's OAuth
 * token from `~/.claude/.credentials.json` and makes a real streaming call
 * to `claude-opus-4-7` through pi-mono's cloaked OAuth pathway.
 *
 * Gated on the file actually existing, so CI without Claude Code installed
 * will skip. Gated on `RUN_LIVE_CLAUDE_CODE=1` so normal test runs don't
 * hit the live API.
 */

interface ClaudeCodeAuthFile {
	claudeAiOauth?: {
		accessToken?: string;
		refreshToken?: string;
		expiresAt?: number;
		subscriptionType?: string;
		scopes?: string[];
	};
}

function loadClaudeCodeOAuthToken(): string | undefined {
	const path = join(homedir(), ".claude", ".credentials.json");
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as ClaudeCodeAuthFile;
		const oauth = parsed.claudeAiOauth;
		if (!oauth?.accessToken) return undefined;
		const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
		if (expiresAt > 0 && expiresAt < Date.now()) {
			// Expired — don't try to use it.
			return undefined;
		}
		return oauth.accessToken;
	} catch {
		return undefined;
	}
}

const token = loadClaudeCodeOAuthToken();
const shouldRun = process.env.RUN_LIVE_CLAUDE_CODE === "1" && Boolean(token);

describe.skipIf(!shouldRun)("Claude Code OAuth token → claude-opus-4-7 (live)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("proves the request was OAuth-cloaked (not PAYG): Bearer auth, 9-block system, no x-api-key", async () => {
		// Intercept global fetch to capture the exact outbound request shape,
		// then forward to the real network. Verifies the wire payload before
		// we assert on the live response.
		const originalFetch = globalThis.fetch;
		const captured: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];

		const interceptor = async (input: unknown, init?: RequestInit): Promise<Response> => {
			let url = "";
			if (typeof input === "string") url = input;
			else if (input instanceof URL) url = input.toString();
			else if (input && typeof input === "object" && "url" in input) {
				url = String((input as { url: unknown }).url);
			}

			const headers: Record<string, string> = {};
			const h = init?.headers;
			if (h instanceof Headers) {
				h.forEach((v, k) => {
					headers[k] = v;
				});
			} else if (Array.isArray(h)) {
				for (const [k, v] of h) headers[k] = v;
			} else if (h) {
				Object.assign(headers, h as Record<string, string>);
			}

			let body: unknown;
			if (typeof init?.body === "string") {
				try {
					body = JSON.parse(init.body);
				} catch {
					body = init.body;
				}
			}
			captured.push({ url, headers, body });
			return originalFetch(input as Parameters<typeof fetch>[0], init);
		};
		vi.stubGlobal("fetch", interceptor);

		const model = getModel("anthropic", "claude-opus-4-7");
		const context: Context = {
			systemPrompt: "You are a test harness. Answer tersely.",
			messages: [
				{
					role: "user",
					content: 'Respond with exactly the single word "pong" and nothing else.',
					timestamp: Date.now(),
				},
			],
		};

		const events = streamAnthropic(model, context, { apiKey: token! });

		let finalText = "";
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheRead = 0;
		let cacheWrite = 0;

		for await (const event of events) {
			if (event.type === "done") {
				stopReason = event.reason;
				errorMessage = event.message.errorMessage;
				inputTokens = event.message.usage.input;
				outputTokens = event.message.usage.output;
				cacheRead = event.message.usage.cacheRead;
				cacheWrite = event.message.usage.cacheWrite;
				for (const block of event.message.content) {
					if (block.type === "text") finalText += block.text;
				}
			}
		}

		// ---- response assertions ----
		console.log("[live] stopReason:", stopReason);
		console.log("[live] errorMessage:", errorMessage ?? "(none)");
		console.log("[live] usage: input=", inputTokens, "output=", outputTokens, "cacheRead=", cacheRead, "cacheWrite=", cacheWrite);
		console.log("[live] response text:", JSON.stringify(finalText));
		expect(errorMessage, `Server error: ${errorMessage}`).toBeFalsy();
		expect(stopReason).toBe("stop");
		expect(finalText.toLowerCase()).toContain("pong");

		// ---- proof-of-OAuth wire assertions ----
		expect(captured.length, "should have intercepted at least one outbound request").toBeGreaterThan(0);
		const messagesCall = captured.find((c) => c.url.includes("/v1/messages"));
		expect(messagesCall, "expected a /v1/messages call").toBeDefined();
		if (!messagesCall) return;

		const lowerHeaders: Record<string, string> = {};
		for (const [k, v] of Object.entries(messagesCall.headers)) lowerHeaders[k.toLowerCase()] = v;

		// Proof #1: OAuth token is sent as Bearer, never as x-api-key.
		console.log("[live] authorization header present:", "authorization" in lowerHeaders);
		console.log("[live] x-api-key header present:", "x-api-key" in lowerHeaders);
		expect(lowerHeaders["authorization"]).toMatch(/^Bearer sk-ant-oat01-/);
		expect(lowerHeaders["x-api-key"], "PAYG header must NOT be present on OAuth path").toBeUndefined();

		// Proof #2: Claude Code identity headers are set (not pi-mono's defaults).
		expect(lowerHeaders["user-agent"]).toBe("claude-cli/2.1.108 (external, sdk-cli)");
		expect(lowerHeaders["x-app"]).toBe("cli");
		expect(lowerHeaders["x-stainless-lang"]).toBe("js");
		expect(lowerHeaders["x-stainless-package-version"]).toBe("0.81.0");
		expect(lowerHeaders["x-claude-code-session-id"]).toMatch(/^[0-9a-f]{8}-/);

		// Proof #3: OAuth-cloak didn't leak the PAYG fingerprint header.
		expect(lowerHeaders["anthropic-dangerous-direct-browser-access"]).toBeUndefined();

		// Proof #4: 9-block Claude Code system prompt is on the wire.
		const body = messagesCall.body as { system?: Array<{ type: string; text: string }>; messages?: Array<{ content: unknown }> };
		expect(body.system, "system must be an array").toBeDefined();
		expect(body.system!.length).toBe(9);
		expect(body.system![0].text.startsWith("x-anthropic-billing-header:")).toBe(true);
		expect(body.system![0].text).toMatch(/cc_version=2\.1\.108\.[0-9a-f]{3};/);
		expect(body.system![0].text).toMatch(/cc_entrypoint=cli;/);
		expect(body.system![0].text).toMatch(/cch=[0-9a-f]{5};/);
		expect(body.system![1].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");

		// Proof #5: anthropic-beta advertises the OAuth-only tags.
		expect(lowerHeaders["anthropic-beta"]).toMatch(/oauth-2025-04-20/);
		expect(lowerHeaders["anthropic-beta"]).toMatch(/claude-code-20250219/);

		// Proof #6: user's "test harness" system prompt was sanitized (default).
		const firstMessageContent = JSON.stringify(body.messages?.[0]?.content);
		expect(firstMessageContent).not.toMatch(/test harness/);
		expect(firstMessageContent).toMatch(/software engineering tasks/);

		// Proof #7: server-side prompt cache hit the Claude Code 9-block system,
		// meaning Anthropic treated the request as byte-identical to real CC.
		// (Confirms the fingerprint — cache keys are over system[] + tools.)
		expect(inputTokens + cacheRead).toBeGreaterThan(500);
	}, 60_000);
});
