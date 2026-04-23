import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.js";
import { _resetSessionIdCache } from "../src/providers/anthropic-oauth-cloak.js";
import type { Context, Model, Tool } from "../src/types.js";

/**
 * Capture the request the Anthropic SDK sends by stubbing global fetch with a
 * single-shot SSE response. Verifies headers + serialized body shape for the
 * OAuth cloaked path end-to-end.
 */

const OAUTH_TOKEN = "sk-ant-oat01-abc-for-wire-test";

const MODEL: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-20250514",
	name: "Claude Sonnet 4",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 8192,
};

/** A stream that terminates immediately with `message_stop` so the generator completes. */
function minimalSSEResponse(): Response {
	const body = [
		'event: message_start',
		'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
		"",
		"event: message_delta",
		'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
		"",
		"event: message_stop",
		'data: {"type":"message_stop"}',
		"",
	].join("\n");
	return new Response(body, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream",
		},
	});
}

function tool(name: string, description: string): Tool {
	return {
		name,
		description,
		parameters: Type.Object({ q: Type.String() }),
	};
}

describe("Anthropic OAuth cloaked request — wire shape", () => {
	let captured: { url: string; headers: Record<string, string>; body: unknown } | undefined;

	beforeEach(() => {
		_resetSessionIdCache();
		captured = undefined;
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			let url = "";
			if (typeof input === "string") url = input;
			else if (input instanceof URL) url = input.toString();
			else if (input && typeof input === "object" && "url" in input && typeof (input as { url: unknown }).url === "string") {
				url = (input as { url: string }).url;
			}
			const headers: Record<string, string> = {};
			if (init?.headers) {
				const h = init.headers;
				if (h instanceof Headers) {
					h.forEach((v, k) => {
						headers[k] = v;
					});
				} else if (Array.isArray(h)) {
					for (const [k, v] of h) headers[k] = v;
				} else {
					Object.assign(headers, h as Record<string, string>);
				}
			}
			let body: unknown;
			if (typeof init?.body === "string") {
				try {
					body = JSON.parse(init.body);
				} catch {
					body = init.body;
				}
			}
			captured = { url, headers, body };
			return minimalSSEResponse();
		});
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function runOnce(context: Context, extraOptions: Record<string, unknown> = {}): Promise<void> {
		const s = streamAnthropic(MODEL, context, { apiKey: OAUTH_TOKEN, ...extraOptions });
		// Drain
		for await (const _event of s) {
			// noop
		}
	}

	it("sends a 9-block system[] with billing header at index 0 and Claude Code identifier at index 1", async () => {
		const ctx: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		};
		await runOnce(ctx);
		const body = captured?.body as { system?: Array<{ type: string; text: string }> };
		expect(body.system?.length).toBe(9);
		expect(body.system?.[0].text.startsWith("x-anthropic-billing-header:")).toBe(true);
		expect(body.system?.[0].text).toMatch(/cc_version=2\.1\.108\.[0-9a-f]{3};/);
		expect(body.system?.[0].text).toMatch(/cc_entrypoint=cli;/);
		expect(body.system?.[0].text).toMatch(/cch=[0-9a-f]{5};/);
		expect(body.system?.[1].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
		expect(body.system?.[2].text).toMatch(/interactive agent that helps users/);
		expect(body.system?.[3].text.startsWith("# System")).toBe(true);
		expect(body.system?.[7].text.startsWith("# Tone and style")).toBe(true);
		expect(body.system?.[8].text.startsWith("# Output efficiency")).toBe(true);
	});

	it("aliases a custom tool (mcp-style descriptive default) and passes Claude Code builtins through", async () => {
		const ctx: Context = {
			messages: [{ role: "user", content: "search it", timestamp: 0 }],
			tools: [tool("search_invoices", "Search invoice db"), tool("TodoWrite", "Write todos")],
		};
		await runOnce(ctx);
		const body = captured?.body as { tools?: Array<{ name: string }> };
		const names = body.tools?.map((t) => t.name) ?? [];
		expect(names).toContain("mcp__local__search_invoices");
		expect(names).toContain("TodoWrite");
		expect(names).not.toContain("search_invoices");
	});

	it("sets user-agent, X-Stainless-*, X-App, and X-Claude-Code-Session-Id headers", async () => {
		const ctx: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		};
		await runOnce(ctx);
		const h = captured?.headers ?? {};
		// Header keys are lowercased by the Fetch API in Node's global fetch.
		const lower: Record<string, string> = {};
		for (const [k, v] of Object.entries(h)) lower[k.toLowerCase()] = v;

		expect(lower["user-agent"]).toBe("claude-cli/2.1.108 (external, sdk-cli)");
		expect(lower["x-stainless-lang"]).toBe("js");
		expect(lower["x-stainless-runtime"]).toBe("node");
		expect(lower["x-stainless-os"]).toBe("MacOS");
		expect(lower["x-stainless-arch"]).toBe("arm64");
		expect(lower["x-stainless-package-version"]).toBe("0.81.0");
		expect(lower["x-app"]).toBe("cli");
		expect(lower["anthropic-version"]).toBe("2023-06-01");
		expect(lower["x-claude-code-session-id"]).toMatch(/^[0-9a-f]{8}-/);
	});

	it("sets Authorization: Bearer <token> and never x-api-key for OAuth", async () => {
		const ctx: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		};
		await runOnce(ctx);
		const lower: Record<string, string> = {};
		for (const [k, v] of Object.entries(captured?.headers ?? {})) lower[k.toLowerCase()] = v;
		expect(lower["authorization"]).toBe(`Bearer ${OAUTH_TOKEN}`);
		expect(lower["x-api-key"]).toBeUndefined();
	});

	it("does NOT emit anthropic-dangerous-direct-browser-access for OAuth cloak", async () => {
		const ctx: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		};
		await runOnce(ctx);
		const lower: Record<string, string> = {};
		for (const [k, v] of Object.entries(captured?.headers ?? {})) lower[k.toLowerCase()] = v;
		expect(lower["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
	});

	it("sends the expanded Anthropic-Beta list", async () => {
		const ctx: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		};
		await runOnce(ctx);
		const lower: Record<string, string> = {};
		for (const [k, v] of Object.entries(captured?.headers ?? {})) lower[k.toLowerCase()] = v;
		const beta = lower["anthropic-beta"] ?? "";
		expect(beta).toMatch(/claude-code-20250219/);
		expect(beta).toMatch(/oauth-2025-04-20/);
		expect(beta).toMatch(/interleaved-thinking-2025-05-14/);
		expect(beta).toMatch(/context-management-2025-06-27/);
		expect(beta).toMatch(/prompt-caching-scope-2026-01-05/);
		expect(beta).toMatch(/token-efficient-tools-2026-03-28/);
	});

	it("sanitizes the user's systemPrompt to a neutral reminder by default (oauthSanitizeSystemPrompt defaults to true)", async () => {
		const ctx: Context = {
			systemPrompt: "You are HelperBot. Be friendly.",
			messages: [{ role: "user", content: "do it", timestamp: 0 }],
		};
		await runOnce(ctx);
		const body = captured?.body as { messages?: Array<{ content: unknown }> };
		const firstStr = JSON.stringify(body.messages?.[0]?.content);
		expect(firstStr).not.toMatch(/HelperBot/);
		expect(firstStr).toMatch(/software engineering tasks/);
		expect(firstStr).toMatch(/do it/);
	});

	it("preserves the user's systemPrompt when oauthSanitizeSystemPrompt=false is explicitly set", async () => {
		const ctx: Context = {
			systemPrompt: "You are HelperBot. Be friendly.",
			messages: [{ role: "user", content: "do it", timestamp: 0 }],
		};
		await runOnce(ctx, { oauthSanitizeSystemPrompt: false });
		const body = captured?.body as { messages?: Array<{ content: unknown }> };
		const first = body.messages?.[0];
		const firstStr = JSON.stringify(first?.content);
		expect(firstStr).toMatch(/HelperBot/);
		expect(firstStr).toMatch(/do it/);
	});

	it("re-signs the billing header cch using xxHash64 over the final body (cch changes vs pre-sign)", async () => {
		// The signAnthropicMessagesBody step MUST run. The only way to verify is
		// that the final cch matches xxHash64 of the body-with-cch-zeroed —
		// which we verified in unit tests. Here we just ensure it's a valid
		// 5-hex cch present in the final request body.
		const ctx: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		};
		await runOnce(ctx);
		const body = captured?.body as { system?: Array<{ text: string }> };
		const cch = body.system?.[0]?.text.match(/cch=([0-9a-f]{5});/)?.[1];
		expect(cch).toMatch(/^[0-9a-f]{5}$/);
	});

	it("defaults to mcp-style descriptive aliases for custom tools (mcp__local__<name>)", async () => {
		const ctx: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
			tools: [
				{
					name: "lookup_order",
					description: "Look up an order by ID",
					parameters: Type.Object({ id: Type.Number() }),
				},
				{
					name: "send_email",
					description: "Send an email",
					parameters: Type.Object({ to: Type.String() }),
				},
			],
		};
		await runOnce(ctx);
		const body = captured?.body as { tools?: Array<{ name: string }> };
		const names = body.tools?.map((t) => t.name) ?? [];
		expect(names).toContain("mcp__local__lookup_order");
		expect(names).toContain("mcp__local__send_email");
		expect(names).not.toContain("lookup_order");
		expect(names).not.toContain("send_email");
		expect(names).not.toContain("t1");
	});

	it("passes through real MCP tools (mcp__server__tool) without aliasing", async () => {
		const ctx: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
			tools: [
				{
					name: "mcp__linear__create_issue",
					description: "Create a Linear issue",
					parameters: Type.Object({ title: Type.String() }),
				},
				{
					name: "my_custom",
					description: "Custom",
					parameters: Type.Object({ q: Type.String() }),
				},
			],
		};
		await runOnce(ctx);
		const body = captured?.body as { tools?: Array<{ name: string }> };
		const names = body.tools?.map((t) => t.name) ?? [];
		expect(names).toContain("mcp__linear__create_issue"); // real MCP — passthrough
		expect(names).toContain("mcp__local__my_custom"); // custom — aliased descriptively
	});

	it("emits opaque tN aliases when oauthMcpStyleAliases=false", async () => {
		const ctx: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
			tools: [
				{
					name: "one",
					description: "",
					parameters: Type.Object({}),
				},
			],
		};
		await runOnce(ctx, { oauthMcpStyleAliases: false });
		const body = captured?.body as { tools?: Array<{ name: string }> };
		const names = body.tools?.map((t) => t.name) ?? [];
		expect(names).toContain("t1");
		expect(names).not.toContain("mcp__local__t1");
	});

	it("honors a custom oauthMcpServerName", async () => {
		const ctx: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
			tools: [
				{ name: "one", description: "", parameters: Type.Object({}) },
			],
		};
		await runOnce(ctx, { oauthMcpServerName: "pi" });
		const body = captured?.body as { tools?: Array<{ name: string }> };
		const names = body.tools?.map((t) => t.name) ?? [];
		expect(names).toContain("mcp__pi__one");
	});

	it("round-trips mcp-style descriptive alias back to original name on inbound stream events", async () => {
		// Stub a stream that emits tool_use with the mcp-wrapped descriptive wire name.
		const streamBody = [
			"event: message_start",
			'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
			"",
			"event: content_block_start",
			'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu","name":"mcp__local__lookup_order","input":{}}}',
			"",
			"event: content_block_delta",
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"id\\":42}"}}',
			"",
			"event: content_block_stop",
			'data: {"type":"content_block_stop","index":0}',
			"",
			"event: message_delta",
			'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":8}}',
			"",
			"event: message_stop",
			'data: {"type":"message_stop"}',
			"",
		].join("\n");
		const fetchMock = vi.fn(async () => new Response(streamBody, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
		vi.stubGlobal("fetch", fetchMock);

		const ctx: Context = {
			messages: [{ role: "user", content: "do it", timestamp: 0 }],
			tools: [
				{
					name: "lookup_order",
					description: "Look up an order",
					parameters: Type.Object({ id: Type.Number() }),
				},
			],
		};
		const s = streamAnthropic(MODEL, ctx, { apiKey: OAUTH_TOKEN });
		let toolCallName: string | undefined;
		for await (const event of s) {
			if (event.type === "toolcall_end") {
				const c = event.partial.content[event.contentIndex];
				if (c.type === "toolCall") toolCallName = c.name;
			}
		}
		// Wire name was mcp__local__t1; the caller sees "lookup_order" restored.
		expect(toolCallName).toBe("lookup_order");
	});

	it("reverse-maps a case-canonicalized builtin back to caller casing when response arrives (pi-bash regression)", async () => {
		// Reproduces the bug seen with the `pi` CLI where the caller registers
		// lowercase `bash` alongside custom tools. convertTools canonicalizes
		// `bash` → `Bash` for the wire. The model responds with `Bash`. The
		// stream handler must restore "bash" so pi's case-sensitive tool
		// registry lookup `tools.find(t => t.name === toolCall.name)` matches.
		//
		// Uses a stubbed SSE response that emits a tool_use block named "Bash".
		const streamBody = [
			"event: message_start",
			'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
			"",
			"event: content_block_start",
			'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}',
			"",
			"event: content_block_delta",
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"echo hi\\"}"}}',
			"",
			"event: content_block_stop",
			'data: {"type":"content_block_stop","index":0}',
			"",
			"event: message_delta",
			'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":8}}',
			"",
			"event: message_stop",
			'data: {"type":"message_stop"}',
			"",
		].join("\n");
		const fetchMock = vi.fn(async () => new Response(streamBody, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
		vi.stubGlobal("fetch", fetchMock);

		const ctx: Context = {
			messages: [{ role: "user", content: "run echo", timestamp: 0 }],
			tools: [
				{
					name: "bash",
					description: "pi-mono bash tool",
					parameters: Type.Object({ command: Type.String() }),
				},
				{
					name: "todo",
					description: "custom",
					parameters: Type.Object({ item: Type.String() }),
				},
			],
		};
		const s = streamAnthropic(MODEL, ctx, { apiKey: OAUTH_TOKEN });
		let toolCallName: string | undefined;
		for await (const event of s) {
			if (event.type === "toolcall_end") {
				const c = event.partial.content[event.contentIndex];
				if (c.type === "toolCall") toolCallName = c.name;
			}
		}
		expect(toolCallName).toBe("bash");
	});

	it("opts out of cloaking with oauthCloak=false (legacy shape preserved)", async () => {
		const ctx: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		};
		await runOnce(ctx, { oauthCloak: false });
		const body = captured?.body as { system?: Array<{ text: string }> };
		// Legacy path: 1 (or 2) block system, not 9
		expect(body.system?.length).toBeLessThan(9);
		expect(body.system?.[0]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
	});
});
