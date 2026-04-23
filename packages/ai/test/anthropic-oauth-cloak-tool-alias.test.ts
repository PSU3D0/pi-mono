import { describe, expect, it } from "vitest";
import {
	buildToolAliases,
	CLAUDE_BUILTIN_TOOL_NAMES,
	classifyToolName,
	resolveAlias,
	reverseAlias,
} from "../src/providers/anthropic-oauth-cloak.js";
import type { Message, Tool } from "../src/types.js";
import { Type } from "typebox";

function tool(name: string): Tool {
	return {
		name,
		description: `${name} tool`,
		parameters: Type.Object({ arg: Type.String() }),
	};
}

describe("CLAUDE_BUILTIN_TOOL_NAMES", () => {
	it("contains Claude Code's session/task tools", () => {
		expect(CLAUDE_BUILTIN_TOOL_NAMES).toContain("TodoWrite");
		expect(CLAUDE_BUILTIN_TOOL_NAMES).toContain("TaskCreate");
		expect(CLAUDE_BUILTIN_TOOL_NAMES).toContain("TaskGet");
		expect(CLAUDE_BUILTIN_TOOL_NAMES).toContain("TaskUpdate");
		expect(CLAUDE_BUILTIN_TOOL_NAMES).toContain("TaskList");
	});

	it("contains Anthropic server-side builtins", () => {
		expect(CLAUDE_BUILTIN_TOOL_NAMES).toContain("web_search");
		expect(CLAUDE_BUILTIN_TOOL_NAMES).toContain("code_execution");
		expect(CLAUDE_BUILTIN_TOOL_NAMES).toContain("text_editor");
		expect(CLAUDE_BUILTIN_TOOL_NAMES).toContain("computer");
	});
});

describe("buildToolAliases", () => {
	it("returns empty maps when there are no custom tools", () => {
		const result = buildToolAliases([tool("TodoWrite"), tool("TaskCreate")], []);
		expect(result.forward.size).toBe(0);
		expect(result.reverse.size).toBe(0);
	});

	it("aliases a single custom tool as t1", () => {
		const result = buildToolAliases([tool("my_db_query")], []);
		expect(result.forward.get("my_db_query")).toBe("t1");
		expect(result.reverse.get("t1")).toBe("my_db_query");
	});

	it("aliases multiple custom tools in order as t1, t2, t3", () => {
		const result = buildToolAliases(
			[tool("alpha"), tool("beta"), tool("gamma")],
			[],
		);
		expect(result.forward.get("alpha")).toBe("t1");
		expect(result.forward.get("beta")).toBe("t2");
		expect(result.forward.get("gamma")).toBe("t3");
	});

	it("does not alias builtins even when they appear in tools", () => {
		const result = buildToolAliases(
			[tool("TodoWrite"), tool("my_custom"), tool("web_search")],
			[],
		);
		expect(result.forward.has("TodoWrite")).toBe(false);
		expect(result.forward.has("web_search")).toBe(false);
		expect(result.forward.get("my_custom")).toBe("t1");
	});

	it("skips an alias index if it collides with an existing tool name", () => {
		// A user-provided tool literally named `t1` forces the aliaser to skip
		// that candidate. Matches the fork's sequential advance-on-collision.
		const result = buildToolAliases(
			[tool("t1"), tool("real_custom")],
			[],
		);
		expect(result.forward.get("t1")).toBe("t2");
		expect(result.forward.get("real_custom")).toBe("t3");
	});

	it("deduplicates custom tool names that appear more than once", () => {
		const result = buildToolAliases([tool("dup"), tool("dup")], []);
		expect(result.forward.size).toBe(1);
		expect(result.forward.get("dup")).toBe("t1");
	});

	it("collects custom tool names referenced in message history (tool_use)", () => {
		const messages: Message[] = [
			{ role: "user", content: "do it", timestamp: 0 },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "legacy_tool_from_history",
						arguments: { foo: 1 },
					},
				],
				stopReason: "toolUse",
				timestamp: 1,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
			},
		];
		const result = buildToolAliases([], messages);
		expect(result.forward.get("legacy_tool_from_history")).toBe("t1");
	});

	it("ignores tools that declare a `type` field (Anthropic server-side builtins)", () => {
		const toolsWithType = [
			{ name: "web_search_20250305", type: "web_search_20250305", description: "", parameters: Type.Object({}) },
			tool("custom_one"),
		];
		const result = buildToolAliases(toolsWithType, []);
		expect(result.forward.has("web_search_20250305")).toBe(false);
		expect(result.forward.get("custom_one")).toBe("t1");
	});
});

describe("resolveAlias", () => {
	it("returns the alias when present", () => {
		const fwd = new Map([["original", "t1"]]);
		expect(resolveAlias("original", fwd)).toBe("t1");
	});

	it("returns the original name when no alias exists", () => {
		const fwd = new Map<string, string>();
		expect(resolveAlias("TodoWrite", fwd)).toBe("TodoWrite");
	});
});

