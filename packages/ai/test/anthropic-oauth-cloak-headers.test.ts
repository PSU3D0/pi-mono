import { describe, expect, it } from "vitest";
import {
	buildOAuthBetaString,
	buildOAuthHeaders,
	CLAUDE_CODE_STAINLESS_ARCH,
	CLAUDE_CODE_STAINLESS_OS,
	CLAUDE_CODE_STAINLESS_PACKAGE_VERSION,
	CLAUDE_CODE_STAINLESS_RUNTIME_VERSION,
	CLAUDE_CODE_USER_AGENT,
} from "../src/providers/anthropic-oauth-cloak.js";

describe("buildOAuthBetaString", () => {
	it("includes the canonical Claude Code base betas", () => {
		const betas = buildOAuthBetaString({ extraBetas: [], injectEffort: false });
		expect(betas).toMatch(/claude-code-20250219/);
		expect(betas).toMatch(/oauth-2025-04-20/);
		expect(betas).toMatch(/interleaved-thinking-2025-05-14/);
		expect(betas).toMatch(/context-management-2025-06-27/);
		expect(betas).toMatch(/prompt-caching-scope-2026-01-05/);
		expect(betas).toMatch(/structured-outputs-2025-12-15/);
		expect(betas).toMatch(/fast-mode-2026-02-01/);
		expect(betas).toMatch(/redact-thinking-2026-02-12/);
		expect(betas).toMatch(/token-efficient-tools-2026-03-28/);
	});

	it("adds effort-2025-11-24 when injectEffort is true", () => {
		const betas = buildOAuthBetaString({ extraBetas: [], injectEffort: true });
		expect(betas).toMatch(/effort-2025-11-24/);
	});

	it("does not add effort-2025-11-24 when injectEffort is false", () => {
		const betas = buildOAuthBetaString({ extraBetas: [], injectEffort: false });
		expect(betas).not.toMatch(/effort-2025-11-24/);
	});

	it("deduplicates when extraBetas repeat a base beta", () => {
		const betas = buildOAuthBetaString({ extraBetas: ["oauth-2025-04-20"], injectEffort: false });
		const matches = betas.match(/oauth-2025-04-20/g) ?? [];
		expect(matches.length).toBe(1);
	});

	it("appends unique extraBetas in order after the base list", () => {
		const betas = buildOAuthBetaString({
			extraBetas: ["fine-grained-tool-streaming-2025-05-14"],
			injectEffort: false,
		});
		expect(betas).toMatch(/fine-grained-tool-streaming-2025-05-14/);
	});
});

describe("buildOAuthHeaders", () => {
	it("sets user-agent to the Claude Code 2.1.108 baseline", () => {
		const h = buildOAuthHeaders({ apiKey: "sk-ant-oat01-a" });
		expect(h["user-agent"]).toBe(CLAUDE_CODE_USER_AGENT);
	});

	it("sets the Stainless SDK baseline headers", () => {
		const h = buildOAuthHeaders({ apiKey: "sk-ant-oat01-a" });
		expect(h["X-Stainless-Lang"]).toBe("js");
		expect(h["X-Stainless-Runtime"]).toBe("node");
		expect(h["X-Stainless-Retry-Count"]).toBe("0");
		expect(h["X-Stainless-Timeout"]).toBe("600");
		expect(h["X-Stainless-Package-Version"]).toBe(CLAUDE_CODE_STAINLESS_PACKAGE_VERSION);
		expect(h["X-Stainless-Runtime-Version"]).toBe(CLAUDE_CODE_STAINLESS_RUNTIME_VERSION);
		expect(h["X-Stainless-Os"]).toBe(CLAUDE_CODE_STAINLESS_OS);
		expect(h["X-Stainless-Arch"]).toBe(CLAUDE_CODE_STAINLESS_ARCH);
	});

	it("sets X-App=cli and Anthropic-Version", () => {
		const h = buildOAuthHeaders({ apiKey: "sk-ant-oat01-a" });
		expect(h["X-App"]).toBe("cli");
		expect(h["Anthropic-Version"]).toBe("2023-06-01");
	});

	it("sets a stable X-Claude-Code-Session-Id per apiKey", () => {
		const a1 = buildOAuthHeaders({ apiKey: "sk-ant-oat01-user-alpha" });
		const a2 = buildOAuthHeaders({ apiKey: "sk-ant-oat01-user-alpha" });
		expect(a1["X-Claude-Code-Session-Id"]).toBe(a2["X-Claude-Code-Session-Id"]);

		const b = buildOAuthHeaders({ apiKey: "sk-ant-oat01-user-beta" });
		expect(b["X-Claude-Code-Session-Id"]).not.toBe(a1["X-Claude-Code-Session-Id"]);
	});

	it("does NOT emit Anthropic-Dangerous-Direct-Browser-Access (OAuth path)", () => {
		const h = buildOAuthHeaders({ apiKey: "sk-ant-oat01-a" });
		expect("Anthropic-Dangerous-Direct-Browser-Access" in h).toBe(false);
		expect("anthropic-dangerous-direct-browser-access" in h).toBe(false);
	});

	it("sets an x-client-request-id UUID only when isAnthropicBase is true", () => {
		const withAnthropic = buildOAuthHeaders({
			apiKey: "sk-ant-oat01-a",
			isAnthropicBase: true,
		});
		expect(withAnthropic["x-client-request-id"]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);

		const withoutAnthropic = buildOAuthHeaders({
			apiKey: "sk-ant-oat01-a",
			isAnthropicBase: false,
		});
		expect(withoutAnthropic["x-client-request-id"]).toBeUndefined();
	});

	it("generates a fresh x-client-request-id on every call even for same apiKey", () => {
		const a = buildOAuthHeaders({ apiKey: "sk-ant-oat01-a", isAnthropicBase: true });
		const b = buildOAuthHeaders({ apiKey: "sk-ant-oat01-a", isAnthropicBase: true });
		expect(a["x-client-request-id"]).not.toBe(b["x-client-request-id"]);
	});
});
