import { describe, expect, it } from "vitest";
import { applyOAuthCloaking } from "../src/providers/anthropic-oauth-cloak.js";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";

function makeParams(overrides?: Partial<MessageCreateParamsStreaming>): MessageCreateParamsStreaming {
	return {
		model: "claude-sonnet-4-20250514",
		max_tokens: 1024,
		stream: true,
		messages: [{ role: "user", content: "Please search for invoices" }],
		...overrides,
	};
}

describe("applyOAuthCloaking", () => {
	it("replaces params.system with 9 blocks", () => {
		const params = makeParams({
			system: [{ type: "text", text: "You are HelperBot." }],
		});
		applyOAuthCloaking(params, { apiKey: "sk-ant-oat01-a", sanitize: false });
		expect(Array.isArray(params.system)).toBe(true);
		expect((params.system as Array<{ text: string }>).length).toBe(9);
		expect((params.system as Array<{ text: string }>)[0].text.startsWith("x-anthropic-billing-header:")).toBe(true);
		expect((params.system as Array<{ text: string }>)[1].text).toBe(
			"You are Claude Code, Anthropic's official CLI for Claude.",
		);
	});

	it("injects output_config.effort='medium' when thinking.type='adaptive'", () => {
		const params = makeParams({
			thinking: { type: "adaptive" } as any,
		});
		applyOAuthCloaking(params, { apiKey: "sk-ant-oat01-a", sanitize: false });
		expect((params as any).output_config?.effort).toBe("medium");
	});

	it("does NOT inject effort when thinking is absent", () => {
		const params = makeParams();
		applyOAuthCloaking(params, { apiKey: "sk-ant-oat01-a", sanitize: false });
		expect((params as any).output_config).toBeUndefined();
	});

	it("aliases custom tools in params.tools using the descriptive mcp scheme by default", () => {
		const params = makeParams({
			tools: [
				{ name: "search_invoices", description: "", input_schema: { type: "object", properties: {}, required: [] } },
				{ name: "send_email", description: "", input_schema: { type: "object", properties: {}, required: [] } },
				{ name: "TodoWrite", description: "", input_schema: { type: "object", properties: {}, required: [] } },
			],
		});
		applyOAuthCloaking(params, { apiKey: "sk-ant-oat01-a", sanitize: false });
		const names = (params.tools as Array<{ name: string }>).map((t) => t.name);
		expect(names).toContain("mcp__local__search_invoices");
		expect(names).toContain("mcp__local__send_email");
		expect(names).toContain("TodoWrite"); // builtin passes through
		expect(names).not.toContain("search_invoices");
		expect(names).not.toContain("send_email");
	});

	it("aliases custom tools to bare t1, t2, ... when aliasScheme='short'", () => {
		const params = makeParams({
			tools: [
				{ name: "search_invoices", description: "", input_schema: { type: "object", properties: {}, required: [] } },
				{ name: "send_email", description: "", input_schema: { type: "object", properties: {}, required: [] } },
			],
		});
		applyOAuthCloaking(params, { apiKey: "sk-ant-oat01-a", sanitize: false, aliasScheme: "short" });
		const names = (params.tools as Array<{ name: string }>).map((t) => t.name);
		expect(names).toContain("t1");
		expect(names).toContain("t2");
	});

	it("returns a toolAliasReverse map keyed by the mcp-wrapped descriptive name", () => {
		const params = makeParams({
			tools: [
				{ name: "my_custom", description: "", input_schema: { type: "object", properties: {}, required: [] } },
			],
		});
		const result = applyOAuthCloaking(params, { apiKey: "sk-ant-oat01-a", sanitize: false });
		expect(result.toolAliasReverse.get("mcp__local__my_custom")).toBe("my_custom");
	});

	it("rewrites tool_use names in message history to match aliases", () => {
		const params = makeParams({
			tools: [
				{ name: "lookup_order", description: "", input_schema: { type: "object", properties: {}, required: [] } },
			],
			messages: [
				{ role: "user", content: "look it up" },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "call_1", name: "lookup_order", input: { id: 42 } },
					],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "call_1", content: "found" }],
				},
			],
		});
		applyOAuthCloaking(params, { apiKey: "sk-ant-oat01-a", sanitize: false });
		const assistantMsg = (params.messages as any[])[1];
		expect(assistantMsg.content[0].name).toBe("mcp__local__lookup_order");
	});

	it("rewrites tool_choice.name when the named tool is custom", () => {
		const params = makeParams({
			tools: [
				{ name: "custom_tool", description: "", input_schema: { type: "object", properties: {}, required: [] } },
			],
			tool_choice: { type: "tool", name: "custom_tool" } as any,
		});
		applyOAuthCloaking(params, { apiKey: "sk-ant-oat01-a", sanitize: false });
		expect((params.tool_choice as { name?: string }).name).toBe("mcp__local__custom_tool");
	});

	it("honors a custom mcpServerName option", () => {
		const params = makeParams({
			tools: [
				{ name: "foo", description: "", input_schema: { type: "object", properties: {}, required: [] } },
			],
		});
		applyOAuthCloaking(params, {
			apiKey: "sk-ant-oat01-a",
			sanitize: false,
			mcpServerName: "pi",
		});
		const names = (params.tools as Array<{ name: string }>).map((t) => t.name);
		expect(names).toContain("mcp__pi__foo");
	});

	it("switches to fully-opaque aliases when aliasScheme='mcp-opaque'", () => {
		const params = makeParams({
			tools: [
				{ name: "lookup_order", description: "", input_schema: { type: "object", properties: {}, required: [] } },
			],
		});
		applyOAuthCloaking(params, {
			apiKey: "sk-ant-oat01-a",
			sanitize: false,
			aliasScheme: "mcp-opaque",
		});
		const names = (params.tools as Array<{ name: string }>).map((t) => t.name);
		expect(names).toContain("mcp__local__t1");
		expect(names).not.toContain("mcp__local__lookup_order");
	});

	it("prepends the user's system prompt to the first user message when sanitize=false", () => {
		const params = makeParams({
			messages: [{ role: "user", content: "do it" }],
		});
		applyOAuthCloaking(params, {
			apiKey: "sk-ant-oat01-a",
			sanitize: false,
			systemPrompt: "You are HelperBot. Always be friendly.",
		});
		const first = (params.messages as any[])[0];
		expect(JSON.stringify(first.content)).toMatch(/HelperBot/);
		expect(JSON.stringify(first.content)).toMatch(/do it/);
	});

	it("replaces user system prompt with neutral reminder when sanitize=true", () => {
		const params = makeParams({
			messages: [{ role: "user", content: "do it" }],
		});
		applyOAuthCloaking(params, {
			apiKey: "sk-ant-oat01-a",
			sanitize: true,
			systemPrompt: "You are HelperBot. Always be friendly.",
		});
		const first = (params.messages as any[])[0];
		const firstContent = JSON.stringify(first.content);
		expect(firstContent).not.toMatch(/HelperBot/);
		expect(firstContent).toMatch(/software engineering tasks/);
	});

	it("does not prepend anything when the user system prompt is empty", () => {
		const params = makeParams({
			messages: [{ role: "user", content: "ask" }],
		});
		applyOAuthCloaking(params, {
			apiKey: "sk-ant-oat01-a",
			sanitize: false,
			systemPrompt: "",
		});
		const first = (params.messages as any[])[0];
		expect(first.content).toBe("ask");
	});

	it("reports effortInjected=false when thinking is not adaptive", () => {
		const params = makeParams();
		const result = applyOAuthCloaking(params, { apiKey: "sk-ant-oat01-a", sanitize: false });
		expect(result.effortInjected).toBe(false);
	});

	it("reports effortInjected=true when effort was newly injected", () => {
		const params = makeParams({ thinking: { type: "adaptive" } as any });
		const result = applyOAuthCloaking(params, { apiKey: "sk-ant-oat01-a", sanitize: false });
		expect(result.effortInjected).toBe(true);
	});

	it("reports effortInjected=false when effort was already present", () => {
		const params = makeParams({
			thinking: { type: "adaptive" } as any,
			output_config: { effort: "high" },
		} as any);
		const result = applyOAuthCloaking(params, { apiKey: "sk-ant-oat01-a", sanitize: false });
		expect(result.effortInjected).toBe(false);
	});

	it("feeds the correct payload to cch so the 9-block system[0] encodes current body", () => {
		const paramsA = makeParams({ messages: [{ role: "user", content: "alpha" }] });
		const paramsB = makeParams({ messages: [{ role: "user", content: "beta" }] });
		applyOAuthCloaking(paramsA, { apiKey: "sk-ant-oat01-a", sanitize: false });
		applyOAuthCloaking(paramsB, { apiKey: "sk-ant-oat01-a", sanitize: false });
		const cchA = ((paramsA.system as any[])[0].text as string).match(/cch=([0-9a-f]{5})/)?.[1];
		const cchB = ((paramsB.system as any[])[0].text as string).match(/cch=([0-9a-f]{5})/)?.[1];
		expect(cchA).not.toBe(cchB);
	});
});