describe("reverseAlias", () => {
	it("returns the original name for a known alias", () => {
		const rev = new Map([["t1", "custom"]]);
		expect(reverseAlias("t1", rev)).toBe("custom");
	});

	it("returns the passed name when alias is unknown (passthrough for builtins)", () => {
		const rev = new Map([["t1", "custom"]]);
		expect(reverseAlias("TodoWrite", rev)).toBe("TodoWrite");
	});
});

describe("buildToolAliases — Claude Code canonical renames", () => {
	it("case-renames a lowercase 'read' to 'Read' (not an opaque alias)", () => {
		const result = buildToolAliases([tool("read")], []);
		expect(result.forward.get("read")).toBe("Read");
		expect(result.reverse.get("Read")).toBe("read");
	});

	it("case-renames all lowercase Claude Code tool names", () => {
		const result = buildToolAliases(
			[tool("read"), tool("write"), tool("bash"), tool("grep"), tool("glob")],
			[],
		);
		expect(result.forward.get("read")).toBe("Read");
		expect(result.forward.get("write")).toBe("Write");
		expect(result.forward.get("bash")).toBe("Bash");
		expect(result.forward.get("grep")).toBe("Grep");
		expect(result.forward.get("glob")).toBe("Glob");
	});

	it("does not rename when case already matches canonical", () => {
		const result = buildToolAliases([tool("Read")], []);
		// "Read" is a builtin; exact match passes through without any entry.
		expect(result.forward.has("Read")).toBe(false);
	});

	it("does not rename a tool whose name is unrelated to any CC tool", () => {
		const result = buildToolAliases([tool("find")], []);
		expect(result.forward.get("find")).toBe("t1"); // aliased, not renamed
	});

	it("mixes canonical renames and opaque aliases in one request", () => {
		const result = buildToolAliases(
			[tool("read"), tool("run_sql"), tool("bash")],
			[],
		);
		expect(result.forward.get("read")).toBe("Read");
		expect(result.forward.get("bash")).toBe("Bash");
		expect(result.forward.get("run_sql")).toBe("t1");
		expect(result.reverse.get("Read")).toBe("read");
		expect(result.reverse.get("Bash")).toBe("bash");
		expect(result.reverse.get("t1")).toBe("run_sql");
	});

	it("aliases indices skip past canonical casing to avoid collision", () => {
		// If user had a literal "t1" tool, the aliaser should not collide.
		const result = buildToolAliases(
			[tool("read"), tool("t1"), tool("my_custom")],
			[],
		);
		expect(result.forward.get("read")).toBe("Read");
		// "t1" is classified as custom (not CC match), gets aliased past itself → t2.
		expect(result.forward.get("t1")).toBe("t2");
		expect(result.forward.get("my_custom")).toBe("t3");
	});
});

describe("classifyToolName — MCP pattern recognition", () => {
	it("classifies mcp__server__tool as 'mcp' (pass-through, no alias)", () => {
		expect(classifyToolName("mcp__linear__create_issue")).toEqual({ kind: "mcp" });
		expect(classifyToolName("mcp__github__search_repos")).toEqual({ kind: "mcp" });
	});

	it("allows hyphens and underscores in both the server and tool segments", () => {
		expect(classifyToolName("mcp__chrome-devtools__take_screenshot")).toEqual({ kind: "mcp" });
		expect(classifyToolName("mcp__my-server_v2__do-thing")).toEqual({ kind: "mcp" });
	});

	it("allows mixed-case server names (real CC uses camelCase)", () => {
		expect(classifyToolName("mcp__openaiDeveloperDocs__search_openai_docs")).toEqual({ kind: "mcp" });
	});

	it("does not misclassify names that merely start with mcp_ (single underscore)", () => {
		expect(classifyToolName("mcp_server_tool")).not.toEqual({ kind: "mcp" });
		expect(classifyToolName("mcp")).not.toEqual({ kind: "mcp" });
		expect(classifyToolName("mcp__foo")).not.toEqual({ kind: "mcp" });
	});

	it("prefers exact builtin match over MCP pattern", () => {
		// Hypothetical: a builtin that happens to match the MCP pattern should
		// be treated as builtin (exact set membership wins).
		// None of our builtins match the pattern, but verify the precedence order.
		expect(classifyToolName("Bash")).toEqual({ kind: "builtin" });
		expect(classifyToolName("TodoWrite")).toEqual({ kind: "builtin" });
	});
});

describe("buildToolAliases — mcp scheme (descriptive, the default)", () => {
	it("keeps the caller's real tool name inside the MCP namespace", () => {
		const result = buildToolAliases(
			[tool("lookup_order"), tool("send_email")],
			[],
			{ scheme: "mcp" },
		);
		expect(result.forward.get("lookup_order")).toBe("mcp__local__lookup_order");
		expect(result.forward.get("send_email")).toBe("mcp__local__send_email");
		expect(result.reverse.get("mcp__local__lookup_order")).toBe("lookup_order");
		expect(result.reverse.get("mcp__local__send_email")).toBe("send_email");
	});

	it("honors a custom mcpServerName", () => {
		const result = buildToolAliases([tool("foo")], [], { scheme: "mcp", mcpServerName: "pi" });
		expect(result.forward.get("foo")).toBe("mcp__pi__foo");
		expect(result.reverse.get("mcp__pi__foo")).toBe("foo");
	});

	it("sanitizes illegal chars in the tool-name segment", () => {
		const result = buildToolAliases([tool("tool.with dots")], [], { scheme: "mcp" });
		// Spaces/dots become underscores so the wire name matches MCP pattern.
		expect(result.forward.get("tool.with dots")).toBe("mcp__local__tool_with_dots");
		expect(result.reverse.get("mcp__local__tool_with_dots")).toBe("tool.with dots");
	});

	it("truncates tool names that would exceed 64 chars on the wire", () => {
		const longName = "a".repeat(80); // mcp__local__ + 80 = 92 chars > 64
		const result = buildToolAliases([tool(longName)], [], { scheme: "mcp" });
		const aliased = result.forward.get(longName);
		expect(aliased).toBeDefined();
		expect(aliased!.length).toBeLessThanOrEqual(64);
		expect(aliased!.startsWith("mcp__local__")).toBe(true);
		// Reverse still resolves to the full original name.
		expect(result.reverse.get(aliased!)).toBe(longName);
	});

	it("falls back to opaque tN when sanitization collision occurs", () => {
		// "foo.bar" and "foo_bar" both sanitize to "foo_bar" — second must
		// fall back to a unique opaque handle to avoid collision.
		const result = buildToolAliases(
			[tool("foo.bar"), tool("foo_bar")],
			[],
			{ scheme: "mcp" },
		);
		expect(result.forward.get("foo.bar")).toBe("mcp__local__foo_bar");
		// Second one collides with first's sanitized form — gets opaque.
		const aliasForSecond = result.forward.get("foo_bar");
		expect(aliasForSecond).toMatch(/^mcp__local__t\d+$/);
		expect(result.reverse.get(aliasForSecond!)).toBe("foo_bar");
	});

	it("passes through real MCP tools without aliasing", () => {
		const result = buildToolAliases(
			[tool("mcp__linear__create_issue"), tool("custom_one")],
			[],
			{ scheme: "mcp" },
		);
		expect(result.forward.has("mcp__linear__create_issue")).toBe(false);
		expect(result.forward.get("custom_one")).toBe("mcp__local__custom_one");
	});

	it("still applies Strategy A (case-rename) for Claude Code canonicals", () => {
		const result = buildToolAliases(
			[tool("bash"), tool("lookup_order")],
			[],
			{ scheme: "mcp" },
		);
		expect(result.forward.get("bash")).toBe("Bash");
		expect(result.forward.get("lookup_order")).toBe("mcp__local__lookup_order");
	});

	it("defaults to 'short' scheme when no option is provided (backward compat)", () => {
		const result = buildToolAliases([tool("one"), tool("two")], []);
		expect(result.forward.get("one")).toBe("t1");
		expect(result.forward.get("two")).toBe("t2");
	});

	it("explicit scheme='short' still produces opaque tN", () => {
		const result = buildToolAliases([tool("one")], [], { scheme: "short" });
		expect(result.forward.get("one")).toBe("t1");
	});
});

describe("buildToolAliases — mcp-opaque scheme (paranoid mode)", () => {
	it("emits mcp__local__tN aliases (fully opaque inside the MCP wrapper)", () => {
		const result = buildToolAliases(
			[tool("lookup_order"), tool("send_email")],
			[],
			{ scheme: "mcp-opaque" },
		);
		expect(result.forward.get("lookup_order")).toBe("mcp__local__t1");
		expect(result.forward.get("send_email")).toBe("mcp__local__t2");
	});

	it("still honors mcpServerName under the opaque variant", () => {
		const result = buildToolAliases([tool("foo")], [], { scheme: "mcp-opaque", mcpServerName: "pi" });
		expect(result.forward.get("foo")).toBe("mcp__pi__t1");
	});

	it("advances past a user-declared mcp__local__t1 collision", () => {
		const result = buildToolAliases(
			[tool("mcp__local__t1"), tool("real_custom")],
			[],
			{ scheme: "mcp-opaque" },
		);
		expect(result.forward.has("mcp__local__t1")).toBe(false);
		expect(result.forward.get("real_custom")).toBe("mcp__local__t2");
	});
});
